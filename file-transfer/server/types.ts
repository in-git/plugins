import type { WebSocket } from 'ws';

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

export interface PeerClient {
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

export interface DeviceEntry {
  deviceId: string;
  displayCode: string;
  createdAt: number;
}
