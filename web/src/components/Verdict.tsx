import { SIMPLE_COPY, type VerdictConfidence, type VerdictResult } from "@polysignal/shared";

export type ViewMode = "simple" | "expert";

export function VerdictBadge({ v, big = false }: { v: VerdictResult; big?: boolean }) {
  const badge = SIMPLE_COPY.badges[v.verdict];
  const dirText = v.verdict !== "NO_READ" && v.direction ? ` · ${v.direction}` : "";
  return (
    <span
      className={`verdict-badge ${v.verdict.toLowerCase()} ${big ? "big" : ""}`}
      title={`${badge.label}${dirText}`}
    >
      <span className="emoji">{badge.emoji}</span>
      {big && (
        <span>
          {badge.label}
          {dirText}
        </span>
      )}
    </span>
  );
}

export function ConfidenceDial({ confidence }: { confidence: VerdictConfidence }) {
  const level = confidence === "high" ? 3 : confidence === "medium" ? 2 : 1;
  return (
    <div className="confidence">
      <span className="dim">Confidence</span>
      <div className="dial" role="img" aria-label={`confidence ${confidence}`}>
        {[1, 2, 3].map((seg) => (
          <div key={seg} className={`seg ${seg <= level ? `on l${level}` : ""}`} />
        ))}
      </div>
      <span className={`conf-label ${confidence}`}>{confidence}</span>
    </div>
  );
}

export function ModeToggle({
  mode,
  onChange,
}: {
  mode: ViewMode;
  onChange: (mode: ViewMode) => void;
}) {
  return (
    <div className="mode-toggle" role="tablist" aria-label="view mode">
      <button
        className={`btn ${mode === "simple" ? "active" : ""}`}
        onClick={() => onChange("simple")}
        role="tab"
        aria-selected={mode === "simple"}
      >
        Simple
      </button>
      <button
        className={`btn ${mode === "expert" ? "active" : ""}`}
        onClick={() => onChange("expert")}
        role="tab"
        aria-selected={mode === "expert"}
      >
        Expert
      </button>
    </div>
  );
}
