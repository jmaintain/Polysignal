import type { SessionState } from "@polysignal/shared";
import { fmtCents, fmtCountdown, fmtDelta, fmtPct, fmtSignedCents, fmtUsd } from "../format";
import { SignalChip } from "./Matrix";

export function FocusPanel({ session }: { session: SessionState | null }) {
  if (!session) {
    return (
      <div className="card">
        <h2>Focused market</h2>
        <div className="dim">Waiting for data…</div>
      </div>
    );
  }
  const s = session;
  const sig = s.signal;
  const horizonSec = { "5m": 300, "15m": 900, "1h": 3600, "1d": 86400 }[s.horizon];
  const elapsedFrac =
    s.secondsLeft != null ? Math.min(1, Math.max(0, 1 - s.secondsLeft / horizonSec)) : 0;
  const deltaCls = s.delta == null ? "dim" : s.delta >= 0 ? "pos" : "neg";

  return (
    <div className="card">
      <h2>Focused market</h2>
      <div className="focus-head">
        <span className="big mono">{fmtUsd(s.spot)}</span>
        <span className={`mono ${deltaCls}`} style={{ fontSize: 18 }}>
          {fmtDelta(s.delta)} ({fmtPct(s.deltaPct)})
        </span>
        <SignalChip s={s} />
      </div>
      <div className="title" style={{ marginTop: 4 }}>
        {s.market?.question ?? `${s.asset.toUpperCase()} ${s.horizon} — market not found`}
      </div>
      {s.discoveryError && !s.market && (
        <div className="tradeerr">discovery: {s.discoveryError}</div>
      )}
      <div className="countbar">
        <div style={{ width: `${(1 - elapsedFrac) * 100}%` }} />
      </div>

      <div className="statgrid">
        <div className="stat">
          <div className="label">Price to beat</div>
          <div className="value mono">{fmtUsd(s.strike)}</div>
          <div className="note">source: {s.strikeSource.replace("_", " ")}</div>
        </div>
        <div className="stat">
          <div className="label">Time left</div>
          <div className="value mono">{fmtCountdown(s.secondsLeft)}</div>
          <div className="note">{s.market ? s.market.slug : "—"}</div>
        </div>
        <div className="stat">
          <div className="label">Model P(UP)</div>
          <div className="value mono gold">{fmtCents(sig?.probUp)}</div>
          <div className="note">driftless GBM · Φ(d₂)</div>
        </div>
        <div className="stat">
          <div className="label">σ remaining</div>
          <div className="value mono">{fmtPct(sig?.sigmaRemaining, 3)}</div>
          <div className="note">
            ann. {sig?.annualizedVol != null ? `${(sig.annualizedVol * 100).toFixed(0)}%` : "—"}
          </div>
        </div>
        <div className="stat">
          <div className="label">Basis (BN−CL)</div>
          <div className="value mono">{fmtPct(sig?.basisPct, 3)}</div>
          <div className="note">z = {sig?.basisZ != null ? sig.basisZ.toFixed(2) : "—"}</div>
        </div>
        <div className="stat">
          <div className="label">Suggested stake</div>
          <div className="value mono">
            {sig?.kellyFraction != null ? `${(sig.kellyFraction * 100).toFixed(1)}%` : "—"}
          </div>
          <div className="note">half-Kelly, 10% cap</div>
        </div>
      </div>

      <div className="oddsrow">
        <OddsBox
          side="UP"
          book={s.up}
          fair={sig?.fairUp ?? null}
          edge={sig?.upBuyEdge ?? null}
        />
        <OddsBox
          side="DOWN"
          book={s.down}
          fair={sig?.fairDown ?? null}
          edge={sig?.downBuyEdge ?? null}
        />
      </div>

      {sig && sig.components.length > 0 && (
        <div className="sigcard">
          <div className="headline">
            <strong style={{ fontSize: 13 }}>Composite signal</strong>
            <div className="strength">
              <div
                style={{
                  width: `${sig.strength}%`,
                  background: sig.direction === "DOWN" ? "var(--red)" : "var(--green)",
                }}
              />
            </div>
            <span className="mono dim">{sig.strength}/100</span>
          </div>
          {sig.components.map((c) => (
            <div key={c.id}>
              <div className="component">
                <span className="name">{c.label}</span>
                <div className="bar">
                  <div
                    style={{
                      left: c.score >= 0 ? "50%" : `${50 + c.score * 50}%`,
                      width: `${Math.abs(c.score) * 50}%`,
                      background: c.score >= 0 ? "var(--green)" : "var(--red)",
                    }}
                  />
                </div>
                <span className={`val mono ${c.score >= 0 ? "pos" : "neg"}`}>
                  {(c.score * 100).toFixed(0)}
                </span>
              </div>
              <div className="component-detail">{c.detail}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function OddsBox({
  side,
  book,
  fair,
  edge,
}: {
  side: "UP" | "DOWN";
  book: SessionState["up"];
  fair: number | null;
  edge: number | null;
}) {
  const cls = side.toLowerCase() as "up" | "down";
  return (
    <div className={`oddsbox ${cls}`}>
      <div className={`side ${cls === "up" ? "pos" : "neg"}`}>{side}</div>
      <div className="market mono">{fmtCents(book?.mid)}</div>
      <div className="fair mono">
        bid {fmtCents(book?.bestBid)} / ask {fmtCents(book?.bestAsk)}
      </div>
      <div className="fair mono">fair {fmtCents(fair)}</div>
      <div className={`edge mono ${edge != null && edge > 0 ? "pos" : "dim"}`}>
        buy edge {fmtSignedCents(edge)}
      </div>
    </div>
  );
}
