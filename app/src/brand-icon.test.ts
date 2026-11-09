import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const smoke = require("../shared/smoke.cjs");
const BRAND = join(import.meta.dirname, "..", "..", "brand", "png");

/** Reads the alpha channel of an 8-bit RGBA PNG (no interlace). */
function alphaOf(file: string): { w: number; h: number; a: (x: number, y: number) => number } {
  const buf = readFileSync(file);
  let p = 8;
  let w = 0;
  let h = 0;
  const idat: Buffer[] = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString("ascii", p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === "IHDR") {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      assert.equal(data[8], 8, "8-bit");
      assert.equal(data[9], 6, "RGBA");
      assert.equal(data[12], 0, "not interlaced");
    }
    if (type === "IDAT") idat.push(data);
    p += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * 4;
  const px = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    for (let i = 0; i < stride; i++) {
      const v = raw[y * (stride + 1) + 1 + i];
      const left = i >= 4 ? px[y * stride + i - 4] : 0;
      const up = y > 0 ? px[(y - 1) * stride + i] : 0;
      const ul = y > 0 && i >= 4 ? px[(y - 1) * stride + i - 4] : 0;
      let pred = 0;
      if (f === 1) pred = left;
      else if (f === 2) pred = up;
      else if (f === 3) pred = (left + up) >> 1;
      else if (f === 4) {
        const q = left + up - ul;
        const pa = Math.abs(q - left);
        const pb = Math.abs(q - up);
        const pc = Math.abs(q - ul);
        pred = pa <= pb && pa <= pc ? left : pb <= pc ? up : ul;
      }
      px[y * stride + i] = (v + pred) & 255;
    }
  }
  return { w, h, a: (x, y) => px[y * stride + x * 4 + 3] };
}

test("Dock icon: the Mac icon keeps the Apple grid margin, so it is the same size as other apps", () => {
  const mac = alphaOf(join(BRAND, "mac", "icon-512.png"));
  assert.equal(mac.w, 512);
  // About 50 px of empty margin on each side of a 512 px icon (100 of 1024 in the Apple grid).
  for (const [x, y] of [
    [30, 256],
    [256, 30],
    [481, 256],
    [256, 481],
  ])
    assert.equal(mac.a(x, y), 0, `margin pixel ${x},${y} must be clear`);
  assert.equal(mac.a(256, 256), 255);
  // The full-bleed tile (window and Windows icon) reaches the edge: using it in the Dock makes Wingman look larger.
  const full = alphaOf(join(BRAND, "icon-512.png"));
  assert.equal(full.a(30, 256), 255);
});

test("packaged Mac app ships the Dock icon; Windows does not need it", () => {
  assert.ok(smoke.expectedFiles("darwin").inResources.includes("brand/png/mac/icon-512.png"));
  assert.ok(!smoke.expectedFiles("win32").inResources.includes("brand/png/mac/icon-512.png"));
});
