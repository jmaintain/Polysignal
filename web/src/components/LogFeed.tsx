import type { AppState } from "@polysignal/shared";

export function LogFeed({ state }: { state: AppState | null }) {
  const entries = state?.log ?? [];
  if (entries.length === 0) return <div className="dim">No events yet.</div>;
  return (
    <div className="log">
      {entries.map((e, i) => (
        <div className="entry" key={`${e.ts}-${i}`}>
          <span className="ts mono">{new Date(e.ts).toLocaleTimeString()}</span>
          <span className={e.level}>{e.text}</span>
        </div>
      ))}
    </div>
  );
}
