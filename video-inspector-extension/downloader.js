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
  const RESUME_QUERY = '__video_inspector_resume_query__';
  const RESUME_LIST = '__video_inspector_resume_list__';
  const SCAN_RESOURCES = '__video_inspector_scan_resources__';
  const SCAN_RESULT = '__video_inspector_scan_result__';
  const MUX_REQUEST = '__video_inspector_mux_request__';
  const MUX_RESPONSE = '__video_inspector_mux_response__';
  const MSE_DIRECT_REQUEST = '__video_inspector_mse_direct_request__';
  const MSE_DIRECT_RESPONSE = '__video_inspector_mse_direct_response__';
  const MANIFEST_FOUND = '__video_inspector_manifest_found__';
  const controllers = new Map();
  const jobLocks = new Map();
  const jobControllers = new Map();
  const MAX_ITEMS = 400;
  const MAX_BYTES = 1024 * 1024 * 1024;
  const NativeMediaSource = window.MediaSource;
  const objectUrlTargets = new WeakMap();
  const mseStates = new Map();
  const msEntries = new WeakMap();
  const engine = window.__viDownloadEngine || null;
  const qualityCache = new Map();
  const QUALITY_CACHE_TTL = 5 * 60 * 1000;

  // ===== 断点续传：未完成的分块落盘到页面同源 IndexedDB，刷新/断网后可继续 =====
  const DB_NAME = 'vi-downloads';
  const DB_VERSION = 1;
  const JOB_TTL = 7 * 24 * 60 * 60 * 1000;
  const FLUSH_BYTES = 8 * 1024 * 1024;
  let dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve) => {
      let req;
      try { req = indexedDB.open(DB_NAME, DB_VERSION); } catch (_) { resolve(null); return; }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('jobs')) db.createObjectStore('jobs', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('chunks')) {
          const store = db.createObjectStore('chunks', { keyPath: 'id' });
          store.createIndex('jobId', 'jobId', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    });
    return dbPromise;
  }

  function idbRun(storeName, mode, fn) {
    return openDb().then((db) => new Promise((resolve) => {
      if (!db) { resolve(null); return; }
      try {
        const tx = db.transaction(storeName, mode);
        const os = tx.objectStore(storeName);
        let out = null;
        const ret = fn(os, (v) => { out = v; });
        if (ret && ret.__viReq) {
          ret.__viReq.onsuccess = () => { out = ret.__viReq.result; };
        }
        tx.oncomplete = () => resolve(out);
        tx.onerror = () => resolve(null);
        tx.onabort = () => resolve(null);
      } catch (_) { resolve(null); }
    }));
  }

  function jobGet(id) {
    return idbRun('jobs', 'readonly', (os, done) => {
      const req = os.get(id);
      req.onsuccess = () => done(req.result || null);
      return { __viReq: req };
    });
  }

  function jobPut(job) {
    job.updatedAt = Date.now();
    return idbRun('jobs', 'readwrite', (os) => { os.put(job); });
  }

  function chunkPut(record) {
    return idbRun('chunks', 'readwrite', (os) => { os.put(record); });
  }

  function chunksFor(jobId, role) {
    return openDb().then((db) => new Promise((resolve) => {
      if (!db) { resolve([]); return; }
      const out = [];
      try {
        const tx = db.transaction('chunks', 'readonly');
        const cursor = tx.objectStore('chunks').index('jobId').openCursor(IDBKeyRange.only(jobId));
        cursor.onsuccess = () => {
          const cur = cursor.result;
          if (!cur) return;
          if (cur.value.role === role) out.push(cur.value);
          cur.continue();
        };
        tx.oncomplete = () => resolve(out.sort((a, b) => a.seq - b.seq));
        tx.onerror = () => resolve([]);
      } catch (_) { resolve([]); }
    }));
  }

  function chunksDeleteRole(jobId, role) {
    return openDb().then((db) => new Promise((resolve) => {
      if (!db) { resolve(); return; }
      try {
        const tx = db.transaction('chunks', 'readwrite');
        const cursor = tx.objectStore('chunks').index('jobId').openCursor(IDBKeyRange.only(jobId));
        cursor.onsuccess = () => {
          const cur = cursor.result;
          if (!cur) return;
          if (cur.value.role === role) cur.delete();
          cur.continue();
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch (_) { resolve(); }
    }));
  }

  function jobDelete(id) {
    return openDb().then((db) => new Promise((resolve) => {
      if (!db) { resolve(); return; }
      try {
        const tx = db.transaction(['jobs', 'chunks'], 'readwrite');
        tx.objectStore('jobs').delete(id);
        const cursor = tx.objectStore('chunks').index('jobId').openCursor(IDBKeyRange.only(id));
        cursor.onsuccess = () => {
          const cur = cursor.result;
          if (!cur) return;
          cur.delete();
          cur.continue();
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch (_) { resolve(); }
    }));
  }

  function jobPercent(job) {
    const tracks = Object.keys(job.tracks || {}).map((k) => job.tracks[k]).filter((tr) => tr && tr.loaded > 0);
    if (!tracks.length) return 0;
    const loaded = tracks.reduce((sum, tr) => sum + (tr.loaded || 0), 0);
    const total = tracks.reduce((sum, tr) => sum + (tr.total || 0), 0);
    if (!total) return 0;
    return Math.max(1, Math.min(99, Math.round((loaded / total) * 100)));
  }

  function jobsForPage(pageUrl) {
    const target = resourceKey(pageUrl || '');
    return openDb().then((db) => new Promise((resolve) => {
      if (!db) { resolve([]); return; }
      const out = [];
      try {
        const tx = db.transaction('jobs', 'readonly');
        const cursor = tx.objectStore('jobs').openCursor();
        cursor.onsuccess = () => {
          const cur = cursor.result;
          if (!cur) return;
          const job = cur.value;
          if (!job || !job.pageUrl) { cur.continue(); return; }
          if (Date.now() - (job.updatedAt || 0) > JOB_TTL) {
            cur.delete();
            cur.continue();
            return;
          }
          if (resourceKey(job.pageUrl) === target) out.push(job);
          cur.continue();
        };
        tx.oncomplete = () => {
          resolve(out
            .map((job) => ({
              id: job.id,
              filename: job.filename || '',
              jobKey: job.jobKey || '',
              pageUrl: job.pageUrl,
              percent: jobPercent(job),
              size: Object.keys(job.tracks || {}).reduce((sum, k) => sum + (job.tracks[k] && job.tracks[k].loaded || 0), 0),
              updatedAt: job.updatedAt || 0
            }))
            .sort((a, b) => b.updatedAt - a.updatedAt));
        };
        tx.onerror = () => resolve([]);
      } catch (_) { resolve([]); }
    }));
  }

  function hashStr(text) {
    let h = 5381;
    const s = String(text || '');
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  function jobIdFor(payload, filename) {
    // 刻意不包含签名直链：TikTok 等平台的 CDN 域名/签名每次解析都会变，包含它将永远对不上断点；
    // 页面传入的 jobKey 取资源 URL 的 origin+pathname，用于区分同一页面里的多个视频。
    return 'vi' + hashStr([
      resourceKey(payload.pageUrl || ''),
      payload.qualityId || '',
      payload.jobKey || '',
      String(filename || '').replace(/\.[^.]+$/, '')
    ].join('|'));
  }

  function fire(name, detail) {
    document.dispatchEvent(new CustomEvent(name, { detail: JSON.stringify(detail) }));
  }

  // 经 content(隔离世界) -> background -> offscreen 用 ffmpeg 合并。
  // 成功时 offscreen 已直接触发下载，这里只回传状态；blob 不序列化，用 CustomEvent detail 对象引用传递。
  function muxViaOffscreen(id, videoBlob, audioBlob, filename) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        document.removeEventListener(MUX_RESPONSE, onResponse);
        reject(new Error('offscreen mux timeout'));
      }, 180000);
      function onResponse(event) {
        const data = event.detail;
        if (!data || data.id !== id) return;
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        document.removeEventListener(MUX_RESPONSE, onResponse);
        if (data.ok) resolve({ size: data.size || 0, downloaded: true, hasAudio: data.hasAudio !== false });
        else reject(new Error(data.error || 'offscreen mux failed'));
      }
      document.addEventListener(MUX_RESPONSE, onResponse);
      document.dispatchEvent(new CustomEvent(MUX_REQUEST, {
        detail: { id, videoBlob, audioBlob, filename }
      }));
    });
  }

  function detectAudioExt(blob) {
    const type = String((blob && blob.type) || '').toLowerCase();
    if (/mpeg|mp3/.test(type)) return 'mp3';
    if (/ogg|opus/.test(type)) return 'ogg';
    if (/webm/.test(type)) return 'webm';
    if (/aac|mp4|m4a/.test(type)) return 'm4a';
    return 'm4a';
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

  // ===== 三层资源模型 Layer 1：页面资源发现（不依赖正在播放的 video） =====
  // 只登记元数据，不保留响应体，避免受 MAX_ITEMS / MAX_BYTES 限制。
  const pageResourceEntries = new Map();

  function normalizeResourceUrl(raw) {
    if (!raw || typeof raw !== 'string') return '';
    let text = String(raw).trim()
      .replace(/\\u002F/gi, '/').replace(/\\\//g, '/')
      .replace(/&amp;/g, '&').replace(/&quot;/g, '"');
    if (!text || /^(blob|data|mse|javascript):/i.test(text)) return '';
    try {
      if (/^\/\//.test(text)) text = location.protocol + text;
      text = new URL(text, location.href).href;
    } catch (_) { return ''; }
    return /^https?:\/\//i.test(text) ? text : '';
  }

  function resourceKey(url) {
    try {
      const u = new URL(url);
      return u.origin + u.pathname;
    } catch (_) {
      return String(url).split('?')[0];
    }
  }

  function mediaScore(url) {
    if (/\.(mp4|m4v|webm|mov|mkv|avi|flv)(\?|#|$)/i.test(url)) return 90;
    if (/\.m3u8(\?|#|$)/i.test(url) || /\.mpd(\?|#|$)/i.test(url)) return 85;
    if (/\/video\/|\/videos\/|videoplayback|\/video\/tos\/|v\d+-webapp[^/]*\/video\/|bilivideo|upos-sz|upos-hz|tiktokcdn|byteoversea|aweme|douyinvod/i.test(url)) return 75;
    if (/\.(mp3|m4a|aac|ogg|opus|flac|wav)(\?|#|$)/i.test(url)) return 20;
    return 0;
  }

  function addPageResource(raw, opts) {
    const url = normalizeResourceUrl(raw);
    if (!url) return;
    const key = resourceKey(url);
    if (!key) return;
    const score = mediaScore(url);
    if (score < 60) return;
    const prev = pageResourceEntries.get(key);
    if (prev && (prev.score || 0) >= score) return;
    let name = '';
    try { name = decodeURIComponent(url.split('?')[0].split('/').pop()) || ''; } catch (_) {}
    pageResourceEntries.set(key, Object.assign({
      id: 'scan-' + key,
      url,
      key,
      score,
      kind: /\.m3u8(\?|#|$)/i.test(url) ? 'hls' : /\.mpd(\?|#|$)/i.test(url) ? 'dash' : 'direct',
      title: name,
      poster: '',
      videoUrl: '',
      audioUrl: '',
      width: 0,
      height: 0,
      duration: 0,
      size: 0,
      source: 'scan'
    }, opts || {}));
  }

  // 从页面内嵌 JSON / DOM 属性 / 网络记录里枚举候选。
  function collectPageResources() {
    try {
      document.querySelectorAll('script:not([src])').forEach((script) => {
        const text = script.textContent || '';
        if (text.length < 20) return;
        (text.match(/https?:\/\/[^"'\s<>\\`]+/g) || []).forEach((url) => addPageResource(url, { source: 'script' }));
      });
    } catch (_) {}

    try {
      document.querySelectorAll('*').forEach((el) => {
        ['src', 'data-src', 'data-url', 'data-video', 'data-video-url', 'href'].forEach((attr) => {
          const value = el.getAttribute && el.getAttribute(attr);
          if (value) addPageResource(value, { source: 'dom' });
        });
      });
    } catch (_) {}

    try {
      (performance.getEntriesByType('resource') || []).forEach((entry) => {
        addPageResource(entry && entry.name, { source: 'performance' });
      });
    } catch (_) {}

    vault.forEach((entry) => {
      if (!entry || !entry.url) return;
      addPageResource(entry.url, {
        source: entry.source || 'network',
        size: entry.size || 0,
        videoUrl: entry.videoUrl || '',
        audioUrl: entry.audioUrl || '',
        kind: entry.kind || 'direct',
        title: entry.label || '',
        score: Math.max(75, mediaScore(entry.url))
      });
    });

    return Array.from(pageResourceEntries.values());
  }

  // ===== webRequest 嗅探到的 manifest 入库 =====
  const sniffedManifests = new Set();
  document.addEventListener(MANIFEST_FOUND, (event) => {
    let data;
    try { data = JSON.parse(event.detail); } catch (_) { return; }
    if (!data || !data.url || !/^https?:\/\//i.test(data.url)) return;
    if (sniffedManifests.has(data.url)) return;
    sniffedManifests.add(data.url);
    const kind = /\.mpd(\?|#|$)/i.test(data.url) || data.kind === 'dash' ? 'dash' : 'hls';
    // 直接登记为 manifest 资源；downloadHls/downloadDash 会在真正下载时读清单配对音轨
    addPageResource(data.url, { source: 'webrequest', kind, score: 95 });
    storeUrl(data.url, 'webrequest');
    // 异步校验清单有效性（含独立音轨标记），只写日志不阻断入库
    if (engine && typeof engine.inspectManifestUrl === 'function') {
      const pageUrl = location.href;
      const meta = (typeof engine.referrerMeta === 'function')
        ? engine.referrerMeta(pageUrl, data.url, null, '') : null;
      engine.inspectManifestUrl(data.url, meta).then((info) => {
        if (!info || !info.ok) {
          console.warn('[VI-SNIFF] manifest unusable', data.url.slice(0, 160), info && info.error);
          return;
        }
        console.log('[VI-SNIFF] manifest', { kind: info.kind, hasAudioTrack: info.hasAudioTrack, url: data.url.slice(0, 160) });
        if (info.hasAudioTrack) {
          const key = resourceKey(data.url);
          const prev = pageResourceEntries.get(key);
          if (prev) pageResourceEntries.set(key, Object.assign({}, prev, { hasAudioTrack: true }));
        }
      }).catch((e) => console.warn('[VI-SNIFF] inspect failed', String(e && e.message || e)));
    }
  });

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

  // 临时诊断（v1.17.0）：验证 MSE appendBuffer 能否拿到 YouTube 音频分片
  const mseDiag = {
    nativeMediaSource: !!NativeMediaSource,
    hooked: false,
    addCalls: 0,
    appendCalls: 0,
    buffers: [],
    summary() {
      return {
        nativeMediaSource: this.nativeMediaSource,
        hooked: this.hooked,
        addCalls: this.addCalls,
        appendCalls: this.appendCalls,
        buffers: this.buffers.map((b) => ({ mimeType: b.mimeType, calls: b.calls, bytes: b.bytes }))
      };
    }
  };
  try { window.__viMseDiag = mseDiag; } catch (_) {}

  // 诊断用：在控制台执行 window.__viDownloadMseAudio() 直接保存当前攒到的音频分片
  try {
    window.__viMseDump = function () {
      const out = vault.filter((item) => item && /^mse-(audio|video)$/.test(item.source || '') && item.blob)
        .map((item) => ({ id: item.id, source: item.source, size: item.blob.size, type: item.type }));
      console.log('[VI-MSE-DIAG] entries', JSON.stringify(out));
      return out;
    };
    window.__viDownloadMseAudio = async function () {
      const entries = vault.filter((item) => item && item.source === 'mse-audio' && item.blob && item.blob.size > 1024)
        .sort((a, b) => b.blob.size - a.blob.size);
      const entry = entries[0];
      if (!entry) { console.warn('[VI-MSE-DIAG] no audio MSE blob yet'); return false; }
      const head = new Uint8Array(await entry.blob.slice(0, 32).arrayBuffer());
      const hex = Array.from(head).map((b) => b.toString(16).padStart(2, '0')).join(' ');
      let ext = 'bin';
      if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) ext = 'webm';
      else if ((head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70) ||
               (head[8] === 0x66 && head[9] === 0x74 && head[10] === 0x79 && head[11] === 0x70)) ext = 'm4a';
      console.log('[VI-MSE-DIAG] audio head', hex, 'size', entry.blob.size, 'type', entry.type, 'entries', entries.length);
      saveHref(URL.createObjectURL(entry.blob), 'youtube-audio.' + ext);
      return true;
    };
    window.__viDownloadMseVideo = async function () {
      const entries = vault.filter((item) => item && item.source === 'mse-video' && item.blob && item.blob.size > 1024)
        .sort((a, b) => b.blob.size - a.blob.size);
      const entry = entries[0];
      if (!entry) { console.warn('[VI-MSE-DIAG] no video MSE blob yet'); return false; }
      const head = new Uint8Array(await entry.blob.slice(0, 32).arrayBuffer());
      const hex = Array.from(head).map((b) => b.toString(16).padStart(2, '0')).join(' ');
      console.log('[VI-MSE-DIAG] video head', hex, 'size', entry.blob.size, 'type', entry.type, 'entries', entries.length);
      saveHref(URL.createObjectURL(entry.blob), 'youtube-video.mp4');
      return true;
    };
    // 诊断用：把攒到的 MSE 音视频分流送进 offscreen ffmpeg 合并，直接下载 MP4
    window.__viMseMuxTest = async function (customFilename, forcedMuxId, matchUrl) {
      // 关键：按视频的 blob URL（matchUrl）精确匹配分片，A/B 两个视频同时存在时不会串台。
      // 控制台直接调用时没传 matchUrl，退回“最近创建的一组”保持原诊断行为。
      const createdAt = (entry) => {
        const parts = String(entry && entry.id || '').split('-');
        const n = Number(parts[parts.length - 1]);
        return Number.isFinite(n) ? n : 0;
      };
      const pick = (source) => {
        let list = vault.filter((x) => x && x.source === source && x.blob && x.blob.size > 1024);
        if (matchUrl) {
          const matched = list.filter((x) => x.matchUrl === matchUrl);
          if (matched.length) list = matched;
        }
        return list.sort((x, y) => createdAt(y) - createdAt(x))[0];
      };
      const a = pick('mse-audio');
      const v = pick('mse-video');
      if (!a || !v) { console.warn('[VI-MSE-DIAG] need both audio+video MSE blobs', !!a, !!v, 'matchUrl', matchUrl); return false; }
      const base = String(customFilename || 'youtube-mse-mux').replace(/\.[^.]+$/, '').slice(0, 80) || 'youtube-mse-mux';
      const fname = base + '-' + Date.now() + '.mp4';
      console.log('[VI-MSE-DIAG] mux(ffmpeg offscreen) start', { audio: a.blob.size, video: v.blob.size, at: a.type, vt: v.type, file: fname, aid: a.id, vid: v.id });
      try {
        const muxId = forcedMuxId || ('mse-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
        const r = await muxViaOffscreen(muxId, v.blob, a.blob, fname);
        console.log('[VI-MSE-DIAG] mux ok', r);
        return true;
      } catch (e) {
        console.warn('[VI-MSE-DIAG] mux failed', String(e && e.message || e));
        return false;
      }
    };
  } catch (_) {}

  // 模态框下载：直接触发诊断函数 __viMseMuxTest()，与控制台命令走完全相同的函数。
  // 通道只负责跨 world 传递“调用请求/结果”，不重复实现任何取流或合并逻辑。
  document.addEventListener(MSE_DIRECT_REQUEST, async (event) => {
    let detail;
    try { detail = JSON.parse(event.detail); } catch (_) { return; }
    const id = detail && detail.id;
    if (!id) return;
    if (typeof window.__viMseMuxTest !== 'function') {
      fire(MSE_DIRECT_RESPONSE, { id, ok: false, error: '__viMseMuxTest unavailable' });
      return;
    }
    try {
      const ok = await window.__viMseMuxTest(detail.filename, id, detail.matchUrl);
      fire(MSE_DIRECT_RESPONSE, { id, ok: !!ok, downloaded: !!ok });
    } catch (e) {
      fire(MSE_DIRECT_RESPONSE, { id, ok: false, error: String(e && e.message || e) });
    }
  });

  if (NativeMediaSource && NativeMediaSource.prototype && NativeMediaSource.prototype.addSourceBuffer) {
    const origAddSourceBuffer = NativeMediaSource.prototype.addSourceBuffer;
    const origEndOfStream = NativeMediaSource.prototype.endOfStream;
    let mseIndex = 0;
    mseDiag.hooked = true;
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
      const mt = String(mimeType || '');
      const isAudio = /^audio\//i.test(mt) || /opus|mp4a\.40\.|aac/i.test(mt);
      const role = isAudio ? 'audio' : 'video';
      const diagBuf = { mimeType: mt, calls: 0, bytes: 0, role };
      mseDiag.buffers.push(diagBuf);
      mseDiag.addCalls++;
      console.log('[VI-MSE-DIAG] addSourceBuffer', mt, '=>', role);
      const matchUrl = objectUrlTargets.get(this) || '';
      const state = { finalized: false, timer: 0, update: null, role };
      const update = () => {
        if (!chunks.length || total <= 1024) return;
        const blob = new Blob(chunks, { type: mt || (isAudio ? 'audio/webm' : 'video/mp4') });
        const url = 'mse://' + role + '/' + id;
        if (!stored) {
          store({
            id,
            url,
            matchUrl,
            type: blob.type,
            size: blob.size,
            blob,
            source: 'mse-' + role,
            label: isAudio ? 'MSE 音频流' : 'MSE 视频流',
            kind: isAudio ? 'audio' : 'video'
          });
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
              const bytes = data && data.byteLength ? data.byteLength : 0;
              if (bytes) { diagBuf.calls++; diagBuf.bytes += bytes; mseDiag.appendCalls++; }
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
      const diagTimer = setInterval(() => {
        console.log('[VI-MSE-DIAG] summary', JSON.stringify(mseDiag.summary()));
      }, 5000);
      setTimeout(() => { clearInterval(diagTimer); }, 5 * 60 * 1000);
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
  document.addEventListener(SCAN_RESOURCES, (event) => {
    let data;
    try { data = JSON.parse(event.detail); } catch (_) { data = {}; }
    const id = (data && data.id) || '';
    (async () => {
      let items = collectPageResources();
      // Layer 3：平台 adapter 从页面数据提取结构化资源（标题/封面/音轨配对）。
      if (engine && typeof engine.extractFromPage === 'function') {
        try {
          const extra = await engine.extractFromPage(data.pageUrl || location.href, null);
          if (Array.isArray(extra)) {
            const byKey = new Map(items.map((item) => [item.key, item]));
            extra.forEach((entry) => {
              if (!entry || !entry.url) return;
              const url = normalizeResourceUrl(entry.url);
              if (!url) return;
              const key = resourceKey(url);
              const base = byKey.get(key) || {
                id: 'page-' + key, key, url, source: 'adapter', score: 80,
                kind: /\.m3u8(\?|#|$)/i.test(url) ? 'hls' : /\.mpd(\?|#|$)/i.test(url) ? 'dash' : 'direct',
                title: '', poster: '', videoUrl: '', audioUrl: '', width: 0, height: 0, duration: 0, size: 0
              };
              const merged = Object.assign({}, base, entry, { url, key, score: Math.max(base.score || 0, entry.score || 80) });
              byKey.set(key, merged);
            });
            items = Array.from(byKey.values());
          }
        } catch (e) {
          console.warn('[VI-AUDIO] extractFromPage failed', e);
        }
      }
      fire(SCAN_RESULT, { id, items: items.slice(0, 300) });
    })();
  });

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
    let heldJobId = '';
    let releaseJobLock = null;

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
      // 音频轨必须用与视频相同的 UA/Referer/Cookie，否则 CDN 返回 403 错误页会被当成音频保存
      const fetchAudioTrack = async (audioUrl) => {
        const rangedMeta = Object.assign({}, dlMeta || {}, { forceRange: true });
        let r;
        try {
          r = await engine.fetchWhole(audioUrl, controller.signal, onProgress, dlArg, rangedMeta);
        } catch (e) {
          console.warn('[VI-AUDIO] audio ranged fetch failed, retry plain', String(e && e.message || e));
          r = await engine.fetchWhole(audioUrl, controller.signal, onProgress, dlArg, dlMeta || undefined);
        }
        const blob = r && r.tracks && r.tracks[0];
        const type = String((blob && blob.type) || (r && r.contentType) || '').toLowerCase();
        if (!blob || blob.size < 1024 || /html|json|javascript|xml|text\//.test(type)) {
          throw new Error('audio track is not media: type=' + type + ' bytes=' + ((blob && blob.size) || 0));
        }
        console.log('[VI-AUDIO] audio fetched', { bytes: blob.size, type });
        return r;
      };

      // ===== 主轨断点续传：分块写入 IndexedDB，中断后可从已下载位置继续 =====
      const persistable = kind !== 'hls' && kind !== 'dash';
      const jobId = persistable ? jobIdFor(payload, filename) : '';
      // 同一任务的并发会话串行化：先让上一个（例如刚被暂停的）会话连分块一起落盘结束，
      // 否则两个会话可能同时写同一个 chunk seq，拼出损坏文件。
      let releaseJob = null;
      if (jobId) {
        const prevLock = jobLocks.get(jobId) || Promise.resolve();
        const prevCtrl = jobControllers.get(jobId);
        if (prevCtrl) { try { prevCtrl.abort(); } catch (_) {} }
        const gate = new Promise((resolve) => { releaseJob = resolve; });
        jobLocks.set(jobId, prevLock.then(() => gate));
        await prevLock;
        if (controller.signal.aborted) {
          releaseJob();
          throw new Error('cancelled');
        }
        jobControllers.set(jobId, controller);
        heldJobId = jobId;
        releaseJobLock = releaseJob;
      }
      let job = jobId ? await jobGet(jobId) : null;
      if (jobId && (!job || job.kind !== kind)) {
        if (job) await jobDelete(jobId);
        try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (_) {}
        job = {
          id: jobId,
          pageUrl: payload.pageUrl || '',
          qualityId: payload.qualityId || '',
          jobKey: payload.jobKey || '',
          filename: filename || '',
          kind,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          tracks: {}
        };
      }

      const createSink = (role, targetUrl, resumeTrack) => {
        const track = resumeTrack
          ? Object.assign({}, resumeTrack)
          : { url: targetUrl, loaded: 0, total: 0, etag: '', chunks: 0, contentType: '' };
        job.tracks[role] = track;
        let pending = [];
        let pendingBytes = 0;
        let chain = Promise.resolve();
        const persist = () => {
          const parts = pending;
          pending = [];
          pendingBytes = 0;
          if (!parts.length) return Promise.resolve();
          const seq = track.chunks++;
          return chunkPut({ id: job.id + ':' + role + ':' + seq, jobId: job.id, role, seq, blob: new Blob(parts) })
            .then(() => jobPut(job))
            .catch((e) => console.warn('[VI-DL] persist chunk failed', e));
        };
        return {
          track,
          push(bytes, loaded, total) {
            pending.push(bytes);
            pendingBytes += bytes.byteLength;
            track.loaded = loaded;
            if (total) track.total = total;
            if (pendingBytes >= FLUSH_BYTES) chain = chain.then(persist);
          },
          flush() {
            chain = chain.then(persist);
            return chain;
          },
          async blob(fallback, type) {
            chain = chain.then(persist);
            await chain;
            const parts = await chunksFor(job.id, role);
            if (!parts.length) return fallback;
            const storedBytes = parts.reduce((sum, p) => sum + ((p.blob && p.blob.size) || 0), 0);
            // 分块存储不完整时宁可报错，也不能产出被截断的文件
            if (storedBytes !== track.loaded) throw new Error('chunk store incomplete ' + storedBytes + '/' + track.loaded);
            return new Blob(parts.map((p) => p.blob), { type: type || (fallback && fallback.type) || 'video/mp4' });
          }
        };
      };

      const fetchMainTrack = async (targetUrl, headersArg, metaArg) => {
        const prev = job && job.tracks && job.tracks.main;
        // 以磁盘上的分块为准修正进度：进程被杀时可能出现“分块已写、进度未更新”
        if (prev && prev.chunks > 0) {
          const stored = await chunksFor(job.id, 'main');
          prev.loaded = stored.reduce((sum, p) => sum + ((p.blob && p.blob.size) || 0), 0);
          prev.chunks = stored.length;
        }
        // 上次已经下完、只是合并/校验阶段失败：直接复用分块，不再重新下载
        if (prev && prev.total && prev.loaded >= prev.total && prev.chunks > 0) {
          const done = await chunksFor(job.id, 'main');
          const storedBytes = done.reduce((sum, p) => sum + ((p.blob && p.blob.size) || 0), 0);
          if (done.length && storedBytes === prev.loaded) {
            console.log('[VI-DL] reuse completed chunks', done.length, 'bytes', prev.loaded);
            const ext = /webm/i.test(prev.contentType || '') ? 'webm' : 'mp4';
            return {
              blob: new Blob(done.map((p) => p.blob), { type: prev.contentType || 'video/mp4' }),
              contentType: prev.contentType || '',
              ext
            };
          }
        }
        let resumeTrack = (prev && prev.loaded > 0 && prev.total && prev.loaded < prev.total && prev.etag && prev.chunks > 0)
          ? prev
          : null;
        for (let attempt = 0; attempt < 2; attempt++) {
          if (!resumeTrack) {
            await chunksDeleteRole(job.id, 'main');
            if (job.tracks.main) delete job.tracks.main;
          }
          const sink = createSink('main', targetUrl, resumeTrack);
          const base = resumeTrack ? resumeTrack.loaded : 0;
          if (resumeTrack) console.log('[VI-DL] resume from', base, '/', resumeTrack.total);
          const meta2 = Object.assign({}, metaArg || {}, {
            resume: resumeTrack ? {
              loaded: base,
              total: resumeTrack.total,
              etag: resumeTrack.etag,
              contentType: resumeTrack.contentType || ''
            } : null,
            onMeta: (info) => {
              if (info.etag) sink.track.etag = info.etag;
              if (info.contentType) sink.track.contentType = info.contentType;
              if (info.total) sink.track.total = info.total;
            },
            onChunk: (bytes, loaded, total) => sink.push(bytes, base + loaded, total || sink.track.total || 0)
          });
          try {
            const r = await engine.fetchWhole(targetUrl, controller.signal, (loaded, total) => {
              if (total) sink.track.total = total;
              onProgress(base + loaded, total || sink.track.total || 0);
            }, headersArg, meta2);
            const blob = await sink.blob(r.tracks && r.tracks[0], r.contentType || '');
            return { blob, contentType: r.contentType || '', ext: r.ext || 'mp4' };
          } catch (e) {
            await sink.flush().catch(() => {});
            const message = String(e && e.message || e);
            if (attempt === 0 && resumeTrack && /resume unsupported|unexpected range|HTTP 41[56]/.test(message)) {
              console.warn('[VI-DL] resume invalid, restart from 0', message);
              resumeTrack = null;
              continue;
            }
            throw e;
          }
        }
        throw new Error('resume failed');
      };

      if (!url) throw new Error('empty url');
      if (kind === 'blob' || kind === 'record') throw new Error('needs_recording');

      let result;
      if (kind === 'streams' && payload.videoUrl) {
        const v = await fetchMainTrack(payload.videoUrl, dlArg, dlMeta || undefined);
        let a = null;
        if (payload.audioUrl) {
          try { a = await fetchAudioTrack(payload.audioUrl); }
          catch (e) { console.warn('[VI-AUDIO] audio fetch failed', String(e && e.message || e)); a = null; }
        } else {
          console.warn('[VI-AUDIO] streams without audioUrl -> will be silent');
        }
        console.log('[VI-AUDIO] streams fetched', { videoBytes: (v.blob && v.blob.size) || 0, audioBytes: (a && a.tracks[0] && a.tracks[0].size) || 0 });
        if (payload.audioUrl && !a) throw new Error('audio track unavailable');
        result = {
          tracks: a ? [v.blob, a.tracks[0]] : [v.blob],
          ext: v.ext || 'mp4', duration: expectedDuration || 0, skipDurationCheck: !!a
        };
      } else if (kind === 'streams' && videoUrl) {
        const v = await fetchMainTrack(videoUrl, dlArg, dlMeta || undefined);
        let a = null;
        if (audioUrl) {
          try { a = await fetchAudioTrack(audioUrl); }
          catch (e) { console.warn('[VI-AUDIO] audio fetch failed', String(e && e.message || e)); a = null; }
        } else {
          console.warn('[VI-AUDIO] streams without audioUrl -> will be silent');
        }
        if (audioUrl && !a) throw new Error('audio track unavailable');
        result = {
          tracks: a ? [v.blob, a.tracks[0]] : [v.blob],
          ext: v.ext || 'mp4', duration: expectedDuration || 0, skipDurationCheck: false
        };
      } else if (kind === 'hls') result = await engine.downloadHls(url, controller.signal, onProgress, dlMeta || undefined);
      else if (kind === 'dash') result = await engine.downloadDash(url, controller.signal, onProgress, expectedDuration, dlMeta || undefined);
      else {
        const r = await fetchMainTrack(url, dlArg, dlMeta || undefined);
        result = { tracks: [r.blob], ext: r.ext || 'mp4', duration: expectedDuration || 0 };
      }

      let tracks = result.tracks || [result.blob];
      let finalBlob;
      let finalExt = result.ext || 'mp4';
      let separateSaved = false;
      let offscreenDone = false;
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
            let vp = await engine.probeTracks(buffers[0]);
            // 上游可能把音轨排在前：没有视频轨就和对面试探交换，否则会把音频当视频保存
            if (!vp.hasVideo && buffers.length > 1) {
              const second = await engine.probeTracks(buffers[1]);
              if (second && second.hasVideo) {
                console.warn('[VI-AUDIO] swap tracks: first is audio, second is video');
                const tmpBuf = buffers[0];
                buffers[0] = buffers[1];
                buffers[1] = tmpBuf;
                const tmpBlob = tracks[0];
                tracks[0] = tracks[1];
                tracks[1] = tmpBlob;
                vp = second;
              }
            }
            needMerge = !vp.hasAudio;
            console.log('[VI-AUDIO] probe video track', vp);
          } catch (e) { console.warn('[VI-AUDIO] probe failed', e); needMerge = true; }
        }
        if (!needMerge) {
          console.warn('[VI-AUDIO] skip merge: source video already has audio');
          finalBlob = tracks[0];
          finalExt = result.ext || 'mp4';
        } else {
          try {
            const muxBase = String(filename || 'video').replace(/\.[^.]+$/, '') + '.mp4';
            console.log('[VI-AUDIO] trying offscreen ffmpeg mux');
            const muxHeartbeat = setInterval(() => {
              fire(PROGRESS, { id, loaded: 0, total: 100, percent: 0, phase: 'merging' });
            }, 15000);
            let muxResult;
            try {
              const vb = new Blob([buffers[0]], { type: (tracks[0] && tracks[0].type) || 'video/mp4' });
              const ab = new Blob([buffers[1]], { type: (tracks[1] && tracks[1].type) || 'audio/mp4' });
              muxResult = await muxViaOffscreen(id, vb, ab, muxBase);
            } finally {
              clearInterval(muxHeartbeat);
            }
            offscreenDone = !!muxResult.downloaded && muxResult.hasAudio !== false;
            if (!offscreenDone) throw new Error('offscreen mux result has no audio');
            console.log('[VI-AUDIO] offscreen mux ok, bytes', muxResult.size);
          } catch (muxError) {
            console.warn('[VI-AUDIO] offscreen mux failed, fallback to MP4Box', muxError);
          }

          if (!offscreenDone) {
            try {
              finalBlob = await engine.mergeStreams(buffers);
              finalExt = 'mp4';
              if (typeof engine.probeTracks === 'function') {
                const mergedProbe = await engine.probeTracks(await finalBlob.arrayBuffer());
                console.log('[VI-AUDIO] MP4Box merge ok', mergedProbe, 'bytes', finalBlob.size);
                if (!mergedProbe.hasAudio) throw new Error('merge produced no audio track');
              }
            } catch (mergeError) {
              console.error('[VI-AUDIO] all merge failed -> save tracks separately', mergeError);
              const base = String(filename || 'video').replace(/\.[^.]+$/, '');
              const videoExt = (result.ext === 'webm' || (tracks[0] && tracks[0].type === 'video/webm')) ? 'webm' : 'mp4';
              saveHref(URL.createObjectURL(tracks[0]), base + '.video.' + videoExt);
              saveHref(URL.createObjectURL(tracks[1]), base + '.audio.' + detectAudioExt(tracks[1] && tracks[1].type));
              separateSaved = true;
              finalBlob = tracks[0];
              finalExt = videoExt;
            }
          }
        }
        // offscreen 已直接下载成品：跳过后续校验与保存，只回传成功
        if (offscreenDone) {
          objectUrl = '';
          fire(RESPONSE, { id, ok: true, method: kind + '+ffmpeg', size: tracks[0].size + tracks[1].size, separateTracks: false });
          fire(PROGRESS, { id, loaded: 100, total: 100, percent: 100, phase: 'verifying' });
          return;
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
      if (typeof engine.probeTracks === 'function' && tracks.length > 1 && !separateSaved) {
        try {
          const probe = await engine.probeTracks(await finalBlob.arrayBuffer());
          console.log('[VI-AUDIO] final probe', probe, 'size', finalBlob.size);
          // 合并结果必须同时有视频轨，否则就是“有声无画”，宁可报错也不落盘
          if (!probe.hasVideo) throw new Error('merge produced no video track');
          if (probe.audioTracks > 1) {
            // 合并后的 fMP4 里 soun 常被重复扫描到，这里只记录，不再回退成源视频——
            // 回退会丢掉刚合并进去的音轨，正是“下载下来没声音”的来源之一。
            console.warn('[VI-AUDIO] multi-audio detected, keep merged output', probe);
          }
        } catch (e) {
          if (/no (audio|video) track|merge produced/i.test(String(e && e.message))) throw e;
        }
      }

      fire(PROGRESS, { id, loaded: finalBlob.size, total: finalBlob.size, percent: 100, phase: 'verifying' });
      // 合并产物（fMP4/DASH/双流）的容器 duration 常不精确，跳过严格时长比对，仅校验容器与大小
      const isMerged = tracks.length > 1 || finalExt === 'ts';
      const checkDuration = isMerged || result.skipDurationCheck ? 0 : (expectedDuration || result.duration || 0);
      const check = await engine.verifyBlob(finalBlob, checkDuration, expectedSize);
      if (!check.ok) throw new Error(check.error);

      if (!separateSaved) {
        objectUrl = URL.createObjectURL(finalBlob);
        const baseName = String(filename || 'video').replace(/\.[^.]+$/, '');
        saveHref(objectUrl, baseName + '.' + finalExt);
      }
      // 成功落盘后清理断点数据
      if (jobId) await jobDelete(jobId);
      fire(RESPONSE, {
        id,
        ok: true,
        method: kind,
        size: finalBlob.size,
        duration: result.duration,
        validated: true,
        separateTracks: separateSaved,
        // 把实际下载的地址回传，重试时优先复用同一个视频，避免按当前页面重新解析串到别的视频
        sourceUrl: url,
        sourceVideoUrl: payload.videoUrl || '',
        sourceAudioUrl: payload.audioUrl || '',
        sourceKind: kind
      });
    })().catch((error) => {
      const message = String((error && error.message) || error);
      const cancelled = controller.signal.aborted || /abort|cancel/i.test(message);
      fire(RESPONSE, {
        id,
        ok: false,
        error: cancelled ? 'cancelled' : message,
        validated: false,
        // 失败也回传已解析的地址，重试时可从同一个视频继续，而不是按页面重新解析
        sourceUrl: cancelled ? '' : (url || ''),
        sourceVideoUrl: cancelled ? '' : (payload.videoUrl || ''),
        sourceAudioUrl: cancelled ? '' : (payload.audioUrl || ''),
        sourceKind: cancelled ? '' : kind
      });
    }).finally(() => {
      controllers.delete(id);
      if (releaseJobLock) {
        jobControllers.delete(heldJobId);
        releaseJobLock();
      }
      if (objectUrl) setTimeout(() => URL.revokeObjectURL(objectUrl), 15 * 60 * 1000);
    });
  });

  // 查询当前页面的未完成下载，供 UI 显示“继续下载 xx%”
  document.addEventListener(RESUME_QUERY, (event) => {
    let payload;
    try { payload = JSON.parse(event.detail); } catch (_) { return; }
    const id = payload && payload.id;
    jobsForPage((payload && payload.pageUrl) || location.href).then((jobs) => {
      fire(RESUME_LIST, { id, jobs });
    });
  });
})();
