import path from 'path';
import fs from 'fs';

export const PORT = 4782;
export const UPLOADS_DIR = path.resolve(process.cwd(), 'uploads');
export const CHUNKS_ROOT = path.resolve(UPLOADS_DIR, 'chunks');
export const INDEX_FILE = path.resolve(UPLOADS_DIR, 'transfers.json');

export const DEFAULT_CHUNK_SIZE = 1024 * 1024; // 1 MB
export const MAX_CHUNK_SIZE = 8 * 1024 * 1024; // 8 MB
export const TRANSFER_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export const OFFLINE_NOTIFY_DEDUPE_MS = 3000;

export const HEARTBEAT_INTERVAL_MS = 5_000;
export const HEARTBEAT_TIMEOUT_MS = 12_000;

// Ensure chunk root exists at import time
fs.mkdirSync(CHUNKS_ROOT, { recursive: true });
