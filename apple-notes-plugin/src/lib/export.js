/**
 * 笔记导出：把 AiEditor 的 HTML 转成纯文本 / Markdown，并触发浏览器下载。
 * 图片（本地 IndexedDB 存储）不参与文本导出，直接跳过。
 */

const SKIP_TAGS = new Set(['IMG', 'SCRIPT', 'STYLE']);

function parse(html) {
  return new DOMParser().parseFromString(html || '', 'text/html');
}

function clean(text) {
  return text.replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ');
}

/* ---------------- 纯文本 ---------------- */

function inlineText(node) {
  let out = '';
  node.childNodes.forEach((child) => {
    if (child.nodeType === 3) out += clean(child.nodeValue);
    else if (child.nodeType === 1 && !SKIP_TAGS.has(child.tagName)) out += inlineText(child);
  });
  return out;
}

function blockText(node) {
  const lines = [];
  node.childNodes.forEach((child) => {
    if (child.nodeType === 3) {
      const text = clean(child.nodeValue).trim();
      if (text) lines.push(text);
      return;
    }
    if (child.nodeType !== 1) return;
    const tag = child.tagName;
    if (SKIP_TAGS.has(tag)) return;
    if (tag === 'BR') {
      lines.push('');
      return;
    }
    if (tag === 'HR') {
      lines.push('---');
      return;
    }
    if (tag === 'LI') {
      lines.push('- ' + inlineText(child).trim());
      return;
    }
    if (tag === 'PRE') {
      lines.push(child.textContent.replace(/\n$/, ''));
      return;
    }
    const inner = blockText(child);
    if (inner.trim()) lines.push(inner);
  });
  return lines.join('\n');
}

export function htmlToText(html) {
  const body = parse(html).body;
  return blockText(body)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 字数 / 字节统计：字数忽略空白，字节按 UTF-8 计算（用于二维码容量判断） */
export function noteStats(html) {
  const text = htmlToText(html || '');
  return {
    text,
    chars: Array.from(text.replace(/\s/g, '')).length,
    bytes: new TextEncoder().encode(text).length
  };
}

/* ---------------- Markdown ---------------- */

function inlineMd(node) {
  let out = '';
  node.childNodes.forEach((child) => {
    if (child.nodeType === 3) {
      out += clean(child.nodeValue);
      return;
    }
    if (child.nodeType !== 1) return;
    const tag = child.tagName;
    if (SKIP_TAGS.has(tag)) return;
    if (tag === 'BR') {
      out += '  \n';
      return;
    }
    if (tag === 'STRONG' || tag === 'B') {
      out += `**${inlineMd(child)}**`;
      return;
    }
    if (tag === 'EM' || tag === 'I') {
      out += `*${inlineMd(child)}*`;
      return;
    }
    if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL') {
      out += `~~${inlineMd(child)}~~`;
      return;
    }
    if (tag === 'CODE') {
      out += '`' + child.textContent + '`';
      return;
    }
    if (tag === 'A') {
      const href = child.getAttribute('href') || '';
      const label = inlineMd(child).trim() || href;
      out += href ? `[${label}](${href})` : label;
      return;
    }
    if (tag === 'U') {
      out += inlineMd(child);
      return;
    }
    out += inlineMd(child);
  });
  return out;
}

function blockMd(node) {
  const blocks = [];
  node.childNodes.forEach((child) => {
    if (child.nodeType === 3) {
      const text = clean(child.nodeValue).trim();
      if (text) blocks.push(text);
      return;
    }
    if (child.nodeType !== 1) return;
    const tag = child.tagName;
    if (SKIP_TAGS.has(tag)) return;

    const heading = /^H([1-6])$/.exec(tag);
    if (heading) {
      const text = inlineMd(child).trim();
      if (text) blocks.push('#'.repeat(Number(heading[1])) + ' ' + text);
      return;
    }
    if (tag === 'P' || tag === 'DIV') {
      const text = inlineMd(child).trim();
      if (text) blocks.push(text);
      return;
    }
    if (tag === 'HR') {
      blocks.push('---');
      return;
    }
    if (tag === 'PRE') {
      blocks.push('```\n' + child.textContent.replace(/\n$/, '') + '\n```');
      return;
    }
    if (tag === 'BLOCKQUOTE') {
      const inner = blockMd(child);
      if (inner) blocks.push(inner.split('\n').map((line) => '> ' + line).join('\n'));
      return;
    }
    if (tag === 'UL' || tag === 'OL') {
      const ordered = tag === 'OL';
      let index = 1;
      child.childNodes.forEach((li) => {
        if (li.nodeType !== 1 || li.tagName !== 'LI') return;
        const marker = ordered ? `${index++}. ` : '- ';
        const inner = blockMd(li) || inlineMd(li).trim();
        if (!inner) return;
        blocks.push(marker + inner.replace(/\n/g, '\n  '));
      });
      return;
    }
    if (tag === 'BR') return;

    const inner = blockMd(child);
    if (inner.trim()) blocks.push(inner);
  });
  return blocks.join('\n\n');
}

export function htmlToMarkdown(html) {
  const body = parse(html).body;
  return blockMd(body)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* ---------------- 下载 ---------------- */

function safeFileName(title) {
  const base = (title || '无标题文档').replace(/[\\/:*?"<>|\r\n]/g, '_').trim();
  return base.slice(0, 80) || '无标题文档';
}

export function downloadNote({ title, format, html }) {
  const name = safeFileName(title);
  const isMd = format === 'md';
  const content = isMd ? htmlToMarkdown(html) : htmlToText(html);
  if (!content) return false;

  // txt 加 BOM，避免 Windows 记事本把中文识别成乱码
  const payload = isMd ? content : '\ufeff' + content;
  const blob = new Blob([payload], {
    type: isMd ? 'text/markdown;charset=utf-8' : 'text/plain;charset=utf-8'
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name + (isMd ? '.md' : '.txt');
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}
