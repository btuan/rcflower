import type { ReactNode } from "react";

import { tuningParamName, type TuningRange } from "./tuningParams";

/** Slider/checkbox panel for the shader prototypes (`/live?wc=1`, `/flower-toon`). */
export function TuningPanel<T extends Record<string, number>>({
  values,
  ranges,
  onChange,
  urlPrefix,
  urlBase,
  children,
}: {
  values: T;
  ranges: Record<keyof T, TuningRange>;
  onChange: (key: keyof T, value: number) => void;
  /** Query-param prefix used by "copy URL", e.g. "wc". */
  urlPrefix: string;
  /** Path plus any fixed params for "copy URL", e.g. "/live?wc=1". */
  urlBase: string;
  children?: ReactNode;
}) {
  return (
    <div className="absolute top-2 right-2 z-10 w-56 max-h-[calc(100%-1rem)] overflow-y-auto font-mono text-[11px] leading-tight text-gray-600 bg-white/80 rounded px-2 py-1">
      {children}
      {(Object.keys(ranges) as (keyof T & string)[]).map((key) => {
        const range = ranges[key];
        // 0|1 options render as checkboxes.
        if (range.max === 1 && range.step === 1) {
          return (
            <label key={key} className="flex items-center gap-1 py-0.5">
              <input
                type="checkbox"
                checked={values[key] === 1}
                onChange={(e) => onChange(key, e.target.checked ? 1 : 0)}
              />
              {key}
            </label>
          );
        }
        return (
          <label key={key} className="block py-0.5">
            <span className="flex justify-between">
              <span>{key}</span>
              <span>{values[key]}</span>
            </span>
            <input
              type="range"
              className="w-full"
              {...range}
              value={values[key]}
              onChange={(e) => onChange(key, Number(e.target.value))}
            />
          </label>
        );
      })}
      <button
        type="button"
        className="mt-1 underline"
        onClick={() => {
          const [path, fixed] = urlBase.split("?");
          const q = new URLSearchParams(fixed);
          for (const [k, v] of Object.entries(values)) q.set(tuningParamName(urlPrefix, k), String(v));
          void navigator.clipboard?.writeText(`${window.location.origin}${path}?${q}`);
        }}
      >
        copy URL with these values
      </button>
    </div>
  );
}
