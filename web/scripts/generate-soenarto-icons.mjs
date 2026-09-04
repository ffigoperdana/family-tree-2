import { deflateSync } from "node:zlib";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const outputRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");
const scale = 4;

const hex = (value) => [
  Number.parseInt(value.slice(1, 3), 16),
  Number.parseInt(value.slice(3, 5), 16),
  Number.parseInt(value.slice(5, 7), 16),
  255
];

const blend = (left, right, amount) => left.map((channel, index) =>
  Math.round(channel + (right[index] - channel) * amount)
);

const roundedRectContains = (x, y, left, top, right, bottom, radius) => {
  const nearestX = Math.max(left + radius, Math.min(x, right - radius));
  const nearestY = Math.max(top + radius, Math.min(y, bottom - radius));
  return Math.hypot(x - nearestX, y - nearestY) <= radius;
};

const distanceToSegment = (x, y, x1, y1, x2, y2) => {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSquared = dx * dx + dy * dy;
  const factor = lengthSquared ? Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / lengthSquared)) : 0;
  return Math.hypot(x - (x1 + factor * dx), y - (y1 + factor * dy));
};

const draw = (size) => {
  const highSize = size * scale;
  const coordinateScale = (size / 192) * scale;
  const pixels = new Uint8Array(highSize * highSize * 4);
  const backgroundStart = hex("#123d5a");
  const backgroundEnd = hex("#071d32");
  const tree = hex("#bceefa");
  const treeEnd = hex("#9cdef2");
  const center = (index) => (index + 0.5) / coordinateScale;
  const set = (x, y, color) => {
    if (x < 0 || y < 0 || x >= highSize || y >= highSize) return;
    const offset = (y * highSize + x) * 4;
    pixels.set(color, offset);
  };
  const line = (x1, y1, x2, y2, width, color) => {
    const minX = Math.max(0, Math.floor((Math.min(x1, x2) - width) * coordinateScale));
    const maxX = Math.min(highSize - 1, Math.ceil((Math.max(x1, x2) + width) * coordinateScale));
    const minY = Math.max(0, Math.floor((Math.min(y1, y2) - width) * coordinateScale));
    const maxY = Math.min(highSize - 1, Math.ceil((Math.max(y1, y2) + width) * coordinateScale));
    for (let py = minY; py <= maxY; py += 1) for (let px = minX; px <= maxX; px += 1) {
      if (distanceToSegment(center(px), center(py), x1, y1, x2, y2) <= width / 2) set(px, py, color);
    }
  };
  const circle = (cx, cy, radius, fill, stroke, strokeWidth) => {
    const minX = Math.max(0, Math.floor((cx - radius - strokeWidth) * coordinateScale));
    const maxX = Math.min(highSize - 1, Math.ceil((cx + radius + strokeWidth) * coordinateScale));
    const minY = Math.max(0, Math.floor((cy - radius - strokeWidth) * coordinateScale));
    const maxY = Math.min(highSize - 1, Math.ceil((cy + radius + strokeWidth) * coordinateScale));
    for (let py = minY; py <= maxY; py += 1) for (let px = minX; px <= maxX; px += 1) {
      const distance = Math.hypot(center(px) - cx, center(py) - cy);
      if (distance <= radius) set(px, py, fill);
      else if (distance <= radius + strokeWidth / 2) set(px, py, stroke);
    }
  };

  for (let py = 0; py < highSize; py += 1) for (let px = 0; px < highSize; px += 1) {
    const x = center(px);
    const y = center(py);
    if (!roundedRectContains(x, y, 5, 5, 187, 187, 43)) continue;
    const amount = Math.max(0, Math.min(1, (x + y - 32) / 320));
    set(px, py, blend(backgroundStart, backgroundEnd, amount));
  }
  line(48, 6, 144, 6, 1, hex("#355a66"));
  line(48, 186, 144, 186, 1, hex("#355a66"));
  line(6, 48, 6, 144, 1, hex("#355a66"));
  line(186, 48, 186, 144, 1, hex("#355a66"));
  line(96, 153, 96, 104, 9, treeEnd);
  line(96, 104, 54, 104, 9, treeEnd);
  line(54, 104, 54, 72, 9, treeEnd);
  line(96, 104, 138, 104, 9, treeEnd);
  line(138, 104, 138, 72, 9, treeEnd);
  line(96, 104, 96, 47, 9, treeEnd);
  circle(96, 34, 15, hex("#0b2942"), tree, 7);
  circle(54, 59, 15, hex("#0b2942"), tree, 7);
  circle(138, 59, 15, hex("#0b2942"), tree, 7);
  circle(96, 104, 13, hex("#0b2942"), tree, 7);
  line(64, 154, 128, 154, 7, treeEnd);

  const result = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
    const outputOffset = (y * size + x) * 4;
    const inputStartX = x * scale;
    const inputStartY = y * scale;
    for (let channel = 0; channel < 4; channel += 1) {
      let total = 0;
      for (let dy = 0; dy < scale; dy += 1) for (let dx = 0; dx < scale; dx += 1) {
        total += pixels[((inputStartY + dy) * highSize + inputStartX + dx) * 4 + channel];
      }
      result[outputOffset + channel] = Math.round(total / (scale * scale));
    }
  }
  return result;
};

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

const crc32 = (bytes) => {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
};

const chunk = (type, data) => {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, checksum]);
};

const png = (size) => {
  const rows = Buffer.alloc(size * (size * 4 + 1));
  const pixels = draw(size);
  for (let y = 0; y < size; y += 1) {
    const offset = y * (size * 4 + 1);
    rows[offset] = 0;
    Buffer.from(pixels.buffer, pixels.byteOffset + y * size * 4, size * 4).copy(rows, offset + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
};

const glyphs = {
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  C: ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"]
};

const drawPreviewText = (pixels, width, text, x, y, pixelSize, color) => {
  let cursor = x;
  for (const character of text) {
    const glyph = glyphs[character] ?? glyphs[" "];
    for (let row = 0; row < 7; row += 1) for (let column = 0; column < 5; column += 1) {
      if (glyph[row][column] !== "1") continue;
      for (let dy = 0; dy < pixelSize; dy += 1) for (let dx = 0; dx < pixelSize; dx += 1) {
        const px = cursor + column * pixelSize + dx;
        const py = y + row * pixelSize + dy;
        if (px < 0 || py < 0 || px >= width || py >= pixels.length / (width * 4)) continue;
        pixels.set(color, (py * width + px) * 4);
      }
    }
    cursor += 6 * pixelSize;
  }
};

const drawPreview = () => {
  const width = 1200;
  const height = 630;
  const pixels = new Uint8Array(width * height * 4);
  const backgroundStart = hex("#071d32");
  const backgroundEnd = hex("#123d5a");
  const panel = hex("#0b2942");
  const lineColor = hex("#4f8294");
  const accent = hex("#bceefa");
  const set = (x, y, color) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    pixels.set(color, (y * width + x) * 4);
  };
  const line = (x1, y1, x2, y2, thickness, color) => {
    const minX = Math.max(0, Math.floor(Math.min(x1, x2) - thickness));
    const maxX = Math.min(width - 1, Math.ceil(Math.max(x1, x2) + thickness));
    const minY = Math.max(0, Math.floor(Math.min(y1, y2) - thickness));
    const maxY = Math.min(height - 1, Math.ceil(Math.max(y1, y2) + thickness));
    for (let y = minY; y <= maxY; y += 1) for (let x = minX; x <= maxX; x += 1) {
      if (distanceToSegment(x + 0.5, y + 0.5, x1, y1, x2, y2) <= thickness / 2) set(x, y, color);
    }
  };
  const circle = (cx, cy, radius, fill, stroke, strokeWidth) => {
    const minX = Math.max(0, Math.floor(cx - radius - strokeWidth));
    const maxX = Math.min(width - 1, Math.ceil(cx + radius + strokeWidth));
    const minY = Math.max(0, Math.floor(cy - radius - strokeWidth));
    const maxY = Math.min(height - 1, Math.ceil(cy + radius + strokeWidth));
    for (let y = minY; y <= maxY; y += 1) for (let x = minX; x <= maxX; x += 1) {
      const distance = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (distance <= radius) set(x, y, fill);
      else if (distance <= radius + strokeWidth / 2) set(x, y, stroke);
    }
  };

  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const amount = Math.max(0, Math.min(1, (x / width) * 0.72 + (y / height) * 0.28));
    set(x, y, blend(backgroundStart, backgroundEnd, amount));
  }
  for (let y = 36; y < height - 36; y += 1) for (let x = 600; x < width - 36; x += 1) {
    if (roundedRectContains(x, y, 600, 36, width - 36, height - 36, 34)) set(x, y, blend(panel, backgroundEnd, (x - 600) / 6000));
  }

  const logo = draw(420);
  const logoX = 84;
  const logoY = 105;
  for (let y = 0; y < 420; y += 1) for (let x = 0; x < 420; x += 1) {
    const offset = (y * 420 + x) * 4;
    if (logo[offset + 3] !== 0) pixels.set(logo.slice(offset, offset + 4), ((logoY + y) * width + logoX + x) * 4);
  }

  line(850, 462, 850, 328, 12, lineColor);
  line(850, 405, 730, 354, 12, lineColor);
  line(850, 405, 970, 354, 12, lineColor);
  line(730, 354, 730, 304, 12, lineColor);
  line(970, 354, 970, 304, 12, lineColor);
  circle(850, 294, 28, panel, accent, 10);
  circle(730, 274, 28, panel, accent, 10);
  circle(970, 274, 28, panel, accent, 10);
  circle(850, 405, 24, panel, accent, 10);
  line(810, 470, 890, 470, 10, accent);
  drawPreviewText(pixels, width, "SOENARTO TREE", 650, 110, 7, accent);
  drawPreviewText(pixels, width, "FAMILY ARCHIVE", 650, 190, 5, lineColor);
  line(650, 250, 1018, 250, 3, lineColor);
  return pixels;
};

const encodePng = (width, height, pixels) => {
  const rows = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y += 1) {
    const offset = y * (width * 4 + 1);
    rows[offset] = 0;
    Buffer.from(pixels.buffer, pixels.byteOffset + y * width * 4, width * 4).copy(rows, offset + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
};

for (const [name, size] of [["pwa-192.png", 192], ["pwa-512.png", 512], ["apple-touch-icon.png", 180], ["favicon.png", 64]]) {
  await writeFile(path.join(outputRoot, name), png(size));
}
await writeFile(path.join(outputRoot, "soenarto-tree-preview.png"), encodePng(1200, 630, drawPreview()));
