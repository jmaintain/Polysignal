export function fmtUsd(v: number | null | undefined, digits?: number): string {
  if (v == null || !isFinite(v)) return "—";
  const d = digits ?? (v >= 1000 ? 2 : v >= 10 ? 2 : 4);
  return v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

export function fmtCents(v: number | null | undefined): string {
  if (v == null || !isFinite(v)) return "—";
  return `${(v * 100).toFixed(1)}¢`;
}

export function fmtSignedCents(v: number | null | undefined): string {
  if (v == null || !isFinite(v)) return "—";
  const s = v >= 0 ? "+" : "";
  return `${s}${(v * 100).toFixed(1)}¢`;
}

export function fmtDelta(v: number | null | undefined, digits = 2): string {
  if (v == null || !isFinite(v)) return "—";
  const s = v >= 0 ? "+" : "";
  return `${s}${v.toFixed(digits)}`;
}

export function fmtPct(v: number | null | undefined, digits = 3): string {
  if (v == null || !isFinite(v)) return "—";
  const s = v >= 0 ? "+" : "";
  return `${s}${(v * 100).toFixed(digits)}%`;
}

export function fmtCountdown(seconds: number | null | undefined): string {
  if (seconds == null || !isFinite(seconds)) return "—";
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

export function fmtAge(tsMs: number | null | undefined): string {
  if (tsMs == null) return "—";
  const age = (Date.now() - tsMs) / 1000;
  if (age < 1) return "<1s";
  if (age < 60) return `${age.toFixed(0)}s`;
  return `${Math.floor(age / 60)}m${Math.floor(age % 60)}s`;
}
