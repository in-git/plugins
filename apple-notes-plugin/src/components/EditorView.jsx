import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AiEditor } from 'aieditor';
import { dehydrateHtml, hydrateHtml, editorUploader } from '../lib/images.js';
import { downloadNote, noteStats } from '../lib/export.js';
import DownloadDialog from './DownloadDialog.jsx';
import QrDialog from './QrDialog.jsx';
import { Icon } from './icons.jsx';

// 二维码容量上限（纠错等级 M、字节模式、版本 40 的上限是 2331 字节）
const QR_MAX_BYTES = 2331;

export default function EditorView({ node, theme, autoFocusTitle, crumbs, onPatch }) {
  const holderRef = useRef(null);
  const titleInputRef = useRef(null);
  const editorRef = useRef(null);
  const nodeRef = useRef(node);
  nodeRef.current = node;

  const [title, setTitle] = useState(node.title || '');
  const titleRef = useRef(node.title || '');
  const [downloadOpen, setDownloadOpen] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  const [stats, setStats] = useState(() => noteStats(node.html || ''));

  const saveTimer = useRef(0);
  const mountedRef = useRef(true);
  const creatingRef = useRef(true);
  const themeRef = useRef(theme);
  themeRef.current = theme;

  // 外部（树中重命名）改动标题时同步
  useEffect(() => {
    const next = node.title || '';
    if (next !== titleRef.current) {
      titleRef.current = next;
      setTitle(next);
    }
  }, [node.title]);

  const saveNow = useCallback(() => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = 0;
    }
    const inst = editorRef.current;
    const current = nodeRef.current;
    if (!inst || !current) return Promise.resolve();

    let html = '';
    try {
      // 图片：blob 临时地址 → idb://图片id，随笔记一起持久化
      html = dehydrateHtml(inst.getHTML());
    } catch (err) {
      console.warn('[笔记] 导出内容失败', err);
      return Promise.resolve();
    }

    return Promise.resolve(onPatch(current.id, { html, title: titleRef.current })).catch((err) => {
      console.warn('[笔记] 保存失败', err);
    });
  }, [onPatch]);

  const markDirty = useCallback(() => {
    if (!mountedRef.current) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(saveNow, 500);
  }, [saveNow]);

  // 每篇文档一个编辑器实例；切换文档时销毁重建，避免状态串味
  useEffect(() => {
    mountedRef.current = true;
    creatingRef.current = true;
    let cancelled = false;

    (async () => {
      const html = await hydrateHtml(node.html || '');
      if (cancelled || !holderRef.current) return;

      const inst = new AiEditor({
        element: holderRef.current,
        content: html,
        theme: themeRef.current,
        locale: 'zh-CN',
        placeholder:
          '在这里开始写作。左侧「+」新建笔记，文件夹右侧「+」新建子目录；双击条目重命名，右键有更多操作；Ctrl+S 立即保存。',
        aiChat: false,
        uploader: editorUploader,
        toolbar: {
          style: 'classic',
          size: 'small',
          overflow: 'wrap',
          sticky: true,
          stickyOffset: 0,
          // 克制的一组常用工具，贴合 Apple Notes 的简洁工具栏
          menus: [
            'text-style',
            'separator-text',
            'bold',
            'italic',
            'underline',
            'strike',
            'separator-block',
            'bullet-list',
            'ordered-list',
            'blockquote',
            'code-block',
            'separator-link',
            'link',
            'image',
            'separator-history',
            'undo',
            'redo'
          ]
        },
        onSave: () => { saveNow(); },
        onUpdate: () => {
          if (creatingRef.current) return;
          if (editorRef.current) setStats(noteStats(editorRef.current.getHTML()));
          markDirty();
        }
      });

      if (cancelled) {
        try { inst.destroy(); } catch (err) { /* 忽略 */ }
        return;
      }
      editorRef.current = inst;
      creatingRef.current = false;
      setStats(noteStats(inst.getHTML()));

      if (autoFocusTitle && titleInputRef.current) {
        titleInputRef.current.focus();
        titleInputRef.current.select();
      }
    })();

    return () => {
      cancelled = true;
      mountedRef.current = false;
      saveNow();
      if (editorRef.current) {
        try { editorRef.current.destroy(); } catch (err) { /* 忽略 */ }
        editorRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id]);

  useEffect(() => {
    const inst = editorRef.current;
    if (!inst) return;
    try { inst.setTheme(theme); } catch (err) { /* 忽略 */ }
  }, [theme]);

  // 正文能否塞进一张二维码：空内容或超出容量时隐藏入口
  const canQr = stats.text.trim().length > 0 && stats.bytes <= QR_MAX_BYTES;

  // 导出当前编辑器里的实时内容（而不是可能滞后的 node.html）
  const handleDownload = useCallback((format) => {
    const inst = editorRef.current;
    let html = '';
    try {
      html = inst ? inst.getHTML() : nodeRef.current.html || '';
    } catch (err) {
      html = nodeRef.current.html || '';
    }
    downloadNote({ title: titleRef.current, format, html });
    setDownloadOpen(false);
  }, []);

  return (
    <section className="relative flex h-full flex-col">
      <header className="shrink-0 px-10 pb-3 pt-7">
        <div className="mb-2.5 flex flex-wrap items-center gap-1 text-caption text-muted">{crumbs}</div>
        <div className="flex items-start justify-between gap-4">
          <input
            id="docTitle"
            ref={titleInputRef}
            value={title}
            placeholder="无标题文档"
            spellCheck={false}
            onChange={(e) => {
              const value = e.target.value;
              setTitle(value);
              titleRef.current = value;
              markDirty();
            }}
            className="min-w-0 flex-1 bg-transparent text-display font-semibold text-ink outline-none placeholder:text-muted"
          />
          <div className="mt-1 flex shrink-0 items-center gap-1">
            {canQr ? (
              <button
                type="button"
                className="nb-icon-btn h-8 w-8"
                title="生成二维码"
                aria-label="生成二维码"
                onClick={() => setQrOpen(true)}
              >
                <Icon name="qr" size={18} />
              </button>
            ) : null}
            <button
              type="button"
              className="nb-icon-btn h-8 w-8"
              title="下载（TXT / Markdown）"
              aria-label="下载"
              onClick={() => setDownloadOpen(true)}
            >
              <Icon name="download" size={18} />
            </button>
          </div>
        </div>
      </header>

      <div className="nb-scroll min-h-0 flex-1 overflow-y-auto px-10 pb-10">
        <div className="w-full">
          <div ref={holderRef} />
        </div>
      </div>

      {/* 右下角字数统计 */}
      <div className="pointer-events-none absolute bottom-4 right-6 rounded-full bg-canvas px-2 py-0.5 text-meta text-muted shadow-soft">
        {stats.chars.toLocaleString('zh-CN')} 字
      </div>

      <QrDialog
        open={qrOpen}
        title={title}
        text={stats.text}
        onClose={() => setQrOpen(false)}
      />

      <DownloadDialog
        open={downloadOpen}
        title={title}
        onCancel={() => setDownloadOpen(false)}
        onConfirm={handleDownload}
      />
    </section>
  );
}
