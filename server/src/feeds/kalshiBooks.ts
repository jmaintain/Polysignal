import WebSocket from "ws";
import type { TokenBook } from "@polysignal/shared";
import { bookImbalance, microprice } from "@polysignal/shared";
import { KALSHI_WS_PATH, KALSHI_WS_URL } from "../config.js";
import {
  normalizeLevels,
  signHeaders,
  topOfBook,
  type KalshiApi,
  type KalshiCredentials,
  type KalshiOrderbook,
} from "../services/kalshiApi.js";

export type BookSide = "up" | "down"; // up = YES (above strike), down = NO

export interface KalshiBooksOptions {
  onBook: (marketTicker: string, side: BookSide, book: TokenBook) => void;
  onStatus?: (connected: boolean) => void;
  log?: (msg: string) => void;
}

interface RawBook {
  yes: Map<number, number>; // price cents -> contracts (bids on YES)
  no: Map<number, number>; // price cents -> contracts (bids on NO)
  lastYesPrice: number | null;
  updatedTs: number | null;
}

const DEPTH_LEVELS = 5;

/**
 * Live YES/NO books for a set of Kalshi markets.
 *
 * With an API key: the authenticated websocket (orderbook_delta + ticker
 * channels) for full-depth, sub-second books. Without: REST polling of
 * top-of-book (batch /markets call every 2s) plus periodic depth snapshots.
 * Kalshi books quote bids per side; the ask on YES is 100c minus the best
 * NO bid.
 */
export class KalshiBooksFeed {
  private tickers: string[] = [];
  private books = new Map<string, RawBook>();
  private ws: WebSocket | null = null;
  private generation = 0;
  private closed = false;
  private applyTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private depthTimer: NodeJS.Timeout | null = null;
  private wsMsgId = 1;

  constructor(
    private readonly api: KalshiApi,
    private readonly creds: KalshiCredentials | null,
    private readonly opts: KalshiBooksOptions,
  ) {}

  get mode(): "ws" | "rest" {
    return this.creds ? "ws" : "rest";
  }

  setTickers(tickers: string[]): void {
    const sorted = [...tickers].sort().join(",");
    if (sorted === [...this.tickers].sort().join(",")) return;
    this.tickers = tickers;
    for (const t of tickers) {
      if (!this.books.has(t)) {
        this.books.set(t, { yes: new Map(), no: new Map(), lastYesPrice: null, updatedTs: null });
      }
    }
    for (const t of [...this.books.keys()]) if (!tickers.includes(t)) this.books.delete(t);
    if (this.applyTimer) clearTimeout(this.applyTimer);
    this.applyTimer = setTimeout(() => {
      this.applyTimer = null;
      if (this.mode === "ws") this.reconnectWs();
    }, 300);
  }

  start(): void {
    this.closed = false;
    if (this.mode === "rest") {
      // Kalshi rate-limits hard; one batch top-of-book call every 2.5s and
      // a slow depth loop keep us well under the unauthenticated budget.
      this.pollTimer = setInterval(() => void this.pollTopOfBook(), 2500);
      this.depthTimer = setInterval(() => void this.pollDepth(), 15000);
      this.opts.log?.("[kalshi-books] REST polling mode (no API key; add one for websocket depth)");
    }
  }

