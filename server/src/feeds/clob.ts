import WebSocket from "ws";
import type { BookLevel, TokenBook } from "@polysignal/shared";
import { bookImbalance, microprice } from "@polysignal/shared";
import { CLOB_REST_URL, CLOB_WS_URL, USER_AGENT } from "../config.js";

const DEPTH_LEVELS = 5;

interface RawLevel {
  price: string | number;
  size: string | number;
}

interface BookState {
  bids: Map<number, number>;
  asks: Map<number, number>;
  lastTradePrice: number | null;
  updatedTs: number | null;
}

export interface ClobFeedOptions {
  onBook: (tokenId: string, book: TokenBook) => void;
  onStatus?: (connected: boolean) => void;
  log?: (msg: string) => void;
}

/**
 * Live order books for a set of CLOB token ids over the public market
 * channel. The subscription set is fixed per connection ("MARKET"
 * subscriptions cannot be extended dynamically), so `setTokens` reconnects
 * whenever the active market set rolls over.
 */
export class ClobMarketFeed {
  private ws: WebSocket | null = null;
  private tokens: string[] = [];
  private books = new Map<string, BookState>();
  private pingTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private generation = 0;

  constructor(private readonly opts: ClobFeedOptions) {}

  setTokens(tokens: string[]): void {
    const sorted = [...tokens].sort();
    if (sorted.join(",") === [...this.tokens].sort().join(",")) return;
    this.tokens = tokens;
    for (const t of tokens) {
      if (!this.books.has(t)) {
        this.books.set(t, { bids: new Map(), asks: new Map(), lastTradePrice: null, updatedTs: null });
      }
    }
    for (const t of [...this.books.keys()]) {
      if (!tokens.includes(t)) this.books.delete(t);
    }
    this.reconnect();
    // Seed with REST snapshots so odds appear before the first WS "book".
    void this.seedSnapshots(tokens);
  }

  stop(): void {
    this.closed = true;
    this.clearTimers();
    this.ws?.close();
    this.ws = null;
  }

  private clearTimers(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private reconnect(): void {
    this.generation += 1;
    this.clearTimers();
    this.ws?.removeAllListeners();
    this.ws?.close();
    this.ws = null;
    if (this.tokens.length > 0 && !this.closed) this.connect(this.generation);
  }

  private connect(gen: number): void {
    if (this.closed || gen !== this.generation) return;
    const ws = new WebSocket(CLOB_WS_URL);
    this.ws = ws;

    ws.on("open", () => {
      if (gen !== this.generation) return ws.close();
      this.opts.onStatus?.(true);
      ws.send(JSON.stringify({ auth: {}, type: "MARKET", assets_ids: this.tokens }));
      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.ping();
          ws.send("PING");
        }
      }, 10000);
    });

    ws.on("message", (raw) => {
      const text = raw.toString();
      if (!text || text === "PONG") return;
      try {
        const msg = JSON.parse(text);
        const events = Array.isArray(msg) ? msg : [msg];
        for (const ev of events) this.handleEvent(ev);
      } catch {
        /* ignore non-JSON frames */
      }
    });

    const onDown = () => {
      this.opts.onStatus?.(false);
      if (this.closed || gen !== this.generation) return;
      this.clearTimers();
      this.reconnectTimer = setTimeout(() => this.connect(gen), 2000);
    };
    ws.on("close", onDown);
    ws.on("error", (err) => {
      this.opts.log?.(`[clob-ws] error: ${String(err)}`);
      ws.close();
    });
  }

  private handleEvent(ev: unknown): void {
    if (typeof ev !== "object" || ev === null) return;
    const e = ev as Record<string, unknown>;
    const type = (e.event_type ?? e.type) as string | undefined;
    const tokenId = (e.asset_id ?? e.assetId) as string | undefined;
    if (!type || !tokenId) return;
    const st = this.books.get(tokenId);
    if (!st) return;

    if (type === "book") {
      st.bids = this.levelsToMap(e.bids ?? e.buys);
      st.asks = this.levelsToMap(e.asks ?? e.sells);
      st.updatedTs = Date.now();
    } else if (type === "price_change") {
      // Two shapes exist in the wild: {changes:[{price,side,size}]} and a
      // flat {price, side, size}.
      const changes = Array.isArray(e.changes) ? e.changes : [e];
      for (const c of changes) {
        const ch = c as Record<string, unknown>;
        const price = Number(ch.price);
        const size = Number(ch.size);
        const side = String(ch.side ?? "").toUpperCase();
        if (!Number.isFinite(price) || !Number.isFinite(size)) continue;
        const map = side === "BUY" || side === "BID" ? st.bids : st.asks;
        if (size <= 0) map.delete(price);
        else map.set(price, size);
      }
      st.updatedTs = Date.now();
    } else if (type === "last_trade_price") {
      const price = Number(e.price);
      if (Number.isFinite(price)) st.lastTradePrice = price;
      st.updatedTs = Date.now();
    } else {
      return;
    }
    this.emit(tokenId, st);
  }

  private levelsToMap(levels: unknown): Map<number, number> {
    const map = new Map<number, number>();
    if (!Array.isArray(levels)) return map;
    for (const l of levels as RawLevel[]) {
      const price = Number(l.price);
      const size = Number(l.size);
      if (price > 0 && size > 0) map.set(price, size);
    }
    return map;
  }

  private emit(tokenId: string, st: BookState): void {
    this.opts.onBook(tokenId, computeTokenBook(tokenId, st));
  }

  private async seedSnapshots(tokens: string[]): Promise<void> {
    for (const tokenId of tokens) {
      try {
        const res = await fetch(`${CLOB_REST_URL}/book?token_id=${tokenId}`, {
          headers: { "user-agent": USER_AGENT },
          signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) continue;
        const body = (await res.json()) as { bids?: RawLevel[]; asks?: RawLevel[] };
        const st = this.books.get(tokenId);
        // Only seed if the WS has not delivered a fresher book already.
        if (!st || st.updatedTs !== null) continue;
        st.bids = this.levelsToMap(body.bids);
        st.asks = this.levelsToMap(body.asks);
        st.updatedTs = Date.now();
        this.emit(tokenId, st);
      } catch {
        /* snapshot is best-effort */
      }
    }
  }
}

export function computeTokenBook(tokenId: string, st: BookState): TokenBook {
  const bids = [...st.bids.entries()]
    .map(([price, size]): BookLevel => ({ price, size }))
    .sort((a, b) => b.price - a.price);
  const asks = [...st.asks.entries()]
    .map(([price, size]): BookLevel => ({ price, size }))
    .sort((a, b) => a.price - b.price);
  const bestBid = bids[0] ?? null;
  const bestAsk = asks[0] ?? null;
  const bidDepth = bids.slice(0, DEPTH_LEVELS).reduce((s, l) => s + l.size, 0);
  const askDepth = asks.slice(0, DEPTH_LEVELS).reduce((s, l) => s + l.size, 0);
  return {
    tokenId,
    bestBid: bestBid?.price ?? null,
    bestAsk: bestAsk?.price ?? null,
    mid: bestBid && bestAsk ? (bestBid.price + bestAsk.price) / 2 : null,
    spread: bestBid && bestAsk ? bestAsk.price - bestBid.price : null,
    microprice:
      bestBid && bestAsk
        ? microprice(bestBid.price, bestBid.size, bestAsk.price, bestAsk.size)
        : null,
    imbalance: bookImbalance(bidDepth, askDepth),
    bidDepth,
    askDepth,
    lastTradePrice: st.lastTradePrice,
    updatedTs: st.updatedTs,
  };
}
