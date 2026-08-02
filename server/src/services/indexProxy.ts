import type { AssetId, PriceTick } from "@polysignal/shared";
import { ASSET_IDS, INDEX_SAMPLE_MS, INDEX_STALE_MS } from "../config.js";
import {
  BinanceFeed,
  BitstampFeed,
  CoinbaseFeed,
  KrakenFeed,
  type QuoteHandler,
} from "../feeds/exchanges.js";

interface Quote {
  mid: number;
  ts: number;
}

/**
 * CF Benchmarks RTI proxy: samples a composite (median) of the index's
 * constituent USD exchanges once per second, mirroring the RTI's 1s
 * cadence. Also samples Binance separately as the lead indicator.
 *
 * This is a proxy, not the licensed index — the validation harness proves
 * its accuracy against Kalshi's actual settlements.
 */
export class IndexProxyService {
  private quotes = new Map<AssetId, Map<string, Quote>>();
  private binanceQuote = new Map<AssetId, Quote>();
  private feeds: { start(): void; stop(): void }[] = [];
  private sampler: NodeJS.Timeout | null = null;

  onIndexTick: ((asset: AssetId, tick: PriceTick) => void) | null = null;
  onBinanceTick: ((asset: AssetId, tick: PriceTick) => void) | null = null;
  onSourcesChange: ((asset: AssetId, sourcesUp: string[]) => void) | null = null;

  constructor(private readonly log: (msg: string) => void) {
    for (const a of ASSET_IDS) this.quotes.set(a, new Map());
    const onQuote: QuoteHandler = (exchange, asset, mid, ts) => {
      this.quotes.get(asset)!.set(exchange, { mid, ts });
    };
    this.feeds = [
      new CoinbaseFeed(onQuote, log),
      new KrakenFeed(onQuote, log),
      new BitstampFeed(onQuote, log),
      new BinanceFeed((_ex, asset, mid, ts) => this.binanceQuote.set(asset, { mid, ts }), log),
    ];
  }

  start(): void {
    for (const f of this.feeds) f.start();
    this.sampler = setInterval(() => this.sample(), INDEX_SAMPLE_MS);
  }

  stop(): void {
    if (this.sampler) clearInterval(this.sampler);
    for (const f of this.feeds) f.stop();
  }

  /** Constituent exchanges currently fresh for an asset. */
  sourcesUp(asset: AssetId): string[] {
    const now = Date.now();
    return [...this.quotes.get(asset)!.entries()]
      .filter(([, q]) => now - q.ts <= INDEX_STALE_MS)
      .map(([name]) => name)
      .sort();
  }

  private sample(): void {
    const now = Date.now();
    for (const asset of ASSET_IDS) {
      const fresh = [...this.quotes.get(asset)!.values()]
        .filter((q) => now - q.ts <= INDEX_STALE_MS)
        .map((q) => q.mid)
        .sort((a, b) => a - b);
      this.onSourcesChange?.(asset, this.sourcesUp(asset));
      if (fresh.length >= 1) {
        const mid =
          fresh.length % 2 === 1
            ? fresh[(fresh.length - 1) / 2]
            : (fresh[fresh.length / 2 - 1] + fresh[fresh.length / 2]) / 2;
        this.onIndexTick?.(asset, { ts: now, price: mid });
      }
      const bn = this.binanceQuote.get(asset);
      if (bn && now - bn.ts <= INDEX_STALE_MS) {
        this.onBinanceTick?.(asset, { ts: now, price: bn.mid });
      }
    }
  }
}
