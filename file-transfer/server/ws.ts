import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import crypto from 'crypto';
import { HEARTBEAT_INTERVAL_MS, HEARTBEAT_TIMEOUT_MS } from './config.js';
import {
  peers,
  broadcastPeerUpdateToNetwork,
  getSameIpPeersFor,
  sendToDevice,
  handlePeerGone,
  removePeerImmediately,
} from './peers.js';
import { knownDevices, transfers, mintOrGetDevice, scheduleSaveIndex, toPublicTransferSummary } from './state.js';
import {
  isValidId,
  getRequestIp,
  getSubnetKey,
  maskIpForDisplay,
} from './utils.js';

export function attachWebSocket(server: http.Server) {
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
      const devLabel = registeredDeviceId || '(unknown)';
      const msg = err?.message || String(err);
      console.warn(`[ws] socket error from ${devLabel}: ${msg}`);
    });
  });

  wss.on('error', (err) => {
    const msg = err?.message || String(err);
    console.error(`[wss] fatal error: ${msg}`);
  });

  // ---------------------------------------------------------------------------
  // Heartbeat — devices that close the page / lose network may leave a dead
  // socket open; prune them so the peer list stays accurate.
  // ---------------------------------------------------------------------------
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

  return wss;
}
