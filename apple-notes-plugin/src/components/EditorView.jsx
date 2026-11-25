import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AiEditor } from 'aieditor';
import { dehydrateHtml, hydrateHtml, editorUploader } from '../lib/images.js';

const HINTS = {
  saved: { text: '已保存', cls: 'text-muted' },
  saving: { text: '正在保存…', cls: 'text-muted' },
  error: { text: '保存失败', cls: 'text-danger' }
};

export default function EditorView({ node, theme, autoFocusTitle, crumbs, onPatch }) {
  const holderRef = useRef(null);
  const titleInputRef = useRef(null);
  const editorRef = useRef(null);
  const nodeRef = useRef(node);
  nodeRef.current = node;

  const [title, setTitle] = useState(node.title || '');
  const titleRef = useRef(node.title || '');
  const [saveState, setSaveState] = useState('saved');

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

    setSaveState('saving');
    return Promise.resolve(onPatch(current.id, { html, title: titleRef.current }))
      .then(() => {
        if (mountedRef.current) setSaveState('saved');
      })
      .catch((err) => {
        console.warn('[笔记] 保存失败', err);
        if (mountedRef.current) setSaveState('error');
      });
  }, [onPatch]);

  const markDirty = useCallback(() => {
    if (!mountedRef.current) return;
    setSaveState('saving');
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
        placeholder: '写点什么…',
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
          markDirty();
        }
      });

      if (cancelled) {
        try { inst.destroy(); } catch (err) { /* 忽略 */ }
        return;
      }
      editorRef.current = inst;
      creatingRef.current = false;

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

  const hint = HINTS[saveState] || HINTS.saved;

  return (
    <section className="flex h-full flex-col">
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
          <span className={'mt-2 shrink-0 text-caption ' + hint.cls}>{hint.text}</span>
        </div>
      </header>

      <div className="nb-scroll min-h-0 flex-1 overflow-y-auto px-10 pb-10">
        <div className="w-full">
          <div ref={holderRef} />
        </div>
      </div>
    </section>
  );
}
