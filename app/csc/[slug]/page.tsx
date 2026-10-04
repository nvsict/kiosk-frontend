"use client";

import { use, useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, CheckCircle, ChevronRight, CreditCard, FileText, Loader2, Printer } from "lucide-react";
import ImageSettings from "../../../components/ImageSettings";
import FullPageSettings from "../../../components/FullPageSettings";
import { Banner } from "../../../components/PrintControls";
import {
  detectKind,
  formatFileSize,
  MAX_DOC_FILES,
  MAX_FILE_MB,
  MAX_ID_FILES,
  type PickedFile,
  type PrepareResult,
  type PrintSettingsHandle,
  type PrintSettingsUpdate,
} from "../../../utils/printLogic";

// On a customer's phone "localhost" is the phone itself. Set NEXT_PUBLIC_API_URL
// (e.g. https://api.yourdomain.com or http://192.168.1.10:8000) in .env.local for real use.
const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
const UPLOAD_URL = `${API_BASE}/api/orders/upload`;

type DocType = "IDCard" | "FullDocument";
type Status = "idle" | "preparing" | "uploading";

const STEP_LABELS = ["Choose", "Settings", "Review", "Done"];

const INITIAL_PRINT: PrintSettingsUpdate = {
  copies: 1,
  colorMode: "B&W",
  isDuplex: false,
  totalPages: 0,
  totalAmount: 0,
  isValid: false,
};

/** Upload with real progress (fetch cannot report upload progress). */
function uploadOrder(
  body: FormData,
  onProgress: (pct: number) => void
): Promise<{ order_id?: string; payment_amount?: number }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", UPLOAD_URL);
    xhr.timeout = 120_000;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText));
        } catch {
          reject(new Error("Unexpected reply from the print server."));
        }
        return;
      }
      let message = `Print server error (${xhr.status}). Please try again.`;
      try {
        const j = JSON.parse(xhr.responseText);
        if (typeof j.detail === "string") message = j.detail;
      } catch {
        /* keep default */
      }
      reject(new Error(message));
    };
    xhr.onerror = () => reject(new Error("Cannot reach the print server. Check your internet and try again."));
    xhr.ontimeout = () => reject(new Error("Upload took too long. Check your internet and try again."));
    xhr.send(body);
  });
}

