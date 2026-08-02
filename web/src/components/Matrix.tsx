import type { AppState, AssetId, HorizonId, SessionState } from "@polysignal/shared";
import { fmtCents, fmtCountdown, fmtDelta, fmtPct, fmtSignedCents, fmtUsd } from "../format";

const HORIZON_ORDER: HorizonId[] = ["5m", "15m", "1h", "1d"];
const ASSET_ORDER: AssetId[] = ["btc", "eth", "sol"];

export function Matrix({
  state,
  focus,
  onFocus,
}: {
  state: AppState | null;
  focus: { asset: AssetId; horizon: HorizonId };
  onFocus: (asset: AssetId, horizon: HorizonId) => void;
}) {
  if (!state) return <div className="dim">Connecting…</div>;
  const rows: SessionState[] = [];
  for (const a of ASSET_ORDER) {
    for (const h of HORIZON_ORDER) {
      const s = state.sessions.find((x) => x.asset === a && x.horizon === h);
      if (s) rows.push(s);
    }
  }
  return (
    <div style={{ overflowX: "auto" }}>
      <table className="matrix">
        <thead>
          <tr>
            <th>Market</th>
            <th>Spot (CL)</th>
            <th>To beat</th>
            <th>Δ</th>
            <th>Δ%</th>
            <th>Ends</th>
            <th>UP mkt</th>
            <th>UP fair</th>
            <th>Best edge</th>
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
}: {
  s: SessionState;
  focused: boolean;
  onFocus: (asset: AssetId, horizon: HorizonId) => void;
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
      <td className={deltaCls}>{fmtPct(s.deltaPct)}</td>
      <td className="dim">{fmtCountdown(s.secondsLeft)}</td>
      <td>{fmtCents(upMid)}</td>
      <td className="gold">{fmtCents(sig?.fairUp)}</td>
      <td className={bestEdge != null && bestEdge > 0 ? "pos" : "dim"}>{fmtSignedCents(bestEdge)}</td>
      <td>
        <SignalChip s={s} />
      </td>
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
