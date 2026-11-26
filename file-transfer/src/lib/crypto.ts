function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function assertWebCrypto() {
  if (!window.crypto || !window.crypto.subtle) {
    throw new Error('当前浏览器环境不支持 Web Crypto 加密，请在 HTTPS 或本地环境下使用。');
  }
}

export function generateSaltBase64(): string {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  return toBase64(salt);
}

export function generateBaseIvBase64(): string {
  const baseIv = new Uint8Array(8);
  crypto.getRandomValues(baseIv);
  return toBase64(baseIv);
}

export function generateStrongPassphrase(length = 12): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%';
  const random = new Uint32Array(length);
  crypto.getRandomValues(random);
  return Array.from(random, (v) => chars[v % chars.length]).join('');
}

export async function deriveAesKey(passphrase: string, saltBase64: string): Promise<CryptoKey> {
  assertWebCrypto();
  const encoder = new TextEncoder();
  const salt = fromBase64(saltBase64);
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt.buffer as ArrayBuffer,
      iterations: 100000,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function encryptChunkBuffer(
  key: CryptoKey,
  baseIvBase64: string,
  chunkIndex: number,
  plainBuffer: ArrayBuffer
): Promise<ArrayBuffer> {
  assertWebCrypto();
  const baseIv = fromBase64(baseIvBase64);
  const iv = new Uint8Array(12);
  iv.set(baseIv.subarray(0, 8), 0);
  const view = new DataView(iv.buffer);
  view.setUint32(8, chunkIndex, false);

  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    plainBuffer
  );

  const output = new Uint8Array(12 + encrypted.byteLength);
  output.set(iv, 0);
  output.set(new Uint8Array(encrypted), 12);
  return output.buffer;
}

export async function decryptChunkBuffer(
  key: CryptoKey,
  encryptedPayload: ArrayBuffer
): Promise<ArrayBuffer> {
  assertWebCrypto();
  if (encryptedPayload.byteLength < 28) {
    throw new Error('加密分片数据损坏');
  }
  const bytes = new Uint8Array(encryptedPayload);
  const iv = bytes.slice(0, 12);
  const cipher = bytes.slice(12);

  return crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    cipher
  );
}

export async function encryptTextPayload(
  plainText: string,
  passphrase: string
): Promise<{ salt: string; iv: string; ciphertext: string }> {
  assertWebCrypto();
  const salt = generateSaltBase64();
  const key = await deriveAesKey(passphrase, salt);
  const ivBytes = new Uint8Array(12);
  crypto.getRandomValues(ivBytes);
  const encoded = new TextEncoder().encode(plainText);

  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: ivBytes },
    key,
    encoded
  );

  return {
    salt,
    iv: toBase64(ivBytes),
    ciphertext: toBase64(new Uint8Array(encrypted)),
  };
}

export async function decryptTextPayload(
  ciphertextBase64: string,
  saltBase64: string,
  ivBase64: string,
  passphrase: string
): Promise<string> {
  assertWebCrypto();
  const key = await deriveAesKey(passphrase, saltBase64);
  const iv = fromBase64(ivBase64);
  const cipher = fromBase64(ciphertextBase64);

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv.buffer as ArrayBuffer },
    key,
    cipher.buffer as ArrayBuffer
  );

  return new TextDecoder().decode(decrypted);
}

export async function computeFileFingerprint(file: File): Promise<string> {
  const headSlice = await file.slice(0, Math.min(file.size, 64 * 1024)).arrayBuffer();
  const tailStart = Math.max(0, file.size - 64 * 1024);
  const tailSlice = await file.slice(tailStart, file.size).arrayBuffer();

  const meta = new TextEncoder().encode(`${file.name}|${file.size}|${file.lastModified}`);
  const combined = new Uint8Array(meta.byteLength + headSlice.byteLength + tailSlice.byteLength);
  combined.set(meta, 0);
  combined.set(new Uint8Array(headSlice), meta.byteLength);
  combined.set(new Uint8Array(tailSlice), meta.byteLength + headSlice.byteLength);

  if (window.crypto?.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', combined);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
      .slice(0, 32);
  }
  return `${file.name}-${file.size}-${file.lastModified}`.replace(/[^a-zA-Z0-9_-]/g, '_');
}
