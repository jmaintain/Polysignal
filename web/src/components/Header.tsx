import type { AppState, AssetId } from "@polysignal/shared";

const ASSETS: AssetId[] = ["btc", "eth", "sol"];

export function Header({ state, connected }: { state: AppState | null; connected: boolean }) {
  return (
    <div className="header">
      <div>
        <div className="logo">
          POLY<span className="accent">SIGNAL</span>
        </div>
        <div className="tagline">Chainlink-true crypto up/down monitor</div>
      </div>
      <div className="spacer" />
      <div className="feedpills">
        {ASSETS.map((a) => {
          const feed = state?.feeds[a]?.chainlink;
          const fresh = feed?.lastTickTs != null && Date.now() - feed.lastTickTs < 6000;
          const cls = feed?.connected && fresh ? "live" : feed?.connected ? "stale" : "";
          return (
            <div className="pill" key={a} title="Chainlink resolution feed status">
              <span className={`dot ${cls}`} />
              <span>{a.toUpperCase()}</span>
              <span className="dim mono">
                {feed?.lastPrice != null
                  ? feed.lastPrice.toLocaleString("en-US", { maximumFractionDigits: 2 })
                  : "—"}
              </span>
              <span className="dim">{feed ? `${feed.ticksPerMin}/min` : ""}</span>
            </div>
          );
        })}
      </div>
      <span className={`badge ${connected ? "on" : ""}`}>
        {connected ? "SERVER LIVE" : "RECONNECTING…"}
      </span>
      <span className={`badge ${state?.trading.enabled ? "on" : ""}`}>
        {state?.trading.enabled ? `TRADING ${short(state.trading.address)}` : "MONITOR ONLY"}
      </span>
    </div>
  );
}

function short(addr: string | null): string {
  return addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : "";
}
