// Рисует иконки приложения без сторонних библиотек: node tools/make-icons.js
// Фон — фиолетовый градиент, карточка-заметка с тремя строками и «искра» AI.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CRC = (() => {
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
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const hex = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const C1 = hex('#4f46e5'), C2 = hex('#8b5cf6'), WHITE = [255, 255, 255], LINE = hex('#5b4cf0'), STAR = hex('#fcd34d');
const mix = (a, b, t) => a.map((x, i) => x + (b[i] - x) * t);

function roundRect(x, y, cx, cy, hw, hh, r) {
  const qx = Math.abs(x - cx) - (hw - r), qy = Math.abs(y - cy) - (hh - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
function capsule(x, y, x1, x2, cy, r) {
  const px = Math.max(x1, Math.min(x2, x));
  return Math.hypot(x - px, y - cy) - r;
}
function star(x, y, cx, cy, r) {
  return Math.sqrt(Math.abs(x - cx)) + Math.sqrt(Math.abs(y - cy)) - Math.sqrt(r);
}

// Цвет точки в координатах 0..1 (s — масштаб содержимого для maskable-иконки)
function shade(u, v, s) {
  const x = (u - 0.5) / s + 0.5, y = (v - 0.5) / s + 0.5;
  let c = mix(C1, C2, Math.min(1, Math.max(0, (u + v) / 2)));
  if (roundRect(x, y, 0.46, 0.56, 0.235, 0.285, 0.065) < 0) {
    c = WHITE;
    const lines = [[0.31, 0.61, 0.43], [0.31, 0.61, 0.55], [0.31, 0.5, 0.67]];
    if (lines.some(([a, b, cy]) => capsule(x, y, a, b, cy, 0.022) < 0)) c = LINE;
  }
  if (star(x, y, 0.735, 0.27, 0.115) < 0) c = STAR;
  return c;
}

function draw(size, s) {
  const N = 4; // сглаживание: 4×4 выборки на пиксель
  const buf = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let acc = [0, 0, 0];
      for (let sy = 0; sy < N; sy++) {
        for (let sx = 0; sx < N; sx++) {
          const c = shade((px + (sx + 0.5) / N) / size, (py + (sy + 0.5) / N) / size, s);
          acc = acc.map((a, i) => a + c[i]);
        }
      }
      const o = (py * size + px) * 4;
      buf[o] = Math.round(acc[0] / (N * N));
      buf[o + 1] = Math.round(acc[1] / (N * N));
      buf[o + 2] = Math.round(acc[2] / (N * N));
      buf[o + 3] = 255;
    }
  }
  return png(size, size, buf);
}

const out = path.join(__dirname, '..', 'app', 'icons');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'icon-192.png'), draw(192, 1));
fs.writeFileSync(path.join(out, 'icon-512.png'), draw(512, 1));
fs.writeFileSync(path.join(out, 'apple-touch-icon.png'), draw(180, 1));
fs.writeFileSync(path.join(out, 'maskable-512.png'), draw(512, 0.8));
console.log('Иконки записаны в', out);
