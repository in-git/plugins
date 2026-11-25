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
    for (;;) {
      if (signal.aborted) throw new Error('cancelled');
      const headers = {};
      if (extraHeaders) {
        for (const k in extraHeaders) headers[k] = extraHeaders[k];
      }
      if (!first) {
        headers.Range = 'bytes=' + pos + '-';
        if (etag) headers['If-Range'] = etag;
      }
      const response = await fetch(url, withMeta(meta, { credentials: (meta && meta.credentials) || 'omit', signal, headers, [INTERNAL]: true }));
      if (!response.ok && response.status !== 206) throw new Error('HTTP ' + response.status);
      const range = parseRange(response.headers.get('content-range'));
      if (first) {
        contentType = response.headers.get('content-type') || '';
        etag = response.headers.get('etag') || '';
        total = (range && range.total) || Number(response.headers.get('content-length')) || 0;
      } else if (response.status !== 206 || !range || range.start !== pos) {
        throw new Error('unexpected range response');
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
            onProgress(loaded, total);
          }
        }
      } else {
        const buf = await response.arrayBuffer();
        chunks.push(buf);
        loaded += buf.byteLength;
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
    return { tracks: [new Blob(chunks, { type: contentType || 'video/mp4' })], contentType, ext };
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

  async function downloadHls(playlistUrl, signal, onProgress, expectedDuration, meta) {
    let text = await fetchText(playlistUrl, signal, meta);
    let base = playlistUrl;
    let audioPlaylistUrl = '';

    if (/#EXT-X-STREAM-INF/.test(text)) {
      const lines = text.split(/\r?\n/).map((s) => s.trim());
      let best = null;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.indexOf('#EXT-X-MEDIA:') === 0 && /TYPE=AUDIO/i.test(line)) {
          const attrs = parseAttrs(line.slice('#EXT-X-MEDIA:'.length));
          if (attrs.URI && /DEFAULT=YES/i.test(line) && !audioPlaylistUrl) {
            audioPlaylistUrl = absUrl(attrs.URI, base);
          }
          continue;
        }
        if (line.indexOf('#EXT-X-STREAM-INF') !== 0) continue;
        if (audioPlaylistUrl && /AUDIO=/i.test(line)) {
          const attrs = parseAttrs(line.slice('#EXT-X-STREAM-INF:'.length));
          if (attrs.AUDIO) {
            const audioLine = lines.find((l) => l.indexOf('#EXT-X-MEDIA:') === 0 &&
              new RegExp('GROUP-ID=' + attrs.AUDIO + '([",]|$)').test(l) && /TYPE=AUDIO/i.test(l));
            if (audioLine) {
              const audioAttrs = parseAttrs(audioLine.slice('#EXT-X-MEDIA:'.length));
              if (audioAttrs.URI) audioPlaylistUrl = absUrl(audioAttrs.URI, base);
            }
          }
        }
        const attrs = parseAttrs(line.slice('#EXT-X-STREAM-INF:'.length));
        const next = lines[i + 1] || '';
        if (!next || next.charAt(0) === '#') continue;
        const score = (Number(attrs.BANDWIDTH) || 0) + (attrs.RESOLUTION ? 100000000 : 0);
        if (!best || score > best.score) best = { url: absUrl(next, base), score };
      }
      if (!best) throw new Error('no valid HLS variant');
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
      } catch (_) {
        // 音轨下载失败则退回视频轨本身（可能已含音频）
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

  // 判断 buffer 是否为 fragmented MP4（首 8 字节是 ftyp/moof/styp/moov）
  function isFmp4Head(bytes) {
    const b = new Uint8Array(bytes.slice(0, 8));
    const fourcc = String.fromCharCode(b[4], b[5], b[6], b[7]);
    return fourcc === 'ftyp' || fourcc === 'moof' || fourcc === 'styp' || fourcc === 'moov';
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

  // 解析单个轨道的样本列表（用 MP4Box 提取）
  function extractTrackSamples(file, trackId) {
    return new Promise((resolve, reject) => {
      const samples = [];
      let received = 0;
      let total = 0;
      file.onSamples = (id, user, s) => {
        s.forEach((sample) => samples.push(sample));
        received += s.length;
        if (total && received >= total) resolve(samples);
      };
      file.setExtractionOptions(trackId, null, { nbSamples: 1000 });
      file.start();
      // 兜底：等待一个 tick 后 resolve 已收到的样本
      setTimeout(() => resolve(samples), 1500);
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
      return {
        hasAudio: count(/soun/g) > 0 || count(/mp4a|Opus|ac-3|ec-3/g) > 0,
        hasVideo: count(/vide/g) > 0 || count(/avc1|hvc1|hev1|av01|vp09/g) > 0,
        audioTracks: count(/soun/g),
        videoTracks: count(/vide/g)
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
          const bin = probeTracksBinary(buffer);
          done({
            hasAudio: tracks.some((t) => t && (t.codec_type === '2' || t.type === 'audio' || /^mp4a|Opus|ac-3|ec-3|fLaC/i.test(t.codec || ''))) || bin.hasAudio,
            hasVideo: tracks.some((t) => t && (t.codec_type === '1' || t.type === 'video' || /^avc|hev|hvc|vp0|av01/i.test(t.codec || ''))) || bin.hasVideo,
            audioTracks: Math.max(tracks.filter((t) => t && t.codec_type === '2').length, bin.audioTracks),
            videoTracks: Math.max(tracks.filter((t) => t && t.codec_type === '1').length, bin.videoTracks)
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

  // DASH 双轨合流（MP4Box.js）：把视频轨(0)与音频轨(1)重封装成单一 MP4
  async function mergeStreams(buffers, onProgress) {
    if (!buffers || buffers.length < 2) return new Blob([buffers[0]], { type: 'video/mp4' });
    if (typeof window.MP4Box === 'undefined') throw new Error('mp4box unavailable');

    const videoBuf = toArrayBuffer(buffers[0]);
    const audioBuf = toArrayBuffer(buffers[1]);
    videoBuf.fileStart = 0;

    // 关键：如果视频文件本身已带音轨，绝不能再加一条音频轨，否则会产生
    // 1 视频 + 2 音频的非法 MP4，Windows 报「不受支持的编码设置」(0xC00D36E5)。
    const bin = probeTracksBinary(videoBuf);
    if (bin.hasAudio) {
      return new Blob([videoBuf], { type: 'video/mp4' });
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      // 兜底超时：MP4Box 解析 MP3 等非 MP4 容器时 onReady 不会触发，避免永久挂起。
      const guard = setTimeout(() => {
        if (!settled) { settled = true; reject(new Error('merge timeout')); }
      }, 20000);
      const fail = (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(guard);
        reject(e);
      };
      const succeed = (blob) => {
        if (settled) return;
        settled = true;
        clearTimeout(guard);
        resolve(blob);
      };

      // 解析视频文件拿轨道信息
      const videoFile = window.MP4Box.createFile();
      videoFile.onError = (e) => fail(new Error('mp4box video: ' + (e && e.message || e)));
      videoFile.onReady = (videoInfo) => {
        try {
          // 解析音频文件拿音频轨道
          const audioFile = window.MP4Box.createFile();
          audioFile.onError = (e) => fail(new Error('mp4box audio: ' + (e && e.message || e)));
          audioFile.onReady = async (audioInfo) => {
            try {
              // 提取音频样本
              const audioTrack = audioInfo.tracks[0];
              const samples = await extractTrackSamples(audioFile, audioTrack.id);

              // 输出文件：先加视频轨道
              const outFile = window.MP4Box.createFile();
              const outChunks = [];
              outFile.onError = (e) => fail(new Error('mp4box out: ' + (e && e.message || e)));
              outFile.onReady = (outInfo) => {
                try {
                  // 添加音频轨道
                  const newAudioTrack = outFile.addTrack(audioTrack);
                  samples.forEach((sample) => {
                    sample.track_id = newAudioTrack.id;
                    outFile.addSample(newAudioTrack.id, sample);
                  });
                  outFile.flush();

                  outInfo.tracks.forEach((t) => {
                    outFile.setSegmentOptions(t.id, t, { nbSamples: 4096, rapAlignement: true });
                  });
                  const initSegs = outFile.initializeSegmentation();
                  initSegs.forEach((s) => outChunks.push(s.buffer));
                  outFile.onSegment = (id, user, buffer) => {
                    outChunks.push(buffer);
                    if (onProgress) onProgress(outChunks.length);
                  };
                  outFile.start();
                  outFile.flush();

                  const total = outChunks.reduce((s, b) => s + b.byteLength, 0);
                  const joined = new Uint8Array(total);
                  let off = 0;
                  outChunks.forEach((b) => { joined.set(new Uint8Array(b), off); off += b.byteLength; });
                  succeed(new Blob([joined.buffer], { type: 'video/mp4' }));
                } catch (e) { fail(e); }
              };

              // 把视频样本喂给输出文件
              const videoSamples = await extractTrackSamples(videoFile, videoInfo.tracks[0].id);
              videoSamples.forEach((sample) => {
                outFile.addSample(videoInfo.tracks[0].id, sample);
              });
              outFile.appendBuffer(videoBuf, 0);
              outFile.flush();
            } catch (e) { fail(e); }
          };
          audioFile.appendBuffer(audioBuf, 0);
          audioFile.flush();
        } catch (e) { fail(e); }
      };

      videoFile.appendBuffer(videoBuf, 0);
      videoFile.flush();
    });
  }

  // B站清晰度 id → 名称
  const BILI_QUALITY_MAP = {
    127: '8K', 126: '杜比视界', 125: 'HDR', 120: '4K', 116: '1080P60', 112: '1080P+',
    80: '1080P', 74: '720P60', 64: '720P', 32: '480P', 16: '360P', 6: '240P'
  };

  function qualityName(id) {
    return BILI_QUALITY_MAP[id] || (id + 'P');
  }

  // 平台解析器：返回 { videoUrl, audioUrl, kind, headers, qualities } 或 null
  async function resolvePlatform(url, pageUrl, qualityId, meta) {
    const host = (() => { try { return new URL(pageUrl || location.href).hostname; } catch (_) { return ''; } })();

    if (/bilibili\.com$/.test(host) || /\.bilibili\.com$/.test(host)) {
      return resolveBilibili(url, pageUrl, qualityId, meta);
    }
    if (/douyin\.com$/.test(host) || /\.douyin\.com$/.test(host)) {
      return resolveDouyin(url, pageUrl, meta);
    }
    if (/tiktok\.com$/.test(host) || /\.tiktok\.com$/.test(host)) {
      return resolveTiktok(url, pageUrl, meta);
    }
    return null;
  }

  // 获取 B站视频的清晰度列表（不下载，只列元数据）
  async function resolveBilibiliQualities(pageUrl, meta) {
    try {
      const bv = /(BV[0-9A-Za-z]+)/.exec(pageUrl || location.href);
      if (!bv) return [];
      const viewUrl = 'https://api.bilibili.com/x/web-interface/view?bvid=' + bv[1];
      const viewRes = await fetch(viewUrl, withMeta(meta, { credentials: 'omit' }));
      const viewJson = await viewRes.json();
      const cid = viewJson && viewJson.data && viewJson.data.cid;
      if (!cid) return [];

      const headers = { Referer: 'https://www.bilibili.com/' };
      const playUrl16 = 'https://api.bilibili.com/x/player/playurl?bvid=' + bv[1] + '&cid=' + cid + '&fnval=16&fnver=0&fourk=1';
      const res16 = await fetch(playUrl16, withMeta(meta, { credentials: 'omit', headers }));
      const json16 = await res16.json();
      const dash = json16 && json16.data && json16.data.dash;
      if (!dash || !Array.isArray(dash.video)) return [];

      const qualities = dash.video.map((v) => ({
        id: v.id,
        label: qualityName(v.id),
        codec: v.codecs || ''
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
      // 从页面 URL 提取 BV 号
      const bv = /(BV[0-9A-Za-z]+)/.exec(pageUrl || location.href);
      if (!bv) return null;
      const viewUrl = 'https://api.bilibili.com/x/web-interface/view?bvid=' + bv[1];
      const viewRes = await fetch(viewUrl, withMeta(meta, { credentials: 'omit' }));
      const viewJson = await viewRes.json();
      const cid = viewJson && viewJson.data && viewJson.data.cid;
      if (!cid) return null;
      const headers = { Referer: 'https://www.bilibili.com/' };

      // 若指定了清晰度，优先用 DASH 拿对应档
      if (qualityId) {
        const playUrl16 = 'https://api.bilibili.com/x/player/playurl?bvid=' + bv[1] + '&cid=' + cid + '&fnval=16&fnver=0&fourk=1';
        const res16 = await fetch(playUrl16, withMeta(meta, { credentials: 'omit', headers }));
        const json16 = await res16.json();
        const dash = json16 && json16.data && json16.data.dash;
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
      const playUrl0 = 'https://api.bilibili.com/x/player/playurl?bvid=' + bv[1] + '&cid=' + cid + '&fnval=0&fnver=0&fourk=1';
      const res0 = await fetch(playUrl0, withMeta(meta, { credentials: 'omit', headers }));
      const json0 = await res0.json();
      const durl = json0 && json0.data && json0.data.durl;
      if (Array.isArray(durl) && durl.length) {
        const u = durl[durl.length - 1].url || durl[0].url;
        if (u) return { videoUrl: u, audioUrl: '', kind: 'direct', headers };
      }

      // 退回 DASH（最高档）
      const playUrl16 = 'https://api.bilibili.com/x/player/playurl?bvid=' + bv[1] + '&cid=' + cid + '&fnval=16&fnver=0&fourk=1';
      const res16 = await fetch(playUrl16, withMeta(meta, { credentials: 'omit', headers }));
      const json16 = await res16.json();
      const dash = json16 && json16.data && json16.data.dash;
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

  const DOUYIN_MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
  const DOUYIN_REFERER = 'https://www.douyin.com/';

  function douyinDecode(raw) {
    if (!raw) return '';
    let text = String(raw);
    try { text = decodeURIComponent(text); } catch (_) {}
    return text.replace(/\\u002F/gi, '/').replace(/\\\//g, '/').replace(/\\u0026/gi, '&').replace(/&amp;/g, '&');
  }

  function pickDouyinUrl(node) {
    // node 可能是字符串、{url_list:[...]}、[{...}] 等结构
    if (!node) return '';
    if (typeof node === 'string') return douyinDecode(node);
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = pickDouyinUrl(item);
        if (found) return found;
      }
      return '';
    }
    if (typeof node === 'object') {
      if (Array.isArray(node.url_list) && node.url_list.length) {
        const list = node.url_list.map(douyinDecode).filter((u) => /^https?:\/\//i.test(u));
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
        const decoded = douyinDecode(hit[1]);
        if (/^https?:\/\//i.test(decoded)) {
          // 正则兜底时单独再找一次音频地址
          let audio = '';
          const musicRe = /"music"\s*:\s*\{[\s\S]{0,2000}?"play_url"\s*:\s*\{[\s\S]{0,600}?"url_list"\s*:\s*\[\s*"([^"]+)"/i;
          const musicHit = musicRe.exec(html);
          if (musicHit && musicHit[1]) audio = douyinDecode(musicHit[1]);
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
          if (m && m[1]) { target = douyinDecode(m[1]); break; }
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
          const cleanDom = douyinDecode(domSrc);
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

  function tiktokDecode(raw) {
    if (!raw) return '';
    let text = String(raw);
    try { text = decodeURIComponent(text); } catch (_) {}
    return text.replace(/\\u002F/gi, '/').replace(/\\\//g, '/').replace(/\\u0026/gi, '&').replace(/&amp;/g, '&');
  }

  // 收集 TikTok 所有可下载候选（不取 music.playUrl，它是 MP3，无法合并进 MP4）
  function searchTiktokJson(node, depth, out, seen) {
    if (!node || depth > 16 || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) searchTiktokJson(item, depth + 1, out, seen);
      return;
    }
    // bitrateInfo[] 档位：PlayAddr.UrlList 里含同源 play 接口与 CDN 直链
    if (node.PlayAddr && node.CodecType) {
      const urls = (node.PlayAddr.UrlList || []).map(tiktokDecode).filter((u) => /^https?:\/\//i.test(u));
      const h265 = /h265|hevc|hvc1/i.test(node.CodecType || '');
      for (const url of urls) out.push({ url, codec: node.CodecType, h265 });
    }
    // 主 playAddr（字符串），带 codecType 可判断是否纯视频
    if (typeof node.playAddr === 'string' && /^https?:\/\//i.test(node.playAddr)) {
      out.push({ url: tiktokDecode(node.playAddr), codec: node.codecType || '', h265: /h265|hevc|hvc1/i.test(node.codecType || '') });
    }
    if (typeof node.downloadAddr === 'string' && /^https?:\/\//i.test(node.downloadAddr)) {
      out.push({ url: tiktokDecode(node.downloadAddr), codec: 'download', h265: false });
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
          const decoded = tiktokDecode(hit[1]);
          if (/^https?:\/\//i.test(decoded)) out.push({ url: decoded, codec: hit[2] || '', h265: /h265|hevc|hvc1/i.test(hit[2] || '') });
        }
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

      // 2. 收集所有候选（downloadAddr 是音视频合一的完整 MP4，优先级最高）
      let candidates = extractTiktokFromHtml(html || '');
      candidates = candidates.slice().sort((a, b) => {
        const score = (c) => (c.codec === 'download' ? 100 : 0) + (/\/\/www\.tiktok\.com\//i.test(c.url) ? 30 : 0) - (c.h265 ? 30 : 0);
        return score(b) - score(a);
      });

      // 3. 兜底：页面 DOM / 已加载资源
      if (!candidates.length) {
        try {
          const domVideo = document.querySelector('video[src], video source[src]');
          const domSrc = domVideo ? (domVideo.currentSrc || domVideo.src || domVideo.getAttribute('src') || '') : '';
          const cleanDom = tiktokDecode(domSrc);
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

      // 4. 逐个验证：优先同源(omit 可过)与 h264；CDN 直链需 include。
      //    h265/hvc1 档实测是纯视频轨，跳过；验证时用 Range 只取一小段，避免整段下载。
      const seen = new Set();
      for (const cand of candidates) {
        if (!cand.url || seen.has(cand.url)) continue;
        seen.add(cand.url);
        if (cand.h265) continue;
        const sameOrigin = /^https?:\/\/www\.tiktok\.com\//i.test(cand.url);
        const cred = sameOrigin ? 'omit' : 'include';
        try {
          const probe = await fetch(cand.url, withMeta(workMeta, {
            credentials: cred,
            headers: Object.assign({ Range: 'bytes=0-4095' }, workMeta.headers || {})
          }));
          if (!probe.ok && probe.status !== 206) continue;
          const type = probe.headers.get('content-type') || '';
          if (/json|text\/html/i.test(type)) continue;
          // 该地址可用且不是纯 h265：作为带音轨单文件下载
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
      return null;
    } catch (_) {
      return null;
    }
  }

  window.__viDownloadEngine = {
    detectKind, fetchWhole, downloadHls, downloadDash, verifyBlob,
    mergeStreams, tsToMp4, isFmp4Head, isTsHead, resolvePlatform,
    resolveBilibiliQualities, referrerMeta, probeTracks
  };
})();
