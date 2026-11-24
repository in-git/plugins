(() => {
  'use strict';

  const INTERNAL = '__viInternalDownload';

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

  async function fetchText(url, signal) {
    const r = await fetch(url, { credentials: 'include', signal, [INTERNAL]: true });
    if (!r.ok) throw new Error('HTTP ' + r.status + ' for playlist');
    return r.text();
  }

  async function fetchBuffer(url, signal, range) {
    const headers = range ? { Range: 'bytes=' + range } : {};
    const r = await fetch(url, { credentials: 'include', signal, headers, [INTERNAL]: true });
    if (!r.ok && r.status !== 206) throw new Error('HTTP ' + r.status + ' for segment');
    if (range && r.status === 206) {
      const cr = parseRange(r.headers.get('content-range'));
      if (!cr || cr.start !== Number(String(range).split('-')[0])) throw new Error('unexpected byte range');
    }
    return r.arrayBuffer();
  }

  async function fetchWhole(url, signal, onProgress, extraHeaders) {
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
      const response = await fetch(url, { credentials: 'omit', signal, headers, [INTERNAL]: true });
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

  async function downloadHls(playlistUrl, signal, onProgress, expectedDuration) {
    let text = await fetchText(playlistUrl, signal);
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
      text = await fetchText(playlistUrl, signal);
    }

    const videoTrack = await downloadHlsTrack(text, base, signal, onProgress);

    if (audioPlaylistUrl) {
      try {
        const audioText = await fetchText(audioPlaylistUrl, signal);
        const audioTrack = await downloadHlsTrack(audioText, audioPlaylistUrl, signal, () => {});
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

  async function downloadHlsTrack(text, base, signal, onProgress) {
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
      keyBytes = new Uint8Array(await fetchBuffer(key.uri, signal));
      if (keyBytes.length !== 16) throw new Error('invalid AES key');
    }

    const pieces = [];
    if (map) {
      let init = await fetchBuffer(map.url, signal, map.range || null);
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
        let buf = await fetchBuffer(seg.url, signal, seg.range || null);
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

  async function downloadDashTrack(track, mpdUrl, signal, onProgress) {
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
      if (initTpl) chunks.push(await fetchBuffer(absUrl(applyTemplate(initTpl, { id, bandwidth, number: '', time: '' }), base), signal));

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
            chunks.push(await fetchBuffer(url, signal));
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
          chunks.push(await fetchBuffer(url, signal));
          onProgress(i + 1, count);
        }
      }
    } else {
      const list = rep.getElementsByTagName('SegmentList')[0];
      if (list) {
        const init = list.getElementsByTagName('Initialization')[0];
        if (init) chunks.push(await fetchBuffer(absUrl(init.getAttribute('sourceURL') || '', base), signal));
        const urls = list.getElementsByTagName('SegmentURL');
        for (let i = 0; i < urls.length; i++) {
          chunks.push(await fetchBuffer(absUrl(urls[i].getAttribute('media') || '', base), signal));
          onProgress(i + 1, urls.length);
        }
      } else {
        const single = (rep.getElementsByTagName('BaseURL')[0] || {}).textContent || track.base;
        if (!single) throw new Error('no DASH segments');
        chunks.push(await fetchBuffer(absUrl(single, mpdUrl), signal));
      }
    }

    if (!chunks.length) throw new Error('no DASH segments');
    return new Blob(chunks, { type: 'video/mp4' });
  }

  async function downloadDash(mpdUrl, signal, onProgress, expectedDuration) {
    const text = await fetchText(mpdUrl, signal);
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
      const videoBlob = await downloadDashTrack(chosenVideo, mpdUrl, signal, onProgress);
      const audioBlob = await downloadDashTrack(chosenAudio, mpdUrl, signal, (done, total) => onProgress(done, total));
      return { tracks: [videoBlob, audioBlob], ext: 'mp4', duration, skipDurationCheck: true };
    }

    return {
      tracks: [await downloadDashTrack(primary, mpdUrl, signal, onProgress)],
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

  async function verifyBlob(blob, expectedDuration, expectedSize) {
    if (!blob || blob.size < 512) return { ok: false, error: 'empty blob' };
    if (expectedSize && Math.abs(blob.size - expectedSize) > Math.max(2048, expectedSize * 0.02)) {
      return { ok: false, error: 'size mismatch' };
    }
    const head = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
    if (!magicOk(head)) return { ok: false, error: 'invalid container' };

    if (expectedDuration && Number.isFinite(expectedDuration) && expectedDuration > 0) {
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

  // DASH 双轨合流（MP4Box.js）：把视频轨(0)与音频轨(1)重封装成单一 MP4
  async function mergeStreams(buffers, onProgress) {
    if (!buffers || buffers.length < 2) return new Blob([buffers[0]], { type: 'video/mp4' });
    if (typeof window.MP4Box === 'undefined') throw new Error('mp4box unavailable');

    const videoBuf = toArrayBuffer(buffers[0]);
    const audioBuf = toArrayBuffer(buffers[1]);
    videoBuf.fileStart = 0;

    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (e) => { if (!settled) { settled = true; reject(e); } };

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
                  settled = true;
                  resolve(new Blob([joined.buffer], { type: 'video/mp4' }));
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

  // 平台解析器：返回 { videoUrl, audioUrl, kind, headers } 或 null
  async function resolvePlatform(url, pageUrl) {
    const host = (() => { try { return new URL(pageUrl || location.href).hostname; } catch (_) { return ''; } })();

    if (/bilibili\.com$/.test(host) || /\.bilibili\.com$/.test(host)) {
      return resolveBilibili(url, pageUrl);
    }
    if (/douyin\.com$/.test(host) || /\.douyin\.com$/.test(host)) {
      return resolveDouyin(url, pageUrl);
    }
    return null;
  }

  async function resolveBilibili(url, pageUrl) {
    try {
      // 从页面 URL 提取 BV 号
      const bv = /(BV[0-9A-Za-z]+)/.exec(pageUrl || location.href);
      if (!bv) return null;
      const viewUrl = 'https://api.bilibili.com/x/web-interface/view?bvid=' + bv[1];
      const viewRes = await fetch(viewUrl, { credentials: 'include' });
      const viewJson = await viewRes.json();
      const cid = viewJson && viewJson.data && viewJson.data.cid;
      if (!cid) return null;

      // 首选 fnval=0 单流 MP4
      const playUrl0 = 'https://api.bilibili.com/x/player/playurl?bvid=' + bv[1] + '&cid=' + cid + '&fnval=0&fnver=0&fourk=1';
      const headers = { Referer: 'https://www.bilibili.com/' };
      const res0 = await fetch(playUrl0, { credentials: 'include', headers });
      const json0 = await res0.json();
      const durl = json0 && json0.data && json0.data.durl;
      if (Array.isArray(durl) && durl.length) {
        const u = durl[durl.length - 1].url || durl[0].url;
        if (u) return { videoUrl: u, audioUrl: '', kind: 'direct', headers };
      }

      // 退回 DASH
      const playUrl16 = 'https://api.bilibili.com/x/player/playurl?bvid=' + bv[1] + '&cid=' + cid + '&fnval=16&fnver=0&fourk=1';
      const res16 = await fetch(playUrl16, { credentials: 'include', headers });
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

  async function resolveDouyin(url, pageUrl) {
    try {
      const vid = /(\d{15,})/.exec(pageUrl || location.href);
      if (!vid) return null;
      // 用移动 UA 请求
      const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
      const res = await fetch(pageUrl || location.href, { headers: { 'User-Agent': ua } });
      const html = await res.text();
      let target = '';
      const patterns = [/playAddr":"(.*?)"/, /videoUrl":"(.*?)"/, /bytevod\S*?":"(.*?)"/];
      for (const re of patterns) {
        const m = re.exec(html);
        if (m) { target = m[1]; break; }
      }
      if (!target) return null;
      target = target.replace(/\\u002F/g, '/').replace(/\\\//g, '/').replace(/&amp;/g, '&');
      const headers = { Referer: 'https://www.douyin.com/' };
      return { videoUrl: target, audioUrl: '', kind: 'direct', headers };
    } catch (_) {
      return null;
    }
  }

  window.__viDownloadEngine = {
    detectKind, fetchWhole, downloadHls, downloadDash, verifyBlob,
    mergeStreams, tsToMp4, isFmp4Head, isTsHead, resolvePlatform
  };
})();
