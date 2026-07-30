// ============================================================
// 导出模块：SVG / PNG(300DPI) / ZIP 打包（纯前端零依赖）
// ============================================================

export function downloadBlob(blob, filename) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

export function svgBlob(svgText) {
  return new Blob([svgText], { type: "image/svg+xml" });
}

// SVG → PNG，300 DPI（屏幕 96dpi → 缩放 3.125x）
export function svgToPng(svgText) {
  return new Promise((resolve, reject) => {
    const scale = 300 / 96;
    const m = /viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/.exec(svgText);
    if (!m) return reject(new Error("SVG 缺少 viewBox"));
    const w = +m[1], h = +m[2];
    const img = new Image();
    const url = URL.createObjectURL(new Blob([svgText], { type: "image/svg+xml" }));
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(w * scale);
      canvas.height = Math.round(h * scale);
      const g = canvas.getContext("2d");
      g.scale(scale, scale);
      g.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("PNG 编码失败"))), "image/png");
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("SVG 加载失败")); };
    img.src = url;
  });
}

// ---------------- 极简 ZIP（store 无压缩）----------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const le16 = (n) => [n & 0xff, (n >> 8) & 0xff];
const le32 = (n) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];

export function makeZip(files) {
  // files: [{name, data:Uint8Array}]
  const enc = new TextEncoder();
  const parts = [], central = [];
  let offset = 0;
  files.forEach((f) => {
    const nameBytes = enc.encode(f.name);
    const crc = crc32(f.data);
    const local = new Uint8Array([
      0x50, 0x4b, 0x03, 0x04, ...le16(20), ...le16(0x0800), ...le16(0), ...le16(0), ...le16(0),
      ...le32(crc), ...le32(f.data.length), ...le32(f.data.length),
      ...le16(nameBytes.length), ...le16(0),
    ]);
    parts.push(local, nameBytes, f.data);
    central.push(new Uint8Array([
      0x50, 0x4b, 0x01, 0x02, ...le16(20), ...le16(20), ...le16(0x0800), ...le16(0), ...le16(0), ...le16(0),
      ...le32(crc), ...le32(f.data.length), ...le32(f.data.length),
      ...le16(nameBytes.length), ...le16(0), ...le16(0), ...le16(0), ...le16(0),
      ...le32(0), ...le32(offset),
    ]), nameBytes);
    offset += local.length + nameBytes.length + f.data.length;
  });
  const centralStart = offset;
  let centralSize = 0;
  central.forEach((c) => (centralSize += c.length));
  const end = new Uint8Array([
    0x50, 0x4b, 0x05, 0x06, ...le16(0), ...le16(0), ...le16(files.length), ...le16(files.length),
    ...le32(centralSize), ...le32(centralStart), ...le16(0),
  ]);
  return new Blob([...parts, ...central, end], { type: "application/zip" });
}

export async function blobToU8(blob) {
  return new Uint8Array(await blob.arrayBuffer());
}
