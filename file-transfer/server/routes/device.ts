import { Router, Request, Response } from 'express';
import express from 'express';
import { peers, removePeerImmediately, getSameIpPeersFor } from '../peers.js';
import { mintOrGetDevice } from '../state.js';
import { isValidId, getRequestIp, getSubnetKey, maskIpForDisplay } from '../utils.js';

const router = Router();
router.use(express.json({ limit: '4mb' }));

// Health
router.get('/health', (_req: Request, res: Response) => {
  res.json({ ok: true, timestamp: Date.now() });
});

// Device bootstrap — server-mints deviceId + displayCode (idempotent)
router.get('/device/bootstrap', (req: Request, res: Response) => {
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
router.get('/connection-test', (req: Request, res: Response) => {
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
router.get('/network/info', (req: Request, res: Response) => {
  const ip = getRequestIp(req);
  const subnet = getSubnetKey(ip);
  res.json({
    ip: maskIpForDisplay(ip),
    subnet,
    onlineCount: getSameIpPeersFor(ip, subnet).length,
  });
});

router.get('/peers/scan', (req: Request, res: Response) => {
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

// 页面离开时的主动下线（sendBeacon 调用），立即移除设备
router.post('/device/offline', (req: Request, res: Response) => {
  const deviceId = req.body?.deviceId;
  if (typeof deviceId === 'string' && isValidId(deviceId)) {
    removePeerImmediately(deviceId);
  }
  res.status(204).end();
});

export default router;
