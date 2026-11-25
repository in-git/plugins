const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

// 边写入边累积 Blob 片段，不长期持有每张图片的原始字节副本。
// addFile(name, Uint8Array) 保持同步；addFile(name, Blob) 返回 Promise，供后台流式写入。
globalThis.ZipWriter = class ZipWriter {
  constructor() {
    this.encoder = new TextEncoder();
    this.localParts = [];
    this.centralParts = [];
    this.offset = 0;
    this.count = 0;
  }

  addFile(name, data) {
    if (data instanceof Blob) return this._addBlob(name, data);
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    this._push(name, bytes, crc32(bytes), bytes.length);
  }

  async _addBlob(name, blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    this._push(name, blob, crc32(bytes), blob.size);
  }

  _push(name, data, crc, size) {
    const nameBytes = this.encoder.encode(name);
    const { time, day } = dosDateTime(new Date());

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, 0, true);
    lv.setUint16(10, time, true);
    lv.setUint16(12, day, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    this.localParts.push(new Blob([local, data]));

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, day, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, this.offset, true);
    central.set(nameBytes, 46);
    this.centralParts.push(central);

    this.offset += local.length + size;
    this.count++;
  }

  build() {
    const centralSize = this.centralParts.reduce((sum, part) => sum + part.length, 0);
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, this.count, true);
    ev.setUint16(10, this.count, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, this.offset, true);
    ev.setUint16(20, 0, true);

    return new Blob([...this.localParts, ...this.centralParts, eocd], { type: 'application/zip' });
  }
};
