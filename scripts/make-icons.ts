/**
 * 產生 PWA 圖示（PNG）。用 Node 內建 zlib 自行編碼 PNG，不需要額外套件。
 *   npx tsx scripts/make-icons.ts
 */
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b: Uint8Array) => {
  let c = 0xffffffff;
  for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size: number, px: (x: number, y: number) => [number, number, number, number]): Buffer {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) raw.set(px(x, y), y * (size * 4 + 1) + 1 + x * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

// 與 public/icon.svg 相同的設計（512 座標系）：藍底、4 條白色聲波柱、黃色底線
const bars = [
  [170, 196, 316],
  [226, 156, 356],
  [282, 196, 316],
  [338, 236, 276],
];
function icon(size: number, maskable: boolean) {
  const s = size / 512;
  return png(size, (px, py) => {
    const x = px / s;
    const y = py / s;
    const r = maskable ? 0 : 112;
    const cx = Math.min(Math.max(x, r), 512 - r);
    const cy = Math.min(Math.max(y, r), 512 - r);
    if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) return [0, 0, 0, 0];
    for (const [bx, y1, y2] of bars) {
      const yy = Math.min(Math.max(y, y1), y2);
      if ((x - bx) ** 2 + (y - yy) ** 2 <= 14 * 14) return [255, 255, 255, 255];
    }
    if (y >= 380 && y <= 416 && x >= 120 && x <= 392) {
      const ex = Math.min(Math.max(x, 138), 374);
      if ((x - ex) ** 2 + (y - 398) ** 2 <= 18 * 18) return [255, 212, 0, 255];
    }
    return [11, 61, 145, 255];
  });
}
writeFileSync('public/icon-192.png', icon(192, false));
writeFileSync('public/icon-512.png', icon(512, true));
writeFileSync('public/apple-touch-icon.png', icon(180, true));
console.log('已產生 public/icon-192.png、icon-512.png、apple-touch-icon.png');