  stop(): void {
    this.closed = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.depthTimer) clearInterval(this.depthTimer);
    if (this.applyTimer) clearTimeout(this.applyTimer);
    this.teardownWs();
  }

  // ---- websocket mode -----------------------------------------------------

  private teardownWs(): void {
    const old = this.ws;
    this.ws = null;
    if (old) {
      old.removeAllListeners();
      old.on("error", () => {});
      if (old.readyState === WebSocket.CONNECTING) old.terminate();
      else old.close();
    }
  }

  private reconnectWs(): void {
    this.generation += 1;
    this.teardownWs();
    if (this.tickers.length > 0 && !this.closed) this.connectWs(this.generation);
  }

  private connectWs(gen: number): void {
    if (this.closed || gen !== this.generation || !this.creds) return;
    const ws = new WebSocket(KALSHI_WS_URL, {
      headers: signHeaders(this.creds, "GET", KALSHI_WS_PATH),
    });
    this.ws = ws;

    ws.on("open", () => {
      if (gen !== this.generation) return ws.close();
      this.opts.onStatus?.(true);
      ws.send(
        JSON.stringify({
          id: this.wsMsgId++,
          cmd: "subscribe",
          params: { channels: ["orderbook_delta", "ticker"], market_tickers: this.tickers },
        }),
      );
    });

    ws.on("message", (raw) => {
      try {
        this.handleWsMessage(JSON.parse(raw.toString()));
      } catch {
        /* ignore */
      }
    });

    const down = () => {
      this.opts.onStatus?.(false);
      if (this.closed || gen !== this.generation) return;
      setTimeout(() => this.connectWs(gen), 2000);
    };
    ws.on("close", down);
    ws.on("error", (err) => {
      this.opts.log?.(`[kalshi-ws] error: ${String(err)}`);
      ws.close();
    });
  }

  private handleWsMessage(m: Record<string, unknown>): void {
    const type = m.type as string | undefined;
    const msg = (m.msg ?? m) as Record<string, unknown>;
    const ticker = msg.market_ticker as string | undefined;
    if (!type || !ticker) return;
    const st = this.books.get(ticker);
    if (!st) return;

    if (type === "orderbook_snapshot") {
      const book = msg as KalshiOrderbook;
      st.yes = new Map(normalizeLevels(book.yes, book.yes_dollars));
      st.no = new Map(normalizeLevels(book.no, book.no_dollars));
      st.updatedTs = Date.now();
    } else if (type === "orderbook_delta") {
      // price may arrive as cents (legacy) or a dollar string (price_dollars).
      const price =
        msg.price_dollars != null
          ? Math.round(Number(msg.price_dollars) * 100)
          : Number(msg.price);
      const delta = Number(msg.delta ?? msg.delta_fp);
      const side = String(msg.side) === "no" ? st.no : st.yes;
      if (Number.isFinite(price) && Number.isFinite(delta)) {
        const next = (side.get(price) ?? 0) + delta;
        if (next <= 0) side.delete(price);
        else side.set(price, next);
        st.updatedTs = Date.now();
      }
    } else if (type === "ticker") {
      const p =
        msg.price_dollars != null
          ? Math.round(Number(msg.price_dollars) * 100)
          : Number(msg.price ?? msg.last_price);
      if (Number.isFinite(p) && p > 0) st.lastYesPrice = p;
      st.updatedTs = Date.now();
    } else {
      return;
    }
    this.emit(ticker, st);
  }

  // ---- REST polling mode --------------------------------------------------

  private async pollTopOfBook(): Promise<void> {
    if (this.tickers.length === 0) return;
    try {
      const body = await this.api.getMarkets({ tickers: this.tickers.join(","), limit: 100 });
      for (const m of body.markets ?? []) {
        const st = this.books.get(m.ticker);
        if (!st) continue;
        // Synthesize one-level books from top-of-book (both API shapes).
        const tob = topOfBook(m);
        const depthAge = Date.now() - (this.depthTs.get(m.ticker) ?? 0);
        if (tob.yesBid != null && depthAge > 20000) {
          st.yes = new Map([[Math.round(tob.yesBid * 100), 1]]);
        }
        if (tob.noBid != null && depthAge > 20000) {
          st.no = new Map([[Math.round(tob.noBid * 100), 1]]);
        }
        if (tob.last != null) st.lastYesPrice = Math.round(tob.last * 100);
        st.updatedTs = Date.now();
        this.emit(m.ticker, st);
      }
      this.opts.onStatus?.(true);
    } catch (err) {
      this.opts.onStatus?.(false);
      this.opts.log?.(`[kalshi-books] poll failed: ${(err as Error).message}`);
    }
  }

  private depthTs = new Map<string, number>();

  private async pollDepth(): Promise<void> {
    for (const ticker of this.tickers) {
      try {
        const body = await this.api.getOrderbook(ticker, DEPTH_LEVELS + 3);
        const book = body.orderbook_fp ?? body.orderbook;
        const st = this.books.get(ticker);
        if (!st || !book) continue;
        st.yes = new Map(normalizeLevels(book.yes, book.yes_dollars));
        st.no = new Map(normalizeLevels(book.no, book.no_dollars));
        st.updatedTs = Date.now();
        this.depthTs.set(ticker, Date.now());
        this.emit(ticker, st);
      } catch {
        /* best-effort depth */
      }
    }
  }

  // ---- shared -------------------------------------------------------------

  private emit(ticker: string, st: RawBook): void {
    this.opts.onBook(ticker, "up", sideBook(`${ticker}:yes`, st.yes, st.no, st.lastYesPrice, st.updatedTs));
    this.opts.onBook(
      ticker,
      "down",
      sideBook(
        `${ticker}:no`,
        st.no,
        st.yes,
        st.lastYesPrice != null ? 100 - st.lastYesPrice : null,
        st.updatedTs,
      ),
    );
  }
}

/**
 * Build a dollar-priced book for one side from its own bids and the
 * opposing side's bids (which imply this side's asks at 100 - price).
 */
function sideBook(
  tokenId: string,
  ownBids: Map<number, number>,
  otherBids: Map<number, number>,
  lastCents: number | null,
  updatedTs: number | null,
): TokenBook {
  const bids = [...ownBids.entries()].sort((a, b) => b[0] - a[0]);
  const asks = [...otherBids.entries()]
    .map(([p, c]): [number, number] => [100 - p, c])
    .sort((a, b) => a[0] - b[0]);
  const bestBid = bids[0] ?? null;
  const bestAsk = asks[0] ?? null;
  const bidDepth = bids.slice(0, DEPTH_LEVELS).reduce((s, [, c]) => s + c, 0);
  const askDepth = asks.slice(0, DEPTH_LEVELS).reduce((s, [, c]) => s + c, 0);
  const bb = bestBid ? bestBid[0] / 100 : null;
  const ba = bestAsk ? bestAsk[0] / 100 : null;
  return {
    tokenId,
    bestBid: bb,
    bestAsk: ba,
    mid: bb != null && ba != null ? (bb + ba) / 2 : null,
    spread: bb != null && ba != null ? ba - bb : null,
    microprice:
      bestBid && bestAsk ? microprice(bestBid[0] / 100, bestBid[1], bestAsk[0] / 100, bestAsk[1]) : null,
    imbalance: bookImbalance(bidDepth, askDepth),
    bidDepth,
    askDepth,
    lastTradePrice: lastCents != null ? lastCents / 100 : null,
    updatedTs,
  };
}
