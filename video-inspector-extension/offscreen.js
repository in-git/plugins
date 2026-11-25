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
    if (typeof self.createFFmpegCore !== 'function') {
      throw new Error('createFFmpegCore global unavailable (core script not loaded)');
    }
    debug('createFFmpegCore direct, base=' + base);
    const wasmUrl = base + 'ffmpeg-core.wasm';
    const core = await self.createFFmpegCore({
      // ffmpeg 的 main 结束时会调用 exit(0)；保持 runtime 存活，避免 core 被销毁后无法重复执行
      noExitRuntime: true,
      // 禁止从 stdin 读取：offscreen 没有 stdin，core 会回退到 window.prompt("Input:") 弹阻塞对话框
      stdin: () => null,
      locateFile: (path) => {
        if (/wasm$/.test(path)) return wasmUrl;
        return base + path;
      },
      print: (msg) => {
        logBuffer.push(String(msg || ''));
        if (logBuffer.length > 400) logBuffer.shift();
      },
      printErr: (msg) => {
        logBuffer.push(String(msg || ''));
        if (logBuffer.length > 400) logBuffer.shift();
      }
    });
    debug('createFFmpegCore resolved');
    // 包装成 wrapper 风格的接口。
    // 直接 core 的 FS 是对象（有 writeFile/readFile/unlink/stat 方法），
    // 而旧代码用的是 wrapper 风格 FS('writeFile', path, data) 函数，这里做适配。
    // core.run 是 Emscripten 的 wd()：初始化后再次调用只会命中 ud 已置位的空分支，
    // 不会执行 ffmpeg main —— 这正是“没有 ffmpeg log、没有输出文件”的原因。
    // 这里改为直接调用 _main，并按 wd() 内部的方式构造 argc/argv（argv[0] 是程序名）。
    const rawMain = core._main;
    if (typeof rawMain !== 'function') throw new Error('ffmpeg core has no _main entry');
    const fsm = core.FS;
    const fsShim = function (method) {
      const args = Array.prototype.slice.call(arguments, 1);
      if (!fsm || typeof fsm[method] !== 'function') throw new Error('ffmpeg FS.' + method + ' unavailable');
      return fsm[method].apply(fsm, args);
    };
    const inst = {
      FS: fsShim,
      run: function () {
        let args = Array.prototype.slice.call(arguments);
        if (args.length === 1 && Array.isArray(args[0])) args = args[0];
        const argv = ['ffmpeg'].concat(args.map(String));
        const ptrs = argv.map((arg) => {
          const bytes = core.lengthBytesUTF8(arg) + 1;
          const ptr = core._malloc(bytes);
          core.stringToUTF8(arg, ptr, bytes);
          return ptr;
        });
        const argvPtr = core._malloc((ptrs.length + 1) * 4);
        try {
          ptrs.forEach((ptr, i) => core.setValue(argvPtr + i * 4, ptr, 'i32'));
          core.setValue(argvPtr + ptrs.length * 4, 0, 'i32');
          debug('ffmpeg _main argc=' + ptrs.length);
          const status = rawMain(ptrs.length, argvPtr);
          debug('ffmpeg _main returned ' + status);
          if (status !== 0) {
            const err = new Error('Program terminated with exit(' + status + ')');
            err.status = status;
            throw err;
          }
          return status;
        } finally {
          ptrs.forEach((ptr) => core._free(ptr));
          core._free(argvPtr);
        }
      },
      setLogger: () => {},
      setProgress: () => {}
    };
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
  debug('files written v=' + vName + ' a=' + aName);

  // 音频统一重编码为 AAC：海外常见 Opus/MP3/AC3 用 copy 塞进 MP4 会被直接丢掉。
  // 若 core 未启用 aac 编码器则退回 copy，至少不比旧版更差。
  let aacFailed = false;
  try {
    debug('ffmpeg run aac start');
    await ff.run(
      '-fflags', '+genpts', '-i', vName,
      '-fflags', '+genpts', '-i', aName,
      '-map', '0:v:0', '-map', '1:a:0',
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k',
      '-y', outName
    );
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (/exit\(0\)|Program terminated with exit|^\s*0\s*$/i.test(msg)) {
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
      if (/exit\(0\)|Program terminated with exit|^\s*0\s*$/i.test(msg)) exitStatusSeen = true;
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

function debug(msg) {
  console.log('[VI-OFFSCREEN]', msg);
  send({ type: 'vi-mux-progress', id: currentId, ratio: 0, note: String(msg) });
}

async function doMux(id, videoBuf, audioBuf) {
  const prev = muxLock;
  let release;
  muxLock = new Promise((r) => { release = r; });
  await prev;
  currentId = id;
  try {
    debug('doMux start video=' + videoBuf.length + ' audio=' + audioBuf.length);
    let ff;
    try {
      debug('loading ffmpeg core');
      ff = await getFFmpeg();
      debug('ffmpeg core loaded');
    } catch (e) {
      throw new Error('ffmpeg core load failed: ' + String(e && e.message || e));
    }
    let result;
    try {
      debug('muxOnce start');
      result = await muxOnce(ff, videoBuf, audioBuf);
      debug('muxOnce done bytes=' + result.length);
    } catch (e) {
      ffmpegInstance = null;
      ffmpegLoading = null;
      throw e;
    }
    // 每次合并成功后都销毁 core：ffmpeg 的 MEMFS 里残留上一次的 out.mp4，
    // 复用 core 会让下一次合并读到旧文件（表现为"下载 B 却是 A 的内容"）。
    // 下次请求会重新 createFFmpegCore，拿到干净的 MEMFS。
    ffmpegInstance = null;
    ffmpegLoading = null;
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
