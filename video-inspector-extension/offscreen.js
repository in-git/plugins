'use strict';

// Offscreen mux: video + audio -> MP4 via ffmpeg.wasm single-thread core.
// Protocol (all binary as base64; sendMessage cannot carry ArrayBuffer):
//   in  vi-mux-init   { id, filename }
//   in  vi-mux-chunk  { id, stream:'video'|'audio', index, b64 }
//   in  vi-mux-go     { id }
//   out vi-mux-progress { id, ratio }
//   out vi-mux-result   { id, ok, size?, error? }

const sessions = new Map();
let ffmpegInstance = null;
let ffmpegLoading = null;
let muxLock = Promise.resolve();
let logBuffer = [];
let currentId = null;
let exitStatusSeen = false;

function b64ToU8(b64) {
  const bin = atob(b64 || '');
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concatChunks(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

function send(msg) {
  try { chrome.runtime.sendMessage(msg); } catch (_) {}
}

function getFFmpeg() {
  if (ffmpegInstance) return Promise.resolve(ffmpegInstance);
  if (ffmpegLoading) return ffmpegLoading;
  ffmpegLoading = (async () => {
    const base = chrome.runtime.getURL('lib/ffmpeg/');
    const { createFFmpeg } = self.FFmpeg;
    const inst = createFFmpeg({
      corePath: base + 'ffmpeg-core.js',
      wasmPath: base + 'ffmpeg-core.wasm',
      workerPath: base + 'ffmpeg-core.worker.js',
      mainName: 'main',
      log: false
    });
    inst.setLogger(({ message }) => {
      logBuffer.push(String(message || ''));
      if (logBuffer.length > 400) logBuffer.shift();
    });
    inst.setProgress((p) => {
      const ratio = p && typeof p === 'object' ? p.ratio : p;
      if (currentId != null && typeof ratio === 'number' && !isNaN(ratio)) {
        send({ type: 'vi-mux-progress', id: currentId, ratio });
      }
    });
    await inst.load();
    ffmpegInstance = inst;
    return inst;
  })().catch((e) => { ffmpegLoading = null; throw e; });
  return ffmpegLoading;
}

function probeVideoExt(buf) {
  if (buf.length > 3 && buf[0] === 0x1A && buf[1] === 0x45 && buf[2] === 0xDF && buf[3] === 0xA3) return 'webm';
  return 'mp4';
}

// 按魔数判断音频真实封装：固定写成 ina.mp4 + -acodec copy 会让 Opus/WebM/MP3 音轨被丢弃
function probeAudioExt(buf) {
  if (!buf || buf.length < 4) return 'm4a';
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const head = String.fromCharCode.apply(null, u8.subarray(0, Math.min(u8.length, 16)));
  if (/^OggS/.test(head)) return 'ogg';
  if (/^fLaC/.test(head)) return 'flac';
  if (/^ID3/.test(head) || (u8[0] === 0xFF && (u8[1] & 0xE0) === 0xE0)) return 'mp3';
  if (u8[0] === 0x1A && u8[1] === 0x45 && u8[2] === 0xDF && u8[3] === 0xA3) return 'webm';
  if (u8[0] === 0x47 && u8.length > 188) return 'ts';
  return 'm4a';
}

// 解析 MP4 的 hdlr box 确认存在 soun handler，比二次调用 ffmpeg 更可靠
function mp4HasAudioTrack(u8) {
  const decode = (part) => {
    let s = '';
    for (let i = 0; i < part.length; i += 8192) {
      s += String.fromCharCode.apply(null, part.subarray(i, Math.min(i + 8192, part.length)));
    }
    return s;
  };
  const head = u8.subarray(0, Math.min(u8.length, 4 * 1024 * 1024));
  const tail = u8.subarray(Math.max(0, u8.length - 4 * 1024 * 1024));
  return /hdlr[\s\S]{8}soun/.test(decode(head)) || /hdlr[\s\S]{8}soun/.test(decode(tail));
}

async function muxOnce(ff, videoBuf, audioBuf) {
  logBuffer = [];
  exitStatusSeen = false;
  const vName = 'inv.' + probeVideoExt(videoBuf);
  const aName = 'ina.' + probeAudioExt(audioBuf);
  const outName = 'out.mp4';
  [vName, aName, outName].forEach((f) => { try { ff.FS('unlink', f); } catch (_) {} });

  await ff.FS('writeFile', vName, videoBuf);
  await ff.FS('writeFile', aName, audioBuf);

  // 音频统一重编码为 AAC：海外常见 Opus/MP3/AC3 用 copy 塞进 MP4 会被直接丢掉。
  // 若 core 未启用 aac 编码器则退回 copy，至少不比旧版更差。
  let aacFailed = false;
  try {
    await ff.run(
      '-fflags', '+genpts', '-i', vName,
      '-fflags', '+genpts', '-i', aName,
      '-map', '0:v:0', '-map', '1:a:0',
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k',
      '-y', outName
    );
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (/exit\(0\)|Program terminated with exit/i.test(msg)) {
      exitStatusSeen = true;
    } else {
      aacFailed = true;
      console.warn('[VI-AUDIO] aac encode failed, retry stream copy', msg);
    }
  }
  if (aacFailed) {
    logBuffer = [];
    exitStatusSeen = false;
    [outName].forEach((f) => { try { ff.FS('unlink', f); } catch (_) {} });
    try {
      await ff.run(
        '-fflags', '+genpts', '-i', vName,
        '-fflags', '+genpts', '-i', aName,
        '-map', '0:v:0', '-map', '1:a:0',
        '-c:v', 'copy', '-c:a', 'copy',
        '-y', outName
      );
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (/exit\(0\)|Program terminated with exit/i.test(msg)) exitStatusSeen = true;
      else throw new Error('ffmpeg run failed: ' + msg + '\n' + logBuffer.slice(-25).join('\n'));
    }
  }

  let size = 0;
  try { size = ff.FS('stat', outName).size; } catch (_) { size = 0; }
  if (!size) {
    throw new Error('ffmpeg produced no output.\n' + (logBuffer.slice(-30).join('\n') || '(no ffmpeg log)'));
  }
  const inputTotal = videoBuf.length + audioBuf.length;
  if (size < inputTotal * 0.9) {
    throw new Error('mux output too small: input=' + inputTotal + ' output=' + size + ' (possible packet drop)\n' + logBuffer.slice(-30).join('\n'));
  }
  const data = new Uint8Array(ff.FS('readFile', outName));
  // 体积正常不等于有声音：解析 hdlr/soun 确认真的写入了音频轨
  if (!mp4HasAudioTrack(data)) {
    throw new Error('mux output has no audio track\n' + logBuffer.slice(-30).join('\n'));
  }
  [vName, aName, outName].forEach((f) => { try { ff.FS('unlink', f); } catch (_) {} });
  return data;
}

async function doMux(id, videoBuf, audioBuf) {
  const prev = muxLock;
  let release;
  muxLock = new Promise((r) => { release = r; });
  await prev;
  currentId = id;
  try {
    let ff;
    try {
      ff = await getFFmpeg();
    } catch (e) {
      throw new Error('ffmpeg core load failed: ' + String(e && e.message || e));
    }
    let result;
    try {
      result = await muxOnce(ff, videoBuf, audioBuf);
    } catch (e) {
      try { ff.exit(); } catch (_) {}
      ffmpegInstance = null;
      ffmpegLoading = null;
      throw e;
    }
    if (exitStatusSeen) {
      try { ff.exit(); } catch (_) {}
      ffmpegInstance = null;
      ffmpegLoading = null;
    }
    return result;
  } finally {
    currentId = null;
    release();
  }
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || !msg.type) return;
  // content 直连副本会广播到 offscreen，忽略带 tab 的 sender，只处理 background 转发副本。
  if (sender && sender.tab) return;

  if (msg.type === 'vi-mux-init') {
    sessions.set(msg.id, { filename: msg.filename || 'video.mp4', video: [], audio: [], vSeen: new Set(), aSeen: new Set() });
    return;
  }

  if (msg.type === 'vi-mux-chunk') {
    const s = sessions.get(msg.id);
    if (!s) return;
    const isAudio = msg.stream === 'audio';
    const seen = isAudio ? s.aSeen : s.vSeen;
    if (!seen.has(msg.index)) {
      seen.add(msg.index);
      (isAudio ? s.audio : s.video).push(b64ToU8(msg.b64));
    }
    return;
  }

  if (msg.type === 'vi-mux-go') {
    const id = msg.id;
    const s = sessions.get(id);
    sessions.delete(id);
    if (!s) {
      send({ type: 'vi-mux-result', id, ok: false, error: 'session lost' });
      return;
    }
    const videoBuf = concatChunks(s.video);
    const audioBuf = concatChunks(s.audio);
    s.video = s.audio = null;
    doMux(id, videoBuf, audioBuf).then((mp4) => {
      try {
        const blob = new Blob([mp4], { type: 'video/mp4' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = s.filename || 'video.mp4';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      } catch (e) {
        send({ type: 'vi-mux-result', id, ok: false, error: 'download failed: ' + String(e && e.message || e) });
        return;
      }
      send({ type: 'vi-mux-result', id, ok: true, size: mp4.length, hasAudio: true });
    }).catch((e) => {
      send({ type: 'vi-mux-result', id, ok: false, error: String(e && e.message || e) });
    });
  }
});

chrome.runtime.sendMessage({ type: 'vi-offscreen-ready' });
