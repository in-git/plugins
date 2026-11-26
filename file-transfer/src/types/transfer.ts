export type DeviceType = 'desktop' | 'mobile' | 'tablet';

export interface NetworkPeer {
  deviceId: string;
  displayCode?: string;
  deviceName: string;
  deviceType: DeviceType;
  ip: string;
  sameIp: boolean;
  rttMs: number;
  connectedAt: number;
}

export interface EncryptionMeta {
  enabled: boolean;
  salt?: string;
  baseIv?: string;
  iv?: string;
  algorithm?: 'AES-256-GCM';
}

export interface TransferSummary {
  id: string;
  pickupCode: string;
  kind: 'file' | 'text';
  status: 'pending' | 'uploading' | 'ready';
  createdAt: number;
  expiresAt: number;
  downloadCount: number;
  maxDownloads: number | null;
  senderDeviceName?: string;
  encryption: EncryptionMeta;
  fileName?: string;
  mimeType?: string;
  fileSize?: number;
  chunkSize?: number;
  totalChunks?: number;
  uploadedChunksCount?: number;
  textContent?: string;
  textByteLength?: number;
}

export interface ResumableUploadRecord {
  transferId: string;
  ownerToken: string;
  pickupCode: string;
  fingerprint: string;
  fileName: string;
  fileSize: number;
  chunkSize: number;
  totalChunks: number;
  uploadedChunks: number[];
  encryption: EncryptionMeta;
  updatedAt: number;
}

export interface TransferHistoryItem {
  id: string;
  pickupCode: string;
  kind: 'file' | 'text';
  direction: 'sent' | 'received';
  title: string;
  sizeBytes: number;
  encrypted: boolean;
  targetDeviceName?: string;
  createdAt: number;
}
