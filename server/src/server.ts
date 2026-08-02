import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import type { AssetId, ClientMessage, ServerMessage } from "@polysignal/shared";
import { ASSET_IDS, SERVER_PORT } from "./config.js";
import type { Engine } from "./services/engine.js";
import type { TradingService } from "./services/trading.js";

const BROADCAST_MS = 500;

export function startServer(engine: Engine, trading: TradingService) {
  const app = express();
  app.use(express.json());

  app.get("/api/state", (_req, res) => res.json(engine.appState()));
  app.get("/api/chart/:asset", (req, res) => {
    const asset = req.params.asset as AssetId;
    if (!ASSET_IDS.includes(asset)) return res.status(404).json({ error: "unknown asset" });
    res.json(engine.chartData(asset));
  });

  app.post("/api/trade", async (req, res) => {
    const b = req.body ?? {};
    if (b.confirm !== true) {
      return res.status(400).json({ ok: false, error: "missing confirm flag" });
    }
    const asset = b.asset as AssetId;
    const market = engine.marketFor(asset, b.horizon);
    if (!market) return res.status(400).json({ ok: false, error: "no active market" });
    const priceCents = Number(b.priceCents);
    const count = Number(b.count);
    if (!(priceCents >= 1 && priceCents <= 99) || !(count >= 1)) {
      return res.status(400).json({ ok: false, error: "invalid price/count" });
    }
    const result = await trading.placeOrder({
      ticker: market.ticker,
      side: b.outcome === "down" ? "no" : "yes",
      action: b.action === "sell" ? "sell" : "buy",
      priceCents,
      count,
    });
    res.status(result.ok ? 200 : 502).json(result);
  });

  // Serve the built dashboard in production.
  const webDist = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../web/dist",
  );
  if (existsSync(webDist)) {
    app.use(express.static(webDist));
    app.get(/^\/(?!api|ws).*/, (_req, res) => res.sendFile(path.join(webDist, "index.html")));
  }

  const httpServer = createServer(app);
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

  const focus = new Map<WebSocket, AssetId>();

  wss.on("connection", (ws) => {
    focus.set(ws, "btc");
    send(ws, { kind: "state", state: engine.appState() });
    send(ws, { kind: "chart", chart: engine.chartData("btc") });
    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as ClientMessage;
        if (msg.kind === "focus" && ASSET_IDS.includes(msg.asset)) {
          focus.set(ws, msg.asset);
          send(ws, { kind: "chart", chart: engine.chartData(msg.asset) });
        }
      } catch {
        /* ignore */
      }
    });
    ws.on("close", () => focus.delete(ws));
  });

  engine.onTick = (asset, source, tick) => {
    for (const [ws, focused] of focus) {
      if (focused === asset && ws.readyState === WebSocket.OPEN) {
        send(ws, { kind: "tick", asset, source, tick });
      }
    }
  };

  const broadcastTimer = setInterval(() => {
    if (wss.clients.size === 0) return;
    const state: ServerMessage = { kind: "state", state: engine.appState() };
    const encoded = JSON.stringify(state);
    for (const ws of wss.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(encoded);
    }
  }, BROADCAST_MS);

  httpServer.listen(SERVER_PORT, () => {
    engine.log("info", `server listening on http://localhost:${SERVER_PORT}`);
  });

  return {
    close: () => {
      clearInterval(broadcastTimer);
      wss.close();
      httpServer.close();
    },
  };
}

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}
