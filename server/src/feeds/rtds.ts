import WebSocket from "ws";
import type { PriceTick } from "@polysignal/shared";
import { RTDS_URL } from "../config.js";

export type RtdsTopic = "crypto_prices" | "crypto_prices_chainlink";

export interface RtdsFeedOptions {
  topic: RtdsTopic;
  symbol: string;
  onTick: (tick: PriceTick) => void;
  /** Initial history dump the server sends right after subscribing. */
  onHistory?: (ticks: PriceTick[]) => void;
  onStatus?: (connected: boolean) => void;
  log?: (msg: string) => void;
  url?: string;
}

const PING_INTERVAL_MS = 5000;

/**
 * One websocket per (topic, symbol) against Polymarket's Real-Time Data
 * Service. The chainlink topic mirrors the exact Chainlink price stream
 * Polymarket uses to resolve its crypto up/down markets.
 *
 * Protocol (from Polymarket/real-time-data-client):
 *   -> {"action":"subscribe","subscriptions":[{"topic":T,"type":"update","filters":"{\"symbol\":\"btc/usd\"}"}]}
 *   -> "ping" every 5s
 *   <- {"topic":T,"type":"update","payload":{"symbol":s,"timestamp":ms,"value":px}}
 *   <- initial dump: payload {"symbol":s,"data":[{"timestamp":ms,"value":px},...]}
 */
export class RtdsFeed {
  private ws: WebSocket | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private reconnectDelay = 1000;
  private closed = false;

  constructor(private readonly opts: RtdsFeedOptions) {}

  start(): void {
    this.closed = false;
    this.connect();
  }

  stop(): void {
    this.closed = true;
    this.clearPing();
    this.ws?.close();
    this.ws = null;
  }

  private clearPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private connect(): void {
    if (this.closed) return;
    const url = this.opts.url ?? RTDS_URL;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on("open", () => {
      this.reconnectDelay = 1000;
      this.opts.onStatus?.(true);
      ws.send(
        JSON.stringify({
          action: "subscribe",
          subscriptions: [
            {
              topic: this.opts.topic,
              type: "update",
              filters: JSON.stringify({ symbol: this.opts.symbol }),
            },
          ],
        }),
      );
      this.clearPing();
      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send("ping");
      }, PING_INTERVAL_MS);
    });

    ws.on("message", (raw) => {
      const text = raw.toString();
      if (!text || !text.includes("payload")) return;
      try {
        const msg = JSON.parse(text);
        this.handleMessage(msg);
      } catch {
        /* non-JSON frame (pong etc.) */
      }
    });

    const onDown = () => {
      this.clearPing();
      this.opts.onStatus?.(false);
      if (this.closed) return;
      const delay = this.reconnectDelay;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 15000);
      this.opts.log?.(
        `[rtds ${this.opts.topic}/${this.opts.symbol}] disconnected, retrying in ${delay}ms`,
      );
      setTimeout(() => this.connect(), delay);
    };

    ws.on("close", onDown);
    ws.on("error", (err) => {
      this.opts.log?.(`[rtds ${this.opts.topic}/${this.opts.symbol}] error: ${String(err)}`);
      ws.close();
    });
  }

  private handleMessage(msg: unknown): void {
    if (typeof msg !== "object" || msg === null) return;
    const m = msg as Record<string, unknown>;
    const topic = (m.topic ?? m.channel) as string | undefined;
    if (topic !== undefined && !String(topic).includes(this.opts.topic)) {
      // Topic strings have been seen both as "crypto_prices_chainlink" and
      // dotted forms like "prices.crypto.chainlink"; accept either.
      const dotted = this.opts.topic === "crypto_prices_chainlink" ? "chainlink" : "crypto";
      if (!String(topic).includes(dotted)) return;
    }
    const payload = m.payload as Record<string, unknown> | undefined;
    if (!payload) return;

    // History dump: payload.data is an array of {timestamp, value}.
    const data = payload.data;
    if (Array.isArray(data)) {
      const ticks: PriceTick[] = [];
      for (const d of data) {
        const t = this.parseTick(d);
        if (t) ticks.push(t);
      }
      ticks.sort((a, b) => a.ts - b.ts);
      if (ticks.length > 0) this.opts.onHistory?.(ticks);
      return;
    }

    const tick = this.parseTick(payload);
    if (tick) this.opts.onTick(tick);
  }

  private parseTick(obj: unknown): PriceTick | null {
    if (typeof obj !== "object" || obj === null) return null;
    const o = obj as Record<string, unknown>;
    const value = Number(o.value ?? o.price);
    let ts = Number(o.timestamp ?? o.ts);
    if (!(value > 0) || !Number.isFinite(ts)) return null;
    // Normalize second-resolution timestamps to ms.
    if (ts < 1e12) ts *= 1000;
    return { ts, price: value };
  }
}
