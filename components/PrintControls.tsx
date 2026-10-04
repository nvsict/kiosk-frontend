"use client";

// components/PrintControls.tsx
// Shared UI pieces. Every screen uses these, so spacing, colors and tap sizes stay identical.

import type { ReactNode } from "react";
import { AlertCircle, AlertTriangle, Info, Minus, Plus } from "lucide-react";
import { MAX_COPIES, RATE_PER_PAGE, type ColorMode } from "../utils/printLogic";

export function SectionTitle({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <h3 className="font-bold text-gray-800 mb-4 flex items-center">
      <span className="mr-2 text-blue-600 flex">{icon}</span>
      {children}
    </h3>
  );
}

export function FieldLabel({ children }: { children: ReactNode }) {
  return <label className="text-sm font-semibold text-gray-700 block mb-2">{children}</label>;
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
    <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            disabled={o.disabled}
            onClick={() => onChange(o.value)}
            className={`py-2.5 px-2 rounded-xl text-sm font-semibold border transition-all active:scale-95 disabled:opacity-50 ${
              active
                ? "bg-blue-50 border-blue-500 text-blue-700 ring-1 ring-blue-500"
                : "bg-white border-gray-200 text-gray-600 hover:bg-gray-50"
            }`}
          >
            <span className="flex items-center justify-center">{o.label}</span>
            {o.sub && <span className="block text-[10px] font-normal text-gray-400 mt-0.5">{o.sub}</span>}
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
    <div className={`flex items-start text-sm font-medium px-3 py-2.5 rounded-xl border ${styles}`} role={tone === "error" ? "alert" : undefined}>
      <Icon className="w-4 h-4 mr-2 mt-0.5 flex-shrink-0" />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function CopiesStepper({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div className="flex items-center justify-between border border-gray-300 rounded-xl p-1 bg-white">
      <button
        type="button"
        aria-label="Fewer copies"
        onClick={() => onChange(Math.max(1, value - 1))}
        className="w-12 h-11 bg-gray-100 hover:bg-gray-200 rounded-lg text-gray-600 flex items-center justify-center active:scale-95"
      >
        <Minus className="w-4 h-4" />
      </button>
      <span className="font-bold text-lg tabular-nums">{value}</span>
      <button
        type="button"
        aria-label="More copies"
        onClick={() => onChange(Math.min(MAX_COPIES, value + 1))}
        className="w-12 h-11 bg-gray-100 hover:bg-gray-200 rounded-lg text-gray-600 flex items-center justify-center active:scale-95"
      >
        <Plus className="w-4 h-4" />
      </button>
    </div>
  );
}

/** Color mode + copies, identical on every screen. */
export function CommonPrintOptions({
  colorMode,
  copies,
  onColorMode,
  onCopies,
}: {
  colorMode: ColorMode;
  copies: number;
  onColorMode: (v: ColorMode) => void;
  onCopies: (v: number) => void;
}) {
  return (
    <div className="space-y-4">
      <div>
        <FieldLabel>Print color</FieldLabel>
        <Segmented<ColorMode>
          value={colorMode}
          onChange={onColorMode}
          options={[
            { value: "B&W", label: "Black & White", sub: `₹${RATE_PER_PAGE["B&W"]} per page` },
            { value: "Color", label: "Color", sub: `₹${RATE_PER_PAGE.Color} per page` },
          ]}
        />
      </div>
      <div>
        <FieldLabel>Copies</FieldLabel>
        <CopiesStepper value={copies} onChange={onCopies} />
      </div>
    </div>
  );
}