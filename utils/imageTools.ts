// utils/imageTools.ts
// Browser-only helpers (call from client components / event handlers only).

import { PDFDocument } from "pdf-lib";

export const A4_MM = { w: 210, h: 297 } as const;

const PRINT_DPI = 300;
const PX_PER_MM = PRINT_DPI / 25.4;

export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("This image could not be opened. Try a JPG or PNG."));
    img.src = src;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Could not process the image."))),
      type,
      quality
    );
  });
}

/**
 * Rotate and/or crop an image and return a new JPEG object URL.
 * - Also downsizes huge phone photos (maxEdge) so the browser never runs out of memory.
 * - Fills transparent PNGs with white (JPEG has no alpha).
 * - Drawing through a canvas also bakes in the EXIF orientation.
 */
export async function transformImage(
  src: string,
  opts: { rotate?: number; crop?: CropRect; maxEdge?: number } = {}
): Promise<{ url: string; w: number; h: number }> {
  const img = await loadImage(src);
  const maxEdge = opts.maxEdge ?? 3200;
  const rot = (((opts.rotate ?? 0) % 360) + 360) % 360;

  let sx = 0;
  let sy = 0;
  let sw = img.naturalWidth;
  let sh = img.naturalHeight;
  if (opts.crop) {
    sx = Math.max(0, Math.round(opts.crop.x));
    sy = Math.max(0, Math.round(opts.crop.y));
    sw = Math.max(1, Math.min(img.naturalWidth - sx, Math.round(opts.crop.w)));
    sh = Math.max(1, Math.min(img.naturalHeight - sy, Math.round(opts.crop.h)));
  }

  const scale = Math.min(1, maxEdge / Math.max(sw, sh));
  const dw = Math.max(1, Math.round(sw * scale));
  const dh = Math.max(1, Math.round(sh * scale));
  const swap = rot === 90 || rot === 270;

  const canvas = document.createElement("canvas");
  canvas.width = swap ? dh : dw;
  canvas.height = swap ? dw : dh;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Your browser cannot process images.");

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((rot * Math.PI) / 180);
  ctx.drawImage(img, sx, sy, sw, sh, -dw / 2, -dh / 2, dw, dh);

  const blob = await canvasToBlob(canvas, "image/jpeg", 0.92);
  return { url: URL.createObjectURL(blob), w: canvas.width, h: canvas.height };
}

export interface ComposeItem {
  src: string;
  xMm: number;
  yMm: number;
  wMm: number;
  hMm: number;
}

export interface ComposeOptions {
  brightness: number; // 100 = unchanged (same scale as CSS brightness %)
  contrast: number; // 100 = unchanged
  grayscale: boolean;
  cutBorder: boolean;
}

/** Pixel-level brightness/contrast/grayscale. Done manually because ctx.filter is missing in many Safari versions. */
function applyAdjustments(ctx: CanvasRenderingContext2D, w: number, h: number, o: ComposeOptions) {
  if (o.brightness === 100 && o.contrast === 100 && !o.grayscale) return;
  const imageData = ctx.getImageData(0, 0, w, h);
  const d = imageData.data;
  const b = o.brightness / 100;
  const c = o.contrast / 100;

  for (let i = 0; i < d.length; i += 4) {
    let r = d[i] * b;
    let g = d[i + 1] * b;
    let bl = d[i + 2] * b;

    r = (r / 255 - 0.5) * c * 255 + 127.5;
    g = (g / 255 - 0.5) * c * 255 + 127.5;
    bl = (bl / 255 - 0.5) * c * 255 + 127.5;

    if (o.grayscale) {
      const y = 0.2126 * r + 0.7152 * g + 0.0722 * bl;
      r = g = bl = y;
    }
    d[i] = r; // Uint8ClampedArray clamps to 0-255
    d[i + 1] = g;
    d[i + 2] = bl;
  }
  ctx.putImageData(imageData, 0, 0);
}

/** Draws every item onto a white 300-DPI A4 canvas and returns a JPEG blob. */
export async function composeA4(items: ComposeItem[], opts: ComposeOptions): Promise<Blob> {
  const W = Math.round(A4_MM.w * PX_PER_MM);
  const H = Math.round(A4_MM.h * PX_PER_MM);

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Your browser cannot process images.");

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);

  for (const it of items) {
    const img = await loadImage(it.src);
    const dx = Math.round(it.xMm * PX_PER_MM);
    const dy = Math.round(it.yMm * PX_PER_MM);
    const dw = Math.max(1, Math.round(it.wMm * PX_PER_MM));
    const dh = Math.max(1, Math.round(it.hMm * PX_PER_MM));

    const tmp = document.createElement("canvas");
    tmp.width = dw;
    tmp.height = dh;
    const tctx = tmp.getContext("2d");
    if (!tctx) throw new Error("Your browser cannot process images.");
    tctx.imageSmoothingQuality = "high";
    tctx.drawImage(img, 0, 0, dw, dh);
    applyAdjustments(tctx, dw, dh, opts);

    ctx.drawImage(tmp, dx, dy);

    if (opts.cutBorder) {
      const lw = Math.max(2, Math.round(0.3 * PX_PER_MM));
      ctx.strokeStyle = "#9ca3af";
      ctx.lineWidth = lw;
      ctx.strokeRect(dx - lw / 2, dy - lw / 2, dw + lw, dh + lw); // drawn outside the image
    }
  }

  return canvasToBlob(canvas, "image/jpeg", 0.92);
}

/** Wraps a full-page JPEG into a single-page A4 PDF (exact paper size, printer friendly). */
export async function jpegToA4Pdf(jpeg: Blob): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595.28, 841.89]);
  const img = await pdf.embedJpg(await jpeg.arrayBuffer());
  page.drawImage(img, { x: 0, y: 0, width: 595.28, height: 841.89 });
  pdf.setTitle("SmartPrint sheet");
  return pdf.save();
}