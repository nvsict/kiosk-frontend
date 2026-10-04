"use client";

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
import { Check, Crop as CropIcon, Edit2, Loader2, Plus, RotateCw, Settings, Trash2, Wand2, X } from "lucide-react";
import { CommonPrintOptions, Banner, SectionTitle } from "./PrintControls";
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
const MARGIN = 5; 
const MIN_MM = 25;
const DEFAULT_MM = 85.6; // ID Card size default
const GAP = 12;

// REDUCED MAX_EDGE for much faster processing on mobile phones (1500px is plenty for ID cards at 300 DPI)
const MAX_EDGE = 1500; 
const CARD_ASPECT = 85.6 / 54;

type SideKey = "front" | "back";

interface Side {
  name: string;
  base: string; 
  rot: number;
  rotated: string; 
  rw: number;
  rh: number;
  src: string; 
  w: number;
  h: number;
  x: number; 
  y: number; 
  mm: number; 
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

const effectiveDpi = (s: Side) => s.w / (s.mm / 25.4);

/* ---------------- component ---------------- */
interface ImageSettingsProps {
  frontFile: File;
  backFile?: File | null;
  onUpdate: (data: PrintSettingsUpdate) => void;
  pricing?: { bw: number; color: number };
}

const ImageSettings = forwardRef<PrintSettingsHandle, ImageSettingsProps>(function ImageSettings(
  { frontFile, backFile = null, onUpdate, pricing },
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
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Size preset state
  const [sizePreset, setSizePreset] = useState<"id" | "half" | "custom">("id");

  // paper preview size (responsive)
  const wrapRef = useRef<HTMLDivElement>(null);
  const [paperW, setPaperW] = useState(280);
  const scale = paperW / A4_W; // px per mm

  // Combined Crop/Rotate modal state
  const [editTarget, setEditTarget] = useState<SideKey | null>(null);
  const [modalRot, setModalRot] = useState(0);
  const [modalRotatedSrc, setModalRotatedSrc] = useState<string>("");
  const [modalCrop, setModalCrop] = useState<Crop | undefined>(undefined);
  const [modalMode, setModalMode] = useState<"free" | "card">("card");
  const imgRef = useRef<HTMLImageElement>(null);

  const backInputRef = useRef<HTMLInputElement>(null);
  const urls = useRef<Set<string>>(new Set());
  const track = (u: string) => { urls.current.add(u); return u; };

  /* ----- resize observer ----- */
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

  /* ----- free blob URLs ----- */
  useEffect(() => {
    const set = urls.current;
    return () => set.forEach((u) => URL.revokeObjectURL(u));
  }, []);

  /* ----- loaders ----- */
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
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sideOf = (k: SideKey | null) => (k === "front" ? front : k === "back" ? back : null);
  const updateSide = (k: SideKey, fn: (s: Side) => Side) => (k === "front" ? setFront : setBack)((s) => (s ? fn(s) : s));

  /* ----- report state ----- */
  const isValid = !!front && !loading && !busy;
  useEffect(() => {
    const rate = colorMode === "Color" ? (pricing?.color ?? 10.0) : (pricing?.bw ?? 2.0);
    
    onUpdate({
      copies,
      colorMode,
      isDuplex: false,
      totalPages: 1,
      totalAmount: 1 * copies * rate,
      isValid,
    });
  }, [copies, colorMode, isValid, onUpdate, pricing]);

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
      s.mm = front.mm; 
      // Ensure the back side spawns safely below the front side
      let newY = front.y + heightMm(front) + GAP;
      if (newY + heightMm(s) > A4_H - MARGIN) {
          newY = MARGIN; // If it goes off the bottom, spawn at the top
      }
      setBack(place(s, newY));
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Could not open this image.");
    } finally {
      setBusy(null);
    }
  };

  const removeBack = () => setBack(null);

  const applyGlobalSize = (mm: number, preset: "id" | "half" | "custom") => {
    setSizePreset(preset);
    if (front) setFront((s) => (s ? clampSide({ ...s, mm }) : s));
    if (back) setBack((s) => (s ? clampSide({ ...s, mm }) : s));
  };

  /* ----- Edit Modal ----- */
  const openEditModal = (key: SideKey) => {
    const s = sideOf(key);
    if (!s) return;
    setEditTarget(key);
    setModalRot(s.rot);
    setModalRotatedSrc(s.rotated);
    setModalCrop(undefined);
    setModalMode("card");
  };

