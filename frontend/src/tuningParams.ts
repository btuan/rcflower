/** Slider range for one numeric tuning option. A 0..1 range with step 1 renders as a checkbox. */
export type TuningRange = { min: number; max: number; step: number };

/** Query-string key for an option, e.g. ("wc", "paperScale") -> "wcPaperScale". */
export function tuningParamName(prefix: string, key: string): string {
  return `${prefix}${key[0].toUpperCase()}${key.slice(1)}`;
}

/** Read numeric overrides for `defaults` from a query string, for quick tuning and shareable looks. */
export function tuningOptionsFromParams<T extends Record<string, number>>(
  params: URLSearchParams,
  prefix: string,
  defaults: T,
): T {
  const opts: Record<string, number> = { ...defaults };
  for (const key of Object.keys(defaults)) {
    const raw = params.get(tuningParamName(prefix, key));
    const v = raw === null ? NaN : Number(raw);
    if (Number.isFinite(v)) opts[key] = v;
  }
  return opts as T;
}
