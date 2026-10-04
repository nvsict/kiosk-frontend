"use client";

// components/FullPageSettings.tsx
// Full document mode (PDFs + page-size images). Replaces the old PdfSettings.tsx.
// Every file has its OWN page selection, so "Marksheet.pdf pages 2,5" and "Form.pdf all pages" work together.

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { PDFDocument } from "pdf-lib";
import { BookOpen, FileText, Image as ImageIcon, Loader2, Plus, Settings, Trash2 } from "lucide-react";
import { Banner, CommonPrintOptions, FieldLabel, SectionTitle, Segmented } from "./PrintControls";
import {
  calculatePrintPrice,
  detectKind,
  formatFileSize,
  MAX_DOC_FILES,
  parsePageRanges,
  type ColorMode,
  type PageRangeResult,
  type PickedFile,
  type PrepareResult,
  type PrintSettingsHandle,
  type PrintSettingsUpdate,
} from "../utils/printLogic";

interface Meta {
  status: "loading" | "ready" | "error";
  pageCount: number;
}

interface RangeState {
  mode: "All" | "Custom";
  text: string;
}

interface FullPageSettingsProps {
  files: PickedFile[];
  onRemove: (id: string) => void;
  onAddMore: () => void;
  onUpdate: (data: PrintSettingsUpdate) => void;
  /** Will come from the operator's Python agent later. */
  isDuplexEnabledByOperator?: boolean;
}