  const handleModalRotate = async () => {
    const s = sideOf(editTarget);
    if (!s) return;
    setBusy("Rotating…");
    try {
      const newRot = (modalRot + 90) % 360;
      const t = await transformImage(s.base, { rotate: newRot, maxEdge: MAX_EDGE });
      track(t.url);
      setModalRot(newRot);
      setModalRotatedSrc(t.url);
      setModalCrop(undefined);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Could not rotate this image.");
    } finally {
      setBusy(null);
    }
  };

  const setInitialCrop = (img: HTMLImageElement, mode: "free" | "card") => {
    const { width, height } = img;
    if (mode === "card") {
      setModalCrop(centerCrop(makeAspectCrop({ unit: "%", width: 90 }, CARD_ASPECT, width, height), width, height));
    } else {
      setModalCrop({ unit: "%", x: 5, y: 5, width: 90, height: 90 });
    }
  };

  const saveEdit = async () => {
    if (!editTarget || !imgRef.current) {
      setEditTarget(null);
      return;
    }
    const s = sideOf(editTarget);
    const img = imgRef.current;
    
    if (!s || !modalCrop || modalCrop.width < 2 || modalCrop.height < 2) {
      updateSide(editTarget, (cur) => clampSide({ ...cur, rot: modalRot, rotated: modalRotatedSrc, src: modalRotatedSrc, w: img.naturalWidth, h: img.naturalHeight, rw: img.naturalWidth, rh: img.naturalHeight }));
      setEditTarget(null);
      return;
    }

    const nw = img.naturalWidth;
    const nh = img.naturalHeight;
    const rect = {
      x: (modalCrop.x / 100) * nw,
      y: (modalCrop.y / 100) * nh,
      w: (modalCrop.width / 100) * nw,
      h: (modalCrop.height / 100) * nh,
    };
    
    setEditTarget(null);
    setBusy("Applying changes…");
    try {
      const t = await transformImage(modalRotatedSrc, { crop: rect, maxEdge: MAX_EDGE });
      track(t.url);
      updateSide(editTarget, (cur) => clampSide({ ...cur, rot: modalRot, rotated: modalRotatedSrc, rw: nw, rh: nh, src: t.url, w: t.w, h: t.h }));
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Could not crop this image.");
    } finally {
      setBusy(null);
    }
  };

  const toggleAutoFix = () => {
    if (brightness !== 100 || contrast !== 100) {
      setBrightness(100); setContrast(100);
    } else {
      setBrightness(115); setContrast(125);
    }
  };

  /* ----- export ----- */
  useImperativeHandle(ref, () => ({
    async prepare(): Promise<PrepareResult> {
      if (!front) throw new Error("Your photo is not ready yet.");
      const sides = [front, back].filter(Boolean) as Side[];
      const jpeg = await composeA4(
        sides.map((s) => ({ src: s.src, xMm: s.x, yMm: s.y, wMm: s.mm, hMm: heightMm(s) })),
        { brightness, contrast, grayscale: colorMode === "B&W", cutBorder }
      );
      const pdfBytes = await jpegToA4Pdf(jpeg);
      const file = new File([new Uint8Array(pdfBytes)], `id-print-${Date.now()}.pdf`, { type: "application/pdf" });
      return {
        files: [file],
        pagesPerFile: ["All"],
        items: [{ name: back ? "ID card: front + back" : "ID card / photo", detail: "1 A4 sheet, ready to print" }],
        previewUrl: URL.createObjectURL(jpeg),
      };
    }
  }), [front, back, brightness, contrast, colorMode, cutBorder]);

  const filterStyle: CSSProperties = {
    filter: `brightness(${brightness}%) contrast(${contrast}%)${colorMode === "B&W" ? " grayscale(100%)" : ""}`,
  };

  const warnings: string[] = [];
  (["front", "back"] as SideKey[]).forEach((k) => {
    const s = sideOf(k);
    if (s && effectiveDpi(s) < 150) warnings.push(`${k === "front" ? "Front" : "Back"} photo is low quality at this size. Print may look blurry.`);
  });

  const maxWidth = front ? Math.floor(Math.min(A4_W - 2 * MARGIN, (A4_H - 2 * MARGIN) * (front.w / front.h))) : 200;

