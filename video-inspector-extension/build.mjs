import { cp, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = process.cwd();
const src = resolve(root, 'src');
const dist = resolve(root, 'dist');

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

// 这个扩展不需要 bundling（content.js / lib/*.min.js 都是现成的），纯 copy
await cp(src, dist, { recursive: true });

console.log('[build] dist/ ready');
