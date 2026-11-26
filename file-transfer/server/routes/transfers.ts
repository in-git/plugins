import { Router, Request, Response } from 'express';
import express from 'express';
import fs from 'fs';
import crypto from 'crypto';
import { CHUNKS_ROOT, DEFAULT_CHUNK_SIZE, MAX_CHUNK_SIZE, TRANSFER_TTL_MS } from '../config.js';
import { sendToDevice } from '../peers.js';
import {
  transfers,
  codeToId,
  generateUniquePickupCode,
  scheduleSaveIndex,
  removeTransferData,
  toPublicTransferSummary,
} from '../state.js';
import { isValidId, resolveConfinedPath, sanitizeFileName } from '../utils.js';
import type { EncryptedMeta } from '../types.js';

const router = Router();
router.use(express.json({ limit: '4mb' }));

// Initialize or Resume chunked file transfer
router.post('/transfers/init', (req: Request, res: Response) => {
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

  const record = {
    id: transferId,
    pickupCode,
    kind: 'file' as const,
    ownerToken,
    senderDeviceId: typeof senderDeviceId === 'string' ? senderDeviceId : undefined,
    senderDeviceName: typeof senderDeviceName === 'string' ? senderDeviceName.slice(0, 64) : '未知设备',
    targetDeviceId: typeof targetDeviceId === 'string' ? targetDeviceId : undefined,
    // 局域网直传：需接收方同意后才开始上传
    status: typeof targetDeviceId === 'string' ? ('pending' as const) : ('uploading' as const),
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
    uploadedChunks: [] as number[],
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
router.put(
  '/transfers/:id/chunk/:index',
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
router.post('/transfers/:id/complete', (req: Request, res: Response) => {
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
router.post('/transfers/text', (req: Request, res: Response) => {
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

  const record = {
    id: transferId,
    pickupCode,
    kind: 'text' as const,
    ownerToken,
    senderDeviceId: typeof senderDeviceId === 'string' ? senderDeviceId : undefined,
    senderDeviceName: typeof senderDeviceName === 'string' ? senderDeviceName.slice(0, 64) : '未知设备',
    targetDeviceId: typeof targetDeviceId === 'string' ? targetDeviceId : undefined,
    status: 'ready' as const,
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
router.get('/transfers/code/:code', (req: Request, res: Response) => {
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
router.get('/transfers/:id/status', (req: Request, res: Response) => {
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
router.get('/transfers/:id/chunk/:index', (req: Request, res: Response) => {
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
router.get('/transfers/:id/download', (req: Request, res: Response) => {
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
router.post('/transfers/:id/ack', (req: Request, res: Response) => {
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
router.delete('/transfers/:id', (req: Request, res: Response) => {
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

export default router;
