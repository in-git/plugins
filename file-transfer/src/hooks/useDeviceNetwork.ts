import { useCallback, useEffect, useRef, useState } from 'react';
import { DeviceType, NetworkPeer, TransferSummary } from '../types/transfer';
import { showToast } from '../lib/toast';

const DEVICE_ID_KEY = 'airvault_device_id';
const DISPLAY_CODE_KEY = 'airvault_display_code';
const DEVICE_NAME_KEY = 'airvault_device_name';

function detectDefaultDeviceProfile(): { name: string; type: DeviceType } {
  const ua = navigator.userAgent;
  let type: DeviceType = 'desktop';
  if (/iPad|Tablet/i.test(ua)) type = 'tablet';
  else if (/iPhone|Android|Mobile/i.test(ua)) type = 'mobile';

  let os = '设备';
  if (/Mac OS X|Macintosh/i.test(ua)) os = 'Mac';
  else if (/iPhone/i.test(ua)) os = 'iPhone';
  else if (/iPad/i.test(ua)) os = 'iPad';
  else if (/Windows/i.test(ua)) os = 'Windows PC';
  else if (/Android/i.test(ua)) os = 'Android';
  else if (/Linux/i.test(ua)) os = 'Linux';

  let browser = 'Browser';
  if (/Edg\//i.test(ua)) browser = 'Edge';
  else if (/Chrome\//i.test(ua) && !/Edg/i.test(ua)) browser = 'Chrome';
  else if (/Safari\//i.test(ua) && !/Chrome/i.test(ua)) browser = 'Safari';
  else if (/Firefox\//i.test(ua)) browser = 'Firefox';

  return { name: `${os} · ${browser}`, type };
}

function readExistingDeviceId(): string | null {
  const existing = localStorage.getItem(DEVICE_ID_KEY);
  if (existing && /^[a-zA-Z0-9_-]{8,64}$/.test(existing)) return existing;
  return null;
}

async function bootstrapDeviceFromServer(): Promise<{ deviceId: string; displayCode: string }> {
  const existing = readExistingDeviceId();
  const url = existing
    ? `/api/device/bootstrap?deviceId=${encodeURIComponent(existing)}`
    : '/api/device/bootstrap';
  try {
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      if (data?.deviceId && data?.displayCode) {
        localStorage.setItem(DEVICE_ID_KEY, data.deviceId);
        localStorage.setItem(DISPLAY_CODE_KEY, data.displayCode);
        return { deviceId: data.deviceId, displayCode: data.displayCode };
      }
    }
  } catch {
    // ignore
  }
  // Fallback: stable client-generated ID if bootstrap fails (offline first)
  const fallback = existing || `dev_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
  localStorage.setItem(DEVICE_ID_KEY, fallback);
  const fallbackCode = localStorage.getItem(DISPLAY_CODE_KEY) || '------';
  return { deviceId: fallback, displayCode: fallbackCode };
}

export interface IncomingTransferNotice {
  transfer: TransferSummary;
  progress: number;
  uploadedChunksCount: number;
  totalChunks: number;
}

export function useDeviceNetwork() {
  const defaultProfile = useRef(detectDefaultDeviceProfile());
  const [deviceId, setDeviceId] = useState<string>(() => readExistingDeviceId() || '');
  const [displayCode, setDisplayCode] = useState<string>(() => localStorage.getItem(DISPLAY_CODE_KEY) || '------');
  const [deviceName, setDeviceNameState] = useState<string>(() => {
    return localStorage.getItem(DEVICE_NAME_KEY) || defaultProfile.current.name;
  });
  const [deviceType] = useState<DeviceType>(defaultProfile.current.type);

  const [yourIp, setYourIp] = useState<string>('正在检测...');
  const [subnet, setSubnet] = useState<string>('');
  const [peers, setPeers] = useState<NetworkPeer[]>([]);
  const [connected, setConnected] = useState<boolean>(false);
  const [scanning, setScanning] = useState<boolean>(false);
  const [lastScannedAt, setLastScannedAt] = useState<number | null>(null);
  const [incomingTransfers, setIncomingTransfers] = useState<IncomingTransferNotice[]>([]);
  const incomingRef = useRef<IncomingTransferNotice[]>([]);
  useEffect(() => { incomingRef.current = incomingTransfers; }, [incomingTransfers]);
  /** 已点过“接收”的传输，避免就地绪后再次弹窗 */
  const acceptedRef = useRef<Set<string>>(new Set());

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const deviceIdRef = useRef<string>(deviceId);
  // Keep ref in sync with state changes
  deviceIdRef.current = deviceId;

  const updateDeviceName = useCallback((nextName: string) => {
    const trimmed = nextName.trim().slice(0, 40) || defaultProfile.current.name;
    setDeviceNameState(trimmed);
    localStorage.setItem(DEVICE_NAME_KEY, trimmed);
    const currentId = deviceIdRef.current;
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN && currentId) {
      wsRef.current.send(
        JSON.stringify({
          type: 'device:register',
          deviceId: currentId,
          deviceName: trimmed,
          deviceType,
        })
      );
    }
  }, [deviceType]);

  const triggerScan = useCallback(async () => {
    setScanning(true);
    const currentId = deviceIdRef.current;
    try {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'scan:request' }));
      }
      if (currentId) {
        const res = await fetch(`/api/peers/scan?deviceId=${encodeURIComponent(currentId)}`);
        if (res.ok) {
          const data = await res.json();
          setYourIp(data.yourIp || '未知');
          setSubnet(data.subnet || '');
          setPeers(Array.isArray(data.peers) ? data.peers : []);
          setLastScannedAt(Date.now());
        }
      }
    } catch {
      // ignore
    } finally {
      window.setTimeout(() => setScanning(false), 380);
    }
  }, []);

  // 用户离开页面（关闭标签 / 刷新 / 跳转）时主动下线，
  // 让服务端立即把它从其它设备的列表里移除，而不用等心跳超时。
  useEffect(() => {
    // pagehide 与 beforeunload 在刷新/关闭时会先后触发，这里只允许下线信号发送一次，
    // 避免服务端把同一次离开当成多次离线而重复通知对端。
    let sent = false;
    const goOffline = () => {
      if (sent) return;
      sent = true;
      const id = deviceIdRef.current;
      if (!id) return;
      try {
        const blob = new Blob([JSON.stringify({ deviceId: id })], {
          type: 'application/json',
        });
        navigator.sendBeacon('/api/device/offline', blob);
      } catch {
        // ignore
      }
      try {
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: 'device:unregister', deviceId: id }));
        }
      } catch {
        // ignore
      }
    };

    window.addEventListener('pagehide', goOffline);
    window.addEventListener('beforeunload', goOffline);
    return () => {
      window.removeEventListener('pagehide', goOffline);
      window.removeEventListener('beforeunload', goOffline);
    };
  }, []);

  useEffect(() => {
    let active = true;

    const connect = () => {
      if (!active) return;
      const currentId = deviceIdRef.current;
      if (!currentId) {
        // Don't connect until bootstrap resolved the deviceId
        return;
      }
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/ws`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        if (!active) return;
        setConnected(true);
        const storedName = localStorage.getItem(DEVICE_NAME_KEY) || defaultProfile.current.name;
        ws.send(
          JSON.stringify({
            type: 'device:register',
            deviceId: currentId,
            deviceName: storedName,
            deviceType,
          })
        );
      };

      ws.onmessage = (event) => {
        if (!active) return;
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'device:registered' || msg.type === 'peers:update' || msg.type === 'scan:results') {
            if (msg.yourIp) setYourIp(msg.yourIp);
            if (msg.subnet) setSubnet(msg.subnet);
            if (Array.isArray(msg.peers)) setPeers(msg.peers);
            if (msg.type === 'scan:results') {
              setLastScannedAt(msg.scannedAt || Date.now());
              setScanning(false);
            }
          } else if (msg.type === 'transfer:incoming' && msg.transfer) {
            const totalChunks = msg.transfer.totalChunks || 1;
            const notice: IncomingTransferNotice = {
              transfer: msg.transfer,
              progress: msg.transfer.status === 'ready' ? 100 : 0,
              uploadedChunksCount: msg.transfer.uploadedChunksCount || 0,
              totalChunks,
            };
            // Queue up every incoming transfer — a batch sends many files, each
            // with its own pickup code, so we must not overwrite previous ones.
            setIncomingTransfers((prev) => {
              const idx = prev.findIndex((n) => n.transfer.id === notice.transfer.id);
              if (idx >= 0) {
                const next = [...prev];
                next[idx] = notice;
                return next;
              }
              return [...prev, notice];
            });
          } else if (msg.type === 'transfer:progress') {
            setIncomingTransfers((prev) =>
              prev.map((n) =>
                n.transfer.id === msg.transferId
                  ? {
                      ...n,
                      progress: msg.progress ?? n.progress,
                      uploadedChunksCount: msg.uploadedChunksCount ?? n.uploadedChunksCount,
                      totalChunks: msg.totalChunks ?? n.totalChunks,
                    }
                  : n
              )
            );
          } else if (msg.type === 'transfer:declined' && msg.transferId) {
            // 接收方取消了接收 → 通知发送方终止上传
            showToast('对方已拒绝接收', 'error');
            window.dispatchEvent(
              new CustomEvent('ft:transfer-declined', {
                detail: { transferId: msg.transferId as string },
              })
            );
          } else if (msg.type === 'transfer:accepted' && msg.transferId) {
            // 接收方已点击接收 → 提示发送方
            showToast('对方已接受，开始接收', 'success');
            window.dispatchEvent(
              new CustomEvent('ft:transfer-accepted', {
                detail: { transferId: msg.transferId as string },
              })
            );
          } else if (msg.type === 'transfer:closed' && msg.transferId) {
            // 接收方关闭了接收界面 → 提示发送方
            showToast('对方已关闭接收', 'error');
            window.dispatchEvent(
              new CustomEvent('ft:transfer-closed', {
                detail: { transferId: msg.transferId as string },
              })
            );
          } else if (msg.type === 'transfer:downloaded' && msg.transferId) {
            // 接收方已点击下载 → 提示发送方「对方已成功接收」
            showToast('对方已成功接收文件', 'success');
            window.dispatchEvent(
              new CustomEvent('ft:transfer-downloaded', {
                detail: { transferId: msg.transferId as string },
              })
            );
          } else if (msg.type === 'transfer:target-offline' && msg.transferId) {
            // 接收方退出 / 断线 → 通知发送方暂停传输
            showToast('对方已离线，传输已暂停', 'error');
            window.dispatchEvent(
              new CustomEvent('ft:transfer-target-offline', {
                detail: { transferId: msg.transferId as string },
              })
            );
          } else if (msg.type === 'transfer:sender-offline' && msg.transferId) {
            // 发送方退出 / 断线 → 通知接收方中止本次接收
            const offlineId = msg.transferId as string;
            showToast('对方已离线，传输已中止', 'error');
            // 未点接收时移除待接收卡片；已接收时由 App 关闭接收界面
            setIncomingTransfers((prev) => prev.filter((n) => n.transfer.id !== offlineId));
            window.dispatchEvent(
              new CustomEvent('ft:transfer-sender-offline', {
                detail: { transferId: offlineId },
              })
            );
          } else if (msg.type === 'transfer:resumed' && msg.transfer) {
            // 断点续传：发送方继续上传 → 视为已接收，通知界面打开进度模态框
            const transfer = msg.transfer as TransferSummary;
            acceptedRef.current.add(transfer.id);
            setIncomingTransfers((prev) => prev.filter((n) => n.transfer.id !== transfer.id));
            window.dispatchEvent(
              new CustomEvent('ft:transfer-resumed', { detail: { transfer } })
            );
          } else if (msg.type === 'transfer:ready' && msg.transfer) {
            // 已接受的传输不再重新弹窗，接收面板会自行轮询到就绪状态
            if (acceptedRef.current.has(msg.transfer.id)) return;
            const ready: IncomingTransferNotice = {
              transfer: msg.transfer,
              progress: 100,
              uploadedChunksCount: msg.transfer.totalChunks || 1,
              totalChunks: msg.transfer.totalChunks || 1,
            };
            setIncomingTransfers((prev) => {
              const idx = prev.findIndex((n) => n.transfer.id === ready.transfer.id);
              if (idx >= 0) {
                const next = [...prev];
                next[idx] = ready;
                return next;
              }
              return [...prev, ready];
            });
          }
        } catch {
          // ignore malformed messages
        }
      };

      ws.onclose = () => {
        if (!active) return;
        setConnected(false);
        if (reconnectTimerRef.current) window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = window.setTimeout(connect, 2500);
      };

      ws.onerror = () => {
        ws.close();
      };
    };

    // 1. First — bootstrap device identity from server (or read cached)
    const bootstrap = async () => {
      const { deviceId: newId, displayCode: newCode } = await bootstrapDeviceFromServer();
      if (!active) return;
      deviceIdRef.current = newId;
      setDeviceId(newId);
      setDisplayCode(newCode);
      // 2. Then open WS
      connect();
    };

    bootstrap();

    // Also fetch initial network info via HTTP immediately
    fetch('/api/network/info')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (active && data?.ip) {
          setYourIp(data.ip);
          setSubnet(data.subnet || '');
        }
      })
      .catch(() => {});

    return () => {
      active = false;
      if (reconnectTimerRef.current) window.clearTimeout(reconnectTimerRef.current);
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceType]);

  /** 静默移除通知（用于“接收”，不通知发送方） */
  const removeIncoming = useCallback((transferId?: string) => {
    setIncomingTransfers((prev) =>
      transferId ? prev.filter((n) => n.transfer.id !== transferId) : []
    );
  }, []);

  /** 接受：回复发送方已接收，并从通知队列移除 */
  const acceptIncoming = useCallback((transferId: string) => {
    acceptedRef.current.add(transferId);
    try {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'transfer:accept', transferId }));
      }
    } catch {
      // ignore
    }
    setIncomingTransfers((prev) => prev.filter((n) => n.transfer.id !== transferId));
  }, []);

  /** 接收方关闭接收界面：告知发送方 */
  const closeIncoming = useCallback((transferId: string) => {
    try {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'transfer:close', transferId }));
      }
    } catch {
      // ignore
    }
  }, []);

  /** 接收方点击下载：告知发送方「对方已成功接收」 */
  const notifyDownloaded = useCallback((transferId: string) => {
    try {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'transfer:downloaded', transferId }));
      }
    } catch {
      // ignore
    }
  }, []);

  /** 拒绝/关闭接收：同时通知发送方取消传输 */
  const dismissIncoming = useCallback((transferId?: string) => {
    const targets = transferId
      ? incomingRef.current.filter((n) => n.transfer.id === transferId)
      : incomingRef.current;
    for (const n of targets) {
      try {
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(
            JSON.stringify({ type: 'transfer:decline', transferId: n.transfer.id })
          );
        }
      } catch {
        // ignore
      }
    }
    setIncomingTransfers((prev) =>
      transferId ? prev.filter((n) => n.transfer.id !== transferId) : []
    );
  }, []);

  return {
    deviceId,
    displayCode,
    deviceName,
    deviceType,
    updateDeviceName,
    yourIp,
    subnet,
    peers,
    connected,
    scanning,
    lastScannedAt,
    triggerScan,
    incomingTransfers,
    removeIncoming,
    acceptIncoming,
    closeIncoming,
    notifyDownloaded,
    dismissIncoming,
  };
}
