// Renders media/icon.png (128x128) from the icon.svg "Mb" mark geometry.
// Pure node: software rasterizer plus a tiny PNG encoder (zlib is builtin),
// so the release icon rebuilds anywhere with no new dependencies.
// Usage: node media/render-icon.js
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const SIZE = 128;
const UNIT = SIZE / 24; // icon.svg viewBox is 24x24
const STROKE = 2 * UNIT;
const R = STROKE / 2;

const DARK = [0x24, 0x26, 0x2b, 255]; // dark rounded square
const WHITE = [255, 255, 255, 255]; // the Mb mark
const GREEN = [0x1f, 0x9d, 0x55, 255]; // --mb-accent dot

// The M: polyline points in viewBox units (M2.5 20V4l6.75 8L16 4v16).
const M_POINTS = [
  [2.5, 20],
  [2.5, 4],
  [9.25, 12],
  [16, 4],
  [16, 20],
];

// The b bowl: arc a3.2 3.2 0 1 1 from (16,14.6) to (16,20). SVG picks the
// center that makes the sweep travel the long way; the code below picks it
// the same way instead of trusting hand math.
const ARC = { from: [16, 14.6], to: [16, 20], r: 3.2 };

// Small green accent dot, clear of the mark, inside the square.
const DOT = { at: [20.3, 4.9], r: 2.0 };

// Corner radius of the dark square, in viewBox units.
const CORNER = 5;

const px = (units) => units * UNIT;

function distToSegment(px_, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px_ - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px_ - cx, py - cy);
}

// Signed distance to the rounded-square boundary (negative inside), in px.
function roundedSquareSd(x, y) {
  const c = px(CORNER);
  const qx = Math.abs(x - SIZE / 2) - (SIZE / 2 - c);
  const qy = Math.abs(y - SIZE / 2) - (SIZE / 2 - c);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - c;
}

// Coverage of a pixel center against a signed distance: 1 inside, 0 outside.
function coverage(sd) {
  return Math.max(0, Math.min(1, 0.5 - sd));
}

function blend(dst, over) {
  const [sr, sg, sb, sa] = over;
  const a = sa / 255;
  dst[0] = sr * a + dst[0] * (1 - a);
  dst[1] = sg * a + dst[1] * (1 - a);
  dst[2] = sb * a + dst[2] * (1 - a);
  dst[3] = Math.max(dst[3], sa);
}

// Sampled points along the bowl arc (screen px), long way round.
function arcPoints() {
  const [fx, fy] = ARC.from;
  const [tx, ty] = ARC.to;
  const mx = (fx + tx) / 2;
  const my = (fy + ty) / 2;
  const half = Math.hypot(tx - fx, ty - fy) / 2;
  const off = Math.sqrt(ARC.r * ARC.r - half * half);
  const nx = -(ty - fy) / (2 * half);
  const ny = (tx - fx) / (2 * half);
  const twoPi = Math.PI * 2;
  let best = null;
  for (const sign of [1, -1]) {
    const cx = mx + nx * off * sign;
    const cy = my + ny * off * sign;
    const start = Math.atan2(fy - cy, fx - cx);
    let travel = (Math.atan2(ty - cy, tx - cx) - start) % twoPi;
    if (travel < 0) {
      travel += twoPi;
    }
    if (travel > Math.PI && (best === null || travel > best.travel)) {
      best = { cx, cy, start, travel };
    }
  }
  if (!best) {
    throw new Error("arc center not found");
  }
  const points = [];
  const steps = 90;
  for (let i = 0; i <= steps; i += 1) {
    const a = best.start + (best.travel * i) / steps;
    points.push([px(best.cx + ARC.r * Math.cos(a)), px(best.cy + ARC.r * Math.sin(a))]);
  }
  return points;
}

// Paint a thick polyline (round joins and caps) in px.
function strokePath(pixels, units, color) {
  const pts = units.map(([x, y]) => [px(x), px(y)]);
  const segs = [];
  for (let i = 0; i + 1 < pts.length; i += 1) {
    segs.push([pts[i], pts[i + 1]]);
  }
  const dots = pts;
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const cx = x + 0.5;
      const cy = y + 0.5;
      let sd = Infinity;
      for (const [[ax, ay], [bx, by]] of segs) {
        sd = Math.min(sd, distToSegment(cx, cy, ax, ay, bx, by) - R);
      }
      for (const [dx, dy] of dots) {
        sd = Math.min(sd, Math.hypot(cx - dx, cy - dy) - R);
      }
      const cov = coverage(sd);
      if (cov > 0) {
        const i = (y * SIZE + x) * 4;
        const pix = [pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3]];
        blend(pix, [color[0], color[1], color[2], Math.round(color[3] * cov)]);
        pixels[i] = pix[0];
        pixels[i + 1] = pix[1];
        pixels[i + 2] = pix[2];
        pixels[i + 3] = pix[3];
      }
    }
  }
}

function paintDisc(pixels, units, color) {
  const [ux, uy] = units.at;
  const cx = px(ux);
  const cy = px(uy);
  const r = px(units.r);
  const minX = Math.max(0, Math.floor(cx - r - 1));
  const maxX = Math.min(SIZE - 1, Math.ceil(cx + r + 1));
  const minY = Math.max(0, Math.floor(cy - r - 1));
  const maxY = Math.min(SIZE - 1, Math.ceil(cy + r + 1));
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const sd = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) - r;
      const cov = coverage(sd);
      if (cov > 0) {
        const i = (y * SIZE + x) * 4;
        const pix = [pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3]];
        blend(pix, [color[0], color[1], color[2], Math.round(color[3] * cov)]);
        pixels[i] = pix[0];
        pixels[i + 1] = pix[1];
        pixels[i + 2] = pix[2];
        pixels[i + 3] = pix[3];
      }
    }
  }
}

const CRC_TABLE = (() => {
  const table = new Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const b of bytes) {
    crc = CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])), 8 + data.length);
  return out;
}

function main() {
  const pixels = new Array(SIZE * SIZE * 4).fill(0);
  // Dark rounded square.
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const cov = coverage(roundedSquareSd(x + 0.5, y + 0.5));
      if (cov > 0) {
        const i = (y * SIZE + x) * 4;
        pixels[i] = DARK[0];
        pixels[i + 1] = DARK[1];
        pixels[i + 2] = DARK[2];
        pixels[i + 3] = Math.round(255 * cov);
      }
    }
  }
  strokePath(pixels, M_POINTS, WHITE);
  strokePath(pixels, arcPoints(), WHITE);
  paintDisc(pixels, DOT, GREEN);

  const raw = Buffer.alloc(SIZE * (1 + SIZE * 4));
  for (let y = 0; y < SIZE; y += 1) {
    raw[y * (1 + SIZE * 4)] = 0; // filter: none
    for (let x = 0; x < SIZE; x += 1) {
      for (let c = 0; c < 4; c += 1) {
        raw[y * (1 + SIZE * 4) + 1 + x * 4 + c] = Math.round(pixels[(y * SIZE + x) * 4 + c]);
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  const target = path.join(__dirname, "icon.png");
  fs.writeFileSync(target, png);
  console.log(`wrote ${target} (${SIZE}x${SIZE}, ${png.length} bytes)`);
}

main();
