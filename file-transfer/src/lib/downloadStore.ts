import type { TransferSummary } from '../types/transfer';

const DB_NAME = 'airvault_downloads';
const DB_VERSION = 1;
const STORE = 'chunks';
const PENDING_KEY = 'airvault_pending_download';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB 不可用'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'key' });
        store.createIndex('transferId', 'transferId', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

interface StoredChunk {
  key: string;
  transferId: string;
  index: number;
  buffer: ArrayBuffer;
}

/** 持久化已下载（已解密）的分片，供刷新后续传 */
export async function saveDownloadChunk(
  transferId: string,
  index: number,
  buffer: ArrayBuffer
): Promise<void> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const record: StoredChunk = { key: `${transferId}#${index}`, transferId, index, buffer };
      const req = tx.objectStore(STORE).put(record);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch {
    // 配额不足等异常不影响内存中的下载
  }
}

/** 读取某次传输已落盘的分片 */
export async function loadDownloadChunks(transferId: string): Promise<Map<number, ArrayBuffer>> {
  const map = new Map<number, ArrayBuffer>();
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const idx = tx.objectStore(STORE).index('transferId');
      const req = idx.openCursor(IDBKeyRange.only(transferId));
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          const v = cursor.value as StoredChunk;
          map.set(v.index, v.buffer);
          cursor.continue();
        } else {
          resolve();
        }
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    // ignore
  }
  return map;
}

export async function clearDownloadChunks(transferId: string): Promise<void> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const idx = tx.objectStore(STORE).index('transferId');
      const req = idx.openCursor(IDBKeyRange.only(transferId));
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        } else {
          resolve();
        }
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    // ignore
  }
}

export interface PendingDownloadTask {
  transfer: TransferSummary;
  downloadedChunks: number;
}

export function loadPendingDownload(): PendingDownloadTask | null {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    return raw ? (JSON.parse(raw) as PendingDownloadTask) : null;
  } catch {
    return null;
  }
}

export function savePendingDownload(task: PendingDownloadTask): void {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(task));
  } catch {
    // ignore
  }
}

export function clearPendingDownload(): void {
  try {
    localStorage.removeItem(PENDING_KEY);
  } catch {
    // ignore
  }
}
