import "dotenv/config";
import { ASSETS, ASSET_IDS } from "./config.js";
import { RtdsFeed } from "./feeds/rtds.js";
import { Engine } from "./services/engine.js";
import { TradingService } from "./services/trading.js";
import { startServer } from "./server.js";

const engine = new Engine();

// A monitor should degrade, not die: log stray async errors (e.g. socket
// teardown races) and keep streaming.
process.on("uncaughtException", (err) => {
  engine.log("error", `uncaught exception: ${err.stack ?? err.message}`);
});
process.on("unhandledRejection", (reason) => {
  engine.log("error", `unhandled rejection: ${String(reason)}`);
});
const trading = new TradingService((level, text) => engine.log(level, text));
engine.tradingStatus = () => trading.getStatus();

const feeds: RtdsFeed[] = [];
for (const asset of ASSET_IDS) {
  const cfg = ASSETS[asset];
  feeds.push(
    new RtdsFeed({
      topic: "crypto_prices_chainlink",
      symbol: cfg.chainlinkSymbol,
      onTick: (tick) => engine.ingestTick(asset, "chainlink", tick),
      onHistory: (ticks) => engine.ingestHistory(asset, "chainlink", ticks),
      onStatus: (up) => engine.feedStatusChanged(asset, "chainlink", up),
      log: (msg) => engine.log("warn", msg),
    }),
    new RtdsFeed({
      topic: "crypto_prices",
      symbol: cfg.binanceSymbol,
      onTick: (tick) => engine.ingestTick(asset, "binance", tick),
      onHistory: (ticks) => engine.ingestHistory(asset, "binance", ticks),
      onStatus: (up) => engine.feedStatusChanged(asset, "binance", up),
      log: (msg) => engine.log("warn", msg),
    }),
  );
}

engine.start();
trading.start();
for (const f of feeds) f.start();
const server = startServer(engine, trading);

function shutdown() {
  engine.log("info", "shutting down");
  for (const f of feeds) f.stop();
  trading.stop();
  engine.stop();
  server.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
