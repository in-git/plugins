import { WebSocket } from 'ws';
import { OFFLINE_NOTIFY_DEDUPE_MS } from './config.js';
import { knownDevices, transfers } from './state.js';
import { maskIpForDisplay } from './utils.js';
import type { PeerClient } from './types.js';

// Active WebSocket peers
export const peers = new Map<string, PeerClient>();

// 同一次"离开/刷新"可能产生多个离线信号（sendBeacon、unregister、socket close），
// 用短时间去重，避免对端收到重复的「对方已离线」提示。
const recentOfflineAt = new Map<string, number>();

export function getSameIpPeersFor(ip: string, subnet: string, excludeDeviceId?: string) {
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

export function sendToDevice(deviceId: string | undefined, payload: unknown) {
  if (!deviceId) return;
  const peer = peers.get(deviceId);
  if (peer && peer.ws.readyState === WebSocket.OPEN) {
    peer.ws.send(JSON.stringify(payload));
  }
}

export function broadcastPeerUpdateToNetwork(ip: string, subnet: string) {
  for (const peer of peers.values()) {
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

/**
 * 设备离线处理：
 * - 通知传输对端（接收方掉线 → 通知发送方；发送方掉线 → 通知接收方），让对端结束当前传输尝试
 * - 记录保留，供断点续传使用
 * - hard（心跳超时判定为真正掉线）时，主动断开与其 1:1 关联的对端连接
 */
export function handlePeerGone(deviceId: string, hard: boolean) {
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
export function removePeerImmediately(deviceId: string) {
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
