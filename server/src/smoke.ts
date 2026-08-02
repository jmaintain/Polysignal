/**
 * Offline plumbing smoke test (no external network needed): drives the
 * engine with synthetic index/binance ticks and a synthetic market, and
 * asserts state assembly, settlement-window math, and the HTTP/WS API.
 *
 *   npm exec -w server tsx src/smoke.ts
 */
import { Engine } from "./services/engine.js";
import { KalshiApi } from "./services/kalshiApi.js";
import { TradingService } from "./services/trading.js";
import { startServer } from "./server.js";
import { SERVER_PORT, SETTLE_WINDOW_SEC } from "./config.js";

async function main() {
  const api = new KalshiApi(null);
  const engine = new Engine(api, null);
  const trading = new TradingService(api, (l, t) => engine.log(l === "trade" ? "trade" : l, t));
  engine.tradingStatus = () => trading.getStatus();
  // NOTE: no engine.start() -> no live discovery attempts during the smoke.
  const server = startServer(engine, trading);

  // Synthetic feeds: 90s of history at 1 Hz, then live ticks.
  let price = 63400;
  const now = Date.now();
  for (let i = 90; i > 0; i--) {
    price += (Math.sin(i / 6) - 0.4) * 3;
    engine.ingestTick("btc", "index", { ts: now - i * 1000, price });
    engine.ingestTick("btc", "binance", { ts: now - i * 1000 + 200, price: price * 1.001 });
  }
  engine.setIndexSources("btc", ["coinbase", "kraken", "bitstamp"]);

  // Inject a synthetic market that is 30s into its settlement window.
  const sessions = (engine as unknown as { sessions: Map<string, { market: unknown }> }).sessions;
  const session = sessions.get("btc:15m")!;
  session.market = {
    ticker: "KXTEST-15M-T63400",
    eventTicker: "KXTEST-15M",
    seriesTicker: "KXTEST",
    title: "Smoke test market",
    yesSubTitle: null,
    strike: 63400,
    strikeType: "greater",
    startTs: now - 870_000,
    endTs: now + 30_000, // 30s left -> inside the 60s window
    tickSize: 0.01,
    feeSchedule: { rate: 0.07, exponent: 1 },
    settleWindowSec: SETTLE_WINDOW_SEC,
  };

  await new Promise((r) => setTimeout(r, 300));

  const failures: string[] = [];
  const state = engine.appState();
  const btc15 = state.sessions.find((s) => s.asset === "btc" && s.horizon === "15m")!;

  if (!state.feeds.btc.index.connected) failures.push("index feed not marked connected");
  if ((state.feeds.btc.index.sourcesUp?.length ?? 0) !== 3) failures.push("sourcesUp missing");
  if (state.feeds.btc.index.ticksPerMin < 30) failures.push(`index tick rate ${state.feeds.btc.index.ticksPerMin}`);
  if (btc15.strike !== 63400) failures.push(`strike ${btc15.strike}`);
  if (btc15.strikeSource !== "kalshi_api") failures.push(`strikeSource ${btc15.strikeSource}`);
  if (btc15.settle == null) failures.push("settle window state missing");
  else {
    if (!(btc15.settle.elapsedSec > 25 && btc15.settle.elapsedSec <= 31))
      failures.push(`settle elapsed ${btc15.settle.elapsedSec}`);
    if (btc15.settle.avgSoFar == null) failures.push("settle avgSoFar missing");
  }
  if (btc15.signal?.probUp == null) failures.push("signal probUp missing");
  if (btc15.signal && btc15.signal.probUp != null) {
    if (!(btc15.signal.probUp >= 0 && btc15.signal.probUp <= 1))
      failures.push(`probUp out of range: ${btc15.signal.probUp}`);
  }
  const chart = engine.chartData("btc");
  if (chart.index.length < 80) failures.push(`chart index buffer ${chart.index.length}`);

  const res = await fetch(`http://localhost:${SERVER_PORT}/api/state`);
  const apiState = await res.json();
  if (!res.ok || apiState.sessions?.length !== 9) {
    failures.push(`/api/state bad response (${res.status}, sessions=${apiState.sessions?.length})`);
  }
  const tradeRes = await fetch(`http://localhost:${SERVER_PORT}/api/trade`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirm: true, asset: "eth", horizon: "15m", outcome: "up", priceCents: 50, count: 5 }),
  });
  if (tradeRes.status !== 400) {
    failures.push(`trade endpoint should 400 without a market, got ${tradeRes.status}`);
  }

  server.close();
  engine.stop();
  trading.stop();

  if (failures.length > 0) {
    console.error("\nSMOKE FAIL:\n  - " + failures.join("\n  - "));
    process.exit(1);
  }
  console.log(
    `\nSMOKE PASS: probUp ${(btc15.signal!.probUp! * 100).toFixed(1)}c with settle avg ` +
      `${btc15.settle!.avgSoFar!.toFixed(2)} @ ${btc15.settle!.elapsedSec.toFixed(0)}s into window; ` +
      `/api/state OK; trade guard OK`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("smoke crashed:", err);
  process.exit(2);
});