  /* ----- render draggable box ----- */
  const renderBox = (key: SideKey, s: Side) => {
    return (
      <Rnd
        key={key}
        size={{ width: s.mm * scale, height: heightMm(s) * scale }}
        position={{ x: s.x * scale, y: s.y * scale }}
        lockAspectRatio
        bounds="parent"
        minWidth={MIN_MM * scale}
        enableResizing={{ bottomRight: true, top: false, right: false, bottom: false, left: false, topRight: false, topLeft: false, bottomLeft: false }}
        resizeHandleComponent={{ bottomRight: (<div className="absolute -right-3 -bottom-3 w-8 h-8 rounded-full bg-blue-600 border-2 border-white shadow-md flex items-center justify-center opacity-90 hover:opacity-100 z-20"><div className="w-2.5 h-2.5 bg-white rounded-full pointer-events-none"/></div>) }}
        onDragStop={(_e, d) => updateSide(key, (cur) => clampSide({ ...cur, x: d.x / scale, y: d.y / scale }))}
        onResizeStop={(_e, _dir, el, _delta, pos) => {
          updateSide(key, (cur) => clampSide({ ...cur, mm: el.offsetWidth / scale, x: pos.x / scale, y: pos.y / scale }));
          setSizePreset("custom"); 
        }}
        // STOP propagation on drag handle so buttons work
        dragHandleClassName="drag-handle"
        style={{ touchAction: "none" }}
        className="group absolute bg-white border-2 border-dashed border-gray-400 focus-within:border-blue-500 hover:border-blue-500 shadow-md hover:shadow-lg transition-shadow duration-200 z-10"
      >
        {/* The draggable area */}
        <div className="drag-handle w-full h-full cursor-move">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={s.src} alt={`${key} side`} draggable={false} style={filterStyle} className="w-full h-full block select-none pointer-events-none" />
        </div>
        
        <span className="absolute -top-3 -left-2 text-[10px] font-bold bg-white text-gray-700 px-2 py-0.5 rounded-full shadow-sm border border-gray-200 pointer-events-none z-10">
          {key === "front" ? "Front" : "Back"}
        </span>

        {/* Floating Contextual Toolbar - Made always visible on mobile, no pointer-events hijacking */}
        <div 
          className="absolute -top-4 -right-4 flex space-x-2 z-30"
          onMouseDown={(e) => e.stopPropagation()} 
          onTouchStart={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button 
            type="button" 
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); openEditModal(key); }} 
            className="w-10 h-10 bg-blue-600 text-white rounded-full shadow-lg flex items-center justify-center hover:bg-blue-700 active:scale-90 transition-transform cursor-pointer"
          >
            <Edit2 className="w-5 h-5" />
          </button>
          {key === "back" && (
            <button 
                type="button" 
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); removeBack(); }} 
                className="w-10 h-10 bg-red-500 text-white rounded-full shadow-lg flex items-center justify-center hover:bg-red-600 active:scale-90 transition-transform cursor-pointer"
            >
              <Trash2 className="w-5 h-5" />
            </button>
          )}
        </div>
      </Rnd>
    );
  };

  return (
    <div className="animate-in fade-in duration-300">
      <SectionTitle icon={<Settings className="w-5 h-5" />}>Adjust & Arrange</SectionTitle>

      <input type="file" accept="image/jpeg,image/png,image/webp" className="hidden" ref={backInputRef} onChange={handleBackPick} />

      {notice && <div className="mb-4"><Banner tone="error">{notice}</Banner></div>}
      {warnings.map((w) => <div className="mb-2" key={w}><Banner tone="warn">{w}</Banner></div>)}

      {/* A4 Paper Canvas */}
      <div ref={wrapRef} className="mb-4 flex justify-center">
        <div className="bg-gray-100 p-3 rounded-2xl ring-1 ring-gray-200 shadow-inner">
          <div className="bg-white shadow-sm relative overflow-hidden ring-1 ring-gray-200" style={{ width: paperW, height: A4_H * scale }}>
            
            <div className="absolute border border-dashed border-gray-200 pointer-events-none" style={{ inset: MARGIN * scale }} />
            
            {loading && (
              <div className="absolute inset-0 flex items-center justify-center text-sm font-medium text-gray-500 z-50 bg-white/50">
                <Loader2 className="w-5 h-5 mr-2 animate-spin text-blue-500" /> Processing…
              </div>
            )}
            
            {!loading && front && renderBox("front", front)}
            {!loading && back && renderBox("back", back)}

            {/* Inline Add Back Side Box */}
            {front && !back && !loading && (
              <div 
                onClick={() => backInputRef.current?.click()}
                className="absolute border-2 border-dashed border-gray-300 bg-gray-50/50 hover:bg-blue-50 hover:border-blue-400 rounded-lg flex flex-col items-center justify-center cursor-pointer transition-colors z-0"
                style={{ 
                  width: front.mm * scale, 
                  height: heightMm(front) * scale,
                  left: front.x * scale, 
                  top: Math.min((front.y + heightMm(front) + GAP) * scale, (A4_H - MARGIN - heightMm(front)) * scale) 
                }}
              >
                <Plus className="w-6 h-6 text-gray-400 mb-1 pointer-events-none" />
                <span className="text-[10px] font-bold text-gray-500 uppercase pointer-events-none">Add Back</span>
              </div>
            )}

            <span className="absolute bottom-1 right-2 text-[9px] text-gray-300 font-bold select-none pointer-events-none tracking-widest z-0">A4</span>
            
            {busy && (
              <div className="absolute inset-0 z-40 bg-white/80 backdrop-blur-sm flex items-center justify-center text-sm font-bold text-blue-600">
                <Loader2 className="w-5 h-5 mr-2 animate-spin" /> {busy}
              </div>
            )}
          </div>
        </div>
      </div>
      
      <p className="text-[11px] font-medium text-gray-400 text-center mb-6">Tip: Tap <Edit2 className="w-3 h-3 inline mx-0.5 text-blue-500"/> on the image to crop. Drag to move.</p>

      {/* Dead-Simple Size Controls */}
      {front && (
        <div className="bg-white ring-1 ring-gray-200 rounded-2xl p-4 mb-6 shadow-sm">
          <p className="text-xs font-bold text-gray-800 uppercase tracking-wide mb-3 text-center">Document Size</p>
          <div className="flex bg-gray-100 p-1 rounded-xl">
            <button 
              onClick={() => applyGlobalSize(85.6, "id")}
              className={`flex-1 py-2 text-sm font-semibold rounded-lg transition-all ${sizePreset === "id" ? "bg-white shadow-sm text-blue-600 ring-1 ring-gray-200/50" : "text-gray-500 hover:text-gray-700"}`}
            >
              ID Card
            </button>
            <button 
              onClick={() => applyGlobalSize(120, "half")}
              className={`flex-1 py-2 text-sm font-semibold rounded-lg transition-all ${sizePreset === "half" ? "bg-white shadow-sm text-blue-600 ring-1 ring-gray-200/50" : "text-gray-500 hover:text-gray-700"}`}
            >
              Half Page
            </button>
            <button 
              onClick={() => setSizePreset("custom")}
              className={`flex-1 py-2 text-sm font-semibold rounded-lg transition-all ${sizePreset === "custom" ? "bg-white shadow-sm text-blue-600 ring-1 ring-gray-200/50" : "text-gray-500 hover:text-gray-700"}`}
            >
              Custom
            </button>
          </div>
          
          {sizePreset === "custom" && (
            <div className="mt-4 px-2 animate-in fade-in slide-in-from-top-2">
              <div className="flex justify-between text-xs text-gray-500 font-medium mb-2">
                <span>Small</span>
                <span className="text-blue-600 font-bold">{Math.round(front.mm)} mm</span>
                <span>Large</span>
              </div>
              <input type="range" min={Math.min(MIN_MM, maxWidth)} max={maxWidth} value={Math.round(front.mm)} onChange={(e) => applyGlobalSize(Number(e.target.value), "custom")} className="w-full h-1.5 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-600" />
            </div>
          )}
        </div>
      )}

      {/* Enhancer */}
      <div className="bg-gradient-to-r from-blue-50 to-indigo-50 ring-1 ring-blue-100/50 rounded-2xl p-5 mb-6">
        <div className="flex justify-between items-center mb-4">
          <span className="text-sm font-bold text-blue-900 flex items-center">
            <Wand2 className="w-4 h-4 mr-2 text-blue-600" /> Improve Quality
          </span>
          <button type="button" onClick={toggleAutoFix} className="text-[11px] uppercase tracking-wider bg-white text-blue-700 px-3 py-1.5 rounded-full font-bold shadow-sm ring-1 ring-blue-200 hover:bg-blue-600 hover:text-white transition-colors active:scale-95 flex items-center">
            {brightness !== 100 ? "Reset" : "Auto Fix"}
          </button>
        </div>
        {(brightness !== 100 || contrast !== 100) && (
          <div className="space-y-3 pt-1">
            <div className="flex items-center gap-3">
              <span className="text-[10px] font-bold text-gray-500 uppercase w-16">Bright</span>
              <input type="range" min={50} max={150} value={brightness} onChange={(e) => setBrightness(Number(e.target.value))} className="flex-1 h-1.5 bg-blue-200/50 rounded-lg appearance-none cursor-pointer accent-blue-600" />
            </div>
            <div className="flex items-center gap-3">
              <span className="text-[10px] font-bold text-gray-500 uppercase w-16">Contrast</span>
              <input type="range" min={50} max={150} value={contrast} onChange={(e) => setContrast(Number(e.target.value))} className="flex-1 h-1.5 bg-blue-200/50 rounded-lg appearance-none cursor-pointer accent-blue-600" />
            </div>
          </div>
        )}
      </div>

      <label className="flex items-center justify-center text-sm font-medium text-gray-600 mb-6 cursor-pointer bg-white py-3 rounded-xl ring-1 ring-gray-200 shadow-sm">
        <input type="checkbox" checked={cutBorder} onChange={(e) => setCutBorder(e.target.checked)} className="w-4 h-4 mr-3 accent-blue-600 rounded" />
        Print thin cutting border around card
      </label>

      <CommonPrintOptions 
        colorMode={colorMode} 
        copies={copies} 
        onColorMode={setColorMode} 
        onCopies={setCopies} 
        pricing={pricing}
      />

      {/* EDIT MODAL (Crop & Rotate combined) */}
      {editTarget && (
        <div className="fixed inset-0 bg-black/90 z-50 flex items-center justify-center p-4 backdrop-blur-sm">
          <div className="bg-white rounded-[2rem] w-full max-w-md overflow-hidden flex flex-col max-h-[90vh] shadow-2xl">
            
            <div className="p-4 border-b border-gray-100 flex justify-between items-center bg-white">
              <h4 className="font-bold text-gray-900 flex items-center tracking-tight">
                <CropIcon className="w-5 h-5 mr-2 text-blue-600" /> Edit Photo
              </h4>
              <button type="button" onClick={() => setEditTarget(null)} className="text-gray-400 hover:bg-gray-100 w-8 h-8 rounded-full flex items-center justify-center transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="px-5 pt-4 bg-gray-50 border-b border-gray-100 flex justify-between items-center pb-4">
              <div className="flex bg-gray-200/80 p-1 rounded-lg w-48">
                <button 
                  onClick={() => { setModalMode("card"); if(imgRef.current) setInitialCrop(imgRef.current, "card"); }} 
                  className={`flex-1 py-1.5 text-xs font-bold rounded-md transition-all ${modalMode === "card" ? "bg-white shadow-sm text-gray-800" : "text-gray-500"}`}
                >
                  Card shape
                </button>
                <button 
                  onClick={() => { setModalMode("free"); if(imgRef.current) setInitialCrop(imgRef.current, "free"); }} 
                  className={`flex-1 py-1.5 text-xs font-bold rounded-md transition-all ${modalMode === "free" ? "bg-white shadow-sm text-gray-800" : "text-gray-500"}`}
                >
                  Free draw
                </button>
              </div>
              <button type="button" onClick={handleModalRotate} className="flex items-center text-sm font-bold text-blue-600 bg-blue-50 px-3 py-1.5 rounded-lg active:scale-95 transition-transform">
                <RotateCw className="w-4 h-4 mr-1.5" /> Rotate
              </button>
            </div>

            <div className="p-4 bg-gray-900 flex-1 overflow-auto flex items-center justify-center relative min-h-[300px]">
              <ReactCrop crop={modalCrop} onChange={(_px, pct) => setModalCrop(pct)} aspect={modalMode === "card" ? CARD_ASPECT : undefined} keepSelection>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  ref={imgRef}
                  src={modalRotatedSrc}
                  alt="Crop"
                  onLoad={(e) => setInitialCrop(e.currentTarget, modalMode)}
                  className="max-h-[50vh] w-auto block rounded-sm"
                />
              </ReactCrop>
              {busy && (
                <div className="absolute inset-0 bg-black/60 flex items-center justify-center text-white font-bold text-sm backdrop-blur-sm">
                  <Loader2 className="w-5 h-5 mr-2 animate-spin" /> {busy}
                </div>
              )}
            </div>

            <div className="p-4 bg-white flex space-x-3">
              <button type="button" onClick={() => setEditTarget(null)} className="flex-1 py-3.5 bg-gray-100 rounded-xl font-bold text-gray-700 hover:bg-gray-200 active:scale-95 transition-all">
                Cancel
              </button>
              <button type="button" onClick={saveEdit} className="flex-1 py-3.5 bg-blue-600 rounded-xl font-bold text-white hover:bg-blue-700 shadow-md active:scale-95 transition-all flex items-center justify-center">
                <Check className="w-5 h-5 mr-1.5" /> Save
              </button>
            </div>
            
          </div>
        </div>
      )}
    </div>
  );
});

export default ImageSettings;