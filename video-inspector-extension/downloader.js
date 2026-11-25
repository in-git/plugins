(() => {
  'use strict';

  const REQUEST = '__video_inspector_download_request__';
  const RESPONSE = '__video_inspector_download_response__';
  const PROGRESS = '__video_inspector_download_progress__';
  const CANCEL = '__video_inspector_download_cancel__';
  const GET_RESOURCES = '__video_inspector_get_resources__';
  const RESOURCES = '__video_inspector_resources__';
  const DOWNLOAD_RESOURCE = '__video_inspector_download_resource__';
  const PROBE_SIZE = '__video_inspector_probe_size__';
  const PROBE_SIZE_RESPONSE = '__video_inspector_probe_size_response__';
  const GET_QUALITIES = '__video_inspector_get_qualities__';
  const QUALITIES = '__video_inspector_qualities__';
  const controllers = new Map();
  const MAX_ITEMS = 400;
  const MAX_BYTES = 1024 * 1024 * 1024;
  const NativeMediaSource = window.MediaSource;
  const objectUrlTargets = new WeakMap();
  const mseStates = new Map();
  const msEntries = new WeakMap();
  const engine = window.__viDownloadEngine || null;
  const qualityCache = new Map();
  const QUALITY_CACHE_TTL = 5 * 60 * 1000;

  function fire(name, detail) {
    document.dispatchEvent(new CustomEvent(name, { detail: JSON.stringify(detail) }));
  }

  function saveHref(href, filename) {
    const link = document.createElement('a');
    link.href = href;
    link.download = filename || 'video.mp4';
    link.rel = 'noopener';
    link.style.display = 'none';
    (document.body || document.documentElement).appendChild(link);
    link.click();
    setTimeout(() => link.remove(), 10000);
  }

  // ===== 嗅探资源库：只用于发现候选源和估算大小，不作为可信下载数据 =====
  const vault = [];
  const vaultIds = new Set();
  let vaultBytes = 0;

  function mediaKind(url, type) {
    if (type && /audio|mp3|m4a|aac|flac|wav|ogg|opus/i.test(type)) return 'audio';
    if (type && /video|mpegurl|mp4|webm/i.test(type)) return 'video';
    if (!url) return null;
    if (/(\.mp3|\.m4a|\.aac|\.flac|\.wav|\.ogg|\.opus)(\?|#|$)/i.test(url) || /\/audio\/|\/music\//i.test(url)) return 'audio';
    if (/(\.mp4|\.webm|\.m4v|\.ogv|\.mov|\.mkv|\.avi|\.flv|\.m3u8|\.mpd)(\?|#|$)/i.test(url)) return 'video';
    if (/\/video\/|\/videos\/|videoplayback|\/tos\/|\/aweme\/v\d+\/|v\d+-webapp[^/]*\/video\/|bilivideo|upos-sz|upos-hz/i.test(url)) return 'video';
    return null;
  }

  function looksLikeVideo(url, type) { return mediaKind(url, type) !== null; }

  function extractUrls(text) {
    if (!text || typeof text !== 'string') return [];
    const cleaned = text.replace(/\\u002F/gi, '/').replace(/\\\//g, '/').replace(/&amp;/g, '&');
    const matches = cleaned.match(/https?:\/\/[^\s"'<>`\\]+/g) || [];
    const out = [];
    for (const match of matches) {
      if (mediaKind(match)) out.push(match);
      if (out.length >= 100) break;
    }
    return out;
  }

  function shortName(url) {
    try { return decodeURIComponent(String(url).split('?')[0].split('/').pop()) || '媒体资源'; }
    catch (_) { return '媒体资源'; }
  }

  function store(entry) {
    if (!entry || !entry.url || vaultIds.has(entry.url)) return;
    if (vault.length >= MAX_ITEMS) return;
    const size = entry.size || 0;
    if (vaultBytes + size > MAX_BYTES) return;
    vaultIds.add(entry.url);
    vaultBytes += size;
    vault.push(entry);
    fire('__video_inspector_resources_updated__', { count: vault.length });
  }

  function storeUrl(url, source) {
    if (!url || !mediaKind(url)) return;
    store({
      id: 'url-' + vault.length + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      url,
      type: mediaKind(url) === 'audio' ? 'audio/mpeg' : 'video/mp4',
      size: 0,
      source: source || 'url',
      label: shortName(url),
      kind: mediaKind(url)
    });
  }

  function storeDashStreams(videoUrl, audioUrl, source) {
    if (!videoUrl) return;
    const key = 'dashstreams:' + videoUrl.split('?')[0];
    if (vaultIds.has(key)) return;
    const entry = {
      id: 'dash-' + vault.length + '-' + Date.now(),
      url: key,
      type: 'video/mp4',
      size: 0,
      source: source || 'playurl',
      label: audioUrl ? 'DASH 视频+音频' : 'DASH 视频',
      kind: 'streams',
      videoUrl,
      audioUrl: audioUrl || ''
    };
    if (vault.length >= MAX_ITEMS) return;
    vaultIds.add(key);
    vault.push(entry);
    fire('__video_inspector_resources_updated__', { count: vault.length });
  }

  // 解析 B站/DASH 类 playurl JSON：data.dash.video[]/audio[] 或 data.durl[]
  function parsePlaylistJson(text) {
    let data;
    try { data = JSON.parse(text); } catch (_) { return; }
    const d = data && data.data;
    if (!d) return;

    const pick = (arr) => {
      if (!Array.isArray(arr) || !arr.length) return '';
      const best = arr.find((x) => x && x.baseUrl) || arr[0];
      return best ? (best.baseUrl || best.backupUrl && best.backupUrl[0]) || '' : '';
    };

    // 新版 B站：DASH 音视频分离
    if (d.dash && (d.dash.video || d.dash.audio)) {
      const v = pick(d.dash.video);
      const a = pick(d.dash.audio);
      if (v) storeDashStreams(v, a, 'playurl');
    }
    // 旧版/HTML5：durl 直接是完整 MP4
    if (Array.isArray(d.durl) && d.durl.length) {
      const u = d.durl[d.durl.length - 1].url;
      if (u) storeUrl(u, 'playurl-durl');
    }
  }

  function storeResponse(url, contentType, buffer) {
    if (!buffer || buffer.byteLength < 1024) return;
    if (!looksLikeVideo(url, contentType)) return;
    store({
      id: 'res-' + vault.length + '-' + Date.now(),
      url,
      type: contentType || 'video/mp4',
      size: buffer.byteLength,
      source: 'network',
      label: shortName(url),
      kind: mediaKind(url, contentType) || 'video'
    });
  }

  // ===== 网络钩子（发现候选源） =====
  const origCreateObjectURL = URL.createObjectURL;
  URL.createObjectURL = function (obj) {
    const url = origCreateObjectURL.call(this, obj);
    try {
      objectUrlTargets.set(obj, url);
      if (obj instanceof Blob && (looksLikeVideo('', obj.type) || obj.size > 200 * 1024)) {
        store({
          id: 'blob-' + vault.length + '-' + Date.now(),
          url,
          matchUrl: url,
          type: obj.type || 'video/mp4',
          size: obj.size,
          source: 'blob',
          label: 'blob 视频',
          kind: mediaKind('', obj.type) || 'video'
        });
      }
    } catch (_) {}
    return url;
  };

  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      if (init && (init.__viInternalDownload || init.__viInternalProbe)) return origFetch.apply(this, arguments);
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const promise = origFetch.apply(this, arguments);
      try {
        promise.then((response) => {
          try {
            const type = response.headers.get('content-type') || '';
            const isManifest = /mpegurl|dash\+xml|xml/i.test(type) || /\.m3u8(\?|#|$)/i.test(url) || /\.mpd(\?|#|$)/i.test(url);
            if (isManifest && typeof response.clone === 'function') {
              response.clone().text().then((text) => {
                extractUrls(text).forEach((found) => storeUrl(found, 'api'));
                storeUrl(url, 'manifest');
              }).catch(() => {});
            } else if (looksLikeVideo(url, type) && response.body && typeof response.clone === 'function') {
              response.clone().arrayBuffer().then((buffer) => storeResponse(url, type, buffer)).catch(() => {});
            } else if (/json|text|javascript/i.test(type) && typeof response.clone === 'function') {
              response.clone().text().then((text) => {
                parsePlaylistJson(text);
                extractUrls(text).forEach((found) => storeUrl(found, 'api'));
              }).catch(() => {});
            }
          } catch (_) {}
          return response;
        }).catch(() => {});
      } catch (_) {}
      return promise;
    };
  }

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function () {
    this.__viUrl = arguments[1];
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    this.addEventListener('load', () => {
      try {
        const type = this.getResponseHeader('content-type') || '';
        const url = this.__viUrl || '';
        const isManifest = /mpegurl|dash\+xml|xml/i.test(type) || /\.m3u8(\?|#|$)/i.test(url) || /\.mpd(\?|#|$)/i.test(url);
        if (isManifest && typeof this.responseText === 'string') {
          extractUrls(this.responseText).forEach((found) => storeUrl(found, 'api'));
          storeUrl(url, 'manifest');
        } else if (/json|text|javascript/i.test(type) && typeof this.responseText === 'string') {
          parsePlaylistJson(this.responseText);
          extractUrls(this.responseText).forEach((found) => storeUrl(found, 'api'));
        }
        if (isManifest || !looksLikeVideo(url, type)) return;
        if (this.responseType === 'blob' && this.response instanceof Blob) {
          this.response.arrayBuffer().then((buf) => storeResponse(url, this.response.type || type, buf)).catch(() => {});
        } else if (this.responseType === 'arraybuffer' && this.response instanceof ArrayBuffer) {
          storeResponse(url, type, this.response);
        }
      } catch (_) {}
    });
    return origSend.apply(this, arguments);
  };

  if (NativeMediaSource && NativeMediaSource.prototype && NativeMediaSource.prototype.addSourceBuffer) {
    const origAddSourceBuffer = NativeMediaSource.prototype.addSourceBuffer;
    const origEndOfStream = NativeMediaSource.prototype.endOfStream;
    let mseIndex = 0;
    if (origEndOfStream) {
      NativeMediaSource.prototype.endOfStream = function () {
        const result = origEndOfStream.apply(this, arguments);
        const ids = (msEntries.get(this) || []).slice();
        setTimeout(() => ids.forEach((id) => {
          const state = mseStates.get(id);
          if (!state) return;
          state.finalized = true;
          clearInterval(state.timer);
          state.update();
        }), 300);
        return result;
      };
    }
    NativeMediaSource.prototype.addSourceBuffer = function (mimeType) {
      const sourceBuffer = origAddSourceBuffer.call(this, mimeType);
      const chunks = [];
      let total = 0, stored = false;
      const id = 'mse-' + (++mseIndex) + '-' + Date.now();
      const matchUrl = objectUrlTargets.get(this) || '';
      const state = { finalized: false, timer: 0, update: null };
      const update = () => {
        if (!chunks.length || total <= 1024) return;
        const blob = new Blob(chunks, { type: /video/i.test(mimeType || '') ? mimeType : 'video/mp4' });
        if (!stored) {
          store({ id, url: 'mse://video/' + id, matchUrl, type: blob.type, size: blob.size, blob, source: 'mse', label: 'MSE 视频流', kind: 'video' });
          stored = vault.some((entry) => entry.id === id);
        } else {
          const entry = vault.find((item) => item.id === id);
          if (entry) { entry.blob = blob; entry.size = blob.size; }
        }
      };
      state.update = update;
      mseStates.set(id, state);
      if (!msEntries.has(this)) msEntries.set(this, []);
      msEntries.get(this).push(id);
      try {
        const origAppend = sourceBuffer.appendBuffer;
        if (origAppend) {
          sourceBuffer.appendBuffer = function (data) {
            try {
              if (data && data.byteLength && total < MAX_BYTES) {
                chunks.push(new Uint8Array(data.slice ? data.slice(0) : new Uint8Array(data)));
                total += data.byteLength;
              }
            } catch (_) {}
            return origAppend.apply(this, arguments);
          };
        }
      } catch (_) {}
      state.timer = setInterval(update, 1500);
      setTimeout(() => {
        if (state.finalized) return;
        state.finalized = true;
        clearInterval(state.timer);
        update();
        mseStates.delete(id);
      }, 15 * 60 * 1000);
      return sourceBuffer;
    };
  }

  // ===== 事件响应 =====
  document.addEventListener(GET_RESOURCES, () => {
    fire(RESOURCES, {
      items: vault.map((entry) => ({
        id: entry.id, url: entry.url, matchUrl: entry.matchUrl || '', type: entry.type,
        size: entry.size, source: entry.source, label: entry.label,
        videoUrl: entry.videoUrl || '', audioUrl: entry.audioUrl || '',
        kind: entry.kind || mediaKind(entry.url, entry.type) || 'video'
      }))
    });
  });

  document.addEventListener(DOWNLOAD_RESOURCE, (event) => {
    let data;
    try { data = JSON.parse(event.detail); } catch (_) { return; }
    if (!data || !data.id) return;
    const entry = vault.find((item) => item.id === data.id);
    if (!entry || !entry.blob) {
      fire(RESPONSE, { id: data.requestId, ok: false, error: 'resource not available' });
      return;
    }
    (async () => {
      let objectUrl = '';
      try {
        const check = engine
          ? await engine.verifyBlob(entry.blob, data.expectedDuration || 0, 0)
          : { ok: entry.blob.size >= 512 };
        if (!check.ok) throw new Error('captured data incomplete: ' + check.error);
        objectUrl = URL.createObjectURL(entry.blob);
        saveHref(objectUrl, data.filename || 'video.mp4');
        fire(RESPONSE, { id: data.requestId, ok: true, method: 'resource', size: entry.blob.size, validated: true });
      } catch (error) {
        fire(RESPONSE, { id: data.requestId, ok: false, error: String((error && error.message) || error) });
      } finally {
        if (objectUrl) setTimeout(() => URL.revokeObjectURL(objectUrl), 15 * 60 * 1000);
      }
    })();
  });

  document.addEventListener(CANCEL, (event) => {
    let data;
    try { data = JSON.parse(event.detail); } catch (_) { return; }
    if (!data || !data.id) return;
    const controller = controllers.get(data.id);
    if (controller) { try { controller.abort(); } catch (_) {} controllers.delete(data.id); }
  });

  document.addEventListener(PROBE_SIZE, (event) => {
    let data;
    try { data = JSON.parse(event.detail); } catch (_) { return; }
    if (!data || !data.id) return;
    const id = data.id, url = data.url;
    const respond = (size) => fire(PROBE_SIZE_RESPONSE, { id, size: size || 0 });
    if (!url || !/^https?:\/\//i.test(url)) { respond(0); return; }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const parseSize = (response) => {
      const range = (response.headers.get('content-range') || '').match(/\/(\d+)\s*$/);
      if (range) return Number(range[1]);
      return Number(response.headers.get('content-length')) || 0;
    };
    (async () => {
      let response = await fetch(url, { method: 'HEAD', credentials: 'include', signal: controller.signal, __viInternalProbe: true });
      let size = parseSize(response);
      if (!size) {
        response = await fetch(url, { headers: { Range: 'bytes=0-0' }, credentials: 'include', signal: controller.signal, __viInternalProbe: true });
        size = parseSize(response);
      }
      clearTimeout(timer);
      respond(size);
    })().catch(() => { clearTimeout(timer); respond(0); });
  });

  document.addEventListener(GET_QUALITIES, (event) => {
    let data;
    try { data = JSON.parse(event.detail); } catch (_) { return; }
    if (!data || !data.id) return;
    const id = data.id;
    const pageUrl = data.pageUrl || location.href;
    if (!engine || typeof engine.resolveBilibiliQualities !== 'function') {
      fire(QUALITIES, { id, qualities: [] });
      return;
    }
    const cached = qualityCache.get(pageUrl);
    if (cached && Date.now() - cached.ts < QUALITY_CACHE_TTL) {
      fire(QUALITIES, { id, qualities: cached.qualities });
      return;
    }
    const meta = (typeof engine.referrerMeta === 'function')
      ? engine.referrerMeta(pageUrl, '', null, '')
      : null;
    engine.resolveBilibiliQualities(pageUrl, meta).then((qualities) => {
      const list = qualities || [];
      if (list.length) qualityCache.set(pageUrl, { ts: Date.now(), qualities: list });
      fire(QUALITIES, { id, qualities: list });
    }).catch(() => {
      fire(QUALITIES, { id, qualities: [] });
    });
  });

  document.addEventListener(REQUEST, (event) => {
    let payload;
    try { payload = JSON.parse(event.detail); } catch (_) { return; }
    if (!payload || !payload.id) return;
    const id = payload.id;
    const filename = payload.filename;
    const expectedDuration = payload.expectedDuration;
    const expectedSize = payload.expectedSize;
    const forceKind = payload.forceKind;
    let url = payload.url;
    let videoUrl = payload.videoUrl;
    let audioUrl = payload.audioUrl;
    console.log('[VI-AUDIO] request', {
      id, forceKind: forceKind || '', url: String(url || '').slice(0, 160),
      videoUrl: String(videoUrl || '').slice(0, 120), audioUrl: String(audioUrl || '').slice(0, 120),
      qualityId: payload.qualityId || ''
    });

    if (!engine) {
      fire(RESPONSE, { id, ok: false, error: 'download engine unavailable', validated: false });
      return;
    }

    const controller = new AbortController();
    controllers.set(id, controller);
    let objectUrl = '';

    const onProgress = (loaded, total) => {
      const percent = total > 0 ? Math.min(99, Math.round((loaded / total) * 100)) : 0;
      fire(PROGRESS, { id, loaded, total, percent, phase: 'downloading' });
    };

    (async () => {
      let kind = forceKind || engine.detectKind(url);

      // 平台解析：B站/抖音等主动调接口拿真实流地址
      if (forceKind === 'platform' || (kind === 'blob' && typeof engine.resolvePlatform === 'function')) {
        const resolvedMeta = (typeof engine.referrerMeta === 'function')
          ? engine.referrerMeta(payload.pageUrl || '', url || '', null, '')
          : null;
        const resolved = await engine.resolvePlatform(url, payload.pageUrl, payload.qualityId, resolvedMeta || undefined);
        console.log('[VI-AUDIO] platform resolved', {
          kind: resolved && resolved.kind,
          videoUrl: String((resolved && resolved.videoUrl) || '').slice(0, 160),
          audioUrl: String((resolved && resolved.audioUrl) || '').slice(0, 160)
        });
        if (resolved && resolved.videoUrl) {
          kind = resolved.kind;
          payload.videoUrl = resolved.videoUrl;
          payload.audioUrl = resolved.audioUrl || '';
          url = resolved.videoUrl;
          if (resolved.headers) payload.headers = resolved.headers;
          if (resolved.userAgent) payload.userAgent = resolved.userAgent;
          if (resolved.credentials) payload.credentials = resolved.credentials;
        } else {
          throw new Error('platform resolve failed');
        }
      }

      // 带 Cookie 请求（TikTok CDN 直链必须 include 才 200）
      const dlMeta = (payload.userAgent || payload.credentials)
        ? {
            userAgent: payload.userAgent || '',
            referrer: payload.pageUrl || '',
            headers: payload.headers || null,
            credentials: payload.credentials || 'omit'
          }
        : null;
      const dlArg = dlMeta
        ? { __viMeta: dlMeta, __viHeaders: payload.headers || null }
        : payload.headers;

      if (!url) throw new Error('empty url');
      if (kind === 'blob' || kind === 'record') throw new Error('needs_recording');

      let result;
      if (kind === 'streams' && payload.videoUrl) {
        const v = await engine.fetchWhole(payload.videoUrl, controller.signal, onProgress, dlArg);
        let a = null;
        if (payload.audioUrl) {
          try { a = await engine.fetchWhole(payload.audioUrl, controller.signal, onProgress, dlArg); }
          catch (e) { console.warn('[VI-AUDIO] audio fetch failed', String(e && e.message || e)); a = null; }
        } else {
          console.warn('[VI-AUDIO] streams without audioUrl -> will be silent');
        }
        console.log('[VI-AUDIO] streams fetched', { videoBytes: (v.tracks[0] && v.tracks[0].size) || 0, audioBytes: (a && a.tracks[0] && a.tracks[0].size) || 0 });
        result = {
          tracks: a ? [v.tracks[0], a.tracks[0]] : [v.tracks[0]],
          ext: 'mp4', duration: expectedDuration || 0, skipDurationCheck: !!a
        };
      } else if (kind === 'streams' && videoUrl) {
        const v = await engine.fetchWhole(videoUrl, controller.signal, onProgress, dlArg);
        let a = null;
        if (audioUrl) {
          try { a = await engine.fetchWhole(audioUrl, controller.signal, onProgress, dlArg); }
          catch (e) { console.warn('[VI-AUDIO] audio fetch failed', String(e && e.message || e)); a = null; }
        } else {
          console.warn('[VI-AUDIO] streams without audioUrl -> will be silent');
        }
        result = {
          tracks: a ? [v.tracks[0], a.tracks[0]] : [v.tracks[0]],
          ext: 'mp4', duration: expectedDuration || 0, skipDurationCheck: false
        };
      } else if (kind === 'hls') result = await engine.downloadHls(url, controller.signal, onProgress, expectedDuration, dlMeta || undefined);
      else if (kind === 'dash') result = await engine.downloadDash(url, controller.signal, onProgress, expectedDuration, dlMeta || undefined);
      else result = await engine.fetchWhole(url, controller.signal, onProgress, dlArg);

      let tracks = result.tracks || [result.blob];
      let finalBlob;
      let finalExt = result.ext || 'mp4';
      console.log('[VI-AUDIO] result', { kind, trackCount: tracks.length, ext: finalExt, sizes: tracks.map((t) => t && t.size || 0) });

      if (tracks.length > 1) {
        fire(PROGRESS, { id, loaded: 0, total: 100, percent: 0, phase: 'merging' });
        const buffers = [];
        for (const t of tracks) {
          let buf = await t.arrayBuffer();
          if (engine.isTsHead(buf)) {
            buf = await engine.tsToMp4(buf, () => {});
          }
          buffers.push(buf);
        }
        // 视频轨本身已有音轨时不需要合并
        let needMerge = true;
        if (typeof engine.probeTracks === 'function') {
          try {
            const vp = await engine.probeTracks(buffers[0]);
            needMerge = !vp.hasAudio;
            console.log('[VI-AUDIO] probe video track', vp);
          } catch (e) { console.warn('[VI-AUDIO] probe failed', e); needMerge = true; }
        }
        if (!needMerge) {
          console.warn('[VI-AUDIO] skip merge: source video already has audio');
          finalBlob = tracks[0];
          finalExt = result.ext || 'mp4';
        } else try {
          finalBlob = await engine.mergeStreams(buffers);
          finalExt = 'mp4';
          console.log('[VI-AUDIO] merge ok, bytes', finalBlob.size);
        } catch (mergeError) {
          // 合并失败（如音频是 MP3 无法注入 MP4 容器）：回退为仅保存视频轨，避免整体失败。
          console.error('[VI-AUDIO] merge FAILED -> fallback to silent video', mergeError);
          finalBlob = tracks[0];
          finalExt = result.ext || 'mp4';
        }
      } else {
        finalBlob = tracks[0];
        // 单轨 TS → 转封装为 MP4，方便直接播放
        if (finalExt === 'ts' && typeof engine.tsToMp4 === 'function') {
          try {
            fire(PROGRESS, { id, loaded: 0, total: 100, percent: 0, phase: 'merging' });
            const mp4Buf = await engine.tsToMp4(await finalBlob.arrayBuffer(), () => {});
            finalBlob = new Blob([mp4Buf], { type: 'video/mp4' });
            finalExt = 'mp4';
          } catch (_) {
            // 转封装失败则保留原始 TS
          }
        }
      }

      // 最终校验：probeTracks 的 audioTracks 取 MP4Box 解析值与二进制 soun 计数的最大值，
      // fMP4 中 soun 常被重复扫描到，>1 多为误判。只有原始视频轨本身带音轨时多轨才是真异常；
      // 否则回退会把已经合并进去的音频丢掉，导致下载的视频没声音。
      if (typeof engine.probeTracks === 'function' && tracks.length > 1) {
        try {
          const probe = await engine.probeTracks(await finalBlob.arrayBuffer());
          console.log('[VI-AUDIO] final probe', probe, 'size', finalBlob.size);
          if (probe.audioTracks > 1) {
            let sourceHasAudio = false;
            try {
              const sourceProbe = await engine.probeTracks(await tracks[0].arrayBuffer());
              sourceHasAudio = !!(sourceProbe && sourceProbe.hasAudio);
            } catch (_) {}
            console.warn('[VI-AUDIO] multi-audio, sourceHasAudio=', sourceHasAudio);
            if (sourceHasAudio) {
              finalBlob = tracks[0];
              finalExt = result.ext || 'mp4';
            }
          }
        } catch (e) {
          if (/no audio track/i.test(String(e && e.message))) throw e;
        }
      }

      fire(PROGRESS, { id, loaded: finalBlob.size, total: finalBlob.size, percent: 100, phase: 'verifying' });
      // 合并产物（fMP4/DASH/双流）的容器 duration 常不精确，跳过严格时长比对，仅校验容器与大小
      const isMerged = tracks.length > 1 || finalExt === 'ts';
      const checkDuration = isMerged || result.skipDurationCheck ? 0 : (expectedDuration || result.duration || 0);
      const check = await engine.verifyBlob(finalBlob, checkDuration, expectedSize);
      if (!check.ok) throw new Error(check.error);

      objectUrl = URL.createObjectURL(finalBlob);
      const baseName = String(filename || 'video').replace(/\.[^.]+$/, '');
      saveHref(objectUrl, baseName + '.' + finalExt);
      fire(RESPONSE, { id, ok: true, method: kind, size: finalBlob.size, duration: result.duration, validated: true });
    })().catch((error) => {
      const message = String((error && error.message) || error);
      const cancelled = controller.signal.aborted || /abort|cancel/i.test(message);
      fire(RESPONSE, { id, ok: false, error: cancelled ? 'cancelled' : message, validated: false });
    }).finally(() => {
      controllers.delete(id);
      if (objectUrl) setTimeout(() => URL.revokeObjectURL(objectUrl), 15 * 60 * 1000);
    });
  });
})();