export default function CSCPrintPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug: cscSlug } = use(params);

  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [docType, setDocType] = useState<DocType | null>(null);
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [status, setStatus] = useState<Status>("idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [prepared, setPrepared] = useState<PrepareResult | null>(null);
  const [print, setPrint] = useState<PrintSettingsUpdate>(INITIAL_PRINT);
  const [receipt, setReceipt] = useState<{ orderId: string; amount: number; copies: number } | null>(null);

  const settingsRef = useRef<PrintSettingsHandle>(null);
  const idCounter = useRef(0);
  const idInputRef = useRef<HTMLInputElement>(null);
  const docInputRef = useRef<HTMLInputElement>(null);
  const previewUrlRef = useRef<string | undefined>(undefined);

  // Stable callback: children call it inside effects.
  const handleSettingsUpdate = useCallback((d: PrintSettingsUpdate) => setPrint(d), []);

  /* ---------- helpers ---------- */
  const clearPrepared = useCallback(() => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    previewUrlRef.current = undefined;
    setPrepared(null);
  }, []);

  useEffect(
    () => () => {
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    },
    []
  );

  const resetAll = useCallback(() => {
    clearPrepared();
    setFiles([]);
    setDocType(null);
    setStep(1);
    setStatus("idle");
    setProgress(0);
    setError(null);
    setPrint(INITIAL_PRINT);
    setReceipt(null);
  }, [clearPrepared]);

  /* ---------- picking files ---------- */
  const handlePick = (kind: DocType) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const list = Array.from(e.target.files ?? []);
    e.target.value = ""; // lets the customer pick the same file again
    if (list.length === 0) return;

    const problems: string[] = [];
    const accepted: File[] = [];

    for (const f of list) {
      const k = detectKind(f);
      if (!k || (kind === "IDCard" && k !== "image")) {
        problems.push(`${f.name}: ${kind === "IDCard" ? "choose a JPG or PNG photo" : "only PDF, JPG or PNG files are allowed"}`);
      } else if (f.size > MAX_FILE_MB * 1024 * 1024) {
        problems.push(`${f.name}: larger than ${MAX_FILE_MB} MB (${formatFileSize(f.size)})`);
      } else if (f.size === 0) {
        problems.push(`${f.name}: the file is empty`);
      } else {
        accepted.push(f);
      }
    }

    const existing = kind === "IDCard" ? 0 : files.length;
    const limit: number = kind === "IDCard" ? MAX_ID_FILES : MAX_DOC_FILES;
    const room = limit - existing;
    if (accepted.length > room) {
      problems.push(`Only ${limit} file${limit === 1 ? "" : "s"} allowed. Extra files were skipped.`);
      accepted.length = Math.max(0, room);
    }

    setError(problems.length ? problems.join("\n") : null);
    if (accepted.length === 0) return;

    const wrapped: PickedFile[] = accepted.map((file) => ({ id: `f${++idCounter.current}`, file }));
    clearPrepared();
    setDocType(kind);
    setFiles((prev) => (kind === "IDCard" ? wrapped : [...prev, ...wrapped]));
    setStep(2);
  };

  const removeFile = (id: string) => {
    const next = files.filter((f) => f.id !== id);
    setFiles(next);
    if (next.length === 0) resetAll();
  };

  /* ---------- step transitions ---------- */
  const goToReview = async () => {
    if (!settingsRef.current || !print.isValid || status !== "idle") return;
    setError(null);
    setStatus("preparing");
    try {
      const result = await settingsRef.current.prepare();
      clearPrepared();
      previewUrlRef.current = result.previewUrl;
      setPrepared(result);
      setStep(3);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not prepare your document. Please try again.");
    } finally {
      setStatus("idle");
    }
  };

  const backToSettings = () => {
    if (status === "uploading") return;
    clearPrepared();
    setError(null);
    setStep(2);
  };

  const handleSubmit = async () => {
    if (!prepared || !docType || status !== "idle") return;
    setError(null);
    setStatus("uploading");
    setProgress(0);

    const fd = new FormData();
    fd.append("csc_slug", cscSlug);
    prepared.files.forEach((f) => fd.append("files", f, f.name));
    fd.append("print_mode", docType);
    fd.append("copies", String(print.copies));
    fd.append("color_mode", print.colorMode);
    fd.append("is_duplex", docType === "FullDocument" && print.isDuplex ? "True" : "False");
    fd.append("pages", prepared.pagesPerFile[0] ?? "All"); // kept for single-file backends
    fd.append("pages_per_file", JSON.stringify(prepared.pagesPerFile)); // one entry per file, same order

    try {
      const data = await uploadOrder(fd, setProgress);
      setReceipt({
        orderId: data.order_id ?? "—",
        amount: data.payment_amount ?? print.totalAmount,
        copies: print.copies,
      });
      clearPrepared();
      setFiles([]);
      setStep(4);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed. Please try again.");
    } finally {
      setStatus("idle");
    }
  };

  /* ---------- render ---------- */
  const showSettings = (step === 2 || step === 3) && docType && files.length > 0;
  const busy = status !== "idle";

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col items-center py-6 px-4 font-sans text-gray-800">
      {/* HEADER */}
      <div className="w-full max-w-md flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-blue-700 flex items-center">
            <Printer className="w-6 h-6 mr-2" /> SmartPrint
          </h1>
          <p className="text-xs text-gray-500 font-medium">KIOSK ID: {cscSlug.toUpperCase()}</p>
        </div>
        <div className="text-right">
          <div className="flex space-x-1 justify-end mb-1">
            {[1, 2, 3, 4].map((s) => (
              <div key={s} className={`w-3 h-3 rounded-full ${step >= s ? (s === 4 ? "bg-green-500" : "bg-blue-600") : "bg-gray-300"}`} />
            ))}
          </div>
          <p className="text-[11px] text-gray-500 font-medium">{STEP_LABELS[step - 1]}</p>
        </div>
      </div>

      {/* Hidden pickers: one per mode, clicked directly from the tap (works on iOS Safari) */}
      <input type="file" multiple accept="image/jpeg,image/png,image/webp" className="hidden" ref={idInputRef} onChange={handlePick("IDCard")} />
      <input type="file" multiple accept="application/pdf,image/jpeg,image/png,image/webp" className="hidden" ref={docInputRef} onChange={handlePick("FullDocument")} />

      <div className="bg-white w-full max-w-md rounded-3xl shadow-sm border border-gray-100 overflow-hidden">
        {error && step !== 4 && (
          <div className="px-6 pt-6">
            <Banner tone="error">
              <span className="whitespace-pre-line">{error}</span>
            </Banner>
          </div>
        )}

        {/* STEP 1: CHOOSE */}
        {step === 1 && (
          <div className="p-6 animate-in fade-in duration-300">
            <div className="text-center mb-6">
              <h2 className="text-xl font-bold text-gray-800">What do you want to print?</h2>
              <p className="text-sm text-gray-500 mt-1">क्या प्रिंट करना है?</p>
            </div>
            <div className="space-y-4">
              <button type="button" onClick={() => idInputRef.current?.click()} className="w-full text-left border-2 rounded-2xl p-4 flex items-center hover:border-blue-500 hover:bg-blue-50 active:scale-[0.98] transition-all">
                <CreditCard className="w-8 h-8 text-blue-600 mr-4 flex-shrink-0" />
                <div>
                  <h3 className="font-bold">ID card / photo</h3>
                  <p className="text-xs text-gray-500">Aadhaar, PAN, Voter ID. Front and back on one sheet.</p>
                  <p className="text-xs text-gray-400">आधार, पैन, फोटो</p>
                </div>
              </button>
              <button type="button" onClick={() => docInputRef.current?.click()} className="w-full text-left border-2 rounded-2xl p-4 flex items-center hover:border-blue-500 hover:bg-blue-50 active:scale-[0.98] transition-all">
                <FileText className="w-8 h-8 text-green-600 mr-4 flex-shrink-0" />
                <div>
                  <h3 className="font-bold">Full document</h3>
                  <p className="text-xs text-gray-500">PDFs, marksheets, forms. Choose which pages.</p>
                  <p className="text-xs text-gray-400">PDF, मार्कशीट, फॉर्म</p>
                </div>
              </button>
            </div>
            <p className="text-xs text-gray-400 text-center mt-6">Files up to {MAX_FILE_MB} MB. You pay the operator at the counter.</p>
          </div>
        )}

        {/* STEP 2 + 3 share one mounted settings screen, so edits are never lost when going back */}
        {showSettings && (
          <div className={step === 2 ? "p-6 animate-in slide-in-from-right-8 duration-300" : "hidden"}>
            <button type="button" onClick={resetAll} className="flex items-center text-sm text-gray-500 mb-5 hover:text-gray-800">
              <ArrowLeft className="w-4 h-4 mr-1" /> Start over
            </button>

            {docType === "IDCard" ? (
              <ImageSettings
                key={files[0].id}
                ref={settingsRef}
                frontFile={files[0].file}
                backFile={files[1]?.file ?? null}
                onUpdate={handleSettingsUpdate}
              />
            ) : (
              <FullPageSettings
                ref={settingsRef}
                files={files}
                onRemove={removeFile}
                onAddMore={() => docInputRef.current?.click()}
                onUpdate={handleSettingsUpdate}
              />
            )}

            <div className="mt-6">
              <div className="flex items-baseline justify-between mb-3 px-1">
                <span className="text-sm text-gray-500">Estimated total</span>
                <span className="text-2xl font-black text-gray-800">₹{print.totalAmount}</span>
              </div>
              <button
                type="button"
                onClick={goToReview}
                disabled={!print.isValid || busy}
                className="w-full py-4 rounded-2xl font-bold text-white shadow-lg transition-all flex items-center justify-center bg-blue-600 hover:bg-blue-700 active:scale-95 disabled:bg-blue-300 disabled:shadow-none disabled:active:scale-100"
              >
                {status === "preparing" ? (
                  <>
                    <Loader2 className="w-5 h-5 mr-2 animate-spin" /> Preparing your print…
                  </>
                ) : (
                  <>
                    Review <ChevronRight className="w-5 h-5 ml-1" />
                  </>
                )}
              </button>
            </div>
          </div>
        )}

        {/* STEP 3: REVIEW */}
        {step === 3 && prepared && docType && (
          <div className="p-6 animate-in slide-in-from-right-8 duration-300">
            <button type="button" onClick={backToSettings} disabled={busy} className="flex items-center text-sm text-gray-500 mb-5 hover:text-gray-800 disabled:opacity-50">
              <ArrowLeft className="w-4 h-4 mr-1" /> Edit settings
            </button>
            <h2 className="text-xl font-bold text-gray-800 mb-4">Review your print</h2>

            {prepared.previewUrl && (
              <div className="bg-gray-200 p-3 rounded-2xl border border-gray-300 mb-5 flex justify-center">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={prepared.previewUrl} alt="Final A4 sheet" className="bg-white shadow-md w-48 aspect-[210/297] object-contain" />
              </div>
            )}

            <div className="bg-gray-50 border border-gray-200 rounded-2xl p-4 mb-5 text-sm">
              {prepared.items.map((it, i) => (
                <div key={i} className="flex justify-between gap-3 py-2 border-b border-gray-200">
                  <span className="text-gray-700 font-medium truncate">{it.name}</span>
                  <span className="font-semibold text-gray-800 whitespace-nowrap">{it.detail}</span>
                </div>
              ))}
              <div className="flex justify-between py-2 border-b border-gray-200">
                <span className="text-gray-500">Pages per copy</span>
                <span className="font-semibold">{print.totalPages}</span>
              </div>
              <div className="flex justify-between py-2 border-b border-gray-200">
                <span className="text-gray-500">Copies</span>
                <span className="font-semibold">{print.copies}</span>
              </div>
              <div className="flex justify-between py-2 border-b border-gray-200">
                <span className="text-gray-500">Color</span>
                <span className="font-semibold">{print.colorMode === "B&W" ? "Black & White" : "Color"}</span>
              </div>
              {docType === "FullDocument" && (
                <div className="flex justify-between py-2">
                  <span className="text-gray-500">Sides</span>
                  <span className="font-semibold">{print.isDuplex ? "Both sides" : "One side"}</span>
                </div>
              )}
            </div>

            <div className="flex items-baseline justify-between mb-4 px-1">
              <span className="text-sm text-gray-500">Amount to pay at counter</span>
              <span className="text-3xl font-black text-green-600">₹{print.totalAmount}</span>
            </div>

            <button
              type="button"
              onClick={handleSubmit}
              disabled={busy}
              className="relative w-full py-4 rounded-2xl font-bold text-white shadow-lg bg-green-600 hover:bg-green-700 flex justify-center items-center overflow-hidden active:scale-95 disabled:cursor-wait disabled:active:scale-100"
            >
              {status === "uploading" && <span className="absolute inset-y-0 left-0 bg-green-800/40 transition-all" style={{ width: `${progress}%` }} />}
              <span className="relative flex items-center">
                {status === "uploading" ? (
                  <>
                    <Loader2 className="w-5 h-5 mr-2 animate-spin" /> Sending… {progress}%
                  </>
                ) : (
                  <>Confirm &amp; send to printer</>
                )}
              </span>
            </button>
            {status === "uploading" && <p className="text-xs text-gray-400 text-center mt-2">Please keep this page open.</p>}
          </div>
        )}

        {/* STEP 4: DONE */}
        {step === 4 && receipt && (
          <div className="p-8 text-center animate-in zoom-in-95 duration-500">
            <div className="w-20 h-20 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <CheckCircle className="w-10 h-10 text-green-600" />
            </div>
            <h2 className="text-2xl font-bold text-gray-800 mb-1">Order sent!</h2>
            <p className="text-gray-500 text-sm mb-6">Tell the operator your Order ID and pay at the counter.</p>

            <div className="bg-gray-50 rounded-2xl p-5 border border-gray-100 mb-6 space-y-3 text-left">
              <div className="flex justify-between items-center border-b pb-3 border-gray-200">
                <span className="text-gray-500 text-sm">Order ID</span>
                <span className="font-mono font-bold text-gray-800 text-lg">{receipt.orderId}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-gray-500 text-sm">Amount to pay</span>
                <span className="text-3xl font-black text-green-600">₹{receipt.amount}</span>
              </div>
            </div>

            <button type="button" onClick={resetAll} className="w-full py-4 bg-gray-100 hover:bg-gray-200 text-gray-800 font-bold rounded-2xl transition-colors active:scale-95">
              Print another document
            </button>
          </div>
        )}
      </div>
    </div>
  );
}