// utils/printLogic.ts
// Single source of truth for pricing, limits, page-range parsing and shared types.

export type ColorMode = "B&W" | "Color";

/** Price per printed page (₹). Change here and every screen updates. */
export const RATE_PER_PAGE: Record<ColorMode, number> = { "B&W": 2, Color: 10 };

export const MAX_FILE_MB = 25;
export const MAX_DOC_FILES = 10;
export const MAX_ID_FILES = 2; // front + back
export const MAX_COPIES = 99;

/* ------------------------------------------------------------------ */
/* Shared types (page.tsx <-> ImageSettings <-> FullPageSettings)       */
/* ------------------------------------------------------------------ */

export interface PickedFile {
  id: string;
  file: File;
}

export interface PreparedItem {
  name: string;
  detail: string;
}

/** What the settings component hands back right before upload. */
export interface PrepareResult {
  files: File[];
  /** One entry per file: "All" or a normalized range like "1,3-5" */
  pagesPerFile: string[];
  items: PreparedItem[];
  /** Object URL of a preview image (only for the ID-card A4 sheet) */
  previewUrl?: string;
}

/** Ref handle both settings components expose to the page. */
export interface PrintSettingsHandle {
  prepare: () => Promise<PrepareResult>;
}

/** Live values both settings components report to the page. */
export interface PrintSettingsUpdate {
  copies: number;
  colorMode: ColorMode;
  isDuplex: boolean;
  totalPages: number; // pages per copy
  totalAmount: number;
  isValid: boolean;
}

/* ------------------------------------------------------------------ */
/* File helpers                                                         */
/* ------------------------------------------------------------------ */

export type FileKind = "pdf" | "image";

/** Detects kind from MIME type, falling back to extension (some Android apps send an empty type). */
export function detectKind(file: File): FileKind | null {
  const type = file.type.toLowerCase();
  const name = file.name.toLowerCase();
  if (type === "application/pdf" || name.endsWith(".pdf")) return "pdf";
  if (["image/jpeg", "image/png", "image/webp"].includes(type)) return "image";
  if (!type && /\.(jpe?g|png|webp)$/.test(name)) return "image";
  return null;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/* ------------------------------------------------------------------ */
/* Pricing                                                              */
/* ------------------------------------------------------------------ */

export function calculatePrintPrice(args: {
  pages: number;
  copies: number;
  colorMode: ColorMode;
}): number {
  const { pages, copies, colorMode } = args;
  if (pages <= 0 || copies <= 0) return 0;
  return pages * copies * RATE_PER_PAGE[colorMode];
}

/* ------------------------------------------------------------------ */
/* Page range parsing: "1, 3-5, 8"                                      */
/* ------------------------------------------------------------------ */

export interface PageRangeResult {
  valid: boolean;
  pages: number[];
  count: number;
  /** Sorted, de-duplicated and compressed, e.g. "1,3-5,8" */
  normalized: string;
  /** null when input is empty or valid */
  error: string | null;
}

function compress(pages: number[]): string {
  const parts: string[] = [];
  let start = pages[0];
  let prev = pages[0];
  for (let i = 1; i <= pages.length; i++) {
    const cur = pages[i];
    if (cur === prev + 1) {
      prev = cur;
      continue;
    }
    parts.push(start === prev ? `${start}` : `${start}-${prev}`);
    start = cur;
    prev = cur;
  }
  return parts.join(",");
}

export function parsePageRanges(input: string, totalPages: number): PageRangeResult {
  const fail = (error: string | null): PageRangeResult => ({
    valid: false,
    pages: [],
    count: 0,
    normalized: "",
    error,
  });

  const cleaned = input.replace(/[–—]/g, "-").replace(/\s*-\s*/g, "-").trim();
  if (!cleaned) return fail(null);

  const set = new Set<number>();
  for (const token of cleaned.split(/[,;\s]+/).filter(Boolean)) {
    const m = token.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) return fail(`"${token}" is not valid. Write like: 1, 3-5`);

    const a = parseInt(m[1], 10);
    const b = m[2] !== undefined ? parseInt(m[2], 10) : a;

    if (a < 1 || b < 1) return fail("Page numbers start from 1");
    if (a > b) return fail(`Range ${a}-${b} is backwards`);
    if (b > totalPages) {
      return fail(
        `Page ${b} not found. This file has only ${totalPages} page${totalPages === 1 ? "" : "s"}`
      );
    }
    for (let p = a; p <= b; p++) set.add(p);
  }

  const pages = [...set].sort((x, y) => x - y);
  return { valid: true, pages, count: pages.length, normalized: compress(pages), error: null };
}