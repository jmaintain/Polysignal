import { useMemo, useState } from "react";
import type { AssetId, HorizonId, SessionState } from "@polysignal/shared";
import { useLiveData } from "./ws";
import type { ViewMode } from "./components/Verdict";
import { Header } from "./components/Header";
import { Matrix } from "./components/Matrix";
import { FocusPanel } from "./components/FocusPanel";
import { ChartCanvas } from "./components/ChartCanvas";
import { TradePanel } from "./components/TradePanel";
import { LogFeed } from "./components/LogFeed";

export default function App() {
  const { state, chart, connected, setFocusAsset } = useLiveData();
  const [focus, setFocus] = useState<{ asset: AssetId; horizon: HorizonId }>({
    asset: "btc",
    horizon: "15m",
  });
  // Single source of truth for Simple/Expert, shared by the focus panel and
  // the matrix; persisted so the choice survives reloads.
  const [mode, setMode] = useState<ViewMode>(
    () => (localStorage.getItem("polysignal-view-mode") === "simple" ? "simple" : "expert"),
  );
  const changeMode = (m: ViewMode) => {
    setMode(m);
    localStorage.setItem("polysignal-view-mode", m);
  };

  const focusedSession: SessionState | null = useMemo(() => {
    if (!state) return null;
    return (
      state.sessions.find((s) => s.asset === focus.asset && s.horizon === focus.horizon) ?? null
    );
  }, [state, focus]);

  const onFocus = (asset: AssetId, horizon: HorizonId) => {
    setFocus({ asset, horizon });
    setFocusAsset(asset);
  };

  return (
    <div className="app">
      <Header state={state} connected={connected} />
      <div className="grid">
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="card">
            <h2>
              Live market matrix <span className="dim">— Chainlink resolution feed</span>
            </h2>
            <Matrix state={state} focus={focus} onFocus={onFocus} mode={mode} />
          </div>
          <div className="card">
            <h2>
              {focus.asset.toUpperCase()} price — Chainlink vs Binance
            </h2>
            <ChartCanvas chart={chart} session={focusedSession} />
          </div>
          <div className="card">
            <h2>Signal &amp; event log</h2>
            <LogFeed state={state} />
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <FocusPanel session={focusedSession} mode={mode} onModeChange={changeMode} />
          <TradePanel state={state} session={focusedSession} />
        </div>
      </div>
      <div className="footer">
        Prices stream from Polymarket's Real-Time Data Service topic{" "}
        <span className="mono">crypto_prices_chainlink</span> — the same Chainlink feed used to
        resolve these markets. Binance spot is shown only as a leading indicator; it is never used
        for fair-value pricing against the strike. Signals are informational, not financial advice.
      </div>
    </div>
  );
}
