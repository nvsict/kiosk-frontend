"use client";

// components/FullPageSettings.tsx
// Full document mode (PDFs + page-size images). Replaces the old PdfSettings.tsx.

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
  previewUrl: string | null;
  orientation: "portrait" | "landscape";
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
  pricing?: { bw: number; color: number };
  isDuplexEnabledByOperator?: boolean;
}

const FullPageSettings = forwardRef<PrintSettingsHandle, FullPageSettingsProps>(function FullPageSettings(
  { files, onRemove, onAddMore, onUpdate, pricing, isDuplexEnabledByOperator = true },
  ref
) {
  const [copies, setCopies] = useState(1);
  const [colorMode, setColorMode] = useState<ColorMode>("B&W");
  const [isDuplex, setIsDuplex] = useState(false);

  const [meta, setMeta] = useState<Record<string, Meta>>({});
  const [ranges, setRanges] = useState<Record<string, RangeState>>({});
  const requested = useRef<Set<string>>(new Set());

  /* ----- Helper: Generate PDF Thumbnail using pdfjs-dist ----- */
  const generatePdfThumbnail = async (file: File): Promise<string | null> => {
    try {
      const pdfjsLib = await import("pdfjs-dist");
      if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
        pdfjsLib.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`;
      }
      const arrayBuffer = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
      const page = await pdf.getPage(1); // Get first page
      
      const viewport = page.getViewport({ scale: 1.0 });
      // Scale down to a max width of 150px for the thumbnail to save memory
      const scale = 150 / viewport.width;
      const scaledViewport = page.getViewport({ scale });

      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d");
      if (!context) return null;
      
      canvas.height = scaledViewport.height;
      canvas.width = scaledViewport.width;

      await page.render({ canvasContext: context, viewport: scaledViewport } as any).promise;
      return canvas.toDataURL("image/jpeg", 0.8);
    } catch (err) {
      console.warn("Could not generate PDF thumbnail", err);
      return null;
    }
  };

  /* ----- Process Files: Count Pages, Detect Orientation, Generate Thumbnails ----- */
  useEffect(() => {
    files.forEach(({ id, file }) => {
      if (requested.current.has(id)) return;
      requested.current.add(id);

      const isPdf = detectKind(file) === "pdf";

      const loadData = async () => {
        setMeta((m) => ({ ...m, [id]: { status: "loading", pageCount: 0, previewUrl: null, orientation: "portrait" } }));
        try {
          if (!isPdf) {
            // It's an image
            const previewUrl = URL.createObjectURL(file);
            const img = new Image();
            img.src = previewUrl;
            await new Promise((r) => (img.onload = r));
            const orientation = img.width > img.height ? "landscape" : "portrait";
            
            setMeta((m) => ({ ...m, [id]: { status: "ready", pageCount: 1, previewUrl, orientation } }));
          } else {
            // It's a PDF
            const buf = await file.arrayBuffer();
            const doc = await PDFDocument.load(buf, { ignoreEncryption: true, updateMetadata: false });
            const pageCount = doc.getPageCount();
            
            // Auto-detect orientation from the first page
            const firstPage = doc.getPage(0);
            const { width, height } = firstPage.getSize();
            const orientation = width > height ? "landscape" : "portrait";

            // Generate thumbnail
            const previewUrl = await generatePdfThumbnail(file);

            setMeta((m) => ({ ...m, [id]: { status: "ready", pageCount, previewUrl, orientation } }));
          }
        } catch (e) {
          setMeta((m) => ({ ...m, [id]: { status: "error", pageCount: 0, previewUrl: null, orientation: "portrait" } }));
        }
      };

      loadData();
    });
  }, [files]);

  const setRange = (id: string, patch: Partial<RangeState>) =>
    setRanges((r) => {
      const current: RangeState = r[id] ?? { mode: "All", text: "" };
      return { ...r, [id]: { ...current, ...patch } };
    });

  const appendPageToRange = (id: string, page: number) => {
    const currentText = ranges[id]?.text || "";
    const newText = currentText.trim() === "" ? `${page}` : `${currentText}, ${page}`;
    setRange(id, { text: newText });
  };

  /* ----- per-file derived state ----- */
  const rows = useMemo(
    () =>
      files.map(({ id, file }) => {
        const m: Meta = meta[id] ?? { status: "loading", pageCount: 0, previewUrl: null, orientation: "portrait" };
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
    const rate = colorMode === "Color" ? (pricing?.color ?? 10.0) : (pricing?.bw ?? 2.0);
    onUpdate({
      copies,
      colorMode,
      isDuplex,
      totalPages,
      totalAmount: totalPages * copies * rate,
      isValid,
    });
  }, [copies, colorMode, isDuplex, totalPages, isValid, onUpdate, pricing]);

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
              (r.range.mode === "All" || !r.parsed
                ? `${r.meta.pageCount} page${r.meta.pageCount === 1 ? "" : "s"}`
                : `Pages ${r.parsed.normalized} (${r.parsed.count} of ${r.meta.pageCount})`) +
              ` • ${r.meta.orientation === "landscape" ? "Landscape" : "Portrait"}`,
          })),
        };
      },
    }),
    [rows, isValid]
  );

  return (
    <div className="animate-in fade-in duration-300">
      <SectionTitle icon={<Settings className="w-5 h-5" />}>Document Setup</SectionTitle>

      {/* Soft File Cards */}
      <div className="space-y-4 mb-5">
        {rows.map((r) => (
          <div key={r.id} className={`rounded-[1.25rem] bg-white shadow-sm ring-1 p-4 relative overflow-hidden transition-all ${r.meta.status === "error" ? "ring-red-200 bg-red-50/20" : "ring-gray-200/60"}`}>
            
            <div className="flex items-start gap-4">
              
              {/* Visual Thumbnail */}
              <div className={`w-16 h-20 rounded-lg flex items-center justify-center flex-shrink-0 shadow-inner overflow-hidden border border-gray-100 ${r.isPdf ? "bg-red-50" : "bg-green-50"}`}>
                {r.meta.previewUrl ? (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img src={r.meta.previewUrl} alt="Document preview" className="w-full h-full object-cover" />
                ) : (
                  r.isPdf ? <FileText className="w-8 h-8 text-red-400" strokeWidth={2} /> : <ImageIcon className="w-8 h-8 text-green-400" strokeWidth={2} />
                )}
              </div>

              <div className="min-w-0 flex-1 pt-1">
                <p className="font-bold text-[15px] text-gray-900 truncate leading-tight">{r.file.name}</p>
                <p className="text-xs font-medium text-gray-500 mt-1">
                  {formatFileSize(r.file.size)}
                  {r.meta.status === "ready" && ` • ${r.meta.pageCount} page${r.meta.pageCount === 1 ? "" : "s"}`}
                </p>
                
                {r.meta.status === "loading" && (
                  <p className="mt-2 text-xs font-bold text-blue-600 flex items-center">
                    <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> Processing file…
                  </p>
                )}
              </div>

              <button type="button" aria-label="Remove" onClick={() => onRemove(r.id)} className="w-10 h-10 flex items-center justify-center text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-full active:scale-95 transition-colors">
                <Trash2 className="w-5 h-5" />
              </button>
            </div>

            {r.meta.status === "error" && (
              <div className="mt-4">
                <Banner tone="error">This file could not be read. It may be damaged or password protected. Please remove it.</Banner>
              </div>
            )}

            {r.meta.status === "ready" && (
              <div className="mt-5 pt-4 border-t border-gray-100">
                
                {/* Orientation Toggle */}
                <div className="mb-5">
                  <FieldLabel>Paper Orientation</FieldLabel>
                  <Segmented<"portrait" | "landscape">
                    value={r.meta.orientation}
                    onChange={(val) => setMeta((m) => ({ ...m, [r.id]: { ...m[r.id], orientation: val } }))}
                    options={[
                      { value: "portrait", label: "Portrait" },
                      { value: "landscape", label: "Landscape" },
                    ]}
                  />
                </div>

                {r.isPdf && (
                  <>
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
                      <div className="mt-4 animate-in fade-in slide-in-from-top-2 duration-200">
                        <input
                          type="text"
                          inputMode="decimal"
                          pattern="[0-9,\- ]*"
                          placeholder="e.g. 1, 3-5"
                          value={r.range.text}
                          onChange={(e) => setRange(r.id, { text: e.target.value })}
                          className={`w-full rounded-xl p-3.5 text-[15px] font-medium shadow-inner outline-none transition-all ${r.parsed?.error ? "bg-red-50 ring-2 ring-red-400 text-red-900" : "bg-gray-50 ring-1 ring-gray-200 focus:ring-2 focus:ring-blue-500 focus:bg-white text-gray-900"}`}
                        />
                        
                        {r.parsed?.error ? (
                          <p className="text-xs text-red-600 mt-2 font-bold">{r.parsed.error}</p>
                        ) : r.parsed?.valid ? (
                          <p className="text-xs text-green-600 mt-2 font-bold">
                            Printing {r.parsed.count} of {r.meta.pageCount} pages
                          </p>
                        ) : (
                          <p className="text-xs text-gray-400 mt-2 font-medium">Type the page numbers or ranges you need.</p>
                        )}

                        {/* Smart Quick Select Chips */}
                        <div className="mt-3 flex flex-wrap gap-2">
                          {r.meta.pageCount <= 6 ? (
                            Array.from({ length: r.meta.pageCount }).map((_, i) => (
                              <button
                                key={i + 1}
                                type="button"
                                onClick={() => appendPageToRange(r.id, i + 1)}
                                className="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 text-gray-700 text-[11px] font-bold uppercase tracking-wider rounded-lg active:scale-95 transition-transform"
                              >
                                Page {i + 1}
                              </button>
                            ))
                          ) : (
                            <>
                              <button
                                type="button"
                                onClick={() => appendPageToRange(r.id, 1)}
                                className="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 text-gray-700 text-[11px] font-bold uppercase tracking-wider rounded-lg active:scale-95 transition-transform"
                              >
                                First Page
                              </button>
                              <button
                                type="button"
                                onClick={() => appendPageToRange(r.id, r.meta.pageCount)}
                                className="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 text-gray-700 text-[11px] font-bold uppercase tracking-wider rounded-lg active:scale-95 transition-transform"
                              >
                                Last Page ({r.meta.pageCount})
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    )}
                  </>
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
        className="w-full mb-8 py-3.5 rounded-2xl border-2 border-dashed border-gray-200 bg-gray-50/50 text-sm font-bold text-gray-400 hover:text-gray-600 hover:bg-gray-100 hover:border-gray-300 flex items-center justify-center active:scale-[0.98] disabled:opacity-50 transition-all duration-200"
      >
        <Plus className="w-5 h-5 mr-1.5" strokeWidth={2.5} /> 
        {files.length >= MAX_DOC_FILES ? `Limit reached (${MAX_DOC_FILES} files)` : "Add another file"}
      </button>

      {/* Global Layout & Colors */}
      <div className="bg-white ring-1 ring-gray-100 shadow-sm rounded-3xl p-5 mb-2">
        {isDuplexEnabledByOperator && (
          <div className="mb-6">
            <FieldLabel>Print Layout</FieldLabel>
            <Segmented<"single" | "double">
              value={isDuplex ? "double" : "single"}
              onChange={(v) => setIsDuplex(v === "double")}
              options={[
                { value: "single", label: "One side" },
                {
                  value: "double",
                  label: (
                    <>
                      <BookOpen className="w-4 h-4 mr-1.5 text-gray-400" /> Both sides
                    </>
                  ),
                },
              ]}
            />
          </div>
        )}

        <CommonPrintOptions colorMode={colorMode} copies={copies} onColorMode={setColorMode} onCopies={setCopies} pricing={pricing} />
      </div>
    </div>
  );
});

export default FullPageSettings;