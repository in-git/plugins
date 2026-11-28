import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = process.cwd();
const src = resolve(root, 'src');
const dist = resolve(root, 'dist');

const STATIC_FILES = ['manifest.json', 'background.js', 'bilibili.png'];
const STATIC_DIRS = ['icons'];

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

for (const file of STATIC_FILES) {
  await cp(resolve(src, file), resolve(dist, file));
}
for (const dir of STATIC_DIRS) {
  await cp(resolve(src, dir), resolve(dist, dir), { recursive: true });
}

// 把 content.js + qrcode 库打包成单文件（content.js 是入口，因为它 import qrcode）
await build({
  entryPoints: [resolve(src, 'content.js')],
  bundle: true,
  format: 'iife',
  globalName: '__QR_CODE_EXT__',
  platform: 'browser',
  target: 'chrome100',
  minify: false,
  outfile: resolve(dist, 'content.js'),
  logLevel: 'info',
});

console.log('[build] dist/ ready');
