// Pixels of the dropdown captures (System.Drawing PNG: 8-bit RGB/RGBA, not interlaced), so the AI
// rescue can compare the part of the dropdown that matters instead of whole files: the shadow at the
// panel's edges shows the window behind it, which changes between two searches (dev machine 2026-11-21).
const zlib = require("node:zlib");

function decodePng(buffer) {
  const bytes = Buffer.from(buffer);
  if (!bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) throw Error("png_invalid");
  let offset = 8, width = 0, height = 0, channels = 0;
  const data = [];
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset), type = bytes.toString("latin1", offset + 4, offset + 8);
    const chunk = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = chunk.readUInt32BE(0); height = chunk.readUInt32BE(4);
      const depth = chunk[8], color = chunk[9], interlace = chunk[12];
      channels = color === 6 ? 4 : color === 2 ? 3 : 0;
      if (depth !== 8 || !channels || interlace !== 0 || width > 8000 || height > 8000) throw Error("png_unsupported");
    } else if (type === "IDAT") data.push(chunk);
    else if (type === "IEND") break;
    offset += 12 + length;
  }
  const raw = zlib.inflateSync(Buffer.concat(data));
  const stride = width * channels, pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? pixels[y * stride + x - channels] : 0;
      const up = y ? pixels[(y - 1) * stride + x] : 0;
      const upLeft = y && x >= channels ? pixels[(y - 1) * stride + x - channels] : 0;
      let value = line[x];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft, pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - upLeft);
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      } else if (filter !== 0) throw Error("png_filter_invalid");
      pixels[y * stride + x] = value & 0xff;
    }
  }
  return { width, height, channels, pixels };
}

// True when the two pictures are the same size and every pixel in the box (fractions of the picture)
// is the same colour.
function sameRegion(a, b, box) {
  if (a.width !== b.width || a.height !== b.height) return false;
  const x0 = Math.max(0, Math.floor(box.left * a.width)), x1 = Math.min(a.width, Math.ceil(box.right * a.width));
  const y0 = Math.max(0, Math.floor(box.top * a.height)), y1 = Math.min(a.height, Math.ceil(box.bottom * a.height));
  if (x1 <= x0 || y1 <= y0) return false;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const i = (y * a.width + x) * a.channels, j = (y * b.width + x) * b.channels;
      if (a.pixels[i] !== b.pixels[j] || a.pixels[i + 1] !== b.pixels[j + 1] || a.pixels[i + 2] !== b.pixels[j + 2]) return false;
    }
  }
  return true;
}

module.exports = { decodePng, sameRegion };
