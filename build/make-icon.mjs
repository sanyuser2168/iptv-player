/**
 * Generates build/icon.png (512x512) and build/icon.ico (256x256)
 * without any external dependencies: gradient rounded square + play mark.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const OUT_DIR = path.dirname(fileURLToPath(import.meta.url));

/* ---------- draw ---------- */

const COL_A = [139, 92, 255];
const COL_B = [34, 211, 238];

function insideRoundRect(x, y, size, radius) {
  const cx = Math.abs(x - size / 2) - (size / 2 - radius);
  const cy = Math.abs(y - size / 2) - (size / 2 - radius);
  const outside = Math.hypot(Math.max(cx, 0), Math.max(cy, 0));
  const inside = Math.min(Math.max(cx, cy), 0);
  return outside + inside - radius;
}

function insideTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

function render(size) {
  const SS = 4;
  const radius = size * 0.225;
  const tri = [
    [size * 0.385, size * 0.285],
    [size * 0.385, size * 0.715],
    [size * 0.735, size * 0.5],
  ];
  const rgba = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          const d = insideRoundRect(px, py, size, radius);
          if (d > 0.6) continue;

          const coverage = d <= 0 ? 1 : 1 - (d / 0.6);
          const t = Math.min(1, Math.max(0, (px + py) / (2 * size)));
          let cr = COL_A[0] + (COL_B[0] - COL_A[0]) * t;
          let cg = COL_A[1] + (COL_B[1] - COL_A[1]) * t;
          let cb = COL_A[2] + (COL_B[2] - COL_A[2]) * t;

          // soft top highlight
          const glow = Math.max(0, 1 - py / size) * 0.22;
          cr += (255 - cr) * glow;
          cg += (255 - cg) * glow;
          cb += (255 - cb) * glow;

          const inTri = insideTriangle(px, py, ...tri[0], ...tri[1], ...tri[2]);
          if (inTri) {
            cr = 255;
            cg = 255;
            cb = 255;
          }

          // subtle shadow under the play mark
          if (!inTri) {
            const dx = px - size * 0.58;
            const dy = py - size * 0.53;
            const dist = Math.hypot(dx, dy);
            if (dist < size * 0.22) {
              const s = (1 - dist / (size * 0.22)) * 0.12;
              cr *= 1 - s;
              cg *= 1 - s;
              cb *= 1 - s;
            }
          }

          r += cr * coverage;
          g += cg * coverage;
          b += cb * coverage;
          a += coverage;
        }
      }

      const total = SS * SS;
      const alpha = a / total;
      const i = (y * size + x) * 4;
      if (alpha > 0) {
        rgba[i] = Math.round(r / a);
        rgba[i + 1] = Math.round(g / a);
        rgba[i + 2] = Math.round(b / a);
        rgba[i + 3] = Math.round(alpha * 255);
      }
    }
  }
  return rgba;
}

/* ---------- PNG ---------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const name = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])), 0);
  return Buffer.concat([len, name, data, crc]);
}

function encodePng(size, rgba) {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------- ICO ---------- */

function encodeIco(png, size) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);

  const entry = Buffer.alloc(16);
  entry[0] = size >= 256 ? 0 : size;
  entry[1] = size >= 256 ? 0 : size;
  entry[2] = 0;
  entry[3] = 0;
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(22, 12);

  return Buffer.concat([header, entry, png]);
}

/* ---------- run ---------- */

const big = 512;
const small = 256;

const png512 = encodePng(big, render(big));
fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), png512);

const png256 = encodePng(small, render(small));
fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), encodeIco(png256, small));

console.log(`icon.png ${png512.length} bytes, icon.ico ${encodeIco(png256, small).length} bytes`);