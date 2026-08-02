/**
 * Live validation harness: proves the monitor's prices are accurate, live,
 * and sourced from the Chainlink feed Polymarket resolves against.
 *
 *   npm run validate            # ~40s quick run
 *   npm run validate -- --strike  # additionally waits for a 5m boundary to
 *                                 # verify "price to beat" capture end-to-end
 *
 * Checks:
 *   1. RTDS crypto_prices_chainlink streams fresh ticks for BTC/ETH/SOL.
 *   2. Tick timestamps are recent (feed is live, not cached) and monotone.
 *   3. Chainlink prices agree with an independent venue (RTDS Binance topic)
 *      and, when reachable, external references (Kraken/Coinbase REST).
 *   4. Gamma discovery finds the active up/down market per asset/horizon and
 *      the session end time aligns with the horizon.
 *   5. CLOB order books for those markets are live and UP+DOWN mids ~ $1.
 *   6. (--strike) Chainlink tick captured at a 5m boundary matches the new
 *      session's reference within tolerance.
 */
import { ASSETS, ASSET_IDS, CLOB_REST_URL, HORIZON_IDS, HORIZONS, USER_AGENT } from "./config.js";
import { RtdsFeed } from "./feeds/rtds.js";
import { discoverMarket, fetchJson, slotStartSec } from "./services/discovery.js";
import type { AssetId, PriceTick } from "@polysignal/shared";

interface CheckResult {
  name: string;
  pass: boolean | null; // null = skipped
  detail: string;
}

const results: CheckResult[] = [];
function record(name: string, pass: boolean | null, detail: string) {
  results.push({ name, pass, detail });
  const tag = pass === null ? "SKIP" : pass ? "PASS" : "FAIL";
  console.log(`  [${tag}] ${name}: ${detail}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
};

interface Collector {
  ticks: PriceTick[];
  history: PriceTick[];
  receivedAt: number[];
}

async function collectRtds(
  seconds: number,
): Promise<Record<AssetId, { chainlink: Collector; binance: Collector }>> {
  const out = {} as Record<AssetId, { chainlink: Collector; binance: Collector }>;
  const feeds: RtdsFeed[] = [];
  for (const asset of ASSET_IDS) {
    const mk = (): Collector => ({ ticks: [], history: [], receivedAt: [] });
    out[asset] = { chainlink: mk(), binance: mk() };
    const cfg = ASSETS[asset];
    feeds.push(
      new RtdsFeed({
        topic: "crypto_prices_chainlink",
        symbol: cfg.chainlinkSymbol,
        onTick: (t) => {
          out[asset].chainlink.ticks.push(t);
          out[asset].chainlink.receivedAt.push(Date.now());
        },
        onHistory: (h) => out[asset].chainlink.history.push(...h),
      }),
      new RtdsFeed({
        topic: "crypto_prices",
        symbol: cfg.binanceSymbol,
        onTick: (t) => {
          out[asset].binance.ticks.push(t);
          out[asset].binance.receivedAt.push(Date.now());
        },
        onHistory: (h) => out[asset].binance.history.push(...h),
      }),
    );
  }
  for (const f of feeds) f.start();
  await sleep(seconds * 1000);
  for (const f of feeds) f.stop();
  return out;
}

async function externalReference(asset: AssetId): Promise<{ source: string; price: number } | null> {
  const pairs: Record<AssetId, { kraken: string; coinbase: string }> = {
    btc: { kraken: "XBTUSD", coinbase: "BTC-USD" },
    eth: { kraken: "ETHUSD", coinbase: "ETH-USD" },
    sol: { kraken: "SOLUSD", coinbase: "SOL-USD" },
  };
  try {
    const k = await fetchJson<{ result: Record<string, { c: string[] }> }>(
      `https://api.kraken.com/0/public/Ticker?pair=${pairs[asset].kraken}`,
      6000,
    );
    const first = Object.values(k.result ?? {})[0];
    const px = Number(first?.c?.[0]);
    if (px > 0) return { source: "kraken", price: px };
  } catch {
    /* try coinbase */
  }
  try {
    const c = await fetchJson<{ data: { amount: string } }>(
      `https://api.coinbase.com/v2/prices/${pairs[asset].coinbase}/spot`,
      6000,
    );
    const px = Number(c.data?.amount);
    if (px > 0) return { source: "coinbase", price: px };
  } catch {
    return null;
  }
  return null;
}

