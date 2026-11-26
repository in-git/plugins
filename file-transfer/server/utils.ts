import path from 'path';
import crypto from 'crypto';
import type http from 'http';

export function resolveConfinedPath(baseDir: string, ...segments: string[]): string {
  const resolved = path.resolve(baseDir, ...segments);
  const normalizedBase = baseDir.endsWith(path.sep) ? baseDir : baseDir + path.sep;
  if (!resolved.startsWith(normalizedBase)) {
    throw new Error('Invalid filesystem path boundary');
  }
  return resolved;
}

export function normalizeIp(rawIp: string | undefined): string {
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

export function getSubnetKey(ip: string): string {
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

export function maskIpForDisplay(ip: string): string {
  if (ip === '127.0.0.1') return '127.0.0.1';
  if (ip.includes('.')) {
    const parts = ip.split('.');
    if (parts.length === 4) {
      return `${parts[0]}.${parts[1]}.${parts[2]}.${parts[3]}`;
    }
  }
  return ip;
}

export function getRequestIp(req: http.IncomingMessage): string {
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

export function isValidId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{8,64}$/.test(id);
}

export function deriveDisplayCode(deviceId: string): string {
  // 根据设备 ID 稳定派生的 6 位人类可读编码（固定不变，不再随机）
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const digest = crypto.createHash('sha256').update(deviceId).digest();
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += alphabet[digest[i] % alphabet.length];
  }
  return code;
}

export function sanitizeFileName(name: string): string {
  const cleaned = path.basename(name).replace(/[\r\n\0]/g, '_').trim();
  return cleaned.slice(0, 200) || 'untitled_file';
}
