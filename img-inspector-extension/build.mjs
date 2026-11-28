import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = process.cwd();
const src = resolve(root, 'src');
const dist = resolve(root, 'dist');

// 运行时原样复制的文件；扩展最终从 dist/ 加载
const STATIC_FILES = ['manifest.json', 'background.js', 'content.js', 'bootstrap.js', 'zip.js', 'popup.html', 'popup.js', 'rules.json', 'bilibili.png'];

async function compileCss() {
  // 直接调用本地 tailwindcss CLI，避免依赖 npm 脚本执行顺序
  const cli = resolve(root, 'node_modules/tailwindcss/lib/cli.js');
  await new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      [cli, '-i', resolve(src, 'tailwind.input.css'), '-o', resolve(dist, 'tailwind.css'), '--minify'],
      { stdio: 'inherit' }
    );
    child.on('exit', (code) => (code === 0 ? resolvePromise() : reject(new Error('tailwindcss 退出码 ' + code))));
    child.on('error', reject);
  });
}

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

await Promise.all([
  ...STATIC_FILES.map((file) => cp(resolve(src, file), resolve(dist, file))),
  cp(resolve(src, 'icons'), resolve(dist, 'icons'), { recursive: true })
]);

// React + ReactDOM + re-resizable + 面板源码 → 单个 IIFE。
// 扩展 CSP 禁止 CDN 与 eval，因此所有依赖必须本地打包。
await build({
  entryPoints: [resolve(src, 'ui.jsx')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome100',
  minify: true,
  jsx: 'automatic',
  // 裁剪库的 css 以文本方式打进 bundle，再注入 shadow root
  loader: { '.css': 'text' },
  define: { 'process.env.NODE_ENV': '"production"' },
  outfile: resolve(dist, 'ui.js'),
  logLevel: 'info'
});

await compileCss();

// Tailwind 产物转成可注入的 JS（constructed stylesheet 用）
const css = await readFile(resolve(dist, 'tailwind.css'), 'utf8');
await writeFile(
  resolve(dist, 'tailwind-css.js'),
  'globalThis.__IMG_INSPECTOR_CSS__=' + JSON.stringify(css) + ';\n'
);

console.log('[build] dist/ 已生成');
