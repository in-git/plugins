import fs from 'fs';
import crypto from 'crypto';
import { CHUNKS_ROOT, INDEX_FILE, TRANSFER_TTL_MS } from './config.js';
import type { DeviceEntry, TransferRecord } from './types.js';
import { deriveDisplayCode, isValidId, resolveConfinedPath } from './utils.js';

// Device registry (server-minted IDs + display codes)
export const knownDevices = new Map<string, DeviceEntry>();

// Persistent transfer store
export const transfers = new Map<string, TransferRecord>();
export const codeToId = new Map<string, string>();

export function mintOrGetDevice(existingId?: string | null): DeviceEntry {
  // 优先沿用客户端已有的设备 ID，保证同一设备编码稳定
  const deviceId =
    existingId && isValidId(existingId)
      ? existingId
      : `dev_${crypto.randomBytes(8).toString('hex')}`;
  const existing = knownDevices.get(deviceId);
  if (existing) return existing;
  const entry: DeviceEntry = {
    deviceId,
    displayCode: deriveDisplayCode(deviceId),
    createdAt: Date.now(),
  };
  knownDevices.set(deviceId, entry);
  return entry;
}

function loadTransfersIndex() {
  try {
    if (!fs.existsSync(INDEX_FILE)) return;
    const raw = fs.readFileSync(INDEX_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as TransferRecord[];
    const now = Date.now();
    for (const item of parsed) {
      if (item && item.id && item.expiresAt > now) {
        transfers.set(item.id, item);
        if (item.pickupCode) {
          codeToId.set(item.pickupCode, item.id);
        }
      }
    }
  } catch (err) {
    console.error('Failed to load transfers index:', err);
  }
}

let saveTimer: NodeJS.Timeout | null = null;
export function scheduleSaveIndex() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const list = Array.from(transfers.values());
      fs.writeFileSync(INDEX_FILE, JSON.stringify(list, null, 2), 'utf-8');
    } catch (err) {
      console.error('Failed to persist transfers index:', err);
    }
  }, 200);
}

export function generateUniquePickupCode(): string {
  for (let i = 0; i < 50; i++) {
    const code = crypto.randomInt(100000, 1000000).toString();
    if (!codeToId.has(code)) return code;
  }
  return crypto.randomInt(100000, 1000000).toString();
}

export function removeTransferData(record: TransferRecord) {
  transfers.delete(record.id);
  if (record.pickupCode && codeToId.get(record.pickupCode) === record.id) {
    codeToId.delete(record.pickupCode);
  }
  if (record.kind === 'file') {
    try {
      const dir = resolveConfinedPath(CHUNKS_ROOT, record.id);
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch {
      // ignore cleanup errors
    }
  }
  scheduleSaveIndex();
}

export function cleanupExpiredTransfers() {
  const now = Date.now();
  for (const record of transfers.values()) {
    if (record.expiresAt <= now) {
      removeTransferData(record);
    }
  }
}

export function toPublicTransferSummary(record: TransferRecord) {
  return {
    id: record.id,
    pickupCode: record.pickupCode,
    kind: record.kind,
    status: record.status,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    downloadCount: record.downloadCount,
    maxDownloads: record.maxDownloads,
    senderDeviceName: record.senderDeviceName,
    encryption: record.encryption,
    fileName: record.fileName,
    mimeType: record.mimeType,
    fileSize: record.fileSize,
    chunkSize: record.chunkSize,
    totalChunks: record.totalChunks,
    uploadedChunksCount: record.uploadedChunks?.length ?? 0,
    textContent: record.kind === 'text' ? record.textContent : undefined,
    textByteLength: record.textByteLength,
  };
}

// Kick off at module load
loadTransfersIndex();
setInterval(cleanupExpiredTransfers, 60 * 60 * 1000);
// keep TRANSFER_TTL_MS referenced to silence unused import when building
void TRANSFER_TTL_MS;
