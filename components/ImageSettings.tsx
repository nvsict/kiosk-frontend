"use client";

// components/ImageSettings.tsx
// ID card / photo mode. The customer arranges front (+ optional back) on an A4 sheet.
// IMPORTANT: on prepare() the exact layout (crop, rotate, size, position, brightness/contrast, B&W)
// is rendered into a real 300-DPI A4 PDF, so what the customer sees is what gets printed.

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import ReactCrop, { centerCrop, makeAspectCrop, type Crop } from "react-image-crop";
import "react-image-crop/dist/ReactCrop.css";
import { Rnd } from "react-rnd";
import { Check, Crop as CropIcon, Loader2, PlusCircle, RotateCw, Settings, Trash2, Wand2, X } from "lucide-react";
import {
  CommonPrintOptions,
  FieldLabel,
  Banner,
  Segmented,
  SectionTitle,
} from "./PrintControls";
import {
  calculatePrintPrice,
  detectKind,
  MAX_FILE_MB,
  type ColorMode,
  type PrepareResult,
  type PrintSettingsHandle,
  type PrintSettingsUpdate,
} from "../utils/printLogic";
import { A4_MM, composeA4, jpegToA4Pdf, transformImage } from "../utils/imageTools";

/* ---------------- constants ---------------- */

const A4_W = A4_MM.w;
const A4_H = A4_MM.h;
const MARGIN = 5; // mm. Most printers cannot print closer to the paper edge.
const MIN_MM = 25;
const DEFAULT_MM = 100;
const GAP = 12;
const MAX_EDGE = 3200;
const CARD_ASPECT = 85.6 / 54;

type SideKey = "front" | "back";

interface Side {
  name: string;
  base: string; // normalized original (rotation 0)
  rot: number;
  rotated: string; // base after rotation (this is what the crop modal shows)
  rw: number;
  rh: number;
  src: string; // rotated + cropped (this is what is printed)
  w: number;
  h: number;
  x: number; // mm from paper left
  y: number; // mm from paper top
  mm: number; // printed width in mm (height follows the image aspect)
}

const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);
const heightMm = (s: Side) => (s.mm * s.h) / s.w;

function clampSide(s: Side): Side {
  const aspect = s.w / s.h;
  const maxMm = Math.min(A4_W - 2 * MARGIN, (A4_H - 2 * MARGIN) * aspect);
  const mm = clamp(s.mm, Math.min(MIN_MM, maxMm), maxMm);
  const h = mm / aspect;
  return {
    ...s,
    mm,
    x: clamp(s.x, MARGIN, A4_W - MARGIN - mm),
    y: clamp(s.y, MARGIN, A4_H - MARGIN - h),
  };
}

function place(s: Side, y: number): Side {
  const c = clampSide(s);
  return clampSide({ ...c, x: (A4_W - c.mm) / 2, y });
}

function arrange(front: Side, back: Side | null): { f: Side; b: Side | null } {
  const f = place(front, 20);
  const b = back ? place(back, f.y + heightMm(f) + GAP) : null;
  return { f, b };
}

function overlaps(a: Side, b: Side) {
  return (
    a.x < b.x + b.mm - 0.5 &&
    b.x < a.x + a.mm - 0.5 &&
    a.y < b.y + heightMm(b) - 0.5 &&
    b.y < a.y + heightMm(a) - 0.5
  );
}

const effectiveDpi = (s: Side) => s.w / (s.mm / 25.4);

/* ---------------- component ---------------- */

interface ImageSettingsProps {
  frontFile: File;
  backFile?: File | null;
  onUpdate: (data: PrintSettingsUpdate) => void;
}

const ImageSettings = forwardRef<PrintSettingsHandle, ImageSettingsProps>(function ImageSettings(
  { frontFile, backFile = null, onUpdate },
  ref
) {
  // print options
  const [copies, setCopies] = useState(1);
  const [colorMode, setColorMode] = useState<ColorMode>("Color");
  const [brightness, setBrightness] = useState(100);
  const [contrast, setContrast] = useState(100);
  const [cutBorder, setCutBorder] = useState(true);

  // images
  const [front, setFront] = useState<Side | null>(null);
  const [back, setBack] = useState<Side | null>(null);
  const [active, setActive] = useState<SideKey>("front");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // paper preview size (responsive)
  const wrapRef = useRef<HTMLDivElement>(null);
  const [paperW, setPaperW] = useState(280);
  const scale = paperW / A4_W; // px per mm

  // crop modal
  const [cropOpen, setCropOpen] = useState(false);
  const [crop, setCrop] = useState<Crop | undefined>(undefined);
  const [cropMode, setCropMode] = useState<"free" | "card">("free");
  const imgRef = useRef<HTMLImageElement>(null);

  const backInputRef = useRef<HTMLInputElement>(null);
  const urls = useRef<Set<string>>(new Set());
  const track = (u: string) => {
    urls.current.add(u);
    return u;
  };

  /* ----- measure paper width (ignore 0 when this screen is hidden on the review step) ----- */
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const w = Math.floor(entry.contentRect.width);
      if (w > 80) setPaperW(Math.min(w, 340));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /* ----- free blob URLs on unmount ----- */
  useEffect(() => {
    const set = urls.current;
    return () => set.forEach((u) => URL.revokeObjectURL(u));
  }, []);

  /* ----- load a File into a Side ----- */
  const loadSide = useCallback(async (file: File): Promise<Side> => {
    const tmp = URL.createObjectURL(file);
    try {
      const t = await transformImage(tmp, { maxEdge: MAX_EDGE });
      track(t.url);
      return {
        name: file.name,
        base: t.url,
        rot: 0,
        rotated: t.url,
        rw: t.w,
        rh: t.h,
        src: t.url,
        w: t.w,
        h: t.h,
        x: MARGIN,
        y: MARGIN,
        mm: DEFAULT_MM,
      };
    } finally {
      URL.revokeObjectURL(tmp);
    }
  }, []);

  /* ----- initial load ----- */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const f = await loadSide(frontFile);
        const b = backFile ? await loadSide(backFile) : null;
        if (cancelled) return;
        const { f: pf, b: pb } = arrange(f, b);
        setFront(pf);
        setBack(pb);
      } catch (e) {
        if (!cancelled) setNotice(e instanceof Error ? e.message : "Could not open this image.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ----- helpers ----- */
  const sideOf = (k: SideKey) => (k === "front" ? front : back);
  const updateSide = (k: SideKey, fn: (s: Side) => Side) =>
    (k === "front" ? setFront : setBack)((s) => (s ? fn(s) : s));

  const activeSide = sideOf(active);

  /* ----- report price/validity to the page ----- */
  const isValid = !!front && !loading && !busy;
  useEffect(() => {
    onUpdate({
      copies,
      colorMode,
      isDuplex: false,
      totalPages: 1,
      totalAmount: calculatePrintPrice({ pages: 1, copies, colorMode }),
      isValid,
    });
  }, [copies, colorMode, isValid, onUpdate]);

  /* ----- actions ----- */
  const handleBackPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !front) return;
    if (detectKind(file) !== "image") {
      setNotice("Please choose a JPG or PNG photo for the back side.");
      return;
    }
    if (file.size > MAX_FILE_MB * 1024 * 1024) {
      setNotice(`That photo is larger than ${MAX_FILE_MB} MB.`);
      return;
    }
    setNotice(null);
    setBusy("Adding back side…");
    try {
      const s = await loadSide(file);
      setBack(place(s, front.y + heightMm(front) + GAP));
      setActive("back");
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Could not open this image.");
    } finally {
      setBusy(null);
    }
  };

  const removeBack = () => {
    setBack(null);
    setActive("front");
  };

  const autoArrange = () => {
    if (!front) return;
    const { f, b } = arrange(front, back);
    setFront(f);
    setBack(b);
  };

  const matchSize = () => {
    if (!front || !back || !activeSide) return;
    const mm = activeSide.mm;
    const f = clampSide({ ...front, mm });
    const b = clampSide({ ...back, mm });
    const arranged = arrange(f, b);
    setFront(arranged.f);
    setBack(arranged.b);
  };

  const setWidth = (mm: number) => updateSide(active, (s) => clampSide({ ...s, mm }));

  const rotate = async () => {
    if (!activeSide) return;
    setBusy("Rotating…");
    setNotice(null);
    try {
      const rot = (activeSide.rot + 90) % 360;
      const t = await transformImage(activeSide.base, { rotate: rot, maxEdge: MAX_EDGE });
      track(t.url);
      updateSide(active, (s) =>
        clampSide({ ...s, rot, rotated: t.url, rw: t.w, rh: t.h, src: t.url, w: t.w, h: t.h })
      );
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Could not rotate this image.");
    } finally {
      setBusy(null);
    }
  };

  const resetCrop = () =>
    updateSide(active, (s) => clampSide({ ...s, src: s.rotated, w: s.rw, h: s.rh }));

  const isCropped = !!activeSide && activeSide.src !== activeSide.rotated;

  /* ----- crop modal ----- */
  const setInitialCrop = (img: HTMLImageElement, mode: "free" | "card") => {
    const { width, height } = img;
    if (mode === "card") {
      setCrop(centerCrop(makeAspectCrop({ unit: "%", width: 90 }, CARD_ASPECT, width, height), width, height));
    } else {
      setCrop({ unit: "%", x: 5, y: 5, width: 90, height: 90 });
    }
  };

  const openCrop = () => {
    setCropMode("free");
    setCrop(undefined);
    setCropOpen(true);
  };

  const applyCrop = async () => {
    const img = imgRef.current;
    if (!img || !crop || !activeSide || crop.width < 2 || crop.height < 2) {
      setCropOpen(false);
      return;
    }
    const nw = img.naturalWidth;
    const nh = img.naturalHeight;
    const rect = {
      x: (crop.x / 100) * nw,
      y: (crop.y / 100) * nh,
      w: (crop.width / 100) * nw,
      h: (crop.height / 100) * nh,
    };
    setCropOpen(false);
    setBusy("Cropping…");
    setNotice(null);
    try {
      const t = await transformImage(activeSide.rotated, { crop: rect, maxEdge: MAX_EDGE });
      track(t.url);
      updateSide(active, (s) => clampSide({ ...s, src: t.url, w: t.w, h: t.h }));
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Could not crop this image.");
    } finally {
      setBusy(null);
    }
  };

  /* ----- enhance ----- */
  const enhanced = brightness !== 100 || contrast !== 100;
  const toggleAutoFix = () => {
    if (enhanced) {
      setBrightness(100);
      setContrast(100);
    } else {
      setBrightness(115);
      setContrast(125);
    }
  };

  /* ----- export (called by the page on "Review") ----- */
  useImperativeHandle(
    ref,
    () => ({
      async prepare(): Promise<PrepareResult> {
        if (!front) throw new Error("Your photo is not ready yet.");
        const sides = [front, back].filter(Boolean) as Side[];
        const jpeg = await composeA4(
          sides.map((s) => ({ src: s.src, xMm: s.x, yMm: s.y, wMm: s.mm, hMm: heightMm(s) })),
          { brightness, contrast, grayscale: colorMode === "B&W", cutBorder }
        );
        const pdfBytes = await jpegToA4Pdf(jpeg);
        const file = new File([new Uint8Array(pdfBytes)], `id-print-${Date.now()}.pdf`, {
          type: "application/pdf",
        });
        return {
          files: [file],
          pagesPerFile: ["All"],
          items: [
            {
              name: back ? "ID card: front + back" : "ID card / photo",
              detail: "1 A4 sheet, ready to print",
            },
          ],
          previewUrl: URL.createObjectURL(jpeg),
        };
      },
    }),
    [front, back, brightness, contrast, colorMode, cutBorder]
  );

  /* ----- derived UI data ----- */
  const filterStyle: CSSProperties = {
    filter: `brightness(${brightness}%) contrast(${contrast}%)${colorMode === "B&W" ? " grayscale(100%)" : ""}`,
  };

  const warnings: string[] = [];
  if (front && back && overlaps(front, back)) warnings.push("Front and back are overlapping. Tap “Auto arrange”.");
  (["front", "back"] as SideKey[]).forEach((k) => {
    const s = sideOf(k);
    if (s && effectiveDpi(s) < 150) {
      warnings.push(`${k === "front" ? "Front" : "Back"} photo is low quality at this size. Print may look blurry.`);
    }
  });

  const maxWidth = activeSide
    ? Math.floor(Math.min(A4_W - 2 * MARGIN, (A4_H - 2 * MARGIN) * (activeSide.w / activeSide.h)))
    : 200;

  /* ----- one draggable box on the paper ----- */
  const renderBox = (key: SideKey, s: Side) => {
    const isActive = active === key;
    return (
      <Rnd
        key={key}
        size={{ width: s.mm * scale, height: heightMm(s) * scale }}
        position={{ x: s.x * scale, y: s.y * scale }}
        lockAspectRatio
        bounds="parent"
        minWidth={MIN_MM * scale}
        enableResizing={{
          bottomRight: true,
          top: false,
          right: false,
          bottom: false,
          left: false,
          topRight: false,
          topLeft: false,
          bottomLeft: false,
        }}
        resizeHandleComponent={{
          bottomRight: (
            <div className="absolute -right-2 -bottom-2 w-5 h-5 rounded-full bg-blue-600 border-2 border-white shadow" />
          ),
        }}
        onDragStart={() => setActive(key)}
        onResizeStart={() => setActive(key)}
        onDragStop={(_e, d) => updateSide(key, (cur) => clampSide({ ...cur, x: d.x / scale, y: d.y / scale }))}
        onResizeStop={(_e, _dir, el, _delta, pos) =>
          updateSide(key, (cur) =>
            clampSide({ ...cur, mm: el.offsetWidth / scale, x: pos.x / scale, y: pos.y / scale })
          )
        }
        style={{ touchAction: "none", zIndex: isActive ? 20 : 10 }}
        className={`cursor-move bg-white ${
          isActive ? "border-2 border-blue-600" : "border border-dashed border-blue-300"
        }`}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={s.src}
          alt={key === "front" ? "Front side" : "Back side"}
          draggable={false}
          style={filterStyle}
          className="w-full h-full block select-none pointer-events-none"
        />
        <span className="absolute -top-2 left-1 text-[9px] font-bold bg-blue-600 text-white px-1.5 rounded pointer-events-none">
          {key === "front" ? "Front" : "Back"}
        </span>
      </Rnd>
    );
  };

  /* ---------------- render ---------------- */
  return (
    <div className="animate-in fade-in duration-300">
      <SectionTitle icon={<Settings className="w-5 h-5" />}>Arrange on A4 sheet</SectionTitle>

      <input type="file" accept="image/jpeg,image/png,image/webp" className="hidden" ref={backInputRef} onChange={handleBackPick} />

      {notice && (
        <div className="mb-4">
          <Banner tone="error">{notice}</Banner>
        </div>
      )}

      {/* Front / Back selector */}
      <div className="mb-3">
        <Segmented<SideKey>
          value={active}
          onChange={(v) => {
            if (v === "back" && !back) {
              backInputRef.current?.click();
              return;
            }
            setActive(v);
          }}
          options={[
            { value: "front", label: "Front side" },
            {
              value: "back",
              label: back ? (
                "Back side"
              ) : (
                <>
                  <PlusCircle className="w-4 h-4 mr-1" /> Add back side
                </>
              ),
            },
          ]}
        />
      </div>

      {/* Paper */}
      <div ref={wrapRef} className="mb-3 flex justify-center">
        <div className="bg-gray-200 p-2 rounded-xl border border-gray-300">
          <div
            className="bg-white shadow-md relative overflow-hidden"
            style={{ width: paperW, height: A4_H * scale }}
          >
            {/* printable-area guide */}
            <div
              className="absolute border border-dashed border-gray-200 pointer-events-none"
              style={{ inset: MARGIN * scale }}
            />
            {loading && (
              <div className="absolute inset-0 flex items-center justify-center text-sm text-gray-400">
                <Loader2 className="w-5 h-5 mr-2 animate-spin" /> Opening photo…
              </div>
            )}
            {front && renderBox("front", front)}
            {back && renderBox("back", back)}
            <span className="absolute bottom-1 right-2 text-[9px] text-gray-400 font-bold select-none pointer-events-none">
              A4
            </span>
            {busy && (
              <div className="absolute inset-0 z-30 bg-white/70 flex items-center justify-center text-sm font-semibold text-blue-700">
                <Loader2 className="w-5 h-5 mr-2 animate-spin" /> {busy}
              </div>
            )}
          </div>
        </div>
      </div>
      <p className="text-xs text-gray-500 text-center mb-4">Drag to move. Pull the blue dot to resize.</p>

      {/* Tools for the selected side */}
      {activeSide && (
        <div className="bg-gray-50 border border-gray-200 rounded-2xl p-4 mb-5">
          <div className="grid grid-cols-3 gap-2 mb-4">
            <button type="button" onClick={openCrop} disabled={!!busy} className="py-2.5 rounded-xl border border-gray-200 bg-white text-sm font-semibold text-gray-700 hover:bg-gray-50 flex flex-col items-center active:scale-95 disabled:opacity-50">
              <CropIcon className="w-4 h-4 mb-1 text-blue-600" /> Crop
            </button>
            <button type="button" onClick={rotate} disabled={!!busy} className="py-2.5 rounded-xl border border-gray-200 bg-white text-sm font-semibold text-gray-700 hover:bg-gray-50 flex flex-col items-center active:scale-95 disabled:opacity-50">
              <RotateCw className="w-4 h-4 mb-1 text-blue-600" /> Rotate
            </button>
            {active === "back" ? (
              <button type="button" onClick={removeBack} className="py-2.5 rounded-xl border border-gray-200 bg-white text-sm font-semibold text-red-600 hover:bg-red-50 flex flex-col items-center active:scale-95">
                <Trash2 className="w-4 h-4 mb-1" /> Remove
              </button>
            ) : (
              <button type="button" onClick={autoArrange} className="py-2.5 rounded-xl border border-gray-200 bg-white text-sm font-semibold text-gray-700 hover:bg-gray-50 flex flex-col items-center active:scale-95">
                <span className="text-blue-600 text-base leading-4 mb-1">⇅</span> Auto arrange
              </button>
            )}
          </div>

          <FieldLabel>
            Size on paper: {Math.round(activeSide.mm)} mm wide
          </FieldLabel>
          <input
            type="range"
            min={Math.min(MIN_MM, maxWidth)}
            max={maxWidth}
            value={Math.round(activeSide.mm)}
            onChange={(e) => setWidth(Number(e.target.value))}
            className="w-full h-1.5 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-600 mb-3"
          />
          <div className="flex flex-wrap gap-2 items-center">
            {[
              { label: "Card size", mm: 85.6 },
              { label: "Medium", mm: 120 },
              { label: "Large", mm: 170 },
            ].map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => setWidth(p.mm)}
                className="px-3 py-1.5 rounded-full text-xs font-semibold border border-gray-200 bg-white text-gray-600 hover:bg-blue-50 hover:border-blue-300 active:scale-95"
              >
                {p.label}
              </button>
            ))}
            {back && (
              <button type="button" onClick={matchSize} className="px-3 py-1.5 rounded-full text-xs font-semibold text-blue-700 hover:underline">
                Same size for both
              </button>
            )}
            {isCropped && (
              <button type="button" onClick={resetCrop} className="px-3 py-1.5 rounded-full text-xs font-semibold text-red-500 hover:underline">
                Undo crop
              </button>
            )}
          </div>
          <p className="text-[11px] text-gray-400 mt-2">Tip: crop to the card edges first, then tap “Card size” for the real 85.6 mm width.</p>
        </div>
      )}

      {warnings.length > 0 && (
        <div className="space-y-2 mb-5">
          {warnings.map((w) => (
            <Banner key={w} tone="warn">
              {w}
            </Banner>
          ))}
        </div>
      )}

      {/* Enhancer (applies to both sides) */}
      <div className="bg-blue-50/50 border border-blue-100 rounded-2xl p-4 mb-5">
        <div className="flex justify-between items-center mb-4">
          <span className="text-sm font-semibold text-gray-800 flex items-center">
            <Wand2 className="w-4 h-4 mr-1.5 text-blue-600" /> Make it clearer
          </span>
          <button type="button" onClick={toggleAutoFix} className="text-xs bg-blue-600 text-white px-3 py-1.5 rounded-full font-semibold shadow-sm hover:bg-blue-700 active:scale-95 flex items-center">
            <Wand2 className="w-3 h-3 mr-1" /> {enhanced ? "Reset" : "Auto fix"}
          </button>
        </div>
        <div className="space-y-3">
          <div>
            <div className="flex justify-between text-xs text-gray-600 font-medium mb-1">
              <span>Brightness</span>
              <span>{brightness}%</span>
            </div>
            <input type="range" min={50} max={150} value={brightness} onChange={(e) => setBrightness(Number(e.target.value))} className="w-full h-1.5 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-600" />
          </div>
          <div>
            <div className="flex justify-between text-xs text-gray-600 font-medium mb-1">
              <span>Contrast</span>
              <span>{contrast}%</span>
            </div>
            <input type="range" min={50} max={150} value={contrast} onChange={(e) => setContrast(Number(e.target.value))} className="w-full h-1.5 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-600" />
          </div>
        </div>
      </div>

      <label className="flex items-center text-sm font-medium text-gray-700 mb-5 cursor-pointer">
        <input type="checkbox" checked={cutBorder} onChange={(e) => setCutBorder(e.target.checked)} className="w-4 h-4 mr-2 accent-blue-600" />
        Print a thin cutting line around each card
      </label>

      <CommonPrintOptions colorMode={colorMode} copies={copies} onColorMode={setColorMode} onCopies={setCopies} />

      {/* Crop modal */}
      {cropOpen && activeSide && (
        <div className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl w-full max-w-md overflow-hidden flex flex-col max-h-[92vh] shadow-2xl">
            <div className="p-4 border-b flex justify-between items-center bg-gray-50">
              <h4 className="font-bold text-gray-800 flex items-center">
                <CropIcon className="w-5 h-5 mr-2 text-blue-600" /> Crop {active === "front" ? "front" : "back"} side
              </h4>
              <button type="button" aria-label="Close" onClick={() => setCropOpen(false)} className="text-gray-500 hover:bg-gray-200 w-9 h-9 rounded-full flex items-center justify-center">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="px-4 pt-3">
              <Segmented<"free" | "card">
                value={cropMode}
                onChange={(m) => {
                  setCropMode(m);
                  if (imgRef.current) setInitialCrop(imgRef.current, m);
                }}
                options={[
                  { value: "free", label: "Free" },
                  { value: "card", label: "Card shape" },
                ]}
              />
            </div>

            <div className="p-4 bg-gray-900 flex-1 overflow-auto flex items-center justify-center mt-3">
              <ReactCrop crop={crop} onChange={(_px, pct) => setCrop(pct)} aspect={cropMode === "card" ? CARD_ASPECT : undefined} keepSelection>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  ref={imgRef}
                  src={activeSide.rotated}
                  alt="Crop"
                  onLoad={(e) => setInitialCrop(e.currentTarget, cropMode)}
                  className="max-h-[50vh] w-auto block"
                />
              </ReactCrop>
            </div>

            <div className="p-4 border-t bg-white flex space-x-3">
              <button type="button" onClick={() => setCropOpen(false)} className="flex-1 py-3 border border-gray-300 rounded-xl font-semibold text-gray-700 hover:bg-gray-50 active:scale-95">
                Cancel
              </button>
              <button type="button" onClick={applyCrop} className="flex-1 py-3 bg-blue-600 rounded-xl font-semibold text-white hover:bg-blue-700 flex items-center justify-center shadow-md active:scale-95">
                <Check className="w-4 h-4 mr-1" /> Apply crop
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
});

export default ImageSettings;