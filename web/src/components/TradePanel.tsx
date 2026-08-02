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
  const [orderKind, setOrderKind] = useState<"limit" | "market">("limit");
  const [price, setPrice] = useState("");
  const [size, setSize] = useState("10");
  const [arming, setArming] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const book = outcome === "up" ? session?.up : session?.down;

  // Track the ask as the default limit price until the user edits it.
  const [priceTouched, setPriceTouched] = useState(false);
  useEffect(() => {
    if (!priceTouched && book?.bestAsk != null) {
      setPrice((book.bestAsk * 100).toFixed(1));
    }
  }, [book?.bestAsk, priceTouched]);

  useEffect(() => {
    setArming(false);
    setResult(null);
  }, [outcome, session?.market?.slug]);

  if (!trading?.enabled) {
    return (
      <div className="card">
        <h2>Manual trading</h2>
        <div className="tradenote">
          Trading is <strong>off</strong> (monitor-only mode). To enable one-click manual orders,
          set <span className="mono">TRADING_ENABLED=true</span> and{" "}
          <span className="mono">POLYMARKET_PRIVATE_KEY</span> in <span className="mono">.env</span>{" "}
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
          side: "BUY",
          orderKind,
          price: Number(price) / 100,
          size: Number(size),
        }),
      });
      const body = await res.json();
      setResult(
        body.ok
          ? { ok: true, text: `order accepted${body.orderId ? ` (${String(body.orderId).slice(0, 12)}…)` : ""}` }
          : { ok: false, text: body.error ?? "order failed" },
      );
    } catch (err) {
      setResult({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
      setArming(false);
    }
  };

  return (
    <div className="card">
      <h2>
        Manual trading{" "}
        <span className="dim">
          {trading.usdcBalance != null ? `· $${trading.usdcBalance.toFixed(2)} USDC` : ""}
        </span>
      </h2>
      <div className="tradegrid">
        <button
          className={`btn ${outcome === "up" ? "active-up" : ""}`}
          onClick={() => setOutcome("up")}
        >
          UP {fmtCents(session?.up?.bestAsk)}
        </button>
        <button
          className={`btn ${outcome === "down" ? "active-down" : ""}`}
          onClick={() => setOutcome("down")}
        >
          DOWN {fmtCents(session?.down?.bestAsk)}
        </button>
        <select
          className="field"
          value={orderKind}
          onChange={(e) => setOrderKind(e.target.value as "limit" | "market")}
        >
          <option value="limit">Limit (GTC, shares)</option>
          <option value="market">Market (FAK, $USDC)</option>
        </select>
        <input
          className="field mono"
          value={price}
          onChange={(e) => {
            setPriceTouched(true);
            setPrice(e.target.value);
          }}
          placeholder="price ¢"
          title="Limit price in cents"
        />
        <input
          className="field mono"
          value={size}
          onChange={(e) => setSize(e.target.value)}
          placeholder={orderKind === "limit" ? "shares" : "$ amount"}
        />
        {!arming ? (
          <button
            className="btn"
            disabled={!session?.market || busy}
            onClick={() => setArming(true)}
          >
            {orderKind === "limit"
              ? `Buy ${size} ${outcome.toUpperCase()} @ ${price}¢`
              : `Buy $${size} ${outcome.toUpperCase()}`}
          </button>
        ) : (
          <button className="btn confirm" disabled={busy} onClick={submit}>
            {busy ? "Sending…" : "CONFIRM ORDER"}
          </button>
        )}
      </div>
      {orderKind === "market" && (
        <div className="presets">
          {[5, 10, 25, 50, 100].map((v) => (
            <button key={v} className="btn" onClick={() => setSize(String(v))}>
              ${v}
            </button>
          ))}
        </div>
      )}
      {result && (
        <div className={result.ok ? "tradeok" : "tradeerr"}>{result.text}</div>
      )}
      {trading.positions.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <h2>Positions</h2>
          {trading.positions.slice(0, 8).map((p) => (
            <div key={p.tokenId} className="log entry mono" style={{ display: "flex", gap: 8 }}>
              <span style={{ flex: 1 }}>{p.title || p.outcome}</span>
              <span>{p.size.toFixed(1)} sh</span>
              <span className="dim">@{fmtCents(p.avgPrice)}</span>
              <span className={p.curPrice != null && p.curPrice >= p.avgPrice ? "pos" : "neg"}>
                {fmtCents(p.curPrice)}
              </span>
            </div>
          ))}
        </div>
      )}
      <div className="tradenote">
        Orders sign locally with your key and post straight to the Polymarket CLOB. No automation,
        no profit siphons — you click, it trades.
      </div>
    </div>
  );
}
