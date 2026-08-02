import WebSocket from "ws";
import type { AssetId } from "@polysignal/shared";
import { ASSETS, ASSET_IDS } from "../config.js";

export type QuoteHandler = (
  exchange: string,
  asset: AssetId,
  mid: number,
  tsMs: number,
) => void;

/**
 * Reconnecting websocket base for the CF-RTI constituent exchanges.
 * Each subclass maintains one connection covering all three assets and
 * reports top-of-book mids (the RTI itself is computed from constituent
 * exchange order books, so mids are the faithful proxy input).
 */
abstract class BaseFeed {
  protected ws: WebSocket | null = null;
  private closed = false;
  private reconnectDelay = 1000;

  constructor(
    protected readonly onQuote: QuoteHandler,
    protected readonly log: (msg: string) => void,
  ) {}

  abstract readonly name: string;
  protected abstract url(): string;
  protected abstract onOpen(ws: WebSocket): void;
  protected abstract onMessage(text: string): void;

  start(): void {
    this.closed = false;
    this.connect();
  }

  stop(): void {
    this.closed = true;
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.on("error", () => {});
      this.ws.terminate();
      this.ws = null;
    }
  }

  private connect(): void {
    if (this.closed) return;
    const ws = new WebSocket(this.url());
    this.ws = ws;
    ws.on("open", () => {
      this.reconnectDelay = 1000;
      this.onOpen(ws);
    });
    ws.on("message", (raw) => {
      try {
        this.onMessage(raw.toString());
      } catch {
        /* tolerate malformed frames */
      }
    });
    ws.on("ping", () => ws.pong());
    const down = () => {
      if (this.closed) return;
      const delay = this.reconnectDelay;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 20000);
      this.log(`[${this.name}] disconnected, retrying in ${delay}ms`);
      setTimeout(() => this.connect(), delay);
    };
    ws.on("close", down);
    ws.on("error", (err) => {
      this.log(`[${this.name}] error: ${String(err)}`);
      ws.close();
    });
  }
}

export class CoinbaseFeed extends BaseFeed {
  readonly name = "coinbase";
  private products = new Map<string, AssetId>(
    ASSET_IDS.map((a) => [ASSETS[a].coinbaseProduct, a]),
  );

  protected url(): string {
    return "wss://ws-feed.exchange.coinbase.com";
  }

  protected onOpen(ws: WebSocket): void {
    ws.send(
      JSON.stringify({
        type: "subscribe",
        product_ids: [...this.products.keys()],
        channels: ["ticker"],
      }),
    );
  }

  protected onMessage(text: string): void {
    const m = JSON.parse(text);
    if (m.type !== "ticker") return;
    const asset = this.products.get(m.product_id);
    if (!asset) return;
    const bid = Number(m.best_bid);
    const ask = Number(m.best_ask);
    const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : Number(m.price);
    if (mid > 0) this.onQuote(this.name, asset, mid, Date.now());
  }
}

export class KrakenFeed extends BaseFeed {
  readonly name = "kraken";
  private pairs = new Map<string, AssetId>(ASSET_IDS.map((a) => [ASSETS[a].krakenPair, a]));

  protected url(): string {
    return "wss://ws.kraken.com";
  }

  protected onOpen(ws: WebSocket): void {
    ws.send(
      JSON.stringify({
        event: "subscribe",
        pair: [...this.pairs.keys()],
        subscription: { name: "ticker" },
      }),
    );
  }

  protected onMessage(text: string): void {
    const m = JSON.parse(text);
    // Ticker frames are arrays: [channelId, data, "ticker", "XBT/USD"]
    if (!Array.isArray(m) || m.length < 4 || m[2] !== "ticker") return;
    const asset = this.pairs.get(String(m[3]));
    if (!asset) return;
    const d = m[1] as { b?: string[]; a?: string[] };
    const bid = Number(d.b?.[0]);
    const ask = Number(d.a?.[0]);
    if (bid > 0 && ask > 0) this.onQuote(this.name, asset, (bid + ask) / 2, Date.now());
  }
}

export class BitstampFeed extends BaseFeed {
  readonly name = "bitstamp";
  private channels = new Map<string, AssetId>(
    ASSET_IDS.map((a) => [`order_book_${ASSETS[a].bitstampChannelSuffix}`, a]),
  );

  protected url(): string {
    return "wss://ws.bitstamp.net";
  }

  protected onOpen(ws: WebSocket): void {
    for (const channel of this.channels.keys()) {
      ws.send(JSON.stringify({ event: "bts:subscribe", data: { channel } }));
    }
  }

  protected onMessage(text: string): void {
    const m = JSON.parse(text);
    if (m.event !== "data") return;
    const asset = this.channels.get(String(m.channel));
    if (!asset) return;
    const bid = Number(m.data?.bids?.[0]?.[0]);
    const ask = Number(m.data?.asks?.[0]?.[0]);
    if (bid > 0 && ask > 0) this.onQuote(this.name, asset, (bid + ask) / 2, Date.now());
  }
}

/**
 * Binance lead-indicator feed (not an RTI constituent, which is what makes
 * it an orthogonal signal). Combined bookTicker stream, one connection.
 */
export class BinanceFeed extends BaseFeed {
  readonly name = "binance";
  private symbols = new Map<string, AssetId>(
    ASSET_IDS.map((a) => [ASSETS[a].binanceSymbol.toUpperCase(), a]),
  );

  protected url(): string {
    const streams = ASSET_IDS.map((a) => `${ASSETS[a].binanceSymbol}@bookTicker`).join("/");
    return `wss://stream.binance.com:9443/stream?streams=${streams}`;
  }

  protected onOpen(): void {
    /* combined streams need no subscribe message */
  }

  protected onMessage(text: string): void {
    const m = JSON.parse(text);
    const d = m.data ?? m;
    const asset = this.symbols.get(String(d.s ?? ""));
    if (!asset) return;
    const bid = Number(d.b);
    const ask = Number(d.a);
    if (bid > 0 && ask > 0) this.onQuote(this.name, asset, (bid + ask) / 2, Date.now());
  }
}
