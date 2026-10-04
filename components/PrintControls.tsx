"use client";

// components/PrintControls.tsx
// Shared UI pieces. Every screen uses these, so spacing, colors and tap sizes stay identical.

import type { ReactNode } from "react";
import { AlertCircle, AlertTriangle, Info, Minus, Plus } from "lucide-react";
import { MAX_COPIES, type ColorMode } from "../utils/printLogic";

export function SectionTitle({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <h3 className="font-bold text-gray-900 mb-5 flex items-center tracking-tight text-[17px]">
      <span className="mr-2.5 text-blue-600 flex">{icon}</span>
      {children}
    </h3>
  );
}

export function FieldLabel({ children }: { children: ReactNode }) {
  return <label className="text-[12px] font-bold text-gray-500 block mb-2.5 uppercase tracking-wider">{children}</label>;
}

interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  sub?: string;
  disabled?: boolean;
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: SegmentedOption<T>[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex bg-gray-100/80 p-1.5 rounded-xl ring-1 ring-gray-200/50 shadow-inner">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            disabled={o.disabled}
            onClick={() => onChange(o.value)}
            className={`flex-1 py-2.5 px-2 rounded-lg text-sm font-semibold transition-all duration-200 active:scale-[0.98] disabled:opacity-50 flex flex-col items-center justify-center ${
              active
                ? "bg-white text-gray-900 shadow-sm ring-1 ring-gray-200/50"
                : "text-gray-500 hover:text-gray-700"
            }`}
          >
            <span className="flex items-center justify-center">{o.label}</span>
            {o.sub && <span className={`block text-[10px] font-medium mt-0.5 ${active ? "text-gray-500" : "text-gray-400"}`}>{o.sub}</span>}
          </button>
        );
      })}
    </div>
  );
}

export function Banner({
  tone,
  children,
}: {
  tone: "info" | "warn" | "error";
  children: ReactNode;
}) {
  const styles = {
    info: "bg-blue-50 border-blue-100 text-blue-700",
    warn: "bg-amber-50 border-amber-200 text-amber-800",
    error: "bg-red-50 border-red-200 text-red-700",
  }[tone];
  const Icon = tone === "info" ? Info : tone === "warn" ? AlertTriangle : AlertCircle;
  return (
    <div className={`flex items-start text-sm font-medium px-3.5 py-3 rounded-xl border ${styles}`} role={tone === "error" ? "alert" : undefined}>
      <Icon className="w-4 h-4 mr-2 mt-0.5 flex-shrink-0" strokeWidth={2.5} />
      <div className="min-w-0 leading-snug">{children}</div>
    </div>
  );
}

export function CopiesStepper({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div className="flex items-center justify-between border-0 ring-1 ring-gray-200 shadow-sm rounded-2xl p-1.5 bg-white">
      <button
        type="button"
        aria-label="Fewer copies"
        onClick={() => onChange(Math.max(1, value - 1))}
        className="w-12 h-11 bg-gray-50 hover:bg-gray-100 rounded-xl text-gray-600 flex items-center justify-center active:scale-95 transition-colors"
      >
        <Minus className="w-5 h-5" strokeWidth={2.5} />
      </button>
      <span className="font-black text-xl text-gray-900 tabular-nums">{value}</span>
      <button
        type="button"
        aria-label="More copies"
        onClick={() => onChange(Math.min(MAX_COPIES, value + 1))}
        className="w-12 h-11 bg-gray-50 hover:bg-gray-100 rounded-xl text-gray-600 flex items-center justify-center active:scale-95 transition-colors"
      >
        <Plus className="w-5 h-5" strokeWidth={2.5} />
      </button>
    </div>
  );
}

/** Color mode + copies, identical on every screen. Now accepts dynamic pricing from the shop's agent. */
export function CommonPrintOptions({
  colorMode,
  copies,
  onColorMode,
  onCopies,
  pricing = { bw: 2.0, color: 10.0 } // Default fallback
}: {
  colorMode: ColorMode;
  copies: number;
  onColorMode: (v: ColorMode) => void;
  onCopies: (v: number) => void;
  pricing?: { bw: number; color: number };
}) {
  return (
    <div className="space-y-6">
      <div>
        <FieldLabel>Print Color</FieldLabel>
        <Segmented<ColorMode>
          value={colorMode}
          onChange={onColorMode}
          options={[
            { value: "B&W", label: "Black & White", sub: `₹${pricing.bw} per page` },
            { value: "Color", label: "Color", sub: `₹${pricing.color} per page` },
          ]}
        />
      </div>
      <div>
        <FieldLabel>Number of Copies</FieldLabel>
        <CopiesStepper value={copies} onChange={onCopies} />
      </div>
    </div>
  );
}