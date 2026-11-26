import express, { Request, Response } from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';

const PORT = 4782;
const UPLOADS_DIR = path.resolve(process.cwd(), 'uploads');
const CHUNKS_ROOT = path.resolve(UPLOADS_DIR, 'chunks');
const INDEX_FILE = path.resolve(UPLOADS_DIR, 'transfers.json');
const DEFAULT_CHUNK_SIZE = 1024 * 1024; // 1 MB chunks for responsive progress & resume
const MAX_CHUNK_SIZE = 8 * 1024 * 1024; // 8 MB max per chunk
const TRANSFER_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

fs.mkdirSync(CHUNKS_ROOT, { recursive: true });

export interface EncryptedMeta {
  enabled: boolean;
  salt?: string;
  baseIv?: string;
  iv?: string;
  algorithm?: 'AES-256-GCM';
}

export interface TransferRecord {
  id: string;
  pickupCode: string;
  kind: 'file' | 'text';
  ownerToken: string;
  senderDeviceId?: string;
  senderDeviceName?: string;
  targetDeviceId?: string;
  status: 'pending' | 'uploading' | 'ready';
  createdAt: number;
  expiresAt: number;
  downloadCount: number;
  maxDownloads: number | null;
  encryption: EncryptedMeta;
  // File fields
  fileName?: string;
  mimeType?: string;
  fileSize?: number;
  chunkSize?: number;
  totalChunks?: number;
  uploadedChunks?: number[];
  fingerprint?: string;
  // Text fields
  textContent?: string;
  textByteLength?: number;
}

interface PeerClient {
  ws: WebSocket;
  deviceId: string;
  deviceName: string;
  deviceType: 'desktop' | 'mobile' | 'tablet';
  ip: string;
  subnet: string;
  connectedAt: number;
  lastSeenAt: number;
  rttMs: number;
  pingSentAt?: number;
}

// Device registry (server-minted IDs + display codes)
interface DeviceEntry {
  deviceId: string;
  displayCode: string;
  createdAt: number;
}
const knownDevices = new Map<string, DeviceEntry>();

function resolveConfinedPath(baseDir: string, ...segments: string[]): string {
  const resolved = path.resolve(baseDir, ...segments);
  const normalizedBase = baseDir.endsWith(path.sep) ? baseDir : baseDir + path.sep;
  if (!resolved.startsWith(normalizedBase)) {
    throw new Error('Invalid filesystem path boundary');
  }
  return resolved;
}

function normalizeIp(rawIp: string | undefined): string {
  if (!rawIp) return '127.0.0.1';
  let ip = rawIp.split(',')[0].trim();
  if (ip.startsWith('::ffff:')) {
    ip = ip.slice(7);
  }
  if (ip === '::1') {
    ip = '127.0.0.1';
  }
  return ip;
}

function getSubnetKey(ip: string): string {
  if (ip.includes('.')) {
    const parts = ip.split('.');
    if (parts.length === 4) {
      return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
    }
  }
  if (ip.includes(':')) {
    const groups = ip.split(':').slice(0, 4);
    return `${groups.join(':')}::/64`;
  }
  return ip;
}

function maskIpForDisplay(ip: string): string {
  if (ip === '127.0.0.1') return '127.0.0.1';
  if (ip.includes('.')) {
    const parts = ip.split('.');
    if (parts.length === 4) {
      return `${parts[0]}.${parts[1]}.${parts[2]}.${parts[3]}`;
    }
  }
  return ip;
}

function getRequestIp(req: http.IncomingMessage): string {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) {
    return normalizeIp(xff);
  }
  const realIp = req.headers['x-real-ip'];
  if (typeof realIp === 'string' && realIp.trim()) {
    return normalizeIp(realIp);
  }
  return normalizeIp(req.socket.remoteAddress);
}

function isValidId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{8,64}$/.test(id);
}

function deriveDisplayCode(deviceId: string): string {
  // 根据设备 ID 稳定派生的 6 位人类可读编码（固定不变，不再随机）
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const digest = crypto.createHash('sha256').update(deviceId).digest();
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += alphabet[digest[i] % alphabet.length];
  }
  return code;
}

function mintOrGetDevice(existingId?: string | null): DeviceEntry {
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

function sanitizeFileName(name: string): string {
  const cleaned = path.basename(name).replace(/[\r\n\0]/g, '_').trim();
  return cleaned.slice(0, 200) || 'untitled_file';
}

// Persistent Transfer Store
const transfers = new Map<string, TransferRecord>();
const codeToId = new Map<string, string>();

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
function scheduleSaveIndex() {
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

function generateUniquePickupCode(): string {
  for (let i = 0; i < 50; i++) {
    const code = crypto.randomInt(100000, 1000000).toString();
    if (!codeToId.has(code)) return code;
  }
  return crypto.randomInt(100000, 1000000).toString();
}

function removeTransferData(record: TransferRecord) {
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

function cleanupExpiredTransfers() {
  const now = Date.now();
  for (const record of transfers.values()) {
    if (record.expiresAt <= now) {
      removeTransferData(record);
    }
  }
}

loadTransfersIndex();
setInterval(cleanupExpiredTransfers, 60 * 60 * 1000);

// Active WebSocket peers
const peers = new Map<string, PeerClient>();

function getSameIpPeersFor(ip: string, subnet: string, excludeDeviceId?: string) {
  const result: Array<{
    deviceId: string;
    displayCode: string;
    deviceName: string;
    deviceType: 'desktop' | 'mobile' | 'tablet';
    ip: string;
    sameIp: boolean;
    rttMs: number;
    connectedAt: number;
  }> = [];

  for (const peer of peers.values()) {
    if (peer.ws.readyState !== WebSocket.OPEN) continue;
    if (excludeDeviceId && peer.deviceId === excludeDeviceId) continue;
    const exactIp = peer.ip === ip;
    const sameSubnet = peer.subnet === subnet;
    if (exactIp || sameSubnet) {
      const entry = knownDevices.get(peer.deviceId);
      result.push({
        deviceId: peer.deviceId,
        displayCode: entry?.displayCode || '------',
        deviceName: peer.deviceName,
        deviceType: peer.deviceType,
        ip: maskIpForDisplay(peer.ip),
        sameIp: exactIp,
        rttMs: peer.rttMs,
        connectedAt: peer.connectedAt,
      });
    }
  }

  result.sort((a, b) => {
    if (a.sameIp !== b.sameIp) return a.sameIp ? -1 : 1;
    return a.deviceName.localeCompare(b.deviceName);
  });
  return result;
}

function sendToDevice(deviceId: string | undefined, payload: unknown) {
  if (!deviceId) return;
  const peer = peers.get(deviceId);
  if (peer && peer.ws.readyState === WebSocket.OPEN) {
    peer.ws.send(JSON.stringify(payload));
  }
}

/**
 * 设备离线处理：
 * - 通知传输对端（接收方掉线 → 通知发送方；发送方掉线 → 通知接收方），让对端结束当前传输尝试
 * - 记录保留，供断点续传使用
 * - hard（心跳超时判定为真正掉线）时，主动断开与其 1:1 关联的对端连接
 */
// 同一次“离开/刷新”可能产生多个离线信号（sendBeacon、unregister、socket close），
// 用短时间去重，避免对端收到重复的「对方已离线」提示。
const OFFLINE_NOTIFY_DEDUPE_MS = 3000;
const recentOfflineAt = new Map<string, number>();

function handlePeerGone(deviceId: string, hard: boolean) {
  const now = Date.now();
  // 去重：短时间内的重复离线信号直接忽略（同时也应按需清理，防止 Map 无界增长）
  const last = recentOfflineAt.get(deviceId) ?? 0;
  if (now - last < OFFLINE_NOTIFY_DEDUPE_MS) return;
  recentOfflineAt.set(deviceId, now);
  if (recentOfflineAt.size > 512) {
    for (const [id, ts] of recentOfflineAt) {
      if (now - ts > OFFLINE_NOTIFY_DEDUPE_MS) recentOfflineAt.delete(id);
    }
  }

  const counterparts = new Set<string>();
  for (const record of transfers.values()) {
    const active = record.status === 'pending' || record.status === 'uploading';
    if (!active || record.expiresAt <= now) continue;
    if (record.targetDeviceId === deviceId) {
      sendToDevice(record.senderDeviceId, {
        type: 'transfer:target-offline',
        transferId: record.id,
      });
      if (record.senderDeviceId) counterparts.add(record.senderDeviceId);
    } else if (record.senderDeviceId === deviceId) {
      sendToDevice(record.targetDeviceId, {
        type: 'transfer:sender-offline',
        transferId: record.id,
      });
      if (record.targetDeviceId) counterparts.add(record.targetDeviceId);
    }
  }

  if (!hard) return;

  // 主动断开对端：仅当对端除与掉线设备的关联外没有其它进行中传输时，断开其连接，
  // 避免一个设备掉线导致整网设备被连锁断开。
  for (const cpId of counterparts) {
    if (cpId === deviceId) continue;
    const busier = Array.from(transfers.values()).some(
      (r) =>
        (r.status === 'pending' || r.status === 'uploading') &&
        r.expiresAt > now &&
        ((r.senderDeviceId === cpId && r.targetDeviceId !== deviceId) ||
          (r.targetDeviceId === cpId && r.senderDeviceId !== deviceId))
    );
    if (busier) continue;
    const cp = peers.get(cpId);
    if (!cp) continue;
    peers.delete(cpId);
    try {
      cp.ws.terminate();
    } catch {
      // ignore
    }
    broadcastPeerUpdateToNetwork(cp.ip, cp.subnet);
  }
}

/** 立即移除设备并通知同网段其他设备刷新列表 */
function removePeerImmediately(deviceId: string) {
  const peer = peers.get(deviceId);
  if (!peer) return;
  // 同一次离开会收到多个信号：若刚处理过离线、且当前是刚重连上来的新连接，则不重复移除
  const now = Date.now();
  const last = recentOfflineAt.get(deviceId) ?? 0;
  if (
    now - last < OFFLINE_NOTIFY_DEDUPE_MS &&
    now - peer.connectedAt < OFFLINE_NOTIFY_DEDUPE_MS
  ) {
    return;
  }
  peers.delete(deviceId);
  handlePeerGone(deviceId, false);
  try {
    peer.ws.terminate();
  } catch {
    // ignore
  }
  broadcastPeerUpdateToNetwork(peer.ip, peer.subnet);
}

function broadcastPeerUpdateToNetwork(ip: string, subnet: string) {  for (const peer of peers.values()) {
    if (peer.ws.readyState !== WebSocket.OPEN) continue;
    if (peer.ip === ip || peer.subnet === subnet) {
      const list = getSameIpPeersFor(peer.ip, peer.subnet, peer.deviceId);
      peer.ws.send(
        JSON.stringify({
          type: 'peers:update',
          yourIp: maskIpForDisplay(peer.ip),
          subnet: peer.subnet,
          peers: list,
        })
      );
    }
  }
}

function toPublicTransferSummary(record: TransferRecord) {
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

async function startServer() {
  const app = express();
  app.set('trust proxy', true);

  // Health
  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({ ok: true, timestamp: Date.now() });
  });

  // Device bootstrap — server-mints deviceId + displayCode (idempotent)
  app.get('/api/device/bootstrap', (req: Request, res: Response) => {
    const existingId =
      typeof req.query.deviceId === 'string' && isValidId(req.query.deviceId)
        ? req.query.deviceId
        : undefined;
    const entry = mintOrGetDevice(existingId);
    res.json({
      deviceId: entry.deviceId,
      displayCode: entry.displayCode,
      createdAt: entry.createdAt,
    });
  });

  // Connection test: latency + live peer count + WS info
  app.get('/api/connection-test', (req: Request, res: Response) => {
    const started = Date.now();
    const ip = getRequestIp(req);
    const subnet = getSubnetKey(ip);
    const peerArr = Array.from(peers.values());
    const sameSubnet = peerArr.filter((p) => p.subnet === subnet);
    res.json({
      ok: true,
      timestamp: Date.now(),
      latencyMs: Date.now() - started,
      serverTime: new Date().toISOString(),
      wsClients: peerArr.length,
      sameSubnetPeers: sameSubnet.length,
      yourIp: maskIpForDisplay(ip),
      subnet,
    });
  });

  // Network Info & IP Scan
  app.get('/api/network/info', (req: Request, res: Response) => {
    const ip = getRequestIp(req);
    const subnet = getSubnetKey(ip);
    res.json({
      ip: maskIpForDisplay(ip),
      subnet,
      onlineCount: getSameIpPeersFor(ip, subnet).length,
    });
  });

  app.get('/api/peers/scan', (req: Request, res: Response) => {
    const ip = getRequestIp(req);
    const subnet = getSubnetKey(ip);
    const excludeId = typeof req.query.deviceId === 'string' ? req.query.deviceId : undefined;
    const found = getSameIpPeersFor(ip, subnet, excludeId);
    res.json({
      yourIp: maskIpForDisplay(ip),
      subnet,
      scannedAt: Date.now(),
      peers: found,
    });
  });

  // JSON body parser for metadata & text routes
  const jsonParser = express.json({ limit: '4mb' });

  // 页面离开时的主动下线（sendBeacon 调用），立即移除设备
  app.post('/api/device/offline', jsonParser, (req: Request, res: Response) => {
    const deviceId = req.body?.deviceId;
    if (typeof deviceId === 'string' && isValidId(deviceId)) {
      removePeerImmediately(deviceId);
    }
    res.status(204).end();
  });

  // Initialize or Resume chunked file transfer
  app.post('/api/transfers/init', jsonParser, (req: Request, res: Response) => {
    const {
      fileName,
      mimeType,
      fileSize,
      chunkSize: requestedChunkSize,
      fingerprint,
      encryption,
      resumeTransferId,
      ownerToken: providedOwnerToken,
      senderDeviceId,
      senderDeviceName,
      targetDeviceId,
      maxDownloads,
    } = req.body ?? {};

    if (typeof fileName !== 'string' || !fileName.trim()) {
      res.status(400).json({ error: '文件名无效' });
      return;
    }
    if (typeof fileSize !== 'number' || !Number.isFinite(fileSize) || fileSize < 0) {
      res.status(400).json({ error: '文件大小无效' });
      return;
    }

    // Attempt resumable match if resumeTransferId + valid ownerToken provided
    if (
      typeof resumeTransferId === 'string' &&
      isValidId(resumeTransferId) &&
      typeof providedOwnerToken === 'string'
    ) {
      const existing = transfers.get(resumeTransferId);
      if (
        existing &&
        existing.kind === 'file' &&
        existing.ownerToken === providedOwnerToken &&
        existing.fileSize === fileSize &&
        (!fingerprint || existing.fingerprint === fingerprint)
      ) {
        // Verify chunks present on disk
        const chunkDir = resolveConfinedPath(CHUNKS_ROOT, existing.id);
        const verifiedChunks: number[] = [];
        const total = existing.totalChunks ?? 0;
        for (let i = 0; i < total; i++) {
          const chunkPath = resolveConfinedPath(chunkDir, `${i}.part`);
          if (fs.existsSync(chunkPath)) {
            verifiedChunks.push(i);
          }
        }
        existing.uploadedChunks = verifiedChunks;
        if (targetDeviceId) existing.targetDeviceId = String(targetDeviceId);
        scheduleSaveIndex();

        // 断点续传：发送方继续上传 → 通知接收方重新打开进度界面
        if (existing.targetDeviceId) {
          sendToDevice(existing.targetDeviceId, {
            type: 'transfer:resumed',
            transfer: toPublicTransferSummary(existing),
          });
        }

        res.json({
          resumed: true,
          transferId: existing.id,
          pickupCode: existing.pickupCode,
          ownerToken: existing.ownerToken,
          chunkSize: existing.chunkSize,
          totalChunks: existing.totalChunks,
          uploadedChunks: verifiedChunks,
          status: existing.status,
          encryption: existing.encryption,
        });
        return;
      }
    }

    const chunkSize =
      typeof requestedChunkSize === 'number' &&
      requestedChunkSize >= 64 * 1024 &&
      requestedChunkSize <= MAX_CHUNK_SIZE
        ? Math.floor(requestedChunkSize)
        : DEFAULT_CHUNK_SIZE;

    const totalChunks = Math.max(1, Math.ceil(fileSize / chunkSize));
    const transferId = `tr_${crypto.randomBytes(12).toString('hex')}`;
    const ownerToken = crypto.randomBytes(24).toString('hex');
    const pickupCode = generateUniquePickupCode();

    const chunkDir = resolveConfinedPath(CHUNKS_ROOT, transferId);
    fs.mkdirSync(chunkDir, { recursive: true });

    const safeEncryption: EncryptedMeta =
      encryption && encryption.enabled
        ? {
            enabled: true,
            algorithm: 'AES-256-GCM',
            salt: typeof encryption.salt === 'string' ? encryption.salt : undefined,
            baseIv: typeof encryption.baseIv === 'string' ? encryption.baseIv : undefined,
          }
        : { enabled: false };

    const record: TransferRecord = {
      id: transferId,
      pickupCode,
      kind: 'file',
      ownerToken,
      senderDeviceId: typeof senderDeviceId === 'string' ? senderDeviceId : undefined,
      senderDeviceName: typeof senderDeviceName === 'string' ? senderDeviceName.slice(0, 64) : '未知设备',
      targetDeviceId: typeof targetDeviceId === 'string' ? targetDeviceId : undefined,
      // 局域网直传：需接收方同意后才开始上传
      status: typeof targetDeviceId === 'string' ? 'pending' : 'uploading',
      createdAt: Date.now(),
      expiresAt: Date.now() + TRANSFER_TTL_MS,
      downloadCount: 0,
      maxDownloads: typeof maxDownloads === 'number' && maxDownloads > 0 ? Math.floor(maxDownloads) : null,
      encryption: safeEncryption,
      fileName: sanitizeFileName(fileName),
      mimeType: typeof mimeType === 'string' && mimeType ? mimeType.slice(0, 128) : 'application/octet-stream',
      fileSize,
      chunkSize,
      totalChunks,
      uploadedChunks: [],
      fingerprint: typeof fingerprint === 'string' ? fingerprint.slice(0, 128) : undefined,
    };

    transfers.set(transferId, record);
    codeToId.set(pickupCode, transferId);
    scheduleSaveIndex();

    if (record.targetDeviceId) {
      sendToDevice(record.targetDeviceId, {
        type: 'transfer:incoming',
        transfer: toPublicTransferSummary(record),
      });
    }

    res.status(201).json({
      resumed: false,
      transferId,
      pickupCode,
      ownerToken,
      chunkSize,
      totalChunks,
      uploadedChunks: [],
      status: record.status,
      encryption: safeEncryption,
    });
  });

  // Upload a binary chunk
  app.put(
    '/api/transfers/:id/chunk/:index',
    express.raw({ type: 'application/octet-stream', limit: '16mb' }),
    (req: Request, res: Response) => {
      const id = String(req.params.id ?? '');
      const indexStr = String(req.params.index ?? '');
      if (!isValidId(id)) {
        res.status(400).json({ error: '无效的传输 ID' });
        return;
      }

      const record = transfers.get(id);
      if (!record || record.kind !== 'file') {
        res.status(404).json({ error: '传输任务不存在' });
        return;
      }

      const token = req.headers['x-owner-token'];
      if (token !== record.ownerToken) {
        res.status(403).json({ error: '无权上传此任务分片' });
        return;
      }

      const chunkIndex = Number(indexStr);
      const totalChunks = record.totalChunks ?? 0;
      if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= totalChunks) {
        res.status(400).json({ error: '分片索引越界' });
        return;
      }

      const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (buffer.length === 0 && (record.fileSize ?? 0) > 0) {
        res.status(400).json({ error: '分片数据为空' });
        return;
      }

      const chunkDir = resolveConfinedPath(CHUNKS_ROOT, record.id);
      fs.mkdirSync(chunkDir, { recursive: true });
      const chunkPath = resolveConfinedPath(chunkDir, `${chunkIndex}.part`);
      fs.writeFileSync(chunkPath, buffer);

      const uploadedSet = new Set(record.uploadedChunks ?? []);
      uploadedSet.add(chunkIndex);
      record.uploadedChunks = Array.from(uploadedSet).sort((a, b) => a - b);
      scheduleSaveIndex();

      const progress = totalChunks > 0 ? Math.round((record.uploadedChunks.length / totalChunks) * 100) : 100;
      if (record.targetDeviceId) {
        sendToDevice(record.targetDeviceId, {
          type: 'transfer:progress',
          transferId: record.id,
          uploadedChunksCount: record.uploadedChunks.length,
          totalChunks,
          progress,
        });
      }

      res.json({
        ok: true,
        chunkIndex,
        uploadedChunksCount: record.uploadedChunks.length,
        totalChunks,
      });
    }
  );

  // Mark chunked file upload complete
  app.post('/api/transfers/:id/complete', jsonParser, (req: Request, res: Response) => {
    const id = String(req.params.id ?? '');
    if (!isValidId(id)) {
      res.status(400).json({ error: '无效的传输 ID' });
      return;
    }

    const record = transfers.get(id);
    if (!record || record.kind !== 'file') {
      res.status(404).json({ error: '传输任务不存在' });
      return;
    }

    const token = req.headers['x-owner-token'];
    if (token !== record.ownerToken) {
      res.status(403).json({ error: '无权完成此任务' });
      return;
    }

    const total = record.totalChunks ?? 0;
    const chunkDir = resolveConfinedPath(CHUNKS_ROOT, record.id);
    const missing: number[] = [];
    for (let i = 0; i < total; i++) {
      const p = resolveConfinedPath(chunkDir, `${i}.part`);
      if (!fs.existsSync(p)) {
        missing.push(i);
      }
    }

    if (missing.length > 0) {
      res.status(409).json({
        error: '仍有分片未上传完成',
        missingChunks: missing,
      });
      return;
    }

    record.status = 'ready';
    scheduleSaveIndex();

    if (record.targetDeviceId) {
      sendToDevice(record.targetDeviceId, {
        type: 'transfer:ready',
        transfer: toPublicTransferSummary(record),
      });
    }

    res.json({
      ok: true,
      transfer: toPublicTransferSummary(record),
    });
  });

  // Create Text transfer
  app.post('/api/transfers/text', jsonParser, (req: Request, res: Response) => {
    const {
      textContent,
      encryption,
      senderDeviceId,
      senderDeviceName,
      targetDeviceId,
      maxDownloads,
    } = req.body ?? {};

    if (typeof textContent !== 'string' || !textContent.trim()) {
      res.status(400).json({ error: '文本内容不能为空' });
      return;
    }
    if (Buffer.byteLength(textContent, 'utf-8') > 2 * 1024 * 1024) {
      res.status(400).json({ error: '文本长度超出 2MB 限制' });
      return;
    }

    const transferId = `tx_${crypto.randomBytes(12).toString('hex')}`;
    const ownerToken = crypto.randomBytes(24).toString('hex');
    const pickupCode = generateUniquePickupCode();

    const safeEncryption: EncryptedMeta =
      encryption && encryption.enabled
        ? {
            enabled: true,
            algorithm: 'AES-256-GCM',
            salt: typeof encryption.salt === 'string' ? encryption.salt : undefined,
            iv: typeof encryption.iv === 'string' ? encryption.iv : undefined,
          }
        : { enabled: false };

    const record: TransferRecord = {
      id: transferId,
      pickupCode,
      kind: 'text',
      ownerToken,
      senderDeviceId: typeof senderDeviceId === 'string' ? senderDeviceId : undefined,
      senderDeviceName: typeof senderDeviceName === 'string' ? senderDeviceName.slice(0, 64) : '未知设备',
      targetDeviceId: typeof targetDeviceId === 'string' ? targetDeviceId : undefined,
      status: 'ready',
      createdAt: Date.now(),
      expiresAt: Date.now() + TRANSFER_TTL_MS,
      downloadCount: 0,
      maxDownloads: typeof maxDownloads === 'number' && maxDownloads > 0 ? Math.floor(maxDownloads) : null,
      encryption: safeEncryption,
      textContent,
      textByteLength: Buffer.byteLength(textContent, 'utf-8'),
    };

    transfers.set(transferId, record);
    codeToId.set(pickupCode, transferId);
    scheduleSaveIndex();

    if (record.targetDeviceId) {
      sendToDevice(record.targetDeviceId, {
        type: 'transfer:ready',
        transfer: toPublicTransferSummary(record),
      });
    }

    res.status(201).json({
      ok: true,
      ownerToken,
      transfer: toPublicTransferSummary(record),
    });
  });

  // Lookup transfer by 6-digit pickup code
  app.get('/api/transfers/code/:code', (req: Request, res: Response) => {
    const code = String(req.params.code ?? '').trim();
    if (!/^[A-Z0-9]{6}$/i.test(code)) {
      res.status(400).json({ error: '取件码必须为 6 位数字或字母' });
      return;
    }

    const id = codeToId.get(code);
    if (!id) {
      res.status(404).json({ error: '取件码无效或已过期' });
      return;
    }

    const record = transfers.get(id);
    if (!record || record.expiresAt <= Date.now()) {
      if (record) removeTransferData(record);
      res.status(404).json({ error: '取件码无效或已过期' });
      return;
    }

    res.json({ transfer: toPublicTransferSummary(record) });
  });

  // Get transfer status by ID
  app.get('/api/transfers/:id/status', (req: Request, res: Response) => {
    const id = String(req.params.id ?? '');
    if (!isValidId(id)) {
      res.status(400).json({ error: '无效的传输 ID' });
      return;
    }
    const record = transfers.get(id);
    if (!record || record.expiresAt <= Date.now()) {
      res.status(404).json({ error: '传输任务不存在或已过期' });
      return;
    }
    res.json({
      transfer: toPublicTransferSummary(record),
      uploadedChunks: record.uploadedChunks ?? [],
    });
  });

  // Download individual chunk (used for encrypted client-side AES-256-GCM decryption & resumable download)
  app.get('/api/transfers/:id/chunk/:index', (req: Request, res: Response) => {
    const id = String(req.params.id ?? '');
    const index = Number(req.params.index);
    if (!isValidId(id)) {
      res.status(400).json({ error: '无效的传输 ID' });
      return;
    }
    const record = transfers.get(id);
    if (!record || record.kind !== 'file' || record.status !== 'ready') {
      res.status(404).json({ error: '文件尚未就绪或不存在' });
      return;
    }
    const total = record.totalChunks ?? 0;
    if (!Number.isInteger(index) || index < 0 || index >= total) {
      res.status(400).json({ error: '分片索引无效' });
      return;
    }

    const chunkPath = resolveConfinedPath(CHUNKS_ROOT, record.id, `${index}.part`);
    if (!fs.existsSync(chunkPath)) {
      res.status(404).json({ error: '分片数据缺失' });
      return;
    }

    if (index === total - 1) {
      record.downloadCount += 1;
      scheduleSaveIndex();
    }

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    fs.createReadStream(chunkPath).pipe(res);
  });

  // Stream full unencrypted file download (supports QR code 1-tap download)
  app.get('/api/transfers/:id/download', (req: Request, res: Response) => {
    const id = String(req.params.id ?? '');
    if (!isValidId(id)) {
      res.status(400).json({ error: '无效的传输 ID' });
      return;
    }
    const record = transfers.get(id);
    if (!record || record.kind !== 'file' || record.status !== 'ready') {
      res.status(404).json({ error: '文件不存在或未完成上传' });
      return;
    }
    if (record.encryption.enabled) {
      res.status(400).json({ error: '加密文件需通过客户端解密下载' });
      return;
    }

    const totalChunks = record.totalChunks ?? 0;
    const chunkDir = resolveConfinedPath(CHUNKS_ROOT, record.id);
    const totalSize = record.fileSize ?? 0;
    const safeName = sanitizeFileName(record.fileName ?? 'download');
    const encodedName = encodeURIComponent(safeName);

    res.setHeader('Content-Type', record.mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="download"; filename*=UTF-8''${encodedName}`);
    res.setHeader('Content-Length', String(totalSize));
    res.setHeader('X-Content-Type-Options', 'nosniff');

    record.downloadCount += 1;
    scheduleSaveIndex();

    let currentIdx = 0;
    let destroyed = false;
    req.on('close', () => {
      destroyed = true;
    });

    const pipeNextChunk = () => {
      if (destroyed) return;
      if (currentIdx >= totalChunks) {
        res.end();
        return;
      }
      const chunkPath = resolveConfinedPath(chunkDir, `${currentIdx}.part`);
      if (!fs.existsSync(chunkPath)) {
        res.destroy(new Error('Missing chunk'));
        return;
      }
      currentIdx += 1;
      const stream = fs.createReadStream(chunkPath);
      stream.on('error', (err) => {
        res.destroy(err);
      });
      stream.on('end', () => {
        pipeNextChunk();
      });
      stream.pipe(res, { end: false });
    };

    pipeNextChunk();
  });

  // Mark text transfer as copied/downloaded
  app.post('/api/transfers/:id/ack', (req: Request, res: Response) => {
    const id = String(req.params.id ?? '');
    if (!isValidId(id)) {
      res.status(400).json({ error: '无效的传输 ID' });
      return;
    }
    const record = transfers.get(id);
    if (!record) {
      res.status(404).json({ error: '记录不存在' });
      return;
    }
    record.downloadCount += 1;
    // 取件完成后销毁：使取件码失效并删除对应文件，同时提示发送方「对方已成功接收」
    const consume = req.query.consume === '1' || req.query.consume === 'true';
    if (consume) {
      sendToDevice(record.senderDeviceId, {
        type: 'transfer:downloaded',
        transferId: record.id,
        fileName: record.kind === 'file' ? record.fileName : undefined,
      });
      removeTransferData(record);
      res.json({ ok: true, consumed: true });
      return;
    }
    scheduleSaveIndex();
    res.json({ ok: true, downloadCount: record.downloadCount });
  });

  // Cancel / Delete transfer (owner only)
  app.delete('/api/transfers/:id', (req: Request, res: Response) => {
    const id = String(req.params.id ?? '');
    if (!isValidId(id)) {
      res.status(400).json({ error: '无效的传输 ID' });
      return;
    }
    const record = transfers.get(id);
    if (!record) {
      res.status(404).json({ error: '传输任务不存在' });
      return;
    }
    const token = req.headers['x-owner-token'];
    if (token !== record.ownerToken) {
      res.status(403).json({ error: '无权删除此传输任务' });
      return;
    }
    removeTransferData(record);
    res.json({ ok: true });
  });

  // Vite dev middleware or static dist serving
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.resolve(distDir, 'index.html'));
    });
  }

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
    const ip = getRequestIp(req);
    const subnet = getSubnetKey(ip);
    let registeredDeviceId: string | null = null;

    ws.on('pong', () => {
      if (!registeredDeviceId) return;
      const peer = peers.get(registeredDeviceId);
      if (peer) {
        if (peer.pingSentAt) {
          peer.rttMs = Math.max(1, Date.now() - peer.pingSentAt);
        }
        peer.lastSeenAt = Date.now();
      }
    });

    ws.on('message', (raw) => {
      // Any traffic from a registered device counts as a heartbeat.
      if (registeredDeviceId) {
        const peer = peers.get(registeredDeviceId);
        if (peer) peer.lastSeenAt = Date.now();
      }
      try {
        const data = JSON.parse(raw.toString());
        if (!data || typeof data !== 'object') return;

        if (data.type === 'device:register') {
          const devId =
            typeof data.deviceId === 'string' && isValidId(data.deviceId)
              ? data.deviceId
              : `dev_${crypto.randomBytes(6).toString('hex')}`;
          const devName =
            typeof data.deviceName === 'string' && data.deviceName.trim()
              ? data.deviceName.trim().slice(0, 48)
              : '我的设备';
          const devType =
            data.deviceType === 'mobile' || data.deviceType === 'tablet' ? data.deviceType : 'desktop';

          registeredDeviceId = devId;
          // Ensure this deviceId has a knownDevices entry (may already exist from bootstrap)
          if (!knownDevices.has(devId)) mintOrGetDevice(devId);
          const prevPeer = peers.get(devId);
          peers.set(devId, {
            ws,
            deviceId: devId,
            deviceName: devName,
            deviceType: devType,
            ip,
            subnet,
            connectedAt: Date.now(),
            lastSeenAt: Date.now(),
            rttMs: 1,
          });
          // 同一设备旧连接仍在：先替换为新连接再终止旧 socket，
          // 避免旧连接变成僵尸（旧 socket 的 close 因 ws 不匹配而不会误删新连接）。
          if (prevPeer && prevPeer.ws !== ws) {
            try {
              prevPeer.ws.terminate();
            } catch {
              // ignore
            }
          }

          ws.send(
            JSON.stringify({
              type: 'device:registered',
              deviceId: devId,
              yourIp: maskIpForDisplay(ip),
              subnet,
              peers: getSameIpPeersFor(ip, subnet, devId),
            })
          );

          broadcastPeerUpdateToNetwork(ip, subnet);

          // 设备（重新）上线：把仍在断点续传中的传输推给接收方，便于其重新打开进度界面
          for (const record of transfers.values()) {
            if (
              record.targetDeviceId === devId &&
              record.status === 'uploading' &&
              (record.uploadedChunks?.length ?? 0) > 0 &&
              record.expiresAt > Date.now() &&
              // 发送方需在线，避免发送方已离线时仍弹出一个无法继续的进度界面
              !!record.senderDeviceId &&
              peers.has(record.senderDeviceId)
            ) {
              sendToDevice(devId, {
                type: 'transfer:resumed',
                transfer: toPublicTransferSummary(record),
              });
            }
          }
        } else if (data.type === 'scan:request') {
          // Ping all peers in same IP/subnet to refresh real RTT
          for (const peer of peers.values()) {
            if (peer.ws.readyState === WebSocket.OPEN && (peer.ip === ip || peer.subnet === subnet)) {
              peer.pingSentAt = Date.now();
              try {
                peer.ws.ping();
              } catch {
                // ignore
              }
            }
          }

          setTimeout(() => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(
                JSON.stringify({
                  type: 'scan:results',
                  yourIp: maskIpForDisplay(ip),
                  subnet,
                  scannedAt: Date.now(),
                  peers: getSameIpPeersFor(ip, subnet, registeredDeviceId ?? undefined),
                })
              );
            }
          }, 180);
        } else if (data.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
        } else if (data.type === 'device:unregister') {
          // 页面离开时主动下线，立即从设备列表移除
          if (registeredDeviceId) {
            removePeerImmediately(registeredDeviceId);
            registeredDeviceId = null;
          }
        } else if (data.type === 'transfer:decline' && typeof data.transferId === 'string') {
          // 接收方拒绝/关闭接收 → 通知发送方取消传输
          const record = transfers.get(data.transferId);
          if (record && record.targetDeviceId === registeredDeviceId) {
            sendToDevice(record.senderDeviceId, {
              type: 'transfer:declined',
              transferId: record.id,
              pickupCode: record.pickupCode,
            });
          }
        } else if (data.type === 'transfer:accept' && typeof data.transferId === 'string') {
          // 接收方接受 → 回复发送方，便于其用 toast 提示
          const record = transfers.get(data.transferId);
          if (record && record.targetDeviceId === registeredDeviceId) {
            if (record.status === 'pending') {
              // 同意后才允许上传
              record.status = 'uploading';
              scheduleSaveIndex();
            }
            sendToDevice(record.senderDeviceId, {
              type: 'transfer:accepted',
              transferId: record.id,
            });
          }
        } else if (data.type === 'transfer:close' && typeof data.transferId === 'string') {
          // 接收方关闭接收界面 → 告知发送方
          const record = transfers.get(data.transferId);
          if (record && record.targetDeviceId === registeredDeviceId) {
            sendToDevice(record.senderDeviceId, {
              type: 'transfer:closed',
              transferId: record.id,
            });
          }
        } else if (data.type === 'transfer:downloaded' && typeof data.transferId === 'string') {
          // 接收方已点击下载 → 通知发送方「对方已成功接收」
          const record = transfers.get(data.transferId);
          if (record && record.targetDeviceId === registeredDeviceId) {
            sendToDevice(record.senderDeviceId, {
              type: 'transfer:downloaded',
              transferId: record.id,
              fileName: record.kind === 'file' ? record.fileName : undefined,
            });
          }
        }
      } catch {
        // ignore malformed ws message
      }
    });

    ws.on('close', () => {
      if (registeredDeviceId) {
        const existing = peers.get(registeredDeviceId);
        if (existing && existing.ws === ws) {
          peers.delete(registeredDeviceId);
          handlePeerGone(registeredDeviceId, false);
          broadcastPeerUpdateToNetwork(ip, subnet);
        }
      }
    });

    ws.on('error', (err) => {
      // Don't crash the process on per-socket errors
      console.warn(`[ws] socket error from ${deviceId || '?'}: ${err?.message || err}`);
    });
  });

  wss.on('error', (err) => {
    console.error(`[wss] fatal error: ${err?.message || err}`);
  });

  // ---------------------------------------------------------------------------
  // Heartbeat — devices that close the page / lose network may leave a dead
  // socket open; prune them so the peer list stays accurate.
  // ---------------------------------------------------------------------------
  const HEARTBEAT_INTERVAL_MS = 5_000;
  // 间隔 5s，连续 2 次没响应（10s）即判定离线
  const HEARTBEAT_TIMEOUT_MS = 12_000;

  const heartbeatTimer = setInterval(() => {
    const now = Date.now();
    for (const peer of peers.values()) {
      if (now - peer.lastSeenAt > HEARTBEAT_TIMEOUT_MS) {
        console.warn(`[ws] peer ${peer.deviceId} (${peer.ip}) timed out — dropping`);
        // 先从 peers 移除，close 事件里因 existing 为空不会重复处理
        peers.delete(peer.deviceId);
        handlePeerGone(peer.deviceId, true);
        broadcastPeerUpdateToNetwork(peer.ip, peer.subnet);
        try {
          peer.ws.terminate();
        } catch {
          // ignore
        }
        continue;
      }
      if (peer.ws.readyState === WebSocket.OPEN) {
        peer.pingSentAt = now;
        try {
          peer.ws.ping();
        } catch {
          // ignore
        }
      }
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref();

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[server] port ${PORT} already in use — exiting`);
      process.exit(1);
    } else {
      console.error(`[server] error: ${err?.message || err}`);
    }
  });

  process.on('uncaughtException', (err) => {
    console.error(`[process] uncaughtException: ${err?.message || err}`);
    console.error(err?.stack || '');
    // Don't exit — let the server keep serving
  });

  process.on('unhandledRejection', (reason) => {
    console.error(`[process] unhandledRejection: ${reason?.message || reason}`);
    if (reason?.stack) console.error(reason.stack);
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`AirVault server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
