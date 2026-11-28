// 手写 zip，强制使用 "/" 作为目录分隔符。
// 背景：PowerShell 5.1 的 Compress-Archive 会把 zip 内路径写成 "\"，
//       Edge/Chrome 解包时把 "\" 视为非法字符替换成 U+FFFD，子目录被压平，
//       于是 lib/mux.min.js、icons/icon16.png 等按路径引用的文件全部找不到。

import {
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  cpSync,
  existsSync,
  rmSync,
  statSync
} from 'node:fs';
import { join, relative, dirname, basename, resolve } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

// 脚本位于 scripts/，项目根目录是它的上一级
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(root, 'dist');

if (!existsSync(join(distDir, 'manifest.json'))) {
  console.error('[pack] dist/manifest.json 不存在，请先执行 npm run build');
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const pkgName = pkg.name || basename(root);
const version = JSON.parse(readFileSync(join(distDir, 'manifest.json'), 'utf8')).version;

// 产物名固定：每次打包覆盖同名文件，Edge 里加载的路径不用变
const releaseDir = join(root, 'releases', pkgName);
const zipPath = join(root, 'releases', `${pkgName}.zip`);

// ---------- 收集文件 ----------
function walk(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(abs, base));
    else if (entry.isFile()) out.push(abs);
  }
  return out;
}

const files = walk(distDir)
  .map((abs) => ({
    abs,
    // 关键：统一用 "/"，绝不出现 "\"
    rel: relative(distDir, abs).split('\\').join('/')
  }))
  .sort((a, b) => a.rel.localeCompare(b.rel));

// ---------- CRC32 ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// ---------- DOS 时间 ----------
const now = new Date();
const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;

// ---------- 构建 zip ----------
const localChunks = [];
const centralChunks = [];
let offset = 0;

for (const f of files) {
  const data = readFileSync(f.abs);
  const crc = crc32(data);
  const deflated = deflateRawSync(data, { level: 9 });
  const useDeflate = deflated.length < data.length;
  const payload = useDeflate ? deflated : data;
  const method = useDeflate ? 8 : 0;
  const nameBuf = Buffer.from(f.rel, 'utf8');
  const flag = 0x0800; // bit 11: 文件名为 UTF-8

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(flag, 6);
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(dosTime, 10);
  local.writeUInt16LE(dosDate, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(payload.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);

  localChunks.push(local, nameBuf, payload);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(flag, 8);
  central.writeUInt16LE(method, 10);
  central.writeUInt16LE(dosTime, 12);
  central.writeUInt16LE(dosDate, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(payload.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt16LE(0, 30);
  central.writeUInt16LE(0, 32);
  central.writeUInt16LE(0, 34);
  central.writeUInt16LE(0, 36);
  central.writeUInt32LE(0, 38);
  central.writeUInt32LE(offset, 42);

  centralChunks.push(central, nameBuf);

  offset += local.length + nameBuf.length + payload.length;
}

const centralBuf = Buffer.concat(centralChunks);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(0, 4);
eocd.writeUInt16LE(0, 6);
eocd.writeUInt16LE(files.length, 8);
eocd.writeUInt16LE(files.length, 10);
eocd.writeUInt32LE(centralBuf.length, 12);
eocd.writeUInt32LE(offset, 16);
eocd.writeUInt16LE(0, 20);

const zip = Buffer.concat([...localChunks, centralBuf, eocd]);

mkdirSync(join(root, 'releases'), { recursive: true });
writeFileSync(zipPath, zip);

// ---------- 同时生成可"加载解压缩的扩展"的目录 ----------
if (existsSync(releaseDir)) rmSync(releaseDir, { recursive: true, force: true });
cpSync(distDir, releaseDir, { recursive: true });

// ---------- 校验 ----------
const bad = files.filter((f) => f.rel.includes('\\'));
console.log(`[pack] version        : ${version}`);
console.log(`[pack] files          : ${files.length}`);
console.log(`[pack] 反斜杠条目      : ${bad.length}  ${bad.length === 0 ? 'OK' : '存在异常!'}`);
console.log(`[pack] zip            : ${zipPath}  (${Math.round(statSync(zipPath).size / 102.4) / 10} KB)`);
console.log(`[pack] 解压目录        : ${releaseDir}`);