const FullPageSettings = forwardRef<PrintSettingsHandle, FullPageSettingsProps>(function FullPageSettings(
  { files, onRemove, onAddMore, onUpdate, isDuplexEnabledByOperator = true },
  ref
) {
  const [copies, setCopies] = useState(1);
  const [colorMode, setColorMode] = useState<ColorMode>("B&W");
  const [isDuplex, setIsDuplex] = useState(false);

  const [meta, setMeta] = useState<Record<string, Meta>>({});
  const [ranges, setRanges] = useState<Record<string, RangeState>>({});
  const requested = useRef<Set<string>>(new Set());

  /* ----- count real pages of every newly added file ----- */
  useEffect(() => {
    files.forEach(({ id, file }) => {
      if (requested.current.has(id)) return;
      requested.current.add(id);

      if (detectKind(file) !== "pdf") {
        setMeta((m) => ({ ...m, [id]: { status: "ready", pageCount: 1 } }));
        return;
      }

      setMeta((m) => ({ ...m, [id]: { status: "loading", pageCount: 0 } }));
      file
        .arrayBuffer()
        .then((buf) => PDFDocument.load(buf, { ignoreEncryption: true, updateMetadata: false }))
        .then((doc) => setMeta((m) => ({ ...m, [id]: { status: "ready", pageCount: doc.getPageCount() } })))
        .catch(() => setMeta((m) => ({ ...m, [id]: { status: "error", pageCount: 0 } })));
    });
  }, [files]);

  const setRange = (id: string, patch: Partial<RangeState>) =>
  setRanges((r) => {
    const current: RangeState = r[id] ?? { mode: "All", text: "" };
    return { ...r, [id]: { ...current, ...patch } };
  });

  /* ----- per-file derived state ----- */
  const rows = useMemo(
    () =>
      files.map(({ id, file }) => {
        const m: Meta = meta[id] ?? { status: "loading", pageCount: 0 };
        const r: RangeState = ranges[id] ?? { mode: "All", text: "" };
        const isPdf = detectKind(file) === "pdf";
        const parsed: PageRangeResult | null =
          isPdf && r.mode === "Custom" && m.status === "ready" ? parsePageRanges(r.text, m.pageCount) : null;
        const valid = m.status === "ready" && (r.mode === "All" || !!parsed?.valid);
        const printCount = !valid ? 0 : r.mode === "All" || !parsed ? m.pageCount : parsed.count;
        return { id, file, isPdf, meta: m, range: r, parsed, valid, printCount };
      }),
    [files, meta, ranges]
  );

  const totalPages = rows.reduce((sum, r) => sum + r.printCount, 0);
  const isValid = rows.length > 0 && rows.every((r) => r.valid) && totalPages > 0;

  useEffect(() => {
    onUpdate({
      copies,
      colorMode,
      isDuplex,
      totalPages,
      totalAmount: calculatePrintPrice({ pages: totalPages, copies, colorMode }),
      isValid,
    });
  }, [copies, colorMode, isDuplex, totalPages, isValid, onUpdate]);

  useImperativeHandle(
    ref,
    () => ({
      async prepare(): Promise<PrepareResult> {
        if (!isValid) throw new Error("Please fix the highlighted files first.");
        return {
          files: rows.map((r) => r.file),
          pagesPerFile: rows.map((r) => (r.range.mode === "All" || !r.parsed ? "All" : r.parsed.normalized)),
          items: rows.map((r) => ({
            name: r.file.name,
            detail:
              r.range.mode === "All" || !r.parsed
                ? `${r.meta.pageCount} page${r.meta.pageCount === 1 ? "" : "s"}`
                : `Pages ${r.parsed.normalized} (${r.parsed.count} of ${r.meta.pageCount})`,
          })),
        };
      },
    }),
    [rows, isValid]
  );

  return (
    <div className="animate-in fade-in duration-300">
      <SectionTitle icon={<Settings className="w-5 h-5" />}>Document settings</SectionTitle>

      {/* File cards */}
      <div className="space-y-3 mb-4">
        {rows.map((r) => (
          <div key={r.id} className={`rounded-2xl border p-4 ${r.meta.status === "error" ? "border-red-200 bg-red-50/40" : "border-gray-200 bg-gray-50"}`}>
            <div className="flex items-center">
              <div className={`w-11 h-11 rounded-lg flex items-center justify-center flex-shrink-0 border ${r.isPdf ? "bg-red-50 border-red-100" : "bg-green-50 border-green-100"}`}>
                {r.isPdf ? <FileText className="w-6 h-6 text-red-500" /> : <ImageIcon className="w-6 h-6 text-green-600" />}
              </div>
              <div className="ml-3 min-w-0 flex-1">
                <p className="font-semibold text-sm text-gray-800 truncate">{r.file.name}</p>
                <p className="text-xs text-gray-500">
                  {formatFileSize(r.file.size)}
                  {r.meta.status === "ready" && ` • ${r.meta.pageCount} page${r.meta.pageCount === 1 ? "" : "s"}`}
                  {r.meta.status === "loading" && " • Reading…"}
                </p>
              </div>
              <button type="button" aria-label={`Remove ${r.file.name}`} onClick={() => onRemove(r.id)} className="ml-2 w-10 h-10 flex items-center justify-center text-red-500 hover:bg-red-100 rounded-xl active:scale-95">
                <Trash2 className="w-4 h-4" />
              </button>
            </div>

            {r.meta.status === "loading" && (
              <p className="mt-3 text-xs text-blue-700 flex items-center">
                <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> Counting pages…
              </p>
            )}

            {r.meta.status === "error" && (
              <div className="mt-3">
                <Banner tone="error">This PDF could not be read. It may be damaged or password protected. Remove it and try another file.</Banner>
              </div>
            )}

            {!r.isPdf && r.meta.status === "ready" && (
              <p className="mt-3 text-xs text-gray-500">This photo will be printed on one A4 page, fitted without stretching.</p>
            )}

            {r.isPdf && r.meta.status === "ready" && (
              <div className="mt-4">
                <FieldLabel>Pages to print</FieldLabel>
                <Segmented<"All" | "Custom">
                  value={r.range.mode}
                  onChange={(mode) => setRange(r.id, { mode })}
                  options={[
                    { value: "All", label: "All pages", sub: `${r.meta.pageCount} total` },
                    { value: "Custom", label: "Select pages", sub: "e.g. 2, 5-7" },
                  ]}
                />
                {r.range.mode === "Custom" && (
                  <div className="mt-3">
                    <input
                      type="text"
                      inputMode="text"
                      placeholder="e.g. 1, 3-5"
                      value={r.range.text}
                      onChange={(e) => setRange(r.id, { text: e.target.value })}
                      className={`w-full border rounded-xl p-3 text-sm focus:ring-2 outline-none bg-white ${r.parsed?.error ? "border-red-300 focus:ring-red-400" : "border-gray-300 focus:ring-blue-500"}`}
                    />
                    {r.parsed?.error && <p className="text-xs text-red-600 mt-1.5 font-semibold">{r.parsed.error}</p>}
                    {!r.parsed?.error && r.parsed?.valid && (
                      <p className="text-xs text-green-700 mt-1.5 font-semibold">
                        Printing {r.parsed.count} of {r.meta.pageCount} pages
                      </p>
                    )}
                    {!r.range.text.trim() && <p className="text-xs text-gray-400 mt-1.5">Type the page numbers you need.</p>}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      <button
        type="button"
        onClick={onAddMore}
        disabled={files.length >= MAX_DOC_FILES}
        className="w-full mb-6 py-3 rounded-2xl border-2 border-dashed border-gray-300 text-sm font-semibold text-blue-600 hover:bg-blue-50 hover:border-blue-300 flex items-center justify-center active:scale-95 disabled:opacity-50"
      >
        <Plus className="w-4 h-4 mr-1" /> {files.length >= MAX_DOC_FILES ? `Maximum ${MAX_DOC_FILES} files` : "Add another file"}
      </button>

      {isDuplexEnabledByOperator && (
        <div className="mb-5">
          <FieldLabel>Print layout</FieldLabel>
          <Segmented<"single" | "double">
            value={isDuplex ? "double" : "single"}
            onChange={(v) => setIsDuplex(v === "double")}
            options={[
              { value: "single", label: "One side" },
              {
                value: "double",
                label: (
                  <>
                    <BookOpen className="w-4 h-4 mr-1" /> Both sides
                  </>
                ),
              },
            ]}
          />
        </div>
      )}

      <CommonPrintOptions colorMode={colorMode} copies={copies} onColorMode={setColorMode} onCopies={setCopies} />
    </div>
  );
});

export default FullPageSettings;