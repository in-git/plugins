// server/index.ts
import express3 from "express";
import http from "http";
import path3 from "path";

// server/config.ts
import path from "path";
import fs from "fs";
var PORT = 4782;
var UPLOADS_DIR = path.resolve(process.cwd(), "uploads");
var CHUNKS_ROOT = path.resolve(UPLOADS_DIR, "chunks");
var INDEX_FILE = path.resolve(UPLOADS_DIR, "transfers.json");
var DEFAULT_CHUNK_SIZE = 1024 * 1024;
var MAX_CHUNK_SIZE = 8 * 1024 * 1024;
var TRANSFER_TTL_MS = 24 * 60 * 60 * 1e3;
var OFFLINE_NOTIFY_DEDUPE_MS = 3e3;
var HEARTBEAT_INTERVAL_MS = 5e3;
var HEARTBEAT_TIMEOUT_MS = 12e3;
fs.mkdirSync(CHUNKS_ROOT, { recursive: true });

// server/routes/device.ts
import { Router } from "express";
import express from "express";

// server/peers.ts
import { WebSocket } from "ws";

// server/state.ts
import fs2 from "fs";
import crypto2 from "crypto";

// server/utils.ts
import path2 from "path";
import crypto from "crypto";
function resolveConfinedPath(baseDir, ...segments) {
  const resolved = path2.resolve(baseDir, ...segments);
  const normalizedBase = baseDir.endsWith(path2.sep) ? baseDir : baseDir + path2.sep;
  if (!resolved.startsWith(normalizedBase)) {
    throw new Error("Invalid filesystem path boundary");
  }
  return resolved;
}
function normalizeIp(rawIp) {
  if (!rawIp) return "127.0.0.1";
  let ip = rawIp.split(",")[0].trim();
  if (ip.startsWith("::ffff:")) {
    ip = ip.slice(7);
  }
  if (ip === "::1") {
    ip = "127.0.0.1";
  }
  return ip;
}
function getSubnetKey(ip) {
  if (ip.includes(".")) {
    const parts = ip.split(".");
    if (parts.length === 4) {
      return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
    }
  }
  if (ip.includes(":")) {
    const groups = ip.split(":").slice(0, 4);
    return `${groups.join(":")}::/64`;
  }
  return ip;
}
function maskIpForDisplay(ip) {
  if (ip === "127.0.0.1") return "127.0.0.1";
  if (ip.includes(".")) {
    const parts = ip.split(".");
    if (parts.length === 4) {
      return `${parts[0]}.${parts[1]}.${parts[2]}.${parts[3]}`;
    }
  }
  return ip;
}
function getRequestIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.trim()) {
    return normalizeIp(xff);
  }
  const realIp = req.headers["x-real-ip"];
  if (typeof realIp === "string" && realIp.trim()) {
    return normalizeIp(realIp);
  }
  return normalizeIp(req.socket.remoteAddress);
}
function isValidId(id) {
  return /^[a-zA-Z0-9_-]{8,64}$/.test(id);
}
function deriveDisplayCode(deviceId) {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const digest = crypto.createHash("sha256").update(deviceId).digest();
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += alphabet[digest[i] % alphabet.length];
  }
  return code;
}
function sanitizeFileName(name) {
  const cleaned = path2.basename(name).replace(/[\r\n\0]/g, "_").trim();
  return cleaned.slice(0, 200) || "untitled_file";
}

// server/state.ts
var knownDevices = /* @__PURE__ */ new Map();
var transfers = /* @__PURE__ */ new Map();
var codeToId = /* @__PURE__ */ new Map();
function mintOrGetDevice(existingId) {
  const deviceId = existingId && isValidId(existingId) ? existingId : `dev_${crypto2.randomBytes(8).toString("hex")}`;
  const existing = knownDevices.get(deviceId);
  if (existing) return existing;
  const entry = {
    deviceId,
    displayCode: deriveDisplayCode(deviceId),
    createdAt: Date.now()
  };
  knownDevices.set(deviceId, entry);
  return entry;
}
function loadTransfersIndex() {
  try {
    if (!fs2.existsSync(INDEX_FILE)) return;
    const raw = fs2.readFileSync(INDEX_FILE, "utf-8");
    const parsed = JSON.parse(raw);
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
    console.error("Failed to load transfers index:", err);
  }
}
var saveTimer = null;
function scheduleSaveIndex() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const list = Array.from(transfers.values());
      fs2.writeFileSync(INDEX_FILE, JSON.stringify(list, null, 2), "utf-8");
    } catch (err) {
      console.error("Failed to persist transfers index:", err);
    }
  }, 200);
}
function generateUniquePickupCode() {
  for (let i = 0; i < 50; i++) {
    const code = crypto2.randomInt(1e5, 1e6).toString();
    if (!codeToId.has(code)) return code;
  }
  return crypto2.randomInt(1e5, 1e6).toString();
}
function removeTransferData(record) {
  transfers.delete(record.id);
  if (record.pickupCode && codeToId.get(record.pickupCode) === record.id) {
    codeToId.delete(record.pickupCode);
  }
  if (record.kind === "file") {
    try {
      const dir = resolveConfinedPath(CHUNKS_ROOT, record.id);
      if (fs2.existsSync(dir)) {
        fs2.rmSync(dir, { recursive: true, force: true });
      }
    } catch {
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
function toPublicTransferSummary(record) {
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
    textContent: record.kind === "text" ? record.textContent : void 0,
    textByteLength: record.textByteLength
  };
}
loadTransfersIndex();
setInterval(cleanupExpiredTransfers, 60 * 60 * 1e3);

// server/peers.ts
var peers = /* @__PURE__ */ new Map();
var recentOfflineAt = /* @__PURE__ */ new Map();
function getSameIpPeersFor(ip, subnet, excludeDeviceId) {
  const result = [];
  for (const peer of peers.values()) {
    if (peer.ws.readyState !== WebSocket.OPEN) continue;
    if (excludeDeviceId && peer.deviceId === excludeDeviceId) continue;
    const exactIp = peer.ip === ip;
    const sameSubnet = peer.subnet === subnet;
    if (exactIp || sameSubnet) {
      const entry = knownDevices.get(peer.deviceId);
      result.push({
        deviceId: peer.deviceId,
        displayCode: entry?.displayCode || "------",
        deviceName: peer.deviceName,
        deviceType: peer.deviceType,
        ip: maskIpForDisplay(peer.ip),
        sameIp: exactIp,
        rttMs: peer.rttMs,
        connectedAt: peer.connectedAt
      });
    }
  }
  result.sort((a, b) => {
    if (a.sameIp !== b.sameIp) return a.sameIp ? -1 : 1;
    return a.deviceName.localeCompare(b.deviceName);
  });
  return result;
}
function sendToDevice(deviceId, payload) {
  if (!deviceId) return;
  const peer = peers.get(deviceId);
  if (peer && peer.ws.readyState === WebSocket.OPEN) {
    peer.ws.send(JSON.stringify(payload));
  }
}
function broadcastPeerUpdateToNetwork(ip, subnet) {
  for (const peer of peers.values()) {
    if (peer.ws.readyState !== WebSocket.OPEN) continue;
    if (peer.ip === ip || peer.subnet === subnet) {
      const list = getSameIpPeersFor(peer.ip, peer.subnet, peer.deviceId);
      peer.ws.send(
        JSON.stringify({
          type: "peers:update",
          yourIp: maskIpForDisplay(peer.ip),
          subnet: peer.subnet,
          peers: list
        })
      );
    }
  }
}
function handlePeerGone(deviceId, hard) {
  const now = Date.now();
  const last = recentOfflineAt.get(deviceId) ?? 0;
  if (now - last < OFFLINE_NOTIFY_DEDUPE_MS) return;
  recentOfflineAt.set(deviceId, now);
  if (recentOfflineAt.size > 512) {
    for (const [id, ts] of recentOfflineAt) {
      if (now - ts > OFFLINE_NOTIFY_DEDUPE_MS) recentOfflineAt.delete(id);
    }
  }
  const counterparts = /* @__PURE__ */ new Set();
  for (const record of transfers.values()) {
    const active = record.status === "pending" || record.status === "uploading";
    if (!active || record.expiresAt <= now) continue;
    if (record.targetDeviceId === deviceId) {
      sendToDevice(record.senderDeviceId, {
        type: "transfer:target-offline",
        transferId: record.id
      });
      if (record.senderDeviceId) counterparts.add(record.senderDeviceId);
    } else if (record.senderDeviceId === deviceId) {
      sendToDevice(record.targetDeviceId, {
        type: "transfer:sender-offline",
        transferId: record.id
      });
      if (record.targetDeviceId) counterparts.add(record.targetDeviceId);
    }
  }
  if (!hard) return;
  for (const cpId of counterparts) {
    if (cpId === deviceId) continue;
    const busier = Array.from(transfers.values()).some(
      (r) => (r.status === "pending" || r.status === "uploading") && r.expiresAt > now && (r.senderDeviceId === cpId && r.targetDeviceId !== deviceId || r.targetDeviceId === cpId && r.senderDeviceId !== deviceId)
    );
    if (busier) continue;
    const cp = peers.get(cpId);
    if (!cp) continue;
    peers.delete(cpId);
    try {
      cp.ws.terminate();
    } catch {
    }
    broadcastPeerUpdateToNetwork(cp.ip, cp.subnet);
  }
}
function removePeerImmediately(deviceId) {
  const peer = peers.get(deviceId);
  if (!peer) return;
  const now = Date.now();
  const last = recentOfflineAt.get(deviceId) ?? 0;
  if (now - last < OFFLINE_NOTIFY_DEDUPE_MS && now - peer.connectedAt < OFFLINE_NOTIFY_DEDUPE_MS) {
    return;
  }
  peers.delete(deviceId);
  handlePeerGone(deviceId, false);
  try {
    peer.ws.terminate();
  } catch {
  }
  broadcastPeerUpdateToNetwork(peer.ip, peer.subnet);
}

// server/routes/device.ts
var router = Router();
router.use(express.json({ limit: "4mb" }));
router.get("/health", (_req, res) => {
  res.json({ ok: true, timestamp: Date.now() });
});
router.get("/device/bootstrap", (req, res) => {
  const existingId = typeof req.query.deviceId === "string" && isValidId(req.query.deviceId) ? req.query.deviceId : void 0;
  const entry = mintOrGetDevice(existingId);
  res.json({
    deviceId: entry.deviceId,
    displayCode: entry.displayCode,
    createdAt: entry.createdAt
  });
});
router.get("/connection-test", (req, res) => {
  const started = Date.now();
  const ip = getRequestIp(req);
  const subnet = getSubnetKey(ip);
  const peerArr = Array.from(peers.values());
  const sameSubnet = peerArr.filter((p) => p.subnet === subnet);
  res.json({
    ok: true,
    timestamp: Date.now(),
    latencyMs: Date.now() - started,
    serverTime: (/* @__PURE__ */ new Date()).toISOString(),
    wsClients: peerArr.length,
    sameSubnetPeers: sameSubnet.length,
    yourIp: maskIpForDisplay(ip),
    subnet
  });
});
router.get("/network/info", (req, res) => {
  const ip = getRequestIp(req);
  const subnet = getSubnetKey(ip);
  res.json({
    ip: maskIpForDisplay(ip),
    subnet,
    onlineCount: getSameIpPeersFor(ip, subnet).length
  });
});
router.get("/peers/scan", (req, res) => {
  const ip = getRequestIp(req);
  const subnet = getSubnetKey(ip);
  const excludeId = typeof req.query.deviceId === "string" ? req.query.deviceId : void 0;
  const found = getSameIpPeersFor(ip, subnet, excludeId);
  res.json({
    yourIp: maskIpForDisplay(ip),
    subnet,
    scannedAt: Date.now(),
    peers: found
  });
});
router.post("/device/offline", (req, res) => {
  const deviceId = req.body?.deviceId;
  if (typeof deviceId === "string" && isValidId(deviceId)) {
    removePeerImmediately(deviceId);
  }
  res.status(204).end();
});
var device_default = router;

// server/routes/transfers.ts
import { Router as Router2 } from "express";
import express2 from "express";
import fs3 from "fs";
import crypto3 from "crypto";
var router2 = Router2();
router2.use(express2.json({ limit: "4mb" }));
router2.post("/transfers/init", (req, res) => {
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
    maxDownloads
  } = req.body ?? {};
  if (typeof fileName !== "string" || !fileName.trim()) {
    res.status(400).json({ error: "\u6587\u4EF6\u540D\u65E0\u6548" });
    return;
  }
  if (typeof fileSize !== "number" || !Number.isFinite(fileSize) || fileSize < 0) {
    res.status(400).json({ error: "\u6587\u4EF6\u5927\u5C0F\u65E0\u6548" });
    return;
  }
  if (typeof resumeTransferId === "string" && isValidId(resumeTransferId) && typeof providedOwnerToken === "string") {
    const existing = transfers.get(resumeTransferId);
    if (existing && existing.kind === "file" && existing.ownerToken === providedOwnerToken && existing.fileSize === fileSize && (!fingerprint || existing.fingerprint === fingerprint)) {
      const chunkDir2 = resolveConfinedPath(CHUNKS_ROOT, existing.id);
      const verifiedChunks = [];
      const total = existing.totalChunks ?? 0;
      for (let i = 0; i < total; i++) {
        const chunkPath = resolveConfinedPath(chunkDir2, `${i}.part`);
        if (fs3.existsSync(chunkPath)) {
          verifiedChunks.push(i);
        }
      }
      existing.uploadedChunks = verifiedChunks;
      if (targetDeviceId) existing.targetDeviceId = String(targetDeviceId);
      scheduleSaveIndex();
      if (existing.targetDeviceId) {
        sendToDevice(existing.targetDeviceId, {
          type: "transfer:resumed",
          transfer: toPublicTransferSummary(existing)
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
        encryption: existing.encryption
      });
      return;
    }
  }
  const chunkSize = typeof requestedChunkSize === "number" && requestedChunkSize >= 64 * 1024 && requestedChunkSize <= MAX_CHUNK_SIZE ? Math.floor(requestedChunkSize) : DEFAULT_CHUNK_SIZE;
  const totalChunks = Math.max(1, Math.ceil(fileSize / chunkSize));
  const transferId = `tr_${crypto3.randomBytes(12).toString("hex")}`;
  const ownerToken = crypto3.randomBytes(24).toString("hex");
  const pickupCode = generateUniquePickupCode();
  const chunkDir = resolveConfinedPath(CHUNKS_ROOT, transferId);
  fs3.mkdirSync(chunkDir, { recursive: true });
  const safeEncryption = encryption && encryption.enabled ? {
    enabled: true,
    algorithm: "AES-256-GCM",
    salt: typeof encryption.salt === "string" ? encryption.salt : void 0,
    baseIv: typeof encryption.baseIv === "string" ? encryption.baseIv : void 0
  } : { enabled: false };
  const record = {
    id: transferId,
    pickupCode,
    kind: "file",
    ownerToken,
    senderDeviceId: typeof senderDeviceId === "string" ? senderDeviceId : void 0,
    senderDeviceName: typeof senderDeviceName === "string" ? senderDeviceName.slice(0, 64) : "\u672A\u77E5\u8BBE\u5907",
    targetDeviceId: typeof targetDeviceId === "string" ? targetDeviceId : void 0,
    // 局域网直传：需接收方同意后才开始上传
    status: typeof targetDeviceId === "string" ? "pending" : "uploading",
    createdAt: Date.now(),
    expiresAt: Date.now() + TRANSFER_TTL_MS,
    downloadCount: 0,
    maxDownloads: typeof maxDownloads === "number" && maxDownloads > 0 ? Math.floor(maxDownloads) : null,
    encryption: safeEncryption,
    fileName: sanitizeFileName(fileName),
    mimeType: typeof mimeType === "string" && mimeType ? mimeType.slice(0, 128) : "application/octet-stream",
    fileSize,
    chunkSize,
    totalChunks,
    uploadedChunks: [],
    fingerprint: typeof fingerprint === "string" ? fingerprint.slice(0, 128) : void 0
  };
  transfers.set(transferId, record);
  codeToId.set(pickupCode, transferId);
  scheduleSaveIndex();
  if (record.targetDeviceId) {
    sendToDevice(record.targetDeviceId, {
      type: "transfer:incoming",
      transfer: toPublicTransferSummary(record)
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
    encryption: safeEncryption
  });
});
router2.put(
  "/transfers/:id/chunk/:index",
  express2.raw({ type: "application/octet-stream", limit: "16mb" }),
  (req, res) => {
    const id = String(req.params.id ?? "");
    const indexStr = String(req.params.index ?? "");
    if (!isValidId(id)) {
      res.status(400).json({ error: "\u65E0\u6548\u7684\u4F20\u8F93 ID" });
      return;
    }
    const record = transfers.get(id);
    if (!record || record.kind !== "file") {
      res.status(404).json({ error: "\u4F20\u8F93\u4EFB\u52A1\u4E0D\u5B58\u5728" });
      return;
    }
    const token = req.headers["x-owner-token"];
    if (token !== record.ownerToken) {
      res.status(403).json({ error: "\u65E0\u6743\u4E0A\u4F20\u6B64\u4EFB\u52A1\u5206\u7247" });
      return;
    }
    const chunkIndex = Number(indexStr);
    const totalChunks = record.totalChunks ?? 0;
    if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= totalChunks) {
      res.status(400).json({ error: "\u5206\u7247\u7D22\u5F15\u8D8A\u754C" });
      return;
    }
    const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (buffer.length === 0 && (record.fileSize ?? 0) > 0) {
      res.status(400).json({ error: "\u5206\u7247\u6570\u636E\u4E3A\u7A7A" });
      return;
    }
    const chunkDir = resolveConfinedPath(CHUNKS_ROOT, record.id);
    fs3.mkdirSync(chunkDir, { recursive: true });
    const chunkPath = resolveConfinedPath(chunkDir, `${chunkIndex}.part`);
    fs3.writeFileSync(chunkPath, buffer);
    const uploadedSet = new Set(record.uploadedChunks ?? []);
    uploadedSet.add(chunkIndex);
    record.uploadedChunks = Array.from(uploadedSet).sort((a, b) => a - b);
    scheduleSaveIndex();
    const progress = totalChunks > 0 ? Math.round(record.uploadedChunks.length / totalChunks * 100) : 100;
    if (record.targetDeviceId) {
      sendToDevice(record.targetDeviceId, {
        type: "transfer:progress",
        transferId: record.id,
        uploadedChunksCount: record.uploadedChunks.length,
        totalChunks,
        progress
      });
    }
    res.json({
      ok: true,
      chunkIndex,
      uploadedChunksCount: record.uploadedChunks.length,
      totalChunks
    });
  }
);
router2.post("/transfers/:id/complete", (req, res) => {
  const id = String(req.params.id ?? "");
  if (!isValidId(id)) {
    res.status(400).json({ error: "\u65E0\u6548\u7684\u4F20\u8F93 ID" });
    return;
  }
  const record = transfers.get(id);
  if (!record || record.kind !== "file") {
    res.status(404).json({ error: "\u4F20\u8F93\u4EFB\u52A1\u4E0D\u5B58\u5728" });
    return;
  }
  const token = req.headers["x-owner-token"];
  if (token !== record.ownerToken) {
    res.status(403).json({ error: "\u65E0\u6743\u5B8C\u6210\u6B64\u4EFB\u52A1" });
    return;
  }
  const total = record.totalChunks ?? 0;
  const chunkDir = resolveConfinedPath(CHUNKS_ROOT, record.id);
  const missing = [];
  for (let i = 0; i < total; i++) {
    const p = resolveConfinedPath(chunkDir, `${i}.part`);
    if (!fs3.existsSync(p)) {
      missing.push(i);
    }
  }
  if (missing.length > 0) {
    res.status(409).json({
      error: "\u4ECD\u6709\u5206\u7247\u672A\u4E0A\u4F20\u5B8C\u6210",
      missingChunks: missing
    });
    return;
  }
  record.status = "ready";
  scheduleSaveIndex();
  if (record.targetDeviceId) {
    sendToDevice(record.targetDeviceId, {
      type: "transfer:ready",
      transfer: toPublicTransferSummary(record)
    });
  }
  res.json({
    ok: true,
    transfer: toPublicTransferSummary(record)
  });
});
router2.post("/transfers/text", (req, res) => {
  const {
    textContent,
    encryption,
    senderDeviceId,
    senderDeviceName,
    targetDeviceId,
    maxDownloads
  } = req.body ?? {};
  if (typeof textContent !== "string" || !textContent.trim()) {
    res.status(400).json({ error: "\u6587\u672C\u5185\u5BB9\u4E0D\u80FD\u4E3A\u7A7A" });
    return;
  }
  if (Buffer.byteLength(textContent, "utf-8") > 2 * 1024 * 1024) {
    res.status(400).json({ error: "\u6587\u672C\u957F\u5EA6\u8D85\u51FA 2MB \u9650\u5236" });
    return;
  }
  const transferId = `tx_${crypto3.randomBytes(12).toString("hex")}`;
  const ownerToken = crypto3.randomBytes(24).toString("hex");
  const pickupCode = generateUniquePickupCode();
  const safeEncryption = encryption && encryption.enabled ? {
    enabled: true,
    algorithm: "AES-256-GCM",
    salt: typeof encryption.salt === "string" ? encryption.salt : void 0,
    iv: typeof encryption.iv === "string" ? encryption.iv : void 0
  } : { enabled: false };
  const record = {
    id: transferId,
    pickupCode,
    kind: "text",
    ownerToken,
    senderDeviceId: typeof senderDeviceId === "string" ? senderDeviceId : void 0,
    senderDeviceName: typeof senderDeviceName === "string" ? senderDeviceName.slice(0, 64) : "\u672A\u77E5\u8BBE\u5907",
    targetDeviceId: typeof targetDeviceId === "string" ? targetDeviceId : void 0,
    status: "ready",
    createdAt: Date.now(),
    expiresAt: Date.now() + TRANSFER_TTL_MS,
    downloadCount: 0,
    maxDownloads: typeof maxDownloads === "number" && maxDownloads > 0 ? Math.floor(maxDownloads) : null,
    encryption: safeEncryption,
    textContent,
    textByteLength: Buffer.byteLength(textContent, "utf-8")
  };
  transfers.set(transferId, record);
  codeToId.set(pickupCode, transferId);
  scheduleSaveIndex();
  if (record.targetDeviceId) {
    sendToDevice(record.targetDeviceId, {
      type: "transfer:ready",
      transfer: toPublicTransferSummary(record)
    });
  }
  res.status(201).json({
    ok: true,
    ownerToken,
    transfer: toPublicTransferSummary(record)
  });
});
router2.get("/transfers/code/:code", (req, res) => {
  const code = String(req.params.code ?? "").trim();
  if (!/^[A-Z0-9]{6}$/i.test(code)) {
    res.status(400).json({ error: "\u53D6\u4EF6\u7801\u5FC5\u987B\u4E3A 6 \u4F4D\u6570\u5B57\u6216\u5B57\u6BCD" });
    return;
  }
  const id = codeToId.get(code);
  if (!id) {
    res.status(404).json({ error: "\u53D6\u4EF6\u7801\u65E0\u6548\u6216\u5DF2\u8FC7\u671F" });
    return;
  }
  const record = transfers.get(id);
  if (!record || record.expiresAt <= Date.now()) {
    if (record) removeTransferData(record);
    res.status(404).json({ error: "\u53D6\u4EF6\u7801\u65E0\u6548\u6216\u5DF2\u8FC7\u671F" });
    return;
  }
  res.json({ transfer: toPublicTransferSummary(record) });
});
router2.get("/transfers/:id/status", (req, res) => {
  const id = String(req.params.id ?? "");
  if (!isValidId(id)) {
    res.status(400).json({ error: "\u65E0\u6548\u7684\u4F20\u8F93 ID" });
    return;
  }
  const record = transfers.get(id);
  if (!record || record.expiresAt <= Date.now()) {
    res.status(404).json({ error: "\u4F20\u8F93\u4EFB\u52A1\u4E0D\u5B58\u5728\u6216\u5DF2\u8FC7\u671F" });
    return;
  }
  res.json({
    transfer: toPublicTransferSummary(record),
    uploadedChunks: record.uploadedChunks ?? []
  });
});
router2.get("/transfers/:id/chunk/:index", (req, res) => {
  const id = String(req.params.id ?? "");
  const index = Number(req.params.index);
  if (!isValidId(id)) {
    res.status(400).json({ error: "\u65E0\u6548\u7684\u4F20\u8F93 ID" });
    return;
  }
  const record = transfers.get(id);
  if (!record || record.kind !== "file" || record.status !== "ready") {
    res.status(404).json({ error: "\u6587\u4EF6\u5C1A\u672A\u5C31\u7EEA\u6216\u4E0D\u5B58\u5728" });
    return;
  }
  const total = record.totalChunks ?? 0;
  if (!Number.isInteger(index) || index < 0 || index >= total) {
    res.status(400).json({ error: "\u5206\u7247\u7D22\u5F15\u65E0\u6548" });
    return;
  }
  const chunkPath = resolveConfinedPath(CHUNKS_ROOT, record.id, `${index}.part`);
  if (!fs3.existsSync(chunkPath)) {
    res.status(404).json({ error: "\u5206\u7247\u6570\u636E\u7F3A\u5931" });
    return;
  }
  if (index === total - 1) {
    record.downloadCount += 1;
    scheduleSaveIndex();
  }
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("X-Content-Type-Options", "nosniff");
  fs3.createReadStream(chunkPath).pipe(res);
});
router2.get("/transfers/:id/download", (req, res) => {
  const id = String(req.params.id ?? "");
  if (!isValidId(id)) {
    res.status(400).json({ error: "\u65E0\u6548\u7684\u4F20\u8F93 ID" });
    return;
  }
  const record = transfers.get(id);
  if (!record || record.kind !== "file" || record.status !== "ready") {
    res.status(404).json({ error: "\u6587\u4EF6\u4E0D\u5B58\u5728\u6216\u672A\u5B8C\u6210\u4E0A\u4F20" });
    return;
  }
  if (record.encryption.enabled) {
    res.status(400).json({ error: "\u52A0\u5BC6\u6587\u4EF6\u9700\u901A\u8FC7\u5BA2\u6237\u7AEF\u89E3\u5BC6\u4E0B\u8F7D" });
    return;
  }
  const totalChunks = record.totalChunks ?? 0;
  const chunkDir = resolveConfinedPath(CHUNKS_ROOT, record.id);
  const totalSize = record.fileSize ?? 0;
  const safeName = sanitizeFileName(record.fileName ?? "download");
  const encodedName = encodeURIComponent(safeName);
  res.setHeader("Content-Type", record.mimeType || "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename="download"; filename*=UTF-8''${encodedName}`);
  res.setHeader("Content-Length", String(totalSize));
  res.setHeader("X-Content-Type-Options", "nosniff");
  record.downloadCount += 1;
  scheduleSaveIndex();
  let currentIdx = 0;
  let destroyed = false;
  req.on("close", () => {
    destroyed = true;
  });
  const pipeNextChunk = () => {
    if (destroyed) return;
    if (currentIdx >= totalChunks) {
      res.end();
      return;
    }
    const chunkPath = resolveConfinedPath(chunkDir, `${currentIdx}.part`);
    if (!fs3.existsSync(chunkPath)) {
      res.destroy(new Error("Missing chunk"));
      return;
    }
    currentIdx += 1;
    const stream = fs3.createReadStream(chunkPath);
    stream.on("error", (err) => {
      res.destroy(err);
    });
    stream.on("end", () => {
      pipeNextChunk();
    });
    stream.pipe(res, { end: false });
  };
  pipeNextChunk();
});
router2.post("/transfers/:id/ack", (req, res) => {
  const id = String(req.params.id ?? "");
  if (!isValidId(id)) {
    res.status(400).json({ error: "\u65E0\u6548\u7684\u4F20\u8F93 ID" });
    return;
  }
  const record = transfers.get(id);
  if (!record) {
    res.status(404).json({ error: "\u8BB0\u5F55\u4E0D\u5B58\u5728" });
    return;
  }
  record.downloadCount += 1;
  const consume = req.query.consume === "1" || req.query.consume === "true";
  if (consume) {
    sendToDevice(record.senderDeviceId, {
      type: "transfer:downloaded",
      transferId: record.id,
      fileName: record.kind === "file" ? record.fileName : void 0
    });
    removeTransferData(record);
    res.json({ ok: true, consumed: true });
    return;
  }
  scheduleSaveIndex();
  res.json({ ok: true, downloadCount: record.downloadCount });
});
router2.delete("/transfers/:id", (req, res) => {
  const id = String(req.params.id ?? "");
  if (!isValidId(id)) {
    res.status(400).json({ error: "\u65E0\u6548\u7684\u4F20\u8F93 ID" });
    return;
  }
  const record = transfers.get(id);
  if (!record) {
    res.status(404).json({ error: "\u4F20\u8F93\u4EFB\u52A1\u4E0D\u5B58\u5728" });
    return;
  }
  const token = req.headers["x-owner-token"];
  if (token !== record.ownerToken) {
    res.status(403).json({ error: "\u65E0\u6743\u5220\u9664\u6B64\u4F20\u8F93\u4EFB\u52A1" });
    return;
  }
  removeTransferData(record);
  res.json({ ok: true });
});
var transfers_default = router2;

// server/ws.ts
import { WebSocketServer, WebSocket as WebSocket2 } from "ws";
import crypto4 from "crypto";
function attachWebSocket(server) {
  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (ws, req) => {
    const ip = getRequestIp(req);
    const subnet = getSubnetKey(ip);
    let registeredDeviceId = null;
    ws.on("pong", () => {
      if (!registeredDeviceId) return;
      const peer = peers.get(registeredDeviceId);
      if (peer) {
        if (peer.pingSentAt) {
          peer.rttMs = Math.max(1, Date.now() - peer.pingSentAt);
        }
        peer.lastSeenAt = Date.now();
      }
    });
    ws.on("message", (raw) => {
      if (registeredDeviceId) {
        const peer = peers.get(registeredDeviceId);
        if (peer) peer.lastSeenAt = Date.now();
      }
      try {
        const data = JSON.parse(raw.toString());
        if (!data || typeof data !== "object") return;
        if (data.type === "device:register") {
          const devId = typeof data.deviceId === "string" && isValidId(data.deviceId) ? data.deviceId : `dev_${crypto4.randomBytes(6).toString("hex")}`;
          const devName = typeof data.deviceName === "string" && data.deviceName.trim() ? data.deviceName.trim().slice(0, 48) : "\u6211\u7684\u8BBE\u5907";
          const devType = data.deviceType === "mobile" || data.deviceType === "tablet" ? data.deviceType : "desktop";
          registeredDeviceId = devId;
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
            rttMs: 1
          });
          if (prevPeer && prevPeer.ws !== ws) {
            try {
              prevPeer.ws.terminate();
            } catch {
            }
          }
          ws.send(
            JSON.stringify({
              type: "device:registered",
              deviceId: devId,
              yourIp: maskIpForDisplay(ip),
              subnet,
              peers: getSameIpPeersFor(ip, subnet, devId)
            })
          );
          broadcastPeerUpdateToNetwork(ip, subnet);
          for (const record of transfers.values()) {
            if (record.targetDeviceId === devId && record.status === "uploading" && (record.uploadedChunks?.length ?? 0) > 0 && record.expiresAt > Date.now() && // 发送方需在线，避免发送方已离线时仍弹出一个无法继续的进度界面
            !!record.senderDeviceId && peers.has(record.senderDeviceId)) {
              sendToDevice(devId, {
                type: "transfer:resumed",
                transfer: toPublicTransferSummary(record)
              });
            }
          }
        } else if (data.type === "scan:request") {
          for (const peer of peers.values()) {
            if (peer.ws.readyState === WebSocket2.OPEN && (peer.ip === ip || peer.subnet === subnet)) {
              peer.pingSentAt = Date.now();
              try {
                peer.ws.ping();
              } catch {
              }
            }
          }
          setTimeout(() => {
            if (ws.readyState === WebSocket2.OPEN) {
              ws.send(
                JSON.stringify({
                  type: "scan:results",
                  yourIp: maskIpForDisplay(ip),
                  subnet,
                  scannedAt: Date.now(),
                  peers: getSameIpPeersFor(ip, subnet, registeredDeviceId ?? void 0)
                })
              );
            }
          }, 180);
        } else if (data.type === "ping") {
          ws.send(JSON.stringify({ type: "pong", ts: Date.now() }));
        } else if (data.type === "device:unregister") {
          if (registeredDeviceId) {
            removePeerImmediately(registeredDeviceId);
            registeredDeviceId = null;
          }
        } else if (data.type === "transfer:decline" && typeof data.transferId === "string") {
          const record = transfers.get(data.transferId);
          if (record && record.targetDeviceId === registeredDeviceId) {
            sendToDevice(record.senderDeviceId, {
              type: "transfer:declined",
              transferId: record.id,
              pickupCode: record.pickupCode
            });
          }
        } else if (data.type === "transfer:accept" && typeof data.transferId === "string") {
          const record = transfers.get(data.transferId);
          if (record && record.targetDeviceId === registeredDeviceId) {
            if (record.status === "pending") {
              record.status = "uploading";
              scheduleSaveIndex();
            }
            sendToDevice(record.senderDeviceId, {
              type: "transfer:accepted",
              transferId: record.id
            });
          }
        } else if (data.type === "transfer:close" && typeof data.transferId === "string") {
          const record = transfers.get(data.transferId);
          if (record && record.targetDeviceId === registeredDeviceId) {
            sendToDevice(record.senderDeviceId, {
              type: "transfer:closed",
              transferId: record.id
            });
          }
        } else if (data.type === "transfer:downloaded" && typeof data.transferId === "string") {
          const record = transfers.get(data.transferId);
          if (record && record.targetDeviceId === registeredDeviceId) {
            sendToDevice(record.senderDeviceId, {
              type: "transfer:downloaded",
              transferId: record.id,
              fileName: record.kind === "file" ? record.fileName : void 0
            });
          }
        }
      } catch {
      }
    });
    ws.on("close", () => {
      if (registeredDeviceId) {
        const existing = peers.get(registeredDeviceId);
        if (existing && existing.ws === ws) {
          peers.delete(registeredDeviceId);
          handlePeerGone(registeredDeviceId, false);
          broadcastPeerUpdateToNetwork(ip, subnet);
        }
      }
    });
    ws.on("error", (err) => {
      const devLabel = registeredDeviceId || "(unknown)";
      const msg = err?.message || String(err);
      console.warn(`[ws] socket error from ${devLabel}: ${msg}`);
    });
  });
  wss.on("error", (err) => {
    const msg = err?.message || String(err);
    console.error(`[wss] fatal error: ${msg}`);
  });
  const heartbeatTimer = setInterval(() => {
    const now = Date.now();
    for (const peer of peers.values()) {
      if (now - peer.lastSeenAt > HEARTBEAT_TIMEOUT_MS) {
        console.warn(`[ws] peer ${peer.deviceId} (${peer.ip}) timed out \u2014 dropping`);
        peers.delete(peer.deviceId);
        handlePeerGone(peer.deviceId, true);
        broadcastPeerUpdateToNetwork(peer.ip, peer.subnet);
        try {
          peer.ws.terminate();
        } catch {
        }
        continue;
      }
      if (peer.ws.readyState === WebSocket2.OPEN) {
        peer.pingSentAt = now;
        try {
          peer.ws.ping();
        } catch {
        }
      }
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref();
  return wss;
}

// server/index.ts
async function main() {
  const app = express3();
  app.set("trust proxy", true);
  app.use("/api", device_default);
  app.use("/api", transfers_default);
  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa"
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path3.resolve(process.cwd(), "dist");
    app.use(express3.static(distDir));
    app.get("*", (_req, res) => {
      res.sendFile(path3.resolve(distDir, "index.html"));
    });
  }
  const server = http.createServer(app);
  attachWebSocket(server);
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(`[server] port ${PORT} already in use \u2014 exiting`);
      process.exit(1);
    } else {
      console.error(`[server] error: ${err?.message || err}`);
    }
  });
  process.on("uncaughtException", (err) => {
    console.error(`[process] uncaughtException: ${err?.message || err}`);
    console.error(err?.stack || "");
  });
  process.on("unhandledRejection", (reason) => {
    const r = reason;
    const msg = r?.message ?? String(reason);
    console.error(`[process] unhandledRejection: ${msg}`);
    if (r?.stack) console.error(r.stack);
  });
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`AirVault server running on http://0.0.0.0:${PORT}`);
  });
}
main();
