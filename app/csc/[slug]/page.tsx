"use client";

import { use, useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, CheckCircle, ChevronRight, CreditCard, FileText, Loader2, Printer, UploadCloud } from "lucide-react";
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

  const handleSettingsUpdate = useCallback((d: PrintSettingsUpdate) => setPrint(d), []);

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

  const handlePick = (kind: DocType) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const list = Array.from(e.target.files ?? []);
    e.target.value = ""; 
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
    fd.append("pages", prepared.pagesPerFile[0] ?? "All");
    fd.append("pages_per_file", JSON.stringify(prepared.pagesPerFile)); 

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

  const showSettings = (step === 2 || step === 3) && docType && files.length > 0;
  const busy = status !== "idle";

  return (
    <div className="min-h-screen bg-gray-50/50 flex flex-col items-center py-6 px-4 font-sans text-gray-800 selection:bg-blue-100">
      
      {/* HEADER */}
      <div className="w-full max-w-md flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-extrabold text-blue-700 flex items-center tracking-tight">
            <Printer className="w-6 h-6 mr-2" strokeWidth={2.5} /> SmartPrint
          </h1>
          <p className="text-[11px] text-gray-500 font-bold tracking-wider mt-0.5">KIOSK ID: <span className="text-gray-700">{cscSlug.toUpperCase()}</span></p>
        </div>
        <div className="text-right">
          <div className="flex space-x-1.5 justify-end mb-1.5">
            {[1, 2, 3, 4].map((s) => (
              <div key={s} className={`w-2.5 h-2.5 rounded-full transition-colors duration-300 ${step >= s ? (s === 4 ? "bg-green-500" : "bg-blue-600") : "bg-gray-200"}`} />
            ))}
          </div>
          <p className="text-[11px] text-gray-500 font-semibold tracking-wide uppercase">{STEP_LABELS[step - 1]}</p>
        </div>
      </div>

      <input type="file" multiple accept="image/jpeg,image/png,image/webp" className="hidden" ref={idInputRef} onChange={handlePick("IDCard")} />
      <input type="file" multiple accept="application/pdf,image/jpeg,image/png,image/webp" className="hidden" ref={docInputRef} onChange={handlePick("FullDocument")} />

      <div className="bg-white w-full max-w-md rounded-[1.5rem] shadow-sm ring-1 ring-gray-100 overflow-hidden relative">
        
        {error && step !== 4 && (
          <div className="px-6 pt-6 animate-in slide-in-from-top-2 duration-300">
            <Banner tone="error">
              <span className="whitespace-pre-line text-sm font-medium">{error}</span>
            </Banner>
          </div>
        )}

        {/* STEP 1: CHOOSE */}
        {step === 1 && (
          <div className="p-7 animate-in fade-in duration-300">
            <div className="text-center mb-8">
              <h2 className="text-xl font-bold text-gray-900 tracking-tight">What do you want to print?</h2>
              <p className="text-sm text-gray-500 mt-1.5 font-medium">Select a document type to begin</p>
            </div>
            
            <div className="space-y-4">
              
              {/* Soft styled button for ID Card */}
              <button 
                type="button" 
                onClick={() => idInputRef.current?.click()} 
                className="group w-full text-left bg-white p-5 rounded-2xl flex items-center ring-1 ring-gray-200 hover:ring-2 hover:ring-blue-500 shadow-sm hover:shadow-md hover:bg-blue-50/40 active:scale-[0.98] transition-all duration-200 cursor-pointer"
              >
                <div className="w-14 h-14 bg-blue-100/70 rounded-xl flex items-center justify-center flex-shrink-0 group-hover:bg-blue-600 transition-colors duration-200">
                  <CreditCard className="w-7 h-7 text-blue-600 group-hover:text-white transition-colors duration-200" strokeWidth={2} />
                </div>
                <div className="ml-4 flex-1">
                  <h3 className="font-bold text-gray-900 text-[15px]">ID Card / Photo</h3>
                  <p className="text-[13px] text-gray-500 mt-0.5 font-medium leading-snug">Upload front & back photos.<br/>We will arrange them on one A4 sheet.</p>
                </div>
                <ChevronRight className="w-5 h-5 text-gray-300 group-hover:text-blue-500 transition-colors" strokeWidth={2.5} />
              </button>

              {/* Soft styled button for Full Document */}
              <button 
                type="button" 
                onClick={() => docInputRef.current?.click()} 
                className="group w-full text-left bg-white p-5 rounded-2xl flex items-center ring-1 ring-gray-200 hover:ring-2 hover:ring-green-500 shadow-sm hover:shadow-md hover:bg-green-50/40 active:scale-[0.98] transition-all duration-200 cursor-pointer"
              >
                <div className="w-14 h-14 bg-green-100/70 rounded-xl flex items-center justify-center flex-shrink-0 group-hover:bg-green-600 transition-colors duration-200">
                  <FileText className="w-7 h-7 text-green-600 group-hover:text-white transition-colors duration-200" strokeWidth={2} />
                </div>
                <div className="ml-4 flex-1">
                  <h3 className="font-bold text-gray-900 text-[15px]">Full Document</h3>
                  <p className="text-[13px] text-gray-500 mt-0.5 font-medium leading-snug">PDFs, Marksheets, or Notes.<br/>Print full A4 size pages.</p>
                </div>
                <ChevronRight className="w-5 h-5 text-gray-300 group-hover:text-green-500 transition-colors" strokeWidth={2.5} />
              </button>

            </div>

            <div className="mt-8 flex items-start justify-center gap-2 text-center bg-gray-50 rounded-xl p-3 ring-1 ring-gray-100">
              <UploadCloud className="w-4 h-4 text-gray-400 mt-0.5" />
              <p className="text-xs text-gray-500 font-medium">Files up to {MAX_FILE_MB} MB are supported.<br/>Pay the operator directly at the counter.</p>
            </div>
          </div>
        )}

        {/* STEP 2 + 3 */}
        {showSettings && (
          <div className={step === 2 ? "p-6 animate-in slide-in-from-right-8 duration-300" : "hidden"}>
            <button type="button" onClick={resetAll} className="flex items-center text-sm font-semibold text-gray-500 mb-6 hover:text-gray-800 transition-colors px-2 py-1 -ml-2 rounded-lg hover:bg-gray-100">
              <ArrowLeft className="w-4 h-4 mr-1.5" strokeWidth={2.5} /> Change document type
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

            <div className="mt-8 pt-6 border-t border-gray-100">
              <div className="flex items-end justify-between mb-4 px-1">
                <span className="text-sm font-semibold text-gray-500 uppercase tracking-wide">Estimated total</span>
                <span className="text-3xl font-black text-gray-900 tracking-tight">₹{print.totalAmount}</span>
              </div>
              <button
                type="button"
                onClick={goToReview}
                disabled={!print.isValid || busy}
                className="w-full py-4 rounded-2xl font-bold text-white shadow-[0_4px_14px_0_rgba(37,99,235,0.39)] transition-all flex items-center justify-center bg-blue-600 hover:bg-blue-700 active:scale-[0.98] disabled:bg-gray-300 disabled:shadow-none disabled:active:scale-100 disabled:text-gray-500"
              >
                {status === "preparing" ? (
                  <>
                    <Loader2 className="w-5 h-5 mr-2 animate-spin" /> Preparing print preview…
                  </>
                ) : (
                  <>
                    Review & Continue <ChevronRight className="w-5 h-5 ml-1" strokeWidth={2.5} />
                  </>
                )}
              </button>
            </div>
          </div>
        )}

        {/* STEP 3: REVIEW */}
        {step === 3 && prepared && docType && (
          <div className="p-6 animate-in slide-in-from-right-8 duration-300">
            <button type="button" onClick={backToSettings} disabled={busy} className="flex items-center text-sm font-semibold text-gray-500 mb-6 hover:text-gray-800 transition-colors px-2 py-1 -ml-2 rounded-lg hover:bg-gray-100 disabled:opacity-50">
              <ArrowLeft className="w-4 h-4 mr-1.5" strokeWidth={2.5} /> Edit settings
            </button>
            
            <h2 className="text-xl font-bold text-gray-900 mb-5 tracking-tight">Review your print</h2>

            {prepared.previewUrl && (
              <div className="bg-gray-100 p-4 rounded-2xl ring-1 ring-gray-200 mb-6 flex justify-center shadow-inner">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={prepared.previewUrl} alt="Final A4 sheet" className="bg-white shadow-sm w-48 aspect-[210/297] object-contain ring-1 ring-gray-200/50" />
              </div>
            )}

            <div className="bg-gray-50 ring-1 ring-gray-200 rounded-2xl p-5 mb-6 text-sm">
              {prepared.items.map((it, i) => (
                <div key={i} className="flex justify-between gap-4 py-2.5 border-b border-gray-200 last:border-0">
                  <span className="text-gray-600 font-medium truncate">{it.name}</span>
                  <span className="font-semibold text-gray-900 whitespace-nowrap">{it.detail}</span>
                </div>
              ))}
              <div className="flex justify-between py-2.5 border-b border-gray-200">
                <span className="text-gray-600 font-medium">Pages per copy</span>
                <span className="font-bold text-gray-900">{print.totalPages}</span>
              </div>
              <div className="flex justify-between py-2.5 border-b border-gray-200">
                <span className="text-gray-600 font-medium">Copies</span>
                <span className="font-bold text-gray-900">{print.copies}</span>
              </div>
              <div className="flex justify-between py-2.5 border-b border-gray-200">
                <span className="text-gray-600 font-medium">Color Mode</span>
                <span className="font-bold text-gray-900 bg-white px-2 py-0.5 rounded ring-1 ring-gray-200">{print.colorMode === "B&W" ? "Black & White" : "Color"}</span>
              </div>
              {docType === "FullDocument" && (
                <div className="flex justify-between py-2.5">
                  <span className="text-gray-600 font-medium">Print Layout</span>
                  <span className="font-bold text-gray-900">{print.isDuplex ? "Both sides" : "One side"}</span>
                </div>
              )}
            </div>

            <div className="flex items-end justify-between mb-5 px-1">
              <span className="text-sm font-semibold text-gray-500 uppercase tracking-wide">Amount to pay</span>
              <span className="text-3xl font-black text-green-600 tracking-tight">₹{print.totalAmount}</span>
            </div>

            <button
              type="button"
              onClick={handleSubmit}
              disabled={busy}
              className="relative w-full py-4 rounded-2xl font-bold text-white shadow-[0_4px_14px_0_rgba(22,163,74,0.39)] bg-green-600 hover:bg-green-700 flex justify-center items-center overflow-hidden active:scale-[0.98] disabled:cursor-wait disabled:active:scale-100 transition-all"
            >
              {status === "uploading" && <span className="absolute inset-y-0 left-0 bg-green-800/20 transition-all duration-300" style={{ width: `${progress}%` }} />}
              <span className="relative flex items-center">
                {status === "uploading" ? (
                  <>
                    <Loader2 className="w-5 h-5 mr-2 animate-spin" /> Sending to printer… {progress}%
                  </>
                ) : (
                  <>Confirm & Send to Printer</>
                )}
              </span>
            </button>
            {status === "uploading" && <p className="text-xs text-gray-400 font-medium text-center mt-3 animate-pulse">Please do not close this page.</p>}
          </div>
        )}

        {/* STEP 4: DONE */}
        {step === 4 && receipt && (
          <div className="p-8 text-center animate-in zoom-in-95 duration-500 flex flex-col items-center">
            <div className="w-24 h-24 bg-green-50 rounded-full flex items-center justify-center mb-5 ring-8 ring-green-50/50">
              <CheckCircle className="w-12 h-12 text-green-500" strokeWidth={2.5} />
            </div>
            <h2 className="text-2xl font-extrabold text-gray-900 mb-2 tracking-tight">Order sent successfully!</h2>
            <p className="text-gray-500 text-sm mb-8 font-medium">Please tell the operator your Order ID<br/>and pay at the counter.</p>

            <div className="w-full bg-white ring-1 ring-gray-200 shadow-sm rounded-2xl p-6 mb-8 text-left relative overflow-hidden">
              <div className="absolute top-0 left-0 w-1 h-full bg-green-500" />
              <div className="flex justify-between items-center border-b border-gray-100 pb-4 mb-4">
                <span className="text-gray-500 text-sm font-semibold uppercase tracking-wider">Order ID</span>
                <span className="font-mono font-bold text-gray-900 text-xl tracking-tight">{receipt.orderId}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-gray-500 text-sm font-semibold uppercase tracking-wider">Amount to pay</span>
                <span className="text-4xl font-black text-green-600 tracking-tight">₹{receipt.amount}</span>
              </div>
            </div>

            <button type="button" onClick={resetAll} className="w-full py-4 bg-gray-100 hover:bg-gray-200 text-gray-800 font-bold rounded-2xl transition-colors active:scale-[0.98]">
              Print another document
            </button>
          </div>
        )}
      </div>
    </div>
  );
}