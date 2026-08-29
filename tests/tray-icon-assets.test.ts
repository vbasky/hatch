import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

const TRAY_DIR = resolve(import.meta.dirname, "../assets/tray");
const LIB_RS = resolve(import.meta.dirname, "../src-tauri/src/lib.rs");
const TRAY_RS = resolve(import.meta.dirname, "../src-tauri/src/tray.rs");

type RgbaPng = {
  width: number;
  height: number;
  data: Uint8Array;
};

function pngSize(buffer: Buffer): { width: number; height: number } {
  if (buffer.subarray(0, 8).toString("binary") !== "\u0089PNG\r\n\u001a\n") {
    throw new Error("not a PNG");
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function decodeRgbaPng(buffer: Buffer): RgbaPng {
  const { width, height } = pngSize(buffer);
  const colorType = buffer[25];
  if (buffer[24] !== 8 || colorType !== 6) {
    throw new Error(`expected 8-bit RGBA PNG, got bitDepth=${buffer[24]} colorType=${colorType}`);
  }

  const chunks: Buffer[] = [];
  let offset = 8;
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IDAT") chunks.push(data);
    offset += 12 + length;
  }

  const raw = inflateSync(Buffer.concat(chunks));
  const bpp = 4;
  const stride = width * bpp;
  const data = new Uint8Array(height * stride);
  let source = 0;
  const prev = new Uint8Array(stride);

  for (let y = 0; y < height; y += 1) {
    const filter = raw[source];
    source += 1;
    const row = raw.subarray(source, source + stride);
    source += stride;
    const dest = data.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x += 1) {
      const left = x >= bpp ? dest[x - bpp] : 0;
      const up = prev[x];
      const upLeft = x >= bpp ? prev[x - bpp] : 0;
      let value = row[x];
      if (filter === 1) value = (value + left) & 255;
      else if (filter === 2) value = (value + up) & 255;
      else if (filter === 3) value = (value + ((left + up) >> 1)) & 255;
      else if (filter === 4) value = (value + paeth(left, up, upLeft)) & 255;
      else if (filter !== 0) throw new Error(`unsupported PNG filter ${filter}`);
      dest[x] = value;
    }
    prev.set(dest);
  }

  return { width, height, data };
}

function glyphBox(png: RgbaPng): { widthRatio: number; heightRatio: number } {
  let minX = png.width;
  let minY = png.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const alpha = png.data[(y * png.width + x) * 4 + 3];
      if (alpha <= 20) continue;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  if (maxX < 0) return { widthRatio: 0, heightRatio: 0 };
  return {
    widthRatio: (maxX - minX + 1) / png.width,
    heightRatio: (maxY - minY + 1) / png.height,
  };
}

describe("Hatch tray template", () => {
  it("ships 1x, 2x, and 3x template PNGs", async () => {
    const files = [
      ["hatchTemplate.png", 22],
      ["hatchTemplate@2x.png", 44],
      ["hatchTemplate@3x.png", 66],
    ] as const;

    for (const [name, size] of files) {
      const buffer = await readFile(resolve(TRAY_DIR, name));
      expect(pngSize(buffer)).toEqual({ width: size, height: size });
    }
  });

  it("sits in the menu-bar canvas at Saturn-like weight, not edge to edge", async () => {
    const png = decodeRgbaPng(await readFile(resolve(TRAY_DIR, "hatchTemplate@3x.png")));
    const box = glyphBox(png);
    expect(box.heightRatio).toBeGreaterThanOrEqual(0.72);
    expect(box.heightRatio).toBeLessThanOrEqual(0.86);
    expect(box.widthRatio).toBeGreaterThanOrEqual(0.5);
    expect(box.widthRatio).toBeLessThanOrEqual(0.72);
  });

  it("loads the @3x template and sizes the status item to 18pt", async () => {
    const lib = await readFile(LIB_RS, "utf8");
    const tray = await readFile(TRAY_RS, "utf8");
    expect(tray).toContain("hatchTemplate@3x.png");
    expect(tray).toMatch(/TRAY_ICON_POINT_SIZE:\s*f64\s*=\s*18(?:\.0)?/);
    expect(tray).toContain("setSize");
    expect(lib).toContain("hatch_tray_icon_path");
    expect(lib).toContain("size_tray_icon_to_menu_bar");
    expect(lib).not.toMatch(/tray\/hatchTemplate\.png"/);
  });
});
