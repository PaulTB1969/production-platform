// Builds the brand images from the Mountain Falls logo
// (assets/mf-logo-source.png, from mountainfalls.co.za):
//   public/brand/mf-logo.png        the full logo, trimmed, black on transparent
//   public/icons/icon-{180,192,512}.png
//                                   the mountain-and-arc mark, white on black,
//                                   for phone/iPad home screens
// The outputs are committed; re-run only to change them:
//   node scripts/make-icons.js

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { PNG } from 'pngjs';

const src = PNG.sync.read(readFileSync('assets/mf-logo-source.png'));
const alphaAt = (img, x, y) => img.data[(y * img.width + x) * 4 + 3];

// Bounding box of visible pixels within [x0, x1).
function bbox(img, x0 = 0, x1 = img.width) {
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = x0; x < x1; x++) {
      if (alphaAt(img, x, y) > 8) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

function crop(img, { x, y, w, h }) {
  const out = new PNG({ width: w, height: h });
  for (let j = 0; j < h; j++) img.data.copy(out.data, j * w * 4, ((y + j) * img.width + x) * 4, ((y + j) * img.width + x + w) * 4);
  return out;
}

// Area-average resample of the alpha channel into a w x h coverage map.
function coverage(img, w, h) {
  const out = new Float32Array(w * h);
  const sx = img.width / w, sy = img.height / h;
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      let sum = 0, n = 0;
      for (let y = Math.floor(j * sy); y < Math.min(img.height, Math.ceil((j + 1) * sy)); y++) {
        for (let x = Math.floor(i * sx); x < Math.min(img.width, Math.ceil((i + 1) * sx)); x++) {
          sum += alphaAt(img, x, y); n++;
        }
      }
      out[j * w + i] = n ? sum / n / 255 : 0;
    }
  }
  return out;
}

// 1. Full logo, trimmed with a small margin.
const full = bbox(src);
const pad = 12;
const logo = crop(src, { x: full.x - pad, y: full.y - pad, w: full.w + pad * 2, h: full.h + pad * 2 });
mkdirSync('public/brand', { recursive: true });
writeFileSync('public/brand/mf-logo.png', PNG.sync.write(logo));

// 2. The mark: the first run of columns with ink, up to the gap before the text.
let gapStart = -1;
for (let x = full.x, inInk = false; x < full.x + full.w; x++) {
  let ink = false;
  for (let y = full.y; y < full.y + full.h && !ink; y++) ink = alphaAt(src, x, y) > 8;
  if (ink) inInk = true;
  else if (inInk) { gapStart = x; break; }
}
const mark = crop(src, bbox(src, full.x, gapStart));

// 3. Icons: white mark centred on black, inside the middle ~62% so the
//    round/maskable crops on Android don't clip it.
mkdirSync('public/icons', { recursive: true });
for (const size of [180, 192, 512]) {
  const box = Math.round(size * 0.62);
  const scale = Math.min(box / mark.width, box / mark.height);
  const mw = Math.round(mark.width * scale), mh = Math.round(mark.height * scale);
  const cov = coverage(mark, mw, mh);
  const ox = Math.round((size - mw) / 2), oy = Math.round((size - mh) / 2);
  const icon = new PNG({ width: size, height: size });
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const inside = x >= ox && x < ox + mw && y >= oy && y < oy + mh;
      const v = Math.round(255 * (inside ? cov[(y - oy) * mw + (x - ox)] : 0));
      const k = (y * size + x) * 4;
      icon.data[k] = icon.data[k + 1] = icon.data[k + 2] = v; icon.data[k + 3] = 255;
    }
  }
  writeFileSync(`public/icons/icon-${size}.png`, PNG.sync.write(icon));
}
console.log(`logo ${logo.width}x${logo.height}, mark ${mark.width}x${mark.height} -> icons 180/192/512`);
