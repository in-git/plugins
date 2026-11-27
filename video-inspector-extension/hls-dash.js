(() => {
  'use strict';

  const INTERNAL = '__viInternalDownload';

  // offscreen 文档的请求默认只带 chrome-extension:// 的 Referer，
  // B站/抖音等 CDN 会因此返回 403。用 fetch 的 referrer 选项补回源页面地址。
  function withMeta(meta, init) {
    const options = Object.assign({}, init || {});
    const source = meta || {};
    if (source.headers) options.headers = Object.assign({}, source.headers, options.headers || {});
    if (source.referrer) {
      options.referrer = source.referrer;
      options.referrerPolicy = 'no-referrer-when-downgrade';
    }
    if (source.userAgent) {
      options.headers = Object.assign({}, options.headers || {});
      options.headers['User-Agent'] = source.userAgent;
    }
    // TikTok CDN 直链必须带页面 Cookie（include）才返回 200，默认 omit 会 403。
    if (source.credentials) options.credentials = source.credentials;
    return options;
  }

  function referrerMeta(pageUrl, fallbackUrl, headers, userAgent) {
    let referrer = '';
    try {
      const raw = pageUrl || fallbackUrl || '';
      const parsed = new URL(raw, location.href);
      if (/^https?:$/.test(parsed.protocol)) referrer = parsed.href;
    } catch (_) {}
    return { headers: headers || null, referrer, userAgent: userAgent || '' };
  }

  function absUrl(url, base) {
    try { return new URL(url, base).href; } catch (_) { return url; }
  }

  function parseRange(header) {
    const m = /bytes\s+(\d+)-(\d+)\/(\d+|\*)/i.exec(header || '');
    return m ? { start: +m[1], end: +m[2], total: m[3] === '*' ? 0 : +m[3] } : null;
  }

  function detectKind(url, contentType) {
    if (/^blob:/i.test(url)) return 'blob';
    if (/\.m3u8(\?|#|$)/i.test(url) || /mpegurl/i.test(contentType || '')) return 'hls';
    if (/\.mpd(\?|#|$)/i.test(url) || /dash\+xml/i.test(contentType || '')) return 'dash';
    return 'direct';
  }

  async function fetchText(url, signal, meta) {
    const r = await fetch(url, withMeta(meta, { credentials: 'omit', signal, [INTERNAL]: true }));
    if (!r.ok) throw new Error('HTTP ' + r.status + ' for playlist');
    return r.text();
  }

  async function fetchBuffer(url, signal, range, meta) {
    const headers = range ? { Range: 'bytes=' + range } : {};
    const r = await fetch(url, withMeta(meta, { credentials: 'omit', signal, headers, [INTERNAL]: true }));
    if (!r.ok && r.status !== 206) throw new Error('HTTP ' + r.status + ' for segment');
    if (range && r.status === 206) {
      const cr = parseRange(r.headers.get('content-range'));
      if (!cr || cr.start !== Number(String(range).split('-')[0])) throw new Error('unexpected byte range');
    }
    return r.arrayBuffer();
  }

  async function fetchWhole(url, signal, onProgress, extraHeaders, meta) {
    if (!meta && extraHeaders && extraHeaders.__viMeta) {
      meta = extraHeaders.__viMeta;
      extraHeaders = extraHeaders.__viHeaders || null;
    }
    const chunks = [];
    let loaded = 0, total = 0, pos = 0, first = true;
    let contentType = '', etag = '';
    // 部分 CDN（如 TikTok 音乐 obj 域名）只接受带 Range 的请求，裸 GET 会被直接断连
    const forceRange = !!(meta && meta.forceRange);
    // 断点续传：从已落盘的字节位置继续，并用 If-Range 校验内容未变
    const resume = meta && meta.resume;
    const onChunk = meta && typeof meta.onChunk === 'function' ? meta.onChunk : null;
    if (resume && resume.loaded > 0) {
      pos = resume.loaded;
      loaded = resume.loaded;
      total = resume.total || 0;
      etag = resume.etag || '';
      contentType = resume.contentType || '';
      first = false;
    }
    for (;;) {
      if (signal.aborted) throw new Error('cancelled');
      const headers = {};
      if (extraHeaders) {
        for (const k in extraHeaders) headers[k] = extraHeaders[k];
      }
      if (!first || forceRange) {
        headers.Range = 'bytes=' + pos + '-';
        if (!first && etag) headers['If-Range'] = etag;
      }
      const response = await fetch(url, withMeta(meta, { credentials: (meta && meta.credentials) || 'omit', signal, headers, [INTERNAL]: true }));
      if (!response.ok && response.status !== 206) throw new Error('HTTP ' + response.status);
      const range = parseRange(response.headers.get('content-range'));
      if (first) {
        contentType = response.headers.get('content-type') || '';
        etag = response.headers.get('etag') || '';
        total = (range && range.total) || Number(response.headers.get('content-length')) || 0;
        if (meta && typeof meta.onMeta === 'function') meta.onMeta({ etag, contentType, total });
      } else {
        // 续传时服务器回 200 说明不支持 Range，或内容已变化（If-Range 失效）
        if (response.status === 200) throw new Error('resume unsupported');
        if (response.status !== 206 || !range || range.start !== pos) throw new Error('unexpected range response');
        if (!total) total = range.total || 0;
      }
      if (response.body && typeof response.body.getReader === 'function') {
        const reader = response.body.getReader();
        for (;;) {
          if (signal.aborted) throw new Error('cancelled');
          const { done, value } = await reader.read();
          if (done) break;
          if (value && value.byteLength) {
            chunks.push(value);
            loaded += value.byteLength;
            if (onChunk) onChunk(value, loaded, total);
            onProgress(loaded, total);
          }
        }
      } else {
        const buf = await response.arrayBuffer();
        chunks.push(buf);
        loaded += buf.byteLength;
        if (onChunk) onChunk(new Uint8Array(buf), loaded, total);
        onProgress(loaded, total);
      }
      if (first && response.status === 200) break;
      if (total && loaded >= total) break;
      if (!total) break;
      pos = loaded;
      first = false;
    }
    if (total && loaded !== total) throw new Error('incomplete ' + loaded + '/' + total);
    let ext = 'mp4';
    if (/webm/i.test(contentType) || /\.webm(\?|#|$)/i.test(url)) ext = 'webm';
    else if (/\.ogv(\?|#|$)/i.test(url)) ext = 'ogv';
    else if (/\.mov(\?|#|$)/i.test(url)) ext = 'mov';
    else if (/\.mkv(\?|#|$)/i.test(url)) ext = 'mkv';
    return { tracks: [new Blob(chunks, { type: contentType || 'video/mp4' })], contentType, ext, etag, loaded, total };
  }

  function parseAttrs(line) {
    const attrs = {};
    const re = /([A-Z0-9-]+)=("([^"]*)"|([^,]*))/g;
    let m;
    while ((m = re.exec(line))) attrs[m[1]] = m[3] !== undefined ? m[3] : m[4];
    return attrs;
  }

  function ivFromValue(value, sequence) {
    const iv = new Uint8Array(16);
    if (value) {
      const hex = value.replace(/^0x/i, '').padStart(32, '0');
      for (let i = 0; i < 16; i++) iv[i] = parseInt(hex.substr(i * 2, 2), 16) || 0;
    } else {
      iv[15] = sequence & 0xff;
      iv[14] = (sequence >> 8) & 0xff;
      iv[13] = (sequence >> 16) & 0xff;
      iv[12] = (sequence >> 24) & 0xff;
    }
    return iv;
  }

  async function decryptAes(buffer, keyBytes, iv) {
    if (!window.crypto || !crypto.subtle) throw new Error('WebCrypto unavailable (requires HTTPS)');
    const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-CBC', false, ['decrypt']);
    const plain = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, buffer);
    const bytes = new Uint8Array(plain);
    const pad = bytes[bytes.length - 1];
    if (pad > 0 && pad <= 16 && bytes.slice(-pad).every((b) => b === pad)) return plain.slice(0, plain.byteLength - pad);
    return plain;
  }

  async function downloadHls(playlistUrl, signal, onProgress, meta) {
    let text = await fetchText(playlistUrl, signal, meta);
    let base = playlistUrl;
    let audioPlaylistUrl = '';

    if (/#EXT-X-STREAM-INF/.test(text)) {
      const lines = text.split(/\r?\n/).map((s) => s.trim());
      // 先按 GROUP-ID 收集所有音轨；不能只认 DEFAULT=YES，
      // 很多站点把独立音轨标成 DEFAULT=NO 或干脆不写 DEFAULT。
      const audioGroups = new Map();
      lines.forEach((line) => {
        if (line.indexOf('#EXT-X-MEDIA:') !== 0 || !/TYPE=AUDIO/i.test(line)) return;
        const attrs = parseAttrs(line.slice('#EXT-X-MEDIA:'.length));
        if (!attrs.URI) return;
        const gid = attrs['GROUP-ID'] || '';
        const entry = { uri: absUrl(attrs.URI, base), isDefault: /DEFAULT=YES/i.test(line) };
        const prev = audioGroups.get(gid);
        if (!prev || (entry.isDefault && !prev.isDefault)) audioGroups.set(gid, entry);
      });

      let best = null;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.indexOf('#EXT-X-STREAM-INF') !== 0) continue;
        const attrs = parseAttrs(line.slice('#EXT-X-STREAM-INF:'.length));
        const next = lines[i + 1] || '';
        if (!next || next.charAt(0) === '#') continue;
        const score = (Number(attrs.BANDWIDTH) || 0) + (attrs.RESOLUTION ? 100000000 : 0);
        if (!best || score > best.score) {
          best = { url: absUrl(next, base), score, audioGroup: attrs.AUDIO || '' };
        }
      }
      if (!best) throw new Error('no valid HLS variant');

      if (best.audioGroup && audioGroups.has(best.audioGroup)) {
        audioPlaylistUrl = audioGroups.get(best.audioGroup).uri;
      }
      if (!audioPlaylistUrl) {
        const groups = Array.from(audioGroups.values());
        audioPlaylistUrl = (groups.find((g) => g.isDefault) || groups[0] || {}).uri || '';
      }

      playlistUrl = best.url;
      base = playlistUrl;
      text = await fetchText(playlistUrl, signal, meta);
    }

    const videoTrack = await downloadHlsTrack(text, base, signal, onProgress, meta);

    if (audioPlaylistUrl) {
      try {
        const audioText = await fetchText(audioPlaylistUrl, signal, meta);
        const audioTrack = await downloadHlsTrack(audioText, audioPlaylistUrl, signal, () => {}, meta);
        return {
          tracks: [videoTrack.blob, audioTrack.blob],
          ext: 'ts',
          duration: videoTrack.duration,
          skipDurationCheck: true
        };
      } catch (e) {
        throw new Error('HLS audio track unavailable: ' + String(e && e.message || e));
      }
    }

    return {
      tracks: [videoTrack.blob],
      ext: videoTrack.isFmp4 ? 'mp4' : 'ts',
      duration: videoTrack.duration,
      skipDurationCheck: !videoTrack.isFmp4
    };
  }

  async function downloadHlsTrack(text, base, signal, onProgress, meta) {
    const lines = text.split(/\r?\n/).map((s) => s.trim());
    const segments = [];
    let key = null, map = null, range = null, segDuration = 0;
    let mediaSequence = 0;
    let discontinuity = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.charAt(0) !== '#') {
        segments.push({
          url: absUrl(line, base), key: key ? { ...key } : null,
          map: map ? { ...map } : null, range, discontinuity,
          duration: segDuration, sequence: mediaSequence + segments.length
        });
        range = null; segDuration = 0; discontinuity = false;
        continue;
      }
      if (line.indexOf('#EXTINF:') === 0) segDuration = parseFloat(line.slice(8).split(',')[0]) || 0;
      else if (line.indexOf('#EXT-X-KEY:') === 0) {
        const attrs = parseAttrs(line.slice('#EXT-X-KEY:'.length));
        key = attrs.METHOD === 'AES-128' && attrs.URI
          ? { uri: absUrl(attrs.URI, base), iv: attrs.IV || '' }
          : null;
      } else if (line.indexOf('#EXT-X-MAP:') === 0) {
        const attrs = parseAttrs(line.slice('#EXT-X-MAP:'.length));
        if (attrs.URI) map = { url: absUrl(attrs.URI, base), range: attrs.BYTERANGE || '' };
      } else if (line.indexOf('#EXT-X-BYTERANGE:') === 0) range = line.slice('#EXT-X-BYTERANGE:'.length).trim();
      else if (line.indexOf('#EXT-X-MEDIA-SEQUENCE:') === 0) mediaSequence = Number(line.split(':')[1]) || 0;
      else if (line.indexOf('#EXT-X-DISCONTINUITY') === 0) discontinuity = true;
    }

    if (!segments.length) throw new Error('no segments in HLS playlist');

    let keyBytes = null;
    if (key) {
      keyBytes = new Uint8Array(await fetchBuffer(key.uri, signal, null, meta));
      if (keyBytes.length !== 16) throw new Error('invalid AES key');
    }

    const pieces = [];
    if (map) {
      let init = await fetchBuffer(map.url, signal, map.range || null, meta);
      if (keyBytes) init = await decryptAes(init, keyBytes, ivFromValue(key.iv, mediaSequence));
      pieces.push(init);
    }

    const results = new Array(segments.length);
    let completed = 0;
    const queue = segments.map((seg, idx) => ({ seg, idx }));
    const workers = Array.from({ length: Math.min(6, queue.length) }, async () => {
      while (queue.length) {
        const { seg, idx } = queue.shift();
        if (signal.aborted) throw new Error('cancelled');
        let buf = await fetchBuffer(seg.url, signal, seg.range || null, meta);
        if (seg.key && keyBytes) buf = await decryptAes(buf, keyBytes, ivFromValue(seg.key.iv, seg.sequence));
        results[idx] = buf;
        onProgress(++completed, segments.length);
      }
    });
    await Promise.all(workers);
    for (const buf of results) if (buf) pieces.push(buf);

    const isFmp4 = !!map;
    return {
      blob: new Blob(pieces, { type: isFmp4 ? 'video/mp4' : 'video/mp2t' }),
      isFmp4,
      duration: segments.reduce((sum, s) => sum + (s.duration || 0), 0)
    };
  }

  function parseISODuration(str) {
    if (!str) return 0;
    const m = /PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?/i.exec(str);
    return m ? (Number(m[1]) || 0) * 3600 + (Number(m[2]) || 0) * 60 + (Number(m[3]) || 0) : 0;
  }

  function applyTemplate(tpl, vars) {
    return String(tpl)
      .replace(/\$RepresentationID\$/g, vars.id)
      .replace(/\$Bandwidth\$/g, vars.bandwidth)
      .replace(/\$Number(?:%0\d+d)?\$/g, vars.number)
      .replace(/\$Time(?:%0\d+d)?\$/g, vars.time);
  }

  function collectReps(doc) {
    const out = [];
    const periods = doc.getElementsByTagName('Period');
    for (let p = 0; p < periods.length; p++) {
      const period = periods[p];
      const sets = period.getElementsByTagName('AdaptationSet');
      for (let a = 0; a < sets.length; a++) {
        const as = sets[a];
        const mime = as.getAttribute('mimeType') || as.getAttribute('contentType') || '';
        const kind = /audio/i.test(mime) ? 'audio' : /video/i.test(mime) ? 'video' : 'unknown';
        const reps = as.getElementsByTagName('Representation');
        for (let r = 0; r < reps.length; r++) {
          const rep = reps[r];
          out.push({
            rep, as, period, kind,
            id: rep.getAttribute('id') || '',
            bandwidth: Number(rep.getAttribute('bandwidth')) || 0,
            duration: parseISODuration(period.getAttribute('duration')) || 0,
            base: (rep.getElementsByTagName('BaseURL')[0] || as.getElementsByTagName('BaseURL')[0] ||
                   period.getElementsByTagName('BaseURL')[0] || doc.documentElement.getElementsByTagName('BaseURL')[0] || {}).textContent || ''
          });
        }
      }
    }
    return out;
  }

  async function downloadDashTrack(track, mpdUrl, signal, onProgress, meta) {
    const { rep, as, period, id, bandwidth, duration } = track;
    const base = track.base ? absUrl(track.base, mpdUrl) : mpdUrl;
    let tpl = rep.getElementsByTagName('SegmentTemplate')[0] ||
              as.getElementsByTagName('SegmentTemplate')[0] ||
              period.getElementsByTagName('SegmentTemplate')[0];
    const chunks = [];

    if (tpl) {
      const timescale = Number(tpl.getAttribute('timescale')) || 1;
      const initTpl = tpl.getAttribute('initialization') || '';
      const mediaTpl = tpl.getAttribute('media') || '';
      const startNumber = Number(tpl.getAttribute('startNumber')) || 1;
      if (initTpl) chunks.push(await fetchBuffer(absUrl(applyTemplate(initTpl, { id, bandwidth, number: '', time: '' }), base), signal, null, meta));

      const timeline = tpl.getElementsByTagName('SegmentTimeline')[0];
      if (timeline) {
        let t = 0, n = startNumber;
        const Ss = timeline.getElementsByTagName('S');
        for (let i = 0; i < Ss.length; i++) {
          const s = Ss[i];
          const st = Number(s.getAttribute('t'));
          if (!isNaN(st)) t = st;
          const d = Number(s.getAttribute('d')) || 0;
          const r = Number(s.getAttribute('r')) || 0;
          for (let k = 0; k <= r; k++) {
            const url = absUrl(applyTemplate(mediaTpl, { id, bandwidth, number: String(n), time: String(t) }), base);
            chunks.push(await fetchBuffer(url, signal, null, meta));
            onProgress(chunks.length, chunks.length + 1);
            t += d; n++;
          }
        }
      } else {
        const segDur = Number(tpl.getAttribute('duration')) || 0;
        if (!segDur || !duration) throw new Error('incomplete DASH template');
        const count = Math.ceil((duration * timescale) / segDur);
        for (let i = 0; i < count; i++) {
          const url = absUrl(applyTemplate(mediaTpl, {
            id, bandwidth, number: String(startNumber + i), time: String(i * segDur)
          }), base);
          chunks.push(await fetchBuffer(url, signal, null, meta));
          onProgress(i + 1, count);
        }
      }
    } else {
      const list = rep.getElementsByTagName('SegmentList')[0];
      if (list) {
        const init = list.getElementsByTagName('Initialization')[0];
        if (init) chunks.push(await fetchBuffer(absUrl(init.getAttribute('sourceURL') || '', base), signal, null, meta));
        const urls = list.getElementsByTagName('SegmentURL');
        for (let i = 0; i < urls.length; i++) {
          chunks.push(await fetchBuffer(absUrl(urls[i].getAttribute('media') || '', base), signal, null, meta));
          onProgress(i + 1, urls.length);
        }
      } else {
        const single = (rep.getElementsByTagName('BaseURL')[0] || {}).textContent || track.base;
        if (!single) throw new Error('no DASH segments');
        chunks.push(await fetchBuffer(absUrl(single, mpdUrl), signal, null, meta));
      }
    }

    if (!chunks.length) throw new Error('no DASH segments');
    return new Blob(chunks, { type: 'video/mp4' });
  }

  async function downloadDash(mpdUrl, signal, onProgress, expectedDuration, meta) {
    const text = await fetchText(mpdUrl, signal, meta);
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.querySelector('parsererror')) throw new Error('invalid MPD');
    const reps = collectReps(doc);
    if (!reps.length) throw new Error('no representations in MPD');

    const videos = reps.filter((r) => r.kind === 'video').sort((a, b) => b.bandwidth - a.bandwidth);
    const audios = reps.filter((r) => r.kind === 'audio').sort((a, b) => b.bandwidth - a.bandwidth);
    const chosenVideo = videos[0] || null;
    const chosenAudio = audios[0] || null;
    const primary = chosenVideo || chosenAudio || reps[0];
    const duration = primary.duration || expectedDuration || 0;

    // 音视频分离：分别下载两条轨，交给 ffmpeg 合并
    if (chosenVideo && chosenAudio) {
      const videoBlob = await downloadDashTrack(chosenVideo, mpdUrl, signal, onProgress, meta);
      const audioBlob = await downloadDashTrack(chosenAudio, mpdUrl, signal, (done, total) => onProgress(done, total), meta);
      return { tracks: [videoBlob, audioBlob], ext: 'mp4', duration, skipDurationCheck: true };
    }

    return {
      tracks: [await downloadDashTrack(primary, mpdUrl, signal, onProgress, meta)],
      ext: 'mp4',
      duration,
      skipDurationCheck: false
    };
  }

  function magicOk(head) {
    if (head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70) return true;
    if (head[4] === 0x73 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70) return true;
    if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return true;
    if (head[0] === 0x47) return true;
    if (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) return true;
    if (head[0] === 0xff && (head[1] & 0xe0) === 0xe0) return true;
    return false;
  }

  async function verifyBlob(blob, expectedDuration, expectedSize, meta) {
    if (!blob || blob.size < 512) return { ok: false, error: 'empty blob' };
    if (expectedSize && Math.abs(blob.size - expectedSize) > Math.max(2048, expectedSize * 0.02)) {
      return { ok: false, error: 'size mismatch' };
    }
    const head = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
    if (!magicOk(head)) return { ok: false, error: 'invalid container' };

    if (expectedDuration && Number.isFinite(expectedDuration) && expectedDuration > 0 && !(meta && meta.allowNoMetadata)) {
      const url = URL.createObjectURL(blob);
      try {
        const actual = await new Promise((resolve) => {
          const v = document.createElement('video');
          let settled = false;
          const done = (value) => {
            if (settled) return;
            settled = true;
            v.removeAttribute('src');
            v.load();
            resolve(value);
          };
          v.preload = 'metadata';
          v.onloadedmetadata = () => done(v.duration);
          v.onerror = () => done(0);
          setTimeout(() => done(0), 15000);
          v.src = url;
        });
        if (!actual || !Number.isFinite(actual) || actual < 0.1) return { ok: false, error: 'no decodable media' };
        if (Math.abs(actual - expectedDuration) > Math.max(1.5, expectedDuration * 0.05)) {
          return { ok: false, error: 'duration mismatch ' + actual.toFixed(1) + '/' + expectedDuration.toFixed(1) };
        }
      } finally {
        URL.revokeObjectURL(url);
      }
    }
    return { ok: true, size: blob.size };
  }

  // 判断是否 MPEG-TS（同步字节 0x47）
  function isTsHead(bytes) {
    return new Uint8Array(bytes.slice(0, 1))[0] === 0x47;
  }

  // TS → MP4 转封装（mux.js）
  async function tsToMp4(tsBuffer, onProgress) {
    if (typeof window.muxjs === 'undefined') throw new Error('mux.js unavailable');
    const transmuxer = new window.muxjs.mp4.Transmuxer();
    return new Promise((resolve, reject) => {
      const parts = [];
      transmuxer.on('data', (segment) => {
        parts.push(segment.data);
        if (onProgress) onProgress(parts.length);
      });
      transmuxer.on('done', () => {
        try {
          const remuxed = new Uint8Array(parts.reduce((sum, p) => sum + p.byteLength, 0));
          let offset = 0;
          for (const p of parts) { remuxed.set(new Uint8Array(p), offset); offset += p.byteLength; }
          resolve(remuxed.buffer);
        } catch (e) { reject(e); }
      });
      transmuxer.on('error', reject);
      transmuxer.push(new Uint8Array(tsBuffer));
      transmuxer.flush();
    });
  }

  function toArrayBuffer(buffer) {
    const u8 = new Uint8Array(buffer);
    return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
  }

  // 解析单个轨道的全部样本（用 MP4Box 提取），必须等样本数到齐才返回
  function extractTrackSamples(file, trackId) {
    return new Promise((resolve, reject) => {
      const trak = file.getTrackById(trackId);
      const total = trak && trak.samples ? trak.samples.length : 0;
      const samples = [];
      let settled = false;
      let guard = null;
      let watch = null;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        if (guard) clearTimeout(guard);
        if (watch) clearInterval(watch);
        if (err) reject(err); else resolve(samples);
      };
      if (!total) { finish(); return; }
      file.onSamples = (id, user, s) => {
        for (const sample of s) samples.push(sample);
        if (samples.length >= total) finish();
      };
      file.setExtractionOptions(trackId, null, { nbSamples: Math.min(total, 1000) });
      file.start();
      watch = setInterval(() => { if (samples.length >= total) finish(); }, 100);
      guard = setTimeout(() => {
        finish(samples.length >= total ? null : new Error('sample extraction incomplete ' + samples.length + '/' + total));
      }, 30000);
    });
  }

  // 解析 MP4 文件头，返回 { file, info }
  function parseMp4File(buffer) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let guard = null;
      const done = (err, value) => {
        if (settled) return;
        settled = true;
        if (guard) clearTimeout(guard);
        if (err) reject(err); else resolve(value);
      };
      guard = setTimeout(() => done(new Error('mp4 parse timeout')), 8000);
      try {
        const file = window.MP4Box.createFile();
        file.onError = (e) => done(new Error('mp4 parse error: ' + ((e && e.message) || '')));
        file.onReady = (info) => done(null, { file, info });
        const buf = buffer.slice(0);
        buf.fileStart = 0;
        file.appendBuffer(buf);
      } catch (e) {
        done(e);
      }
    });
  }

  // 检测 MP4 容器里的轨道类型，返回 { hasAudio, hasVideo }
  // 二进制兜底：直接在字节里数 moov 的 soun/vide handler，不依赖 MP4Box 解析
  function probeTracksBinary(buffer) {
    try {
      const bytes = new Uint8Array(buffer);
      const scanLen = Math.min(bytes.length, 2 * 1024 * 1024);
      let text = '';
      const decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder('iso-8859-1') : null;
      if (decoder) {
        text = decoder.decode(bytes.subarray(0, scanLen));
      } else {
        const chunk = 0x8000;
        for (let i = 0; i < scanLen; i += chunk) {
          text += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunk, scanLen)));
        }
      }
      const count = (re) => (text.match(re) || []).length;
      const soun = count(/soun/g);
      const audCodec = count(/mp4a|Opus|ac-3|ec-3|fLaC/g);
      const vide = count(/vide/g);
      const vidCodec = count(/avc1|hvc1|hev1|av01|vp09/g);
      return {
        hasAudio: soun > 0 && audCodec > 0,
        hasVideo: vide > 0 && vidCodec > 0,
        audioTracks: soun,
        videoTracks: vide
      };
    } catch (_) {
      return { hasAudio: false, hasVideo: false, audioTracks: 0, videoTracks: 0 };
    }
  }

  function probeTracks(buffer) {
    return new Promise((resolve) => {
      let settled = false;
      const fallback = () => { if (!settled) { settled = true; resolve(probeTracksBinary(buffer)); } };
      const done = (value) => { if (!settled) { settled = true; resolve(value); } };
      try {
        const file = window.MP4Box.createFile();
        file.onError = fallback;
        file.onReady = (info) => {
          const tracks = (info && info.tracks) || [];
          done({
            hasAudio: tracks.some((t) => t && (t.codec_type === '2' || t.type === 'audio' || /^mp4a|Opus|ac-3|ec-3|fLaC/i.test(t.codec || ''))),
            hasVideo: tracks.some((t) => t && (t.codec_type === '1' || t.type === 'video' || /^avc|hev|hvc|vp0|av01/i.test(t.codec || ''))),
            audioTracks: tracks.filter((t) => t && t.codec_type === '2').length,
            videoTracks: tracks.filter((t) => t && t.codec_type === '1').length
          });
        };
        const buf = buffer.slice(0);
        buf.fileStart = 0;
        file.appendBuffer(buf);
        file.flush();
      } catch (_) {
        fallback();
      }
      setTimeout(fallback, 4000);
    });
  }

  // 取 stsd 里的第一个 sample entry（含 avcC / esds 解码配置），直接复用避免重建
  function firstSampleEntry(trak) {
    const stsd = trak && trak.mdia && trak.mdia.minf && trak.mdia.minf.stbl && trak.mdia.minf.stbl.stsd;
    return stsd && stsd.entries ? stsd.entries[0] : null;
  }

  // 双轨合流（MP4Box.js）：把视频轨与音频轨重封装成一条同时含 video+audio 的 fMP4。
  // 关键点：
  //   1. 两条轨必须用不同的 track_id，否则 getTrackById 永远命中的是视频轨，音轨不会被写出；
  //   2. addSample 必须传 sample.data + sample 元数据，否则样本 size/dts 全错；
  //   3. 初始化段要一次包含两条轨（mp4box 自带的 initializeSegmentation 是按轨拆分的）。
  async function mergeStreams(buffers) {
    if (!buffers || buffers.length < 2) return new Blob([buffers[0]], { type: 'video/mp4' });
    if (typeof window.MP4Box === 'undefined') throw new Error('mp4box unavailable');
    const ISO = window.ISOFile;
    const BoxParserRef = window.BoxParser;
    if (!ISO || !BoxParserRef) throw new Error('mp4box internals unavailable');

    const firstBuf = toArrayBuffer(buffers[0]);
    const secondBuf = toArrayBuffer(buffers[1]);

    // 上游传下来的顺序可能是“音频在前”，按真实轨道类型纠正，否则会把音频当视频轨重封装，
    // 产出“有声无画”的文件。
    let videoBuf = firstBuf;
    let audioBuf = secondBuf;
    let vBin = probeTracksBinary(videoBuf);
    let aBin = probeTracksBinary(audioBuf);
    if (!vBin.hasVideo && aBin.hasVideo) {
      videoBuf = secondBuf;
      audioBuf = firstBuf;
      vBin = aBin;
      aBin = probeTracksBinary(audioBuf);
    }
    if (!vBin.hasVideo) throw new Error('merge failed: no video track in source');

    // 关键：如果视频文件本身已带音轨，绝不能再加一条音频轨，否则会产生
    // 1 视频 + 2 音频的非法 MP4，Windows 报「不受支持的编码设置」(0xC00D36E5)。
    if (vBin.hasAudio && vBin.hasVideo) {
      return new Blob([videoBuf], { type: 'video/mp4' });
    }

    const videoSource = await parseMp4File(videoBuf);
    const audioSource = await parseMp4File(audioBuf);
    const vInfo = (videoSource.info.videoTracks || [])[0];
    const aInfo = (audioSource.info.audioTracks || [])[0];
    if (!vInfo) throw new Error('video track missing');
    if (!aInfo) throw new Error('audio track missing in audio stream');

    const vSrcTrak = videoSource.file.getTrackById(vInfo.id);
    const aSrcTrak = audioSource.file.getTrackById(aInfo.id);

    // 先抽样本，两路都拿全后再开始写输出
    const vSamples = await extractTrackSamples(videoSource.file, vInfo.id);
    const aSamples = await extractTrackSamples(audioSource.file, aInfo.id);
    if (!vSamples.length) throw new Error('no video samples');
    if (!aSamples.length) throw new Error('no audio samples');

    const outFile = window.MP4Box.createFile();
    // 注意：mp4box 的 addTrack 返回的是 track_id（不是 trak box），要再用 getTrackById 取
    const vTrackId = outFile.addTrack({
      id: 1,
      type: String(vInfo.codec || 'avc1').split('.')[0] || 'avc1',
      hdlr: 'vide',
      name: vInfo.name || 'VideoHandler',
      timescale: vInfo.timescale || 90000,
      width: (vInfo.video && vInfo.video.width) || Math.round(vInfo.track_width || 0) || 320,
      height: (vInfo.video && vInfo.video.height) || Math.round(vInfo.track_height || 0) || 240,
      language: vInfo.language || 'und'
    });
    const aTrackId = outFile.addTrack({
      id: 2,
      type: String(aInfo.codec || 'mp4a').split('.')[0] || 'mp4a',
      hdlr: 'soun',
      name: aInfo.name || 'SoundHandler',
      timescale: aInfo.timescale || 44100,
      language: aInfo.language || 'und'
    });
    const vOut = outFile.getTrackById(vTrackId);
    const aOut = outFile.getTrackById(aTrackId);
    if (!vOut || !aOut) throw new Error('create output track failed');
    const vEntry = firstSampleEntry(vSrcTrak);
    const aEntry = firstSampleEntry(aSrcTrak);
    if (vEntry) vOut.mdia.minf.stbl.stsd.entries[0] = vEntry;
    if (aEntry) aOut.mdia.minf.stbl.stsd.entries[0] = aEntry;
    outFile.moov.traks = [vOut, aOut];

    outFile.setSegmentOptions(vTrackId, null, { nbSamples: 1000 });
    outFile.setSegmentOptions(aTrackId, null, { nbSamples: 1000 });

    const chunks = [];
    outFile.onSegment = (id, user, buffer) => {
      chunks.push(buffer);
    };

    // 初始化分段：一次写入 video+audio 两条轨（等价于 mp4box 内部 writeInitializationSegment）
    outFile.isFragmentationInitialized = true;
    outFile.nextMoofNumber = 0;
    outFile.resetTables();
    const movieTimescale = outFile.moov.mvhd.timescale || 600;
    const videoSeconds = vInfo.duration && vInfo.timescale ? vInfo.duration / vInfo.timescale : 0;
    const movieDuration = Math.round(videoSeconds * movieTimescale);
    outFile.moov.mvhd.duration = movieDuration;
    const moov = new BoxParserRef.moovBox();
    moov.mvhd = outFile.moov.mvhd;
    moov.boxes.push(moov.mvhd, vOut, aOut);
    moov.traks = [vOut, aOut];
    const initBuffer = ISO.writeInitializationSegment(outFile.ftyp, moov, movieDuration, 0);

    outFile.start();
    for (const sample of vSamples) outFile.addSample(vTrackId, sample.data, sample);
    for (const sample of aSamples) outFile.addSample(aTrackId, sample.data, sample);

    const parts = [initBuffer].concat(chunks);
    const total = parts.reduce((sum, part) => sum + (part.byteLength || part.size || 0), 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      const view = part instanceof Uint8Array ? part : new Uint8Array(part);
      merged.set(view, offset);
      offset += view.byteLength;
    }
    return new Blob([merged.buffer], { type: 'video/mp4' });
  }

  // B站清晰度 id → 名称
  const BILI_QUALITY_MAP = {
    127: '8K', 126: '杜比视界', 125: 'HDR', 120: '4K', 116: '1080P60', 112: '1080P+',
    80: '1080P', 74: '720P60', 64: '720P', 32: '480P', 16: '360P', 6: '240P'
  };

  function qualityName(id) {
    return BILI_QUALITY_MAP[id] || (id + 'P');
  }

  // 平台解析器：返回 { videoUrl, audioUrl, kind, headers } 或 null
  async function resolvePlatform(url, pageUrl, qualityId, meta) {
    switch (detectPlatform(pageUrl)) {
      case 'bilibili': return resolveBilibili(url, pageUrl, qualityId, meta);
      case 'douyin': return resolveDouyin(url, pageUrl, meta);
      case 'tiktok': return resolveTiktok(url, pageUrl, meta);
      case 'youtube': return resolveYoutube(url, pageUrl, qualityId, meta);
      default: return null;
    }
  }

  const BILI_HEADERS = { Referer: 'https://www.bilibili.com/' };

  async function bilibiliContext(pageUrl, meta) {
    const bv = /(BV[0-9A-Za-z]+)/.exec(pageUrl || location.href);
    if (!bv) return null;
    const res = await fetch('https://api.bilibili.com/x/web-interface/view?bvid=' + bv[1], withMeta(meta, { credentials: 'omit' }));
    const json = await res.json();
    const cid = json && json.data && json.data.cid;
    return cid ? { bv: bv[1], cid } : null;
  }

  function bilibiliPlayUrl(ctx, fnval) {
    return 'https://api.bilibili.com/x/player/playurl?bvid=' + ctx.bv + '&cid=' + ctx.cid + '&fnval=' + fnval + '&fnver=0&fourk=1';
  }

  async function fetchBilibiliDash(ctx, meta) {
    const res = await fetch(bilibiliPlayUrl(ctx, 16), withMeta(meta, { credentials: 'omit', headers: BILI_HEADERS }));
    const json = await res.json();
    return (json && json.data && json.data.dash) || null;
  }

  // 获取 B站视频的清晰度列表（不下载，只列元数据）
  async function resolveBilibiliQualities(pageUrl, meta) {
    try {
      const ctx = await bilibiliContext(pageUrl, meta);
      if (!ctx) return [];
      const dash = await fetchBilibiliDash(ctx, meta);
      if (!dash || !Array.isArray(dash.video)) return [];

      const qualities = dash.video.map((v) => ({
        id: v.id,
        label: qualityName(v.id),
        codec: v.codecs || '',
        width: v.width || 0,
        height: v.height || 0,
        frameRate: v.frameRate || ''
      }));
      // 去重并按清晰度降序
      const seen = new Set();
      return qualities.filter((q) => {
        if (seen.has(q.id)) return false;
        seen.add(q.id);
        return true;
      }).sort((a, b) => (b.id || 0) - (a.id || 0));
    } catch (_) {
      return [];
    }
  }

  async function resolveBilibili(url, pageUrl, qualityId, meta) {
    try {
      const ctx = await bilibiliContext(pageUrl, meta);
      if (!ctx) return null;
      const headers = BILI_HEADERS;

      // 若指定了清晰度，优先用 DASH 拿对应档
      if (qualityId) {
        const dash = await fetchBilibiliDash(ctx, meta);
        if (dash && Array.isArray(dash.video) && dash.video.length) {
          const videoArr = dash.video.slice().sort((a, b) => (b.id || 0) - (a.id || 0));
          const chosen = videoArr.find((v) => String(v.id) === String(qualityId)) || videoArr[0];
          const audioArr = (dash.audio || []).slice().sort((a, b) => (b.id || 0) - (a.id || 0));
          const audio = audioArr[0];
          const v = chosen.baseUrl || (chosen.backupUrl && chosen.backupUrl[0]) || '';
          const a = audio ? (audio.baseUrl || (audio.backupUrl && audio.backupUrl[0]) || '') : '';
          if (v) return { videoUrl: v, audioUrl: a, kind: 'streams', headers, quality: qualityName(chosen.id) };
        }
      }

      // 未指定清晰度：首选 fnval=0 单流 MP4
      const res0 = await fetch(bilibiliPlayUrl(ctx, 0), withMeta(meta, { credentials: 'omit', headers }));
      const json0 = await res0.json();
      const durl = json0 && json0.data && json0.data.durl;
      if (Array.isArray(durl) && durl.length) {
        const u = durl[durl.length - 1].url || durl[0].url;
        if (u) return { videoUrl: u, audioUrl: '', kind: 'direct', headers };
      }

      // 退回 DASH（最高档）
      const dash = await fetchBilibiliDash(ctx, meta);
      if (!dash) return null;
      const pick = (arr) => {
        if (!Array.isArray(arr) || !arr.length) return '';
        const sorted = arr.slice().sort((a, b) => (b.id || 0) - (a.id || 0));
        return sorted[0].baseUrl || (sorted[0].backupUrl && sorted[0].backupUrl[0]) || '';
      };
      const v = pick(dash.video);
      const a = pick(dash.audio);
      if (!v) return null;
      return { videoUrl: v, audioUrl: a, kind: 'streams', headers };
    } catch (_) {
      return null;
    }
  }

  // ===== YouTube: JS-less InnerTube client 拿音视频直链 =====
  // WEB 播放器当前是 SABR-only，adaptiveFormats 没有 url；改用不需要 player JS 的胶囊客户端，
  // 它们返回的 adaptiveFormats[].url 是普通直链，无 signatureCipher / n 参数，可直接 Range 下载。
  const YT_INNERTUBE = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';
  const YT_CLIENTS = [
    { name: 'ANDROID_VR', id: 28, version: '1.60.19', androidSdk: 32 },
    { name: 'VISIONOS', id: 101, version: '1.02' }
  ];

  function youtubeVideoId(pageUrl) {
    const s = String(pageUrl || '');
    let m = /[?&]v=([0-9A-Za-z_-]{11})/.exec(s);
    if (m) return m[1];
    m = /youtu\.be\/([0-9A-Za-z_-]{11})/.exec(s);
    if (m) return m[1];
    m = /(?:embed|shorts|live)\/([0-9A-Za-z_-]{11})/.exec(s);
    return m ? m[1] : '';
  }

  function youtubePickFormats(info, qualityId) {
    const formats = (info && info.streamingData && info.streamingData.adaptiveFormats) || [];
    const usable = formats.filter((f) => f && f.url && /^https?:\/\//i.test(f.url));
    const audios = usable.filter((f) => /^audio\//i.test(f.mimeType || ''));
    const videos = usable.filter((f) => /^video\//i.test(f.mimeType || ''));
    const audio = audios.slice().sort((a, b) => (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0))[0] || null;
    let video = null;
    if (qualityId) {
      video = videos.find((f) => String(f.itag) === String(qualityId)) || null;
    }
    if (!video) {
      const ranked = videos.slice().sort((a, b) => {
        const ah = Number((a.qualityLabel || '').match(/\d+/)) || 0;
        const bh = Number((b.qualityLabel || '').match(/\d+/)) || 0;
        if (bh !== ah) return bh - ah;
        return (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0);
      });
      video = ranked[0] || null;
    }
    return { video, audio, videos, audios };
  }

  async function youtubePlayerRequest(videoId, client, meta) {
    const clientBody = {
      clientName: client.name,
      clientVersion: client.version,
      hl: 'en',
      gl: 'US'
    };
    if (client.androidSdk) clientBody.androidSdkVersion = client.androidSdk;
    const body = {
      context: { client: clientBody },
      videoId,
      contentCheckOk: true,
      racyCheckOk: true
    };
    const headers = {
      'Content-Type': 'application/json',
      'X-YouTube-Client-Name': String(client.id),
      'X-YouTube-Client-Version': client.version
    };
    const res = await fetch(YT_INNERTUBE, withMeta(meta, {
      method: 'POST',
      credentials: 'omit',
      headers,
      body: JSON.stringify(body),
      [INTERNAL]: true
    }));
    if (!res.ok) throw new Error('InnerTube ' + client.name + ' HTTP ' + res.status);
    return res.json();
  }

  async function resolveYoutube(url, pageUrl, qualityId, meta) {
    const videoId = youtubeVideoId(pageUrl) || youtubeVideoId(url);
    if (!videoId) return null;
    for (const client of YT_CLIENTS) {
      try {
        const info = await youtubePlayerRequest(videoId, client, meta || null);
        const status = info && info.playabilityStatus && info.playabilityStatus.status;
        if (status !== 'OK') {
          continue;
        }
        const picked = youtubePickFormats(info, qualityId);
        if (!picked.video || !picked.audio) {
          continue;
        }
        return {
          videoUrl: picked.video.url,
          audioUrl: picked.audio.url,
          kind: 'streams',
          headers: {},
          quality: picked.video.qualityLabel || String(picked.video.itag || ''),
          ytClient: client.name
        };
      } catch (e) {
        continue;
      }
    }
    return null;
  }

  const DOUYIN_MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
  const DOUYIN_REFERER = 'https://www.douyin.com/';

  function decodePlatformUrl(raw) {
    if (!raw) return '';
    let text = String(raw);
    try { text = decodeURIComponent(text); } catch (_) {}
    return text.replace(/\\u002F/gi, '/').replace(/\\\//g, '/').replace(/\\u0026/gi, '&').replace(/&amp;/g, '&');
  }

  function pickDouyinUrl(node) {
    // node 可能是字符串、{url_list:[...]}、[{...}] 等结构
    if (!node) return '';
    if (typeof node === 'string') return decodePlatformUrl(node);
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = pickDouyinUrl(item);
        if (found) return found;
      }
      return '';
    }
    if (typeof node === 'object') {
      if (Array.isArray(node.url_list) && node.url_list.length) {
        const list = node.url_list.map(decodePlatformUrl).filter((u) => /^https?:\/\//i.test(u));
        if (list.length) return list[0];
      }
      for (const key of ['play_addr', 'playAddr', 'play_addr_h264', 'download_addr', 'downloadAddr']) {
        if (node[key]) {
          const found = pickDouyinUrl(node[key]);
          if (found) return found;
        }
      }
    }
    return '';
  }

  function findAwemeVideo(item) {
    if (!item || typeof item !== 'object') return '';
    const video = item.video || item.videoInfo || null;
    if (!video) return '';
    return pickDouyinUrl(video.play_addr) ||
      pickDouyinUrl(video.playAddr) ||
      pickDouyinUrl(video.play_addr_h264) ||
      pickDouyinUrl(video.download_addr) ||
      pickDouyinUrl(video.downloadAddr) ||
      pickDouyinUrl(video.playApi) || '';
  }

  // 抖音音视频分离：视频轨在 video.play_addr，音频在 music.play_url
  function findAwemeAudio(item) {
    if (!item || typeof item !== 'object') return '';
    const music = item.music || null;
    if (music) {
      const audio = pickDouyinUrl(music.play_url) ||
        pickDouyinUrl(music.playUrl) ||
        pickDouyinUrl(music.play_url_h265);
      if (audio) return audio;
    }
    // 少数结构把音频放在 video.play_addr_265 的兄弟节点
    const video = item.video || null;
    if (video) {
      return pickDouyinUrl(video.audio) || pickDouyinUrl(video.play_addr_audio) || '';
    }
    return '';
  }

  // 从页面内嵌 JSON 中递归寻找 aweme 结构里的视频地址（命中后把音视频一起写入 out）
  function searchDouyinJson(node, depth, out) {
    if (!node || depth > 12 || out.length) return;
    if (Array.isArray(node)) {
      for (const item of node) {
        searchDouyinJson(item, depth + 1, out);
        if (out.length) return;
      }
      return;
    }
    if (typeof node !== 'object') return;
    const found = findAwemeVideo(node);
    if (found) {
      out.push({ videoUrl: found, audioUrl: findAwemeAudio(node) });
      return;
    }
    for (const key in node) {
      if (key === 'aweme_detail' || key === 'aweme_list' || key === 'awemeList' || key === 'awemeDetail' || key === 'data' || key === 'item_list' || key === 'itemList' || key === 'video') {
        searchDouyinJson(node[key], depth + 1, out);
        if (out.length) return;
      }
    }
    // 再兜底扫一层所有值，覆盖结构变化
    for (const key in node) {
      const value = node[key];
      if (value && typeof value === 'object') {
        searchDouyinJson(value, depth + 1, out);
        if (out.length) return;
      }
    }
  }

  function extractFromJsonScripts(html) {
    const out = [];
    const scriptRe = /<script[^>]*id="(RENDER_DATA|__NEXT_DATA__|__NUXT__|_ROUTER_DATA)"[^>]*>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = scriptRe.exec(html))) {
      let text = m[2].trim();
      try { text = decodeURIComponent(text); } catch (_) {}
      try {
        const data = JSON.parse(text);
        searchDouyinJson(data, 0, out);
      } catch (_) {}
      if (out.length) return out[0];
    }
    // 直接对整段 HTML 里出现的 aweme JSON 做正则兜底
    const playRe = /"play_addr"\s*:\s*\{[\s\S]{0,600}?"url_list"\s*:\s*\[\s*"([^"]+)"/i;
    const playRe2 = /"playAddr"\s*:\s*"([^"]+)"/i;
    const urlListRe = /"url_list"\s*:\s*\[\s*"(https?:\\?\/\\?\/[^"]+)"/i;
    for (const re of [playRe, playRe2, urlListRe]) {
      const hit = re.exec(html);
      if (hit && hit[1]) {
        const decoded = decodePlatformUrl(hit[1]);
        if (/^https?:\/\//i.test(decoded)) {
          // 正则兜底时单独再找一次音频地址
          let audio = '';
          const musicRe = /"music"\s*:\s*\{[\s\S]{0,2000}?"play_url"\s*:\s*\{[\s\S]{0,600}?"url_list"\s*:\s*\[\s*"([^"]+)"/i;
          const musicHit = musicRe.exec(html);
          if (musicHit && musicHit[1]) audio = decodePlatformUrl(musicHit[1]);
          return { videoUrl: decoded, audioUrl: audio };
        }
      }
    }
    return null;
  }

  // 短链 v.douyin.com / 无 ID 时，先拿到真实页面 HTML 与最终 URL
  async function fetchDouyinPage(pageUrl, meta) {
    const metaWithUa = Object.assign({}, meta || {}, {
      referrer: DOUYIN_REFERER,
      userAgent: DOUYIN_MOBILE_UA,
      credentials: 'include',
      headers: Object.assign({ Referer: DOUYIN_REFERER }, (meta && meta.headers) || {})
    });
    const res = await fetch(pageUrl, withMeta(metaWithUa, { credentials: 'include', redirect: 'follow' }));
    const html = await res.text();
    return { html, finalUrl: res.url || pageUrl, meta: metaWithUa };
  }

  async function resolveDouyin(url, pageUrl, meta) {
    try {
      const page = pageUrl || location.href;
      const headers = { Referer: DOUYIN_REFERER, Origin: 'https://www.douyin.com' };

      // 1. 直接抓页面 HTML（follow 重定向，短链也会落到真实视频页）
      let html = '';
      let finalUrl = page;
      let workMeta = meta;
      try {
        const fetched = await fetchDouyinPage(page, meta);
        html = fetched.html;
        finalUrl = fetched.finalUrl;
        workMeta = fetched.meta;
      } catch (_) {}

      // 2. 从内嵌 JSON 中提取无水印播放地址（同时拿音频地址）
      let target = '';
      let audioTarget = '';
      const extracted = extractFromJsonScripts(html || '');
      if (extracted && extracted.videoUrl) {
        target = extracted.videoUrl;
        audioTarget = extracted.audioUrl || '';
      }

      // 3. 兜底：老式正则
      if (!target) {
        const patterns = [/playAddr"\s*:\s*"(.*?)"/, /videoUrl"\s*:\s*"(.*?)"/, /bytevod\S*?":\s*"(.*?)"/];
        for (const re of patterns) {
          const m = re.exec(html || '');
          if (m && m[1]) { target = decodePlatformUrl(m[1]); break; }
        }
      }

      // 4. 优先走带音轨的 play 接口：拿 aweme_id → detail → video_id(vid) → play 接口
      //    实测该接口返回音视频合一的普通 MP4，是最可靠的带声源。
      //    无条件尝试（即使步骤 2 已拿到直链），因为内嵌 JSON 的直链常是纯视频轨。
      const idMatch = /(?:video|note|share\/video|share\/note)\/(\d{15,})/.exec(finalUrl) || /(\d{18,19})/.exec(finalUrl);
      if (idMatch) {
        try {
          const entries = performance.getEntriesByType('resource') || [];
          let apiUrl = 'https://www.douyin.com/aweme/v1/web/aweme/detail/?device_platform=webapp&aid=6383&channel=channel_pc_web&aweme_id=' + idMatch[1];
          for (const e of entries) {
            const name = e && e.name ? e.name : '';
            if (/aweme\/v1\/web\/aweme\/detail/.test(name) && name.indexOf(idMatch[1]) !== -1) { apiUrl = name; break; }
          }
          const apiRes = await fetch(apiUrl, withMeta(workMeta || {}, {
            credentials: 'include',
            headers: Object.assign({ Referer: DOUYIN_REFERER }, headers)
          }));
          const apiJson = await apiRes.json();
          const aweme = apiJson && apiJson.aweme_detail;
          let vid = '';
          if (aweme) {
            const v = aweme.video || {};
            vid = (v.play_addr && v.play_addr.uri) || v.vid || '';
            // 即使 play 接口失败，也要用 detail 里的直链/音频作为可靠兜底
            if (!target) target = findAwemeVideo(aweme);
            if (!audioTarget) audioTarget = findAwemeAudio(aweme);
          }
          if (!vid && html) {
            const m = /"uri"\s*:\s*"(v[\da-z]{20,})"/i.exec(html) || /"vid"\s*:\s*"(v[\da-z]{20,})"/i.exec(html);
            if (m) vid = m[1];
          }
          if (vid) {
            const playUrl = 'https://www.douyin.com/aweme/v1/play/?video_id=' + encodeURIComponent(vid) + '&ratio=720p&line=0';
            try {
              const check = await fetch(playUrl, withMeta(workMeta || {}, { credentials: 'omit' }));
              if (check.ok) {
                target = playUrl;
                audioTarget = '';
              }
            } catch (_) {}
          }
        } catch (_) {}
      }

      // 5. 兜底：从页面 DOM / 已加载网络资源里找抖音视频直链
      if (!target) {
        try {
          const domVideo = document.querySelector('video[src], video source[src]');
          const domSrc = domVideo ? (domVideo.currentSrc || domVideo.src || domVideo.getAttribute('src') || '') : '';
          const cleanDom = decodePlatformUrl(domSrc);
          if (/^https?:\/\//i.test(cleanDom) && /douyin|aweme|byteimg|zjcdn|douyinvod|\/video\//i.test(cleanDom)) target = cleanDom;
        } catch (_) {}
      }
      if (!target) {
        try {
          const entries = performance.getEntriesByType('resource') || [];
          for (const entry of entries) {
            const name = entry && entry.name ? entry.name : '';
            if (!/^https?:\/\//i.test(name)) continue;
            if (/douyinvod|aweme|zjcdn|\/video\/tos\//i.test(name) && /\.(mp4|m4s)(\?|#|$)/i.test(name)) {
              target = name;
              break;
            }
          }
        } catch (_) {}
      }

      if (!target) return null;
      if (!/^https?:\/\//i.test(target)) return null;

      // 6. 去掉水印：playwm -> play，并用移动 UA + Referer/Origin 请求
      target = target.replace('/playwm/', '/play/').replace('playwm', 'play');
      if (audioTarget) audioTarget = audioTarget.replace('/playwm/', '/play/').replace('playwm', 'play');
      // play 接口是同源，用 omit 即可（实测 302 带 CORS）；CDN 直链需 include
      const cred = /\/aweme\/v1\/play\//i.test(target) ? 'omit' : 'include';
      // MP3 音频无法注入 MP4 容器，直接丢弃；只有非 MP3 才尝试合并
      const audioIsMp4 = !!audioTarget && !/\.mp3(\?|#|$)/i.test(audioTarget);
      if (audioTarget && audioIsMp4) {
        return { videoUrl: target, audioUrl: audioTarget, kind: 'streams', headers, userAgent: DOUYIN_MOBILE_UA, credentials: cred };
      }
      return { videoUrl: target, audioUrl: '', kind: 'direct', headers, userAgent: DOUYIN_MOBILE_UA, credentials: cred };
    } catch (_) {
      return null;
    }
  }

  // ===== TikTok（海外版抖音）=====
  const TIKTOK_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
  const TIKTOK_REFERER = 'https://www.tiktok.com/';

  // 收集 TikTok 所有可下载候选；音轨标记为 isAudio，交给 resolveTiktok 做双流合并
  function searchTiktokJson(node, depth, out, seen) {
    if (!node || depth > 16 || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) searchTiktokJson(item, depth + 1, out, seen);
      return;
    }

    // 音轨：TikTok 的 video 是纯视频流，声音在 music.playAddr / playUrl
    const music = node.music || node.Music;
    if (music && typeof music === 'object') {
      const addAudio = (raw) => {
        const url = decodePlatformUrl(raw);
        if (/^https?:\/\//i.test(url) && !out.some((c) => c.isAudio && c.url === url)) {
          out.push({ url, isAudio: true });
        }
      };
      if (typeof music.playAddr === 'string') addAudio(music.playAddr);
      if (typeof music.playUrl === 'string') addAudio(music.playUrl);
      if (typeof music.downloadUrl === 'string') addAudio(music.downloadUrl);
      if (music.playAddr && typeof music.playAddr === 'object') {
        (music.playAddr.UrlList || music.playAddr.url_list || []).forEach(addAudio);
      }
      if (music.playUrl && typeof music.playUrl === 'object') {
        (music.playUrl.UrlList || music.playUrl.url_list || []).forEach(addAudio);
      }
    }

    // bitrateInfo[] 档位：PlayAddr.UrlList 里含同源 play 接口与 CDN 直链
    if (node.PlayAddr && node.CodecType) {
      const urls = (node.PlayAddr.UrlList || []).map(decodePlatformUrl).filter((u) => /^https?:\/\//i.test(u));
      const h265 = /h265|hevc|hvc1/i.test(node.CodecType || '');
      for (const url of urls) out.push({ url, codec: node.CodecType, h265 });
    }
    // 主 playAddr（字符串），带 codecType 可判断是否纯视频
    if (typeof node.playAddr === 'string' && /^https?:\/\//i.test(node.playAddr)) {
      out.push({ url: decodePlatformUrl(node.playAddr), codec: node.codecType || '', h265: /h265|hevc|hvc1/i.test(node.codecType || '') });
    }
    if (typeof node.downloadAddr === 'string' && /^https?:\/\//i.test(node.downloadAddr)) {
      out.push({ url: decodePlatformUrl(node.downloadAddr), codec: 'download', h265: false });
    }
    for (const key in node) {
      const value = node[key];
      if (value && typeof value === 'object') searchTiktokJson(value, depth + 1, out, seen);
    }
  }

  function extractTiktokFromHtml(html) {
    const out = [];
    const seen = new WeakSet();
    const scriptRe = /<script[^>]*id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/i;
    const scriptHit = scriptRe.exec(html || '');
    if (scriptHit && scriptHit[1]) {
      try { searchTiktokJson(JSON.parse(scriptHit[1]), 0, out, seen); } catch (_) {}
    }
    if (!out.length) {
      const sigiRe = /<script[^>]*id="SIGI_STATE"[^>]*>([\s\S]*?)<\/script>/i;
      const sigiHit = sigiRe.exec(html || '');
      if (sigiHit && sigiHit[1]) {
        try { searchTiktokJson(JSON.parse(sigiHit[1]), 0, out, new WeakSet()); } catch (_) {}
      }
    }
    if (!out.length) {
      // 正则兜底（codecType 一起抓，便于降权 h265）
      const reList = [/"playAddr":"([^"]+)"[^}]{0,200}?"codecType":"([^"]+)"/i, /"playAddr":"([^"]+)"/i, /"downloadAddr":"([^"]+)"/i];
      for (const re of reList) {
        const hit = re.exec(html || '');
        if (hit && hit[1]) {
          const decoded = decodePlatformUrl(hit[1]);
          if (/^https?:\/\//i.test(decoded)) out.push({ url: decoded, codec: hit[2] || '', h265: /h265|hevc|hvc1/i.test(hit[2] || '') });
        }
      }
      const musicRe = /"music"\s*:\s*\{[\s\S]{0,2000}?"playAddr"\s*:\s*"(https?:\\?\/\\?\/[^"]+)"/i;
      const musicHit = musicRe.exec(html || '');
      if (musicHit && musicHit[1]) {
        const decoded = decodePlatformUrl(musicHit[1]);
        if (/^https?:\/\//i.test(decoded)) out.push({ url: decoded, isAudio: true });
      }
    }
    // 同源 play 接口优先；h264 优先；h265 降权（实测 hvc1 是纯视频轨）
    out.sort((a, b) => {
      const score = (c) => (/\/\/www\.tiktok\.com\//i.test(c.url) ? 100 : 0) + (c.h265 ? -20 : 10);
      return score(b) - score(a);
    });
    return out;
  }

  async function resolveTiktok(url, pageUrl, meta) {
    try {
      const page = pageUrl || location.href;
      const headers = { Referer: TIKTOK_REFERER, Origin: 'https://www.tiktok.com' };
      const workMeta = Object.assign({}, meta || {}, {
        referrer: TIKTOK_REFERER,
        userAgent: TIKTOK_UA,
        headers: Object.assign({ Referer: TIKTOK_REFERER }, (meta && meta.headers) || {})
      });

      // 1. 抓页面（follow 重定向，vt./vm. 短链会落到真实视频页）
      let html = '';
      try {
        const res = await fetch(page, withMeta(workMeta, { credentials: 'include', redirect: 'follow' }));
        html = await res.text();
      } catch (_) {}

      // 2. 收集所有候选（downloadAddr 音视频合一优先级最高；否则视频轨 + music 音轨双流）
      let candidates = extractTiktokFromHtml(html || '');
      const audioCandidates = candidates.filter((c) => c.isAudio);
      candidates = candidates.filter((c) => !c.isAudio).slice().sort((a, b) => {
        const score = (c) => (c.codec === 'download' ? 100 : 0) + (/\/\/www\.tiktok\.com\//i.test(c.url) ? 30 : 0) - (c.h265 ? 30 : 0);
        return score(b) - score(a);
      });

      // 2.1 页面里已经在用的媒体地址：<video>/<audio> 的 currentSrc、已加载资源中的音频请求。
      //     TikTok 网页播放器拿到的地址往往就是带音轨的，比猜 music 接口更可靠。
      const addAudioUrl = (raw) => {
        const url = decodePlatformUrl(raw);
        if (!/^https?:\/\//i.test(url)) return;
        if (audioCandidates.some((c) => c.url === url)) return;
        audioCandidates.push({ url, isAudio: true, from: 'page' });
      };
      try {
        const mediaEls = document.querySelectorAll('video, video source, audio, audio source');
        mediaEls.forEach((el) => {
          const src = decodePlatformUrl(el.currentSrc || el.src || el.getAttribute('src') || '');
          if (/^https?:\/\//i.test(src) && /(music|audio|mime_type=audio|\.mp3|\.m4a)(\?|#|$)/i.test(src)) addAudioUrl(src);
        });
      } catch (_) {}
      try {
        const entries = performance.getEntriesByType('resource') || [];
        for (const entry of entries) {
          const name = entry && entry.name ? entry.name : '';
          if (/^https?:\/\//i.test(name) && /(music|audio|mime_type=audio|\.mp3|\.m4a)(\?|#|$)/i.test(name)) addAudioUrl(name);
        }
      } catch (_) {}

      // 2.2 页面里没有音轨地址时，再请求 TikTok 官方 item/detail 接口补一次
      if (!audioCandidates.length) {
        const idMatch = /\/video\/(\d{10,25})/.exec(page) || /"id"\s*:\s*"(\d{10,25})"/.exec(html || '');
        if (idMatch) {
          try {
            const api = 'https://www.tiktok.com/api/item/detail/?itemId=' + idMatch[1] + '&aid=1988';
            const res = await fetch(api, withMeta(workMeta, { credentials: 'include' }));
            const type = res.headers.get('content-type') || '';
            if (res.ok && /json/i.test(type)) {
              const extra = [];
              searchTiktokJson(await res.json(), 0, extra, new WeakSet());
              for (const c of extra) {
                if (c.isAudio) addAudioUrl(c.url);
                else if (!candidates.some((x) => x.url === c.url)) candidates.push(c);
              }
            }
          } catch (e) {
          }
        }
      }

      // 3. 兜底：页面 DOM / 已加载资源
      if (!candidates.length) {
        try {
          const domVideo = document.querySelector('video[src], video source[src]');
          const domSrc = domVideo ? (domVideo.currentSrc || domVideo.src || domVideo.getAttribute('src') || '') : '';
          const cleanDom = decodePlatformUrl(domSrc);
          if (/^https?:\/\//i.test(cleanDom) && /tiktokcdn|tiktokv|byteoversea|\/video\/tos\//i.test(cleanDom)) {
            candidates.push({ url: cleanDom, codec: 'dom', h265: false });
          }
        } catch (_) {}
      }
      if (!candidates.length) {
        try {
          const entries = performance.getEntriesByType('resource') || [];
          for (const entry of entries) {
            const name = entry && entry.name ? entry.name : '';
            if (/^https?:\/\//i.test(name) && /tiktokcdn|tiktokv|byteoversea|\/video\/tos\//i.test(name) && /\.(mp4|m4s)(\?|#|$)/i.test(name)) {
              candidates.push({ url: name, codec: 'perf', h265: false });
              break;
            }
          }
        } catch (_) {}
      }
      if (!candidates.length) return null;

      // 2.5 探测音轨；即使探测失败也把第一个音轨地址传下去，让下载阶段再试，
      //     不能直接丢弃——否则整条视频静音。
      let usableAudioUrl = '';
      for (const ac of audioCandidates) {
        try {
          const probe = await fetch(ac.url, withMeta(workMeta, {
            credentials: 'include',
            headers: Object.assign({ Range: 'bytes=0-4095' }, workMeta.headers || {})
          }));
          const type = probe.headers.get('content-type') || '';
          if (probe.ok || probe.status === 206) {
            if (!/json|text\/html/i.test(type)) { usableAudioUrl = ac.url; break; }
          }
        } catch (_) {}
      }
      if (!usableAudioUrl && audioCandidates.length) usableAudioUrl = audioCandidates[0].url;

      // 4. 逐个验证：优先同源(omit 可过)与 h264；CDN 直链需 include。
      //    h265/hvc1 档实测是纯视频轨，跳过；验证时用 Range 只取一小段，避免整段下载。
      const seen = new Set();
      let pendingDirect = null;
      for (const cand of candidates) {
        if (!cand.url || seen.has(cand.url)) continue;
        seen.add(cand.url);
        if (cand.h265) continue;
        const sameOrigin = /^https?:\/\/www\.tiktok\.com\//i.test(cand.url);
        const cred = sameOrigin ? 'omit' : 'include';
        try {
          const probe = await fetch(cand.url, withMeta(workMeta, {
            credentials: cred,
            headers: Object.assign({ Range: 'bytes=0-196607' }, workMeta.headers || {})
          }));
          if (!probe.ok && probe.status !== 206) continue;
          const type = probe.headers.get('content-type') || '';
          if (/json|text\/html/i.test(type)) continue;
          // 先看候选文件本身是否已带音轨：TikTok 的 playAddr/downloadAddr 有一部分是音视频合一的，
          // 这种情况直接单文件下载，既不用拼“背景音乐”，也不会受音乐 CDN 断连影响。
          let bin = probeTracksBinary(await probe.arrayBuffer());
          // 首包探测不到轨道（moov 在文件尾部）时再抓一段尾部判断，避免把带音轨的文件误判成纯视频
          if (!bin.hasVideo && !bin.hasAudio) {
            const range = probe.headers.get('content-range') || '';
            const total = Number((range.split('/')[1] || probe.headers.get('content-length') || 0));
            if (total > 262144) {
              try {
                const tail = await fetch(cand.url, withMeta(workMeta, {
                  credentials: cred,
                  headers: Object.assign({ Range: `bytes=${Math.max(0, total - 262144)}-${total - 1}` }, workMeta.headers || {})
                }));
                if (tail.ok || tail.status === 206) bin = probeTracksBinary(await tail.arrayBuffer());
              } catch (_) {}
            }
          }
          // 视频轨可见但看不到音频轨：moov 里的 stbl 可能超过 192KB，音频轨排在后面。
          // 再取前 2MB 复查一次，避免把“音视频合一”的文件误判成纯视频（否则会拿音乐去拼，听不到原声）。
          if (bin.hasVideo && !bin.hasAudio) {
            const range = probe.headers.get('content-range') || '';
            const total = Number((range.split('/')[1] || probe.headers.get('content-length') || 0));
            const wantEnd = Math.min(total || 2097152, 2097152) - 1;
            if (wantEnd > 196607) {
              try {
                const wide = await fetch(cand.url, withMeta(workMeta, {
                  credentials: cred,
                  headers: Object.assign({ Range: `bytes=0-${wantEnd}` }, workMeta.headers || {})
                }));
                if (wide.ok || wide.status === 206) {
                  const wideBin = probeTracksBinary(await wide.arrayBuffer());
                  if (wideBin.hasAudio) bin = wideBin;
                }
              } catch (_) {}
            }
          }
          // 只有音轨没有视频轨的候选（常见于把 music 地址混进候选）不能当视频轨用。
          // 但不能直接丢弃：moov 落在探测窗口之外时会把“合一文件”误判成纯音频，
          // 先记下来，全部候选都失败时再按单文件下载，避免整条视频被漏掉。
          if (bin.hasAudio && !bin.hasVideo) {
            const looksMusic = /(ies-music|mime_type=audio|\.mp3|\.m4a|music\/)/i.test(cand.url);
            if (!looksMusic && !pendingDirect) {
              pendingDirect = { videoUrl: cand.url, audioUrl: '', kind: 'direct', headers, userAgent: TIKTOK_UA, credentials: cred };
            }
            continue;
          }
          if (bin.hasAudio && bin.hasVideo) {
            return {
              videoUrl: cand.url,
              audioUrl: '',
              kind: 'direct',
              headers,
              userAgent: TIKTOK_UA,
              credentials: cred
            };
          }
          // 纯视频轨：走双流；downloadAddr 实测也可能是纯视频，不能再当合一文件直接下载。
          // 只有确实没有音轨候选时，才退回单文件。
          if (usableAudioUrl) {
            return {
              videoUrl: cand.url,
              audioUrl: usableAudioUrl,
              kind: 'streams',
              headers,
              userAgent: TIKTOK_UA,
              credentials: cred
            };
          }
          return {
            videoUrl: cand.url,
            audioUrl: '',
            kind: 'direct',
            headers,
            userAgent: TIKTOK_UA,
            credentials: cred
          };
        } catch (_) { continue; }
      }
      if (pendingDirect) {
        return pendingDirect;
      }
      return null;
    } catch (_) {
      return null;
    }
  }

  // ===== 三层资源模型 Layer 3：平台 Adapter =====
  function detectPlatform(pageUrl) {
    let host = '';
    try { host = new URL(pageUrl || location.href).hostname; } catch (_) {}
    if (/bilibili\.com$/.test(host) || /\.bilibili\.com$/.test(host)) return 'bilibili';
    if (/douyin\.com$/.test(host) || /\.douyin\.com$/.test(host)) return 'douyin';
    if (/tiktok\.com$/.test(host) || /\.tiktok\.com$/.test(host)) return 'tiktok';
    if (/youtube\.com$/.test(host) || /\.youtube\.com$/.test(host) || /youtu\.be$/.test(host)) return 'youtube';
    return '';
  }

  function pageFetchMeta(platform) {
    if (platform === 'tiktok') {
      return {
        referrer: TIKTOK_REFERER,
        userAgent: TIKTOK_UA,
        credentials: 'include',
        headers: { Referer: TIKTOK_REFERER }
      };
    }
    if (platform === 'douyin') {
      return {
        referrer: DOUYIN_REFERER,
        userAgent: DOUYIN_MOBILE_UA,
        credentials: 'include',
        headers: { Referer: DOUYIN_REFERER }
      };
    }
    return { referrer: 'https://www.bilibili.com/', headers: { Referer: 'https://www.bilibili.com/' } };
  }

  // 从页面一次性枚举所有可下载视频，不要求它正在播放。
  async function extractFromPage(pageUrl, meta) {
    const platform = detectPlatform(pageUrl);
    if (!platform) return [];
    const out = [];
    const seen = new Set();
    const add = (entry) => {
      if (!entry || !entry.url || seen.has(entry.url)) return;
      seen.add(entry.url);
      out.push(Object.assign({ kind: 'direct', score: 80, poster: '', title: '', videoUrl: '', audioUrl: '', width: 0, height: 0, duration: 0 }, entry));
    };

    let html = '';
    try {
      const workMeta = Object.assign({}, pageFetchMeta(platform), meta || {});
      const res = await fetch(pageUrl || location.href, withMeta(workMeta, { credentials: workMeta.credentials || 'omit', redirect: 'follow' }));
      html = await res.text();
    } catch (_) {}

    if (platform === 'tiktok') {
      const cands = extractTiktokFromHtml(html || '');
      const video = cands.filter((c) => !c.isAudio && !c.h265);
      const audio = cands.filter((c) => c.isAudio);
      const audioUrl = audio.length ? audio[0].url : '';
      video.slice(0, 60).forEach((c) => {
        add({
          url: c.url,
          videoUrl: c.url,
          audioUrl,
          kind: audioUrl ? 'streams' : 'direct',
          title: c.codec || 'TikTok 视频',
          score: c.codec === 'download' ? 92 : 86
        });
      });
    } else if (platform === 'douyin') {
      const extracted = extractFromJsonScripts(html || '');
      if (extracted && extracted.videoUrl) {
        add({
          url: extracted.videoUrl,
          videoUrl: extracted.videoUrl,
          audioUrl: extracted.audioUrl || '',
          kind: extracted.audioUrl ? 'streams' : 'direct',
          title: '抖音视频',
          score: 86
        });
      }
    } else if (platform === 'bilibili') {
      const bvs = new Set();
      (String(html || '').match(/BV[0-9A-Za-z]{10}/g) || []).forEach((bv) => bvs.add(bv));
      const current = /(BV[0-9A-Za-z]{10})/.exec(pageUrl || location.href);
      if (current) bvs.add(current[1]);
      Array.from(bvs).slice(0, 60).forEach((bv) => {
        add({
          url: 'https://www.bilibili.com/video/' + bv,
          title: bv,
          kind: 'platform',
          score: 70
        });
      });
    }

    return out;
  }

  // 校验 webRequest 嗅探到的 manifest 是否可用，并标记是否含独立音轨。
  // 不伪造 streams URL：HLS/DASH 的音视频配对由 downloadHls/downloadDash 在读清单时完成。
  async function inspectManifestUrl(url, meta) {
    const kind = detectKind(url);
    if (kind !== 'hls' && kind !== 'dash') return { ok: false, kind, url };
    const text = await fetchText(url, null, meta);
    let hasAudioTrack = false;
    if (kind === 'hls') {
      hasAudioTrack = /#EXT-X-MEDIA:[^\r\n]*TYPE=AUDIO/i.test(text);
    } else {
      const doc = new DOMParser().parseFromString(text, 'application/xml');
      if (doc.querySelector('parsererror')) return { ok: false, kind, url, error: 'invalid MPD' };
      const reps = collectReps(doc);
      hasAudioTrack = reps.some((r) => r.kind === 'audio');
    }
    return { ok: true, kind, url, hasAudioTrack, bytes: text.length };
  }

  window.__viDownloadEngine = {
    detectKind, fetchWhole, downloadHls, downloadDash, verifyBlob,
    mergeStreams, tsToMp4, isTsHead, resolvePlatform, extractFromPage,
    resolveBilibiliQualities, referrerMeta, probeTracks, inspectManifestUrl
  };
})();
