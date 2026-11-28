// 每次 pack 前自动 +0.0.1（patch）
// 同步更新 package.json 和 public/manifest.json

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 脚本位于 scripts/，项目根目录是它的上一级
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkgPath = resolve(root, 'package.json');
const manifestPath = resolve(root, 'public', 'manifest.json');

function bumpPatch(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-[\w.]+)?$/.exec(v);
  if (!m) throw new Error(`无法解析版本号: ${v}`);
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
const oldVer = pkg.version;
const newVer = bumpPatch(oldVer);
pkg.version = newVer;
await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

// manifest.json（如果存在）
try {
  const manifestText = await readFile(manifestPath, 'utf8');
  // 正则替换 version 字段，避免 JSON.parse/stringify 破坏原有格式
  const updated = manifestText.replace(/"version"\s*:\s*"\d+\.\d+\.\d+(-[\w.]+)?"/, `"version": "${newVer}"`);
  await writeFile(manifestPath, updated);
} catch {
  // manifest 不存在就跳过
}

console.log(`[bump] ${oldVer} → ${newVer}`);
