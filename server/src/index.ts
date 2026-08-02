import "dotenv/config";
import { Engine } from "./services/engine.js";
import { IndexProxyService } from "./services/indexProxy.js";
import { KalshiApi, loadCredentials } from "./services/kalshiApi.js";
import { TradingService } from "./services/trading.js";
import { startServer } from "./server.js";

const creds = loadCredentials();
const api = new KalshiApi(creds);
const engine = new Engine(api, creds);

// A monitor should degrade, not die: log stray async errors (e.g. socket
// teardown races) and keep streaming.
process.on("uncaughtException", (err) => {
  engine.log("error", `uncaught exception: ${err.stack ?? err.message}`);
});
process.on("unhandledRejection", (reason) => {
  engine.log("error", `unhandled rejection: ${String(reason)}`);
});

const trading = new TradingService(api, (level, text) => engine.log(level, text));
engine.tradingStatus = () => trading.getStatus();

const proxy = new IndexProxyService((msg) => engine.log("warn", msg));
proxy.onIndexTick = (asset, tick) => engine.ingestTick(asset, "index", tick);
proxy.onBinanceTick = (asset, tick) => engine.ingestTick(asset, "binance", tick);
proxy.onSourcesChange = (asset, sources) => engine.setIndexSources(asset, sources);

engine.log(
  "info",
  creds
    ? "Kalshi API key loaded — websocket order books + trading available"
    : "no Kalshi API key — REST polling for order books (monitor-only)",
);

engine.start();
trading.start();
proxy.start();
const server = startServer(engine, trading);

function shutdown() {
  engine.log("info", "shutting down");
  proxy.stop();
  trading.stop();
  engine.stop();
  server.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