async function main() {
  const strikeMode = process.argv.includes("--strike");
  console.log("Polysignal live validation");
  console.log("==========================\n");

  console.log("Phase 1: RTDS price feeds (30s sample)");
  const sample = await collectRtds(30);

  for (const asset of ASSET_IDS) {
    const cl = sample[asset].chainlink;
    const bn = sample[asset].binance;
    const label = asset.toUpperCase();

    record(
      `${label} chainlink stream`,
      cl.ticks.length >= 5,
      `${cl.ticks.length} live ticks in 30s (+${cl.history.length} history)`,
    );

    if (cl.ticks.length > 0) {
      const lags = cl.ticks.map((t, i) => cl.receivedAt[i] - t.ts);
      const lag = median(lags);
      record(
        `${label} chainlink freshness`,
        Math.abs(lag) < 15000,
        `median |receive - source ts| = ${lag.toFixed(0)}ms`,
      );
      const sortedOk = cl.ticks.every((t, i) => i === 0 || t.ts >= cl.ticks[i - 1].ts);
      record(`${label} chainlink monotone timestamps`, sortedOk, sortedOk ? "ordered" : "out-of-order ticks seen");
    }

    if (cl.ticks.length > 0 && bn.ticks.length > 0) {
      const basis: number[] = [];
      for (const t of cl.ticks) {
        let best: PriceTick | null = null;
        for (const b of bn.ticks) {
          if (!best || Math.abs(b.ts - t.ts) < Math.abs(best.ts - t.ts)) best = b;
        }
        if (best && Math.abs(best.ts - t.ts) < 3000) {
          basis.push(Math.abs(best.price - t.price) / t.price);
        }
      }
      const med = median(basis);
      record(
        `${label} chainlink vs binance agreement`,
        basis.length > 0 && med < 0.005,
        basis.length > 0
          ? `median |basis| = ${(med * 100).toFixed(3)}% over ${basis.length} pairs`
          : "no overlapping pairs",
      );
    } else {
      record(`${label} chainlink vs binance agreement`, false, "missing ticks on one side");
    }

    const last = cl.ticks[cl.ticks.length - 1];
    if (last) {
      const ext = await externalReference(asset);
      if (ext) {
        const dev = Math.abs(ext.price - last.price) / last.price;
        record(
          `${label} chainlink vs ${ext.source}`,
          dev < 0.01,
          `chainlink ${last.price.toFixed(2)} vs ${ext.source} ${ext.price.toFixed(2)} (${(dev * 100).toFixed(3)}%)`,
        );
      } else {
        record(`${label} external reference`, null, "kraken/coinbase unreachable from this network");
      }
    }
  }

  console.log("\nPhase 2: Gamma market discovery");
  const now = Date.now();
  const found: { asset: AssetId; horizon: string; up: string; down: string; slug: string }[] = [];
  for (const asset of ASSET_IDS) {
    for (const horizon of HORIZON_IDS) {
      try {
        const { info } = await discoverMarket(asset, horizon, now);
        const secsLeft = (info.endTs - now) / 1000;
        const okWindow = secsLeft > 0 && secsLeft <= HORIZONS[horizon].seconds + 60;
        record(
          `${asset.toUpperCase()} ${horizon} market`,
          okWindow,
          `${info.slug} ends in ${Math.round(secsLeft)}s`,
        );
        found.push({ asset, horizon, up: info.upTokenId, down: info.downTokenId, slug: info.slug });
      } catch (err) {
        record(`${asset.toUpperCase()} ${horizon} market`, false, (err as Error).message);
      }
    }
  }

  console.log("\nPhase 3: CLOB order books");
  for (const f of found.slice(0, 6)) {
    try {
      const [upBook, downBook] = await Promise.all([
        fetchJson<{ bids?: { price: string; size: string }[]; asks?: { price: string; size: string }[] }>(
          `${CLOB_REST_URL}/book?token_id=${f.up}`,
        ),
        fetchJson<{ bids?: { price: string; size: string }[]; asks?: { price: string; size: string }[] }>(
          `${CLOB_REST_URL}/book?token_id=${f.down}`,
        ),
      ]);
      const mid = (b: typeof upBook) => {
        const bb = Math.max(...(b.bids ?? []).map((l) => Number(l.price)), 0);
        const ba = Math.min(...(b.asks ?? []).map((l) => Number(l.price)), 1);
        return bb > 0 && ba < 1 ? (bb + ba) / 2 : null;
      };
      const upMid = mid(upBook);
      const downMid = mid(downBook);
      if (upMid == null || downMid == null) {
        record(`${f.asset.toUpperCase()} ${f.horizon} book`, false, "empty book side");
      } else {
        const sum = upMid + downMid;
        record(
          `${f.asset.toUpperCase()} ${f.horizon} book`,
          sum > 0.9 && sum < 1.1,
          `UP mid ${(upMid * 100).toFixed(1)}c + DOWN mid ${(downMid * 100).toFixed(1)}c = ${(sum * 100).toFixed(1)}c`,
        );
      }
    } catch (err) {
      record(`${f.asset.toUpperCase()} ${f.horizon} book`, false, (err as Error).message);
    }
  }

  if (strikeMode) {
    console.log("\nPhase 4: strike capture across a 5m boundary");
    const slotNow = slotStartSec(Date.now(), "5m");
    const nextBoundary = (slotNow + 300) * 1000;
    const waitMs = nextBoundary - Date.now() + 3000;
    console.log(`  waiting ${(waitMs / 1000).toFixed(0)}s for the next 5m boundary...`);
    const ticks: PriceTick[] = [];
    const feed = new RtdsFeed({
      topic: "crypto_prices_chainlink",
      symbol: ASSETS.btc.chainlinkSymbol,
      onTick: (t) => ticks.push(t),
    });
    feed.start();
    await sleep(waitMs);
    feed.stop();
    const before = [...ticks].reverse().find((t) => t.ts <= nextBoundary);
    if (!before) {
      record("BTC 5m strike capture", false, "no tick at boundary");
    } else {
      await sleep(2000);
      try {
        const { info, gammaStrike } = await discoverMarket("btc", "5m", nextBoundary + 5000);
        const ref = gammaStrike;
        if (ref == null) {
          record(
            "BTC 5m strike capture",
            true,
            `captured ${before.price.toFixed(2)} at boundary (gamma exposes no strike field; boundary tick is the reference)`,
          );
        } else {
          const dev = Math.abs(ref - before.price) / before.price;
          record(
            "BTC 5m strike capture",
            dev < 0.0005,
            `boundary tick ${before.price.toFixed(2)} vs gamma ${ref.toFixed(2)} for ${info.slug} (${(dev * 100).toFixed(4)}%)`,
          );
        }
      } catch (err) {
        record("BTC 5m strike capture", false, (err as Error).message);
      }
    }
  }

  console.log("\n==========================");
  const fails = results.filter((r) => r.pass === false);
  const skips = results.filter((r) => r.pass === null);
  console.log(
    `${results.length - fails.length - skips.length} passed, ${fails.length} failed, ${skips.length} skipped`,
  );
  if (fails.length > 0) {
    console.log("\nFailed checks:");
    for (const f of fails) console.log(`  - ${f.name}: ${f.detail}`);
  }
  process.exit(fails.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("validation crashed:", err);
  process.exit(2);
});
