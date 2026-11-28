const DB_NAME = 'apple-notes-db';
const DB_VERSION = 2;
const NODES = 'nodes';
const IMAGES = 'images';

let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      reject(err);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(NODES)) {
        const store = db.createObjectStore(NODES, { keyPath: 'id' });
        store.createIndex('parentId', 'parentId', { unique: false });
      }
      // v1 → v2：新增图片库，历史笔记不受影响
      if (!db.objectStoreNames.contains(IMAGES)) {
        db.createObjectStore(IMAGES, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB 打开失败'));
  });
  return dbPromise;
}

export async function getAllNodes() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(NODES, 'readonly').objectStore(NODES).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

export async function putNode(node) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(NODES, 'readwrite');
    tx.objectStore(NODES).put(node);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function deleteNodes(ids) {
  if (!ids.length) return;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(NODES, 'readwrite');
    const store = tx.objectStore(NODES);
    ids.forEach((id) => store.delete(id));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function putImage(record) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IMAGES, 'readwrite');
    tx.objectStore(IMAGES).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getImage(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(IMAGES, 'readonly').objectStore(IMAGES).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function deleteImages(ids) {
  if (!ids.length) return;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IMAGES, 'readwrite');
    const store = tx.objectStore(IMAGES);
    ids.forEach((id) => store.delete(id));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
