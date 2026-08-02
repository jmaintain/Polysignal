import { useState } from "react";
import type { SessionState } from "@polysignal/shared";
import {
  SIMPLE_COPY,
  sentenceForSession,
  takerFeePerShare,
  verdictForSession,
} from "@polysignal/shared";
import { fmtCents, fmtCountdown, fmtDelta, fmtPct, fmtSignedCents, fmtUsd } from "../format";
import { SignalChip } from "./Matrix";
import { ConfidenceDial, ModeToggle, VerdictBadge, type ViewMode } from "./Verdict";

export function FocusPanel({
  session,
  mode,
  onModeChange,
}: {
  session: SessionState | null;
  mode: ViewMode;
  onModeChange: (mode: ViewMode) => void;
}) {
  if (!session) {
    return (
      <div className="card">
        <div className="panel-head">
          <h2>Focused market</h2>
          <ModeToggle mode={mode} onChange={onModeChange} />
        </div>
        <div className="dim">Waiting for data…</div>
      </div>
    );
  }
  if (mode === "simple") {
    return <SimpleFocus s={session} mode={mode} onModeChange={onModeChange} />;
  }
  const s = session;
  const sig = s.signal;
  const horizonSec = { "15m": 900, "1h": 3600, "1d": 86400 }[s.horizon];
  const elapsedFrac =
    s.secondsLeft != null ? Math.min(1, Math.max(0, 1 - s.secondsLeft / horizonSec)) : 0;
  const deltaCls = s.delta == null ? "dim" : s.delta >= 0 ? "pos" : "neg";

  return (
    <div className="card">
      <div className="panel-head">
        <h2>Focused market</h2>
        <ModeToggle mode={mode} onChange={onModeChange} />
      </div>
      <div className="focus-head">
        <span className="big mono">{fmtUsd(s.spot)}</span>
        <span className={`mono ${deltaCls}`} style={{ fontSize: 18 }}>
          {fmtDelta(s.delta)} ({fmtPct(s.deltaPct)})
        </span>
        <SignalChip s={s} />
      </div>
      <div className="title" style={{ marginTop: 4 }}>
        {s.market?.title ?? `${s.asset.toUpperCase()} ${s.horizon} — market not found`}
        {s.market?.yesSubTitle ? ` — ${s.market.yesSubTitle}` : ""}
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
          <div className="note">{s.market ? s.market.ticker : "—"}</div>
        </div>
        <div className="stat">
          <div className="label">Model P(YES)</div>
          <div className="value mono gold">{fmtCents(sig?.probUp)}</div>
          <div className="note">60s-avg settle · Φ(d₂)</div>
        </div>
        <div className="stat">
          <div className="label">σ remaining</div>
          <div className="value mono">{fmtPct(sig?.sigmaRemaining, 3)}</div>
          <div className="note">
            ann. {sig?.annualizedVol != null ? `${(sig.annualizedVol * 100).toFixed(0)}%` : "—"}
          </div>
        </div>
        <div className="stat">
          <div className="label">Basis (BN−RTI)</div>
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
        {s.settle && (
          <div className="stat" style={{ borderColor: "var(--gold)", border: "1px solid" }}>
            <div className="label">Settle avg ({s.settle.elapsedSec.toFixed(0)}s/60s)</div>
            <div className="value mono gold">{fmtUsd(s.settle.avgSoFar)}</div>
            <div className="note">projected {fmtUsd(s.settle.projected)}</div>
          </div>
        )}
      </div>

      <div className="oddsrow">
        <OddsBox
          side="YES"
          book={s.up}
          fair={sig?.fairUp ?? null}
          edge={sig?.upBuyEdge ?? null}
          fee={feeAtAsk(s, s.up?.bestAsk)}
        />
        <OddsBox
          side="NO"
          book={s.down}
          fair={sig?.fairDown ?? null}
          edge={sig?.downBuyEdge ?? null}
          fee={feeAtAsk(s, s.down?.bestAsk)}
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

function SimpleFocus({
  s,
  mode,
  onModeChange,
}: {
  s: SessionState;
  mode: ViewMode;
  onModeChange: (mode: ViewMode) => void;
}) {
  const [whyOpen, setWhyOpen] = useState(false);
  const verdict = verdictForSession(s);
  const sentence = sentenceForSession(s, verdict);
  const components = s.signal?.components ?? [];

  return (
    <div className="card">
      <div className="panel-head">
        <h2>
          {s.asset.toUpperCase()} {s.horizon} market
        </h2>
        <ModeToggle mode={mode} onChange={onModeChange} />
      </div>
      <div className="simple-focus">
        <VerdictBadge v={verdict} big />
        <p className="simple-sentence">{sentence}</p>
        {verdict.verdict !== "NO_READ" && <ConfidenceDial confidence={verdict.confidence} />}
        {components.length > 0 && (
          <div className="why">
            <button className="why-toggle" onClick={() => setWhyOpen(!whyOpen)}>
              {whyOpen ? "▾" : "▸"} Why?
            </button>
            {whyOpen && (
              <ul className="why-list">
                {components.map((c) => {
                  const phrase =
                    c.id in SIMPLE_COPY.components
                      ? SIMPLE_COPY.components[c.id as keyof typeof SIMPLE_COPY.components](c.score)
                      : `${c.label}: ${c.detail}`;
                  return <li key={c.id}>{phrase}</li>;
                })}
              </ul>
            )}
          </div>
        )}
        <div className="simple-meta dim mono">
          {s.market?.title ?? "no active market"}
          {s.secondsLeft != null && <> · ends in {fmtCountdown(s.secondsLeft)}</>}
        </div>
        <button className="linkish" onClick={() => onModeChange("expert")}>
          switch to expert view
        </button>
      </div>
    </div>
  );
}

function feeAtAsk(s: SessionState, ask: number | null | undefined): number | null {
  const sched = s.market?.feeSchedule;
  if (!sched || ask == null) return null;
  return takerFeePerShare(ask, sched.rate, sched.exponent);
}

function OddsBox({
  side,
  book,
  fair,
  edge,
  fee,
}: {
  side: "YES" | "NO";
  book: SessionState["up"];
  fair: number | null;
  edge: number | null;
  fee: number | null;
}) {
  const cls = side === "YES" ? "up" : "down";
  return (
    <div className={`oddsbox ${cls}`}>
      <div className={`side ${cls === "up" ? "pos" : "neg"}`}>
        {side} {side === "YES" ? "· above" : "· below"}
      </div>
      <div className="market mono">{fmtCents(book?.mid)}</div>
      <div className="fair mono">
        bid {fmtCents(book?.bestBid)} / ask {fmtCents(book?.bestAsk)}
      </div>
      <div className="fair mono">
        fair {fmtCents(fair)}
        {fee != null && <> · fee {fmtCents(fee)}</>}
      </div>
      <div className={`edge mono ${edge != null && edge > 0 ? "pos" : "dim"}`}>
        buy edge {fmtSignedCents(edge)} <span className="dim">(net of fee)</span>
      </div>
    </div>
  );
}
