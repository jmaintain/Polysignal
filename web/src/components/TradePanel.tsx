import { useEffect, useState } from "react";
import type { AppState, SessionState } from "@polysignal/shared";
import { fmtCents } from "../format";

export function TradePanel({
  state,
  session,
}: {
  state: AppState | null;
  session: SessionState | null;
}) {
  const trading = state?.trading;
  const [outcome, setOutcome] = useState<"up" | "down">("up");
  const [price, setPrice] = useState("");
  const [count, setCount] = useState("10");
  const [arming, setArming] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const book = outcome === "up" ? session?.up : session?.down;

  // Track the ask as the default limit price until the user edits it.
  const [priceTouched, setPriceTouched] = useState(false);
  useEffect(() => {
    if (!priceTouched && book?.bestAsk != null) {
      setPrice(String(Math.round(book.bestAsk * 100)));
    }
  }, [book?.bestAsk, priceTouched]);

  useEffect(() => {
    setArming(false);
    setResult(null);
  }, [outcome, session?.market?.ticker]);

  if (!trading?.enabled) {
    return (
      <div className="card">
        <h2>Manual trading</h2>
        <div className="tradenote">
          Trading is <strong>off</strong> (monitor-only mode). To enable one-click manual orders,
          set <span className="mono">TRADING_ENABLED=true</span> plus your{" "}
          <span className="mono">KALSHI_API_KEY_ID</span> and{" "}
          <span className="mono">KALSHI_PRIVATE_KEY_PATH</span> in <span className="mono">.env</span>{" "}
          and restart the server. Keys never leave your machine. There is no automated trading
          loop — every order is an explicit click.
        </div>
      </div>
    );
  }

  const submit = async () => {
    if (!session?.market) return;
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/trade", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          confirm: true,
          asset: session.asset,
          horizon: session.horizon,
          outcome,
          action: "buy",
          priceCents: Number(price),
          count: Number(count),
        }),
      });
      const body = await res.json();
      setResult(
        body.ok
          ? { ok: true, text: `order ${body.status ?? "submitted"}${body.orderId ? ` (${String(body.orderId).slice(0, 12)}…)` : ""}` }
          : { ok: false, text: body.error ?? "order failed" },
      );
    } catch (err) {
      setResult({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
      setArming(false);
    }
  };

  const cost = ((Number(price) || 0) * (Number(count) || 0)) / 100;

  return (
    <div className="card">
      <h2>
        Manual trading{" "}
        <span className="dim">
          {trading.usdcBalance != null ? `· $${trading.usdcBalance.toFixed(2)} balance` : ""}
        </span>
      </h2>
      <div className="tradegrid">
        <button
          className={`btn ${outcome === "up" ? "active-up" : ""}`}
          onClick={() => setOutcome("up")}
        >
          YES {fmtCents(session?.up?.bestAsk)}
        </button>
        <button
          className={`btn ${outcome === "down" ? "active-down" : ""}`}
          onClick={() => setOutcome("down")}
        >
          NO {fmtCents(session?.down?.bestAsk)}
        </button>
        <input
          className="field mono"
          value={price}
          onChange={(e) => {
            setPriceTouched(true);
            setPrice(e.target.value);
          }}
          placeholder="limit price ¢ (1-99)"
          title="Limit price in cents"
        />
        <input
          className="field mono"
          value={count}
          onChange={(e) => setCount(e.target.value)}
          placeholder="contracts"
        />
        {!arming ? (
          <button
            className="btn wide"
            disabled={!session?.market || busy}
            onClick={() => setArming(true)}
          >
            Buy {count} {outcome === "up" ? "YES" : "NO"} @ {price}¢ (~${cost.toFixed(2)})
          </button>
        ) : (
          <button className="btn confirm wide" disabled={busy} onClick={submit}>
            {busy ? "Sending…" : `CONFIRM: ${count}x ${outcome === "up" ? "YES" : "NO"} @ ${price}¢`}
          </button>
        )}
      </div>
      <div className="presets">
        {[5, 10, 25, 50, 100].map((v) => (
          <button key={v} className="btn" onClick={() => setCount(String(v))}>
            {v}x
          </button>
        ))}
      </div>
      {result && <div className={result.ok ? "tradeok" : "tradeerr"}>{result.text}</div>}
      {trading.positions.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <h2>Positions</h2>
          {trading.positions.slice(0, 8).map((p) => (
            <div key={p.tokenId} className="log entry mono" style={{ display: "flex", gap: 8 }}>
              <span style={{ flex: 1 }}>{p.title || p.tokenId}</span>
              <span className={p.outcome === "YES" ? "pos" : "neg"}>{p.outcome}</span>
              <span>{p.size} ct</span>
              <span className="dim">@{fmtCents(p.avgPrice)}</span>
            </div>
          ))}
        </div>
      )}
      <div className="tradenote">
        Limit orders sign locally with your Kalshi API key and post straight to the exchange.
        Kalshi's taker fee (7% × P × (1−P)) is already deducted from every edge shown. No
        automation — you click, it trades.
      </div>
    </div>
  );
}
