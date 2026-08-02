/**
 * Offline plumbing smoke test (no external network needed):
 * starts a mock RTDS websocket on localhost, points the feed layer at it,
 * runs the engine + HTTP/WS server, and asserts ticks flow end to end.
 *
 *   npm exec -w server tsx src/smoke.ts
 */
import { WebSocketServer } from "ws";
import { Engine } from "./services/engine.js";
import { RtdsFeed } from "./feeds/rtds.js";
import { TradingService } from "./services/trading.js";
import { startServer } from "./server.js";
import { SERVER_PORT } from "./config.js";

const MOCK_PORT = 9099;

async function main() {
  // --- Mock RTDS server ------------------------------------------------
  const wss = new WebSocketServer({ port: MOCK_PORT });
  let price = 115000;
  wss.on("connection", (ws) => {
    let symbol = "btc/usd";
    let topic = "crypto_prices_chainlink";
    ws.on("message", (raw) => {
      const text = raw.toString();
      if (text === "ping") return void ws.send("pong");
      try {
        const msg = JSON.parse(text);
        const sub = msg?.subscriptions?.[0];
        if (msg.action === "subscribe" && sub) {
          topic = sub.topic;
          symbol = JSON.parse(sub.filters ?? "{}").symbol ?? symbol;
          // History dump: 60s of 1Hz ticks ending now.
          const now = Date.now();
          const data = Array.from({ length: 60 }, (_, i) => ({
            timestamp: now - (60 - i) * 1000,
            value: price + Math.sin(i / 5) * 20,
          }));
          ws.send(JSON.stringify({ topic, type: "update", payload: { symbol, data } }));
        }
      } catch {
        /* ignore */
      }
    });
    const timer = setInterval(() => {
      price += (Math.random() - 0.5) * 30;
      ws.send(
        JSON.stringify({
          topic,
          type: "update",
          timestamp: Date.now(),
          payload: { symbol, timestamp: Date.now(), value: price },
        }),
      );
    }, 500);
    ws.on("close", () => clearInterval(timer));
  });

  // --- Real engine + feeds pointed at the mock -------------------------
  const engine = new Engine();
  const trading = new TradingService((l, t) => engine.log(l === "trade" ? "trade" : l, t));
  engine.tradingStatus = () => trading.getStatus();
  // NOTE: no engine.start() -> no live discovery attempts during the smoke.
  const mkFeed = (topic: "crypto_prices" | "crypto_prices_chainlink", symbol: string, source: "chainlink" | "binance") =>
    new RtdsFeed({
      topic,
      symbol,
      url: `ws://localhost:${MOCK_PORT}`,
      onTick: (t) => engine.ingestTick("btc", source, t),
      onHistory: (h) => engine.ingestHistory("btc", source, h),
      onStatus: (up) => engine.feedStatusChanged("btc", source, up),
      log: (m) => engine.log("warn", m),
    });
  const feeds = [mkFeed("crypto_prices_chainlink", "btc/usd", "chainlink"), mkFeed("crypto_prices", "BTCUSDT", "binance")];
  for (const f of feeds) f.start();
  const server = startServer(engine, trading);

  await new Promise((r) => setTimeout(r, 6000));

  // --- Assertions -------------------------------------------------------
  const state = engine.appState();
  const cl = state.feeds.btc.chainlink;
  const bn = state.feeds.btc.binance;
  const chart = engine.chartData("btc");
  const failures: string[] = [];
  if (!cl.connected) failures.push("chainlink feed not connected");
  if (!bn.connected) failures.push("binance feed not connected");
  if (cl.ticksPerMin < 5) failures.push(`chainlink tick rate too low: ${cl.ticksPerMin}`);
  if (chart.chainlink.length < 60) failures.push(`history+ticks missing: ${chart.chainlink.length}`);
  if (cl.lastPrice == null || cl.lastPrice < 100000) failures.push("bad last price");

  const res = await fetch(`http://localhost:${SERVER_PORT}/api/state`);
  const apiState = await res.json();
  if (!res.ok || apiState.sessions?.length !== 12) {
    failures.push(`/api/state bad response (${res.status}, sessions=${apiState.sessions?.length})`);
  }
  const tradeRes = await fetch(`http://localhost:${SERVER_PORT}/api/trade`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirm: true, asset: "btc", horizon: "15m", outcome: "up", price: 0.5, size: 5 }),
  });
  if (tradeRes.status !== 400) {
    failures.push(`trade endpoint should 400 without a market, got ${tradeRes.status}`);
  }

  for (const f of feeds) f.stop();
  server.close();
  wss.close();
  engine.stop();
  trading.stop();

  if (failures.length > 0) {
    console.error("\nSMOKE FAIL:\n  - " + failures.join("\n  - "));
    process.exit(1);
  }
  console.log(
    `\nSMOKE PASS: chainlink ${cl.ticksPerMin} ticks/min, last ${cl.lastPrice?.toFixed(2)}, ` +
      `chart buffer ${chart.chainlink.length} ticks, /api/state OK, trade guard OK`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("smoke crashed:", err);
  process.exit(2);
});
