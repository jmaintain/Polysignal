import type { AppState, AssetId, HorizonId, SessionState } from "@polysignal/shared";
import { verdictForSession } from "@polysignal/shared";
import { fmtCents, fmtCountdown, fmtDelta, fmtPct, fmtSignedCents, fmtUsd } from "../format";
import { VerdictBadge, type ViewMode } from "./Verdict";

const HORIZON_ORDER: HorizonId[] = ["15m", "1h", "1d"];

export function Matrix({
  state,
  focus,
  onFocus,
  mode,
}: {
  state: AppState | null;
  focus: { asset: AssetId; horizon: HorizonId };
  onFocus: (asset: AssetId, horizon: HorizonId) => void;
  mode: ViewMode;
}) {
  if (!state) return <div className="dim">Connecting…</div>;
  const rows: SessionState[] = [];
  for (const a of state.assets) {
    for (const h of HORIZON_ORDER) {
      const s = state.sessions.find((x) => x.asset === a && x.horizon === h);
      if (s) rows.push(s);
    }
  }
  const simple = mode === "simple";
  return (
    <div style={{ overflowX: "auto" }}>
      <table className="matrix">
        <thead>
          <tr>
            <th>Market</th>
            <th>Spot (CL)</th>
            <th>To beat</th>
            <th>Δ</th>
            {!simple && <th>Δ%</th>}
            <th>Ends</th>
            {!simple && <th>UP mkt</th>}
            {!simple && <th>UP fair</th>}
            {!simple && <th>Best edge</th>}
            <th>Signal</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <Row
              key={`${s.asset}:${s.horizon}`}
              s={s}
              focused={focus.asset === s.asset && focus.horizon === s.horizon}
              onFocus={onFocus}
              simple={simple}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Row({
  s,
  focused,
  onFocus,
  simple,
}: {
  s: SessionState;
  focused: boolean;
  onFocus: (asset: AssetId, horizon: HorizonId) => void;
  simple: boolean;
}) {
  const sig = s.signal;
  const upMid = s.up?.mid ?? null;
  const bestEdge =
    sig?.upBuyEdge != null && sig?.downBuyEdge != null
      ? Math.max(sig.upBuyEdge, sig.downBuyEdge)
      : null;
  const deltaCls = s.delta == null ? "dim" : s.delta >= 0 ? "pos" : "neg";
  const noMarket = s.market == null;
  return (
    <tr className={`row mono ${focused ? "focused" : ""}`} onClick={() => onFocus(s.asset, s.horizon)}>
      <td>
        {s.asset.toUpperCase()}
        <span className="sub">{s.horizon}</span>
        {noMarket && <span className="sub neg">no market</span>}
      </td>
      <td>{fmtUsd(s.spot)}</td>
      <td className="dim" title={`strike source: ${s.strikeSource}`}>
        {fmtUsd(s.strike)}
      </td>
      <td className={deltaCls}>{fmtDelta(s.delta)}</td>
      {!simple && <td className={deltaCls}>{fmtPct(s.deltaPct)}</td>}
      <td className="dim">{fmtCountdown(s.secondsLeft)}</td>
      {!simple && <td>{fmtCents(upMid)}</td>}
      {!simple && <td className="gold">{fmtCents(sig?.fairUp)}</td>}
      {!simple && (
        <td className={bestEdge != null && bestEdge > 0 ? "pos" : "dim"}>{fmtSignedCents(bestEdge)}</td>
      )}
      <td>{simple ? <VerdictBadge v={verdictForSession(s)} /> : <SignalChip s={s} />}</td>
    </tr>
  );
}

export function SignalChip({ s }: { s: SessionState }) {
  const sig = s.signal;
  if (!sig || sig.phase === "NO_MARKET") return <span className="chip none">—</span>;
  if (sig.phase === "LOCKED") return <span className="chip locked">LOCKED</span>;
  if (sig.phase === "WARMING_UP") return <span className="chip none">WARMUP</span>;
  if (sig.direction === "UP") return <span className="chip up">UP {sig.strength}</span>;
  if (sig.direction === "DOWN") return <span className="chip down">DOWN {sig.strength}</span>;
  return <span className="chip none">FLAT</span>;
}
