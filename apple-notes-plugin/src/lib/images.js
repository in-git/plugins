import { putImage, getImage } from '../db.js';
import { uid } from './utils.js';

// blob: URL → IndexedDB 图片 id，保存时把临时地址换回 idb://<id>
const urlToId = new Map();

export function createBlobUrl(id, blob) {
  const url = URL.createObjectURL(blob);
  urlToId.set(url, id);
  return url;
}

/** 用户上传的图片直接写入本地 IndexedDB，不经过任何服务器 */
export async function saveUploadedFile(file) {
  const id = uid();
  await putImage({
    id,
    blob: file,
    name: file.name || 'image',
    type: file.type || 'application/octet-stream',
    size: file.size || 0,
    createdAt: Date.now()
  });
  return id;
}

export const editorUploader = {
  accept: { image: 'image/*' },
  maxSize: { image: 20 * 1024 * 1024 },
  async upload(file) {
    const id = await saveUploadedFile(file);
    return {
      url: createBlobUrl(id, file),
      name: file.name,
      mimeType: file.type,
      size: file.size
    };
  }
};

/** 入库前：把本次会话的 blob 地址换成 idb://id，保证刷新后仍能复原 */
export function dehydrateHtml(html) {
  let out = html || '';
  urlToId.forEach((id, url) => {
    if (out.indexOf(url) >= 0) out = out.split(url).join('idb://' + id);
  });
  return out;
}

/** 展示前：从本地数据库取回图片，生成新的 blob 地址 */
export async function hydrateHtml(html) {
  const source = html || '';
  const ids = (source.match(/idb:\/\/([A-Za-z0-9-]+)/g) || []).map((s) => s.slice(6));
  if (!ids.length) return source;

  const unique = Array.from(new Set(ids));
  const resolved = new Map();
  await Promise.all(
    unique.map(async (id) => {
      try {
        const record = await getImage(id);
        if (record && record.blob) resolved.set(id, createBlobUrl(id, record.blob));
      } catch (err) {
        console.warn('[笔记] 图片读取失败', id, err);
      }
    })
  );

  return source.replace(/idb:\/\/([A-Za-z0-9-]+)/g, (match, id) => resolved.get(id) || match);
}
