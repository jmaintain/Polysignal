/**
 * Live validation harness (Kalshi + CF Benchmarks edition): proves the
 * monitor's prices are accurate, live, and faithful to the settlement
 * source (CF Benchmarks RTI, approximated by its constituent exchanges).
 *
 *   npm run validate              # ~40s live check
 *   npm run validate -- --settle  # + waits for a 15m expiry and grades our
 *                                 #   60s average against the actual result
 *
 * Checks:
 *   1. Constituent exchange feeds (Coinbase/Kraken/Bitstamp) are live and
 *      agree tightly; the 1 Hz composite proxy ticks steadily.
 *   2. Binance (lead indicator) tracks the proxy within tolerance.
 *   3. Kalshi discovery finds an active market for every asset/horizon
 *      with a sane strike and close time.
 *   4. Kalshi top-of-book obeys YES/NO identities (yes_ask = 100 - no_bid).
 *   5. (--settle) our proxy's final-minute average agrees with the actual
 *      settlement result of a real expiring market.
 */
import "dotenv/config";
import type { AssetId, PriceTick } from "@polysignal/shared";
import { ASSET_IDS, HORIZON_IDS, HORIZONS } from "./config.js";
import { IndexProxyService } from "./services/indexProxy.js";
import { discoverMarket } from "./services/discovery.js";
import { KalshiApi, loadCredentials, topOfBook } from "./services/kalshiApi.js";

interface CheckResult {
  name: string;
  pass: boolean | null;
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

async function main() {
  const settleMode = process.argv.includes("--settle");
  console.log("Polysignal live validation (Kalshi / CF Benchmarks)");
  console.log("===================================================\n");

  // ---- Phase 1: index proxy + binance (25s sample) -----------------------
  console.log("Phase 1: CF-RTI proxy feeds (25s sample)");
  const index: Record<AssetId, PriceTick[]> = { btc: [], eth: [], sol: [] };
  const binance: Record<AssetId, PriceTick[]> = { btc: [], eth: [], sol: [] };
  let sourcesSeen: Record<AssetId, string[]> = { btc: [], eth: [], sol: [] };
  const proxy = new IndexProxyService((m) => console.log(`    ${m}`));
  proxy.onIndexTick = (a, t) => index[a].push(t);
  proxy.onBinanceTick = (a, t) => binance[a].push(t);
  proxy.onSourcesChange = (a, s) => {
    if (s.length > sourcesSeen[a].length) sourcesSeen[a] = s;
  };
  proxy.start();
  await sleep(25000);

  for (const asset of ASSET_IDS) {
    const label = asset.toUpperCase();
    record(
      `${label} proxy composite`,
      index[asset].length >= 15,
      `${index[asset].length} ticks in 25s from [${sourcesSeen[asset].join(", ")}]`,
    );
    if (index[asset].length > 0 && binance[asset].length > 0) {
      const basis: number[] = [];
      for (const t of index[asset]) {
        const b = binance[asset].reduce((best, x) =>
          Math.abs(x.ts - t.ts) < Math.abs(best.ts - t.ts) ? x : best,
        );
        if (Math.abs(b.ts - t.ts) < 2000) basis.push(Math.abs(b.price - t.price) / t.price);
      }
      const med = median(basis);
      record(
        `${label} binance vs proxy`,
        basis.length > 0 && med < 0.005,
        basis.length > 0 ? `median |basis| ${(med * 100).toFixed(3)}%` : "no overlapping pairs",
      );
    }
  }

  // ---- Phase 2: Kalshi discovery -----------------------------------------
  console.log("\nPhase 2: Kalshi market discovery");
  const api = new KalshiApi(loadCredentials());
  try {
    await api.getMarkets({ limit: 1 });
    record("kalshi api reachable", true, "GET /markets OK");
  } catch (err) {
    record("kalshi api reachable", false, (err as Error).message);
  }

  const now = Date.now();
  const found: { asset: AssetId; horizon: string; ticker: string; strike: number; endTs: number }[] = [];
  for (const asset of ASSET_IDS) {
    const spot = index[asset][index[asset].length - 1]?.price ?? null;
    for (const horizon of HORIZON_IDS) {
      try {
        const { info } = await discoverMarket(api, asset, horizon, now, spot, () => {});
        const secsLeft = (info.endTs - now) / 1000;
        const okWindow = secsLeft > 0 && secsLeft <= HORIZONS[horizon].seconds + 3600;
        const strikeSane =
          spot == null || (info.strike > spot * 0.5 && info.strike < spot * 2);
        record(
          `${asset.toUpperCase()} ${horizon} market`,
          okWindow && strikeSane,
          `${info.ticker} strike ${info.strike} ends in ${Math.round(secsLeft)}s`,
        );
        found.push({ asset, horizon, ticker: info.ticker, strike: info.strike, endTs: info.endTs });
      } catch (err) {
        record(`${asset.toUpperCase()} ${horizon} market`, false, (err as Error).message);
      }
    }
  }

  // ---- Phase 3: top-of-book identities -----------------------------------
  console.log("\nPhase 3: order book sanity");
  if (found.length > 0) {
    try {
      const body = await api.getMarkets({
        tickers: found.map((f) => f.ticker).join(","),
        limit: 100,
      });
      for (const m of body.markets ?? []) {
        const tob = topOfBook(m);
        if (tob.yesBid == null || tob.yesAsk == null || tob.noBid == null) {
          record(`book ${m.ticker}`, false, `missing top-of-book (${JSON.stringify(tob)})`);
          continue;
        }
        const identity = Math.abs(tob.yesAsk - (1 - tob.noBid));
        record(
          `book ${m.ticker}`,
          tob.yesBid < tob.yesAsk && identity <= 0.011,
          `yes ${(tob.yesBid * 100).toFixed(0)}/${(tob.yesAsk * 100).toFixed(0)}c ` +
            `no_bid ${(tob.noBid * 100).toFixed(0)}c (identity off by ${(identity * 100).toFixed(1)}c)`,
        );
      }
    } catch (err) {
      record("top-of-book fetch", false, (err as Error).message);
    }
  }

  // ---- Phase 4: settlement agreement (optional) --------------------------
  if (settleMode) {
    console.log("\nPhase 4: settlement agreement (waits for a 15m expiry)");
    const next15 = found
      .filter((f) => f.horizon === "15m")
      .sort((a, b) => a.endTs - b.endTs)[0];
    if (!next15) {
      record("settlement agreement", null, "no 15m market discovered");
    } else {
      const waitMs = next15.endTs - Date.now() + 3000;
      console.log(
        `  watching ${next15.ticker} (strike ${next15.strike}), expires in ${(waitMs / 1000 / 60).toFixed(1)}min`,
      );
      await sleep(Math.max(waitMs, 0));
      const windowStart = next15.endTs - 60000;
      const windowTicks = index[next15.asset].filter(
        (t) => t.ts >= windowStart && t.ts <= next15.endTs,
      );
      if (windowTicks.length < 30) {
        record("settlement agreement", false, `only ${windowTicks.length} proxy ticks in window`);
      } else {
        const avg = windowTicks.reduce((s, t) => s + t.price, 0) / windowTicks.length;
        const ourCall = avg > next15.strike ? "yes" : "no";
        let result = "";
        for (let i = 0; i < 40 && !result; i++) {
          await sleep(15000);
          try {
            const m = await api.getMarket(next15.ticker);
            result = String(m.market.result ?? "");
          } catch {
            /* retry */
          }
        }
        const margin = Math.abs(avg - next15.strike);
        if (!result) {
          record("settlement agreement", null, "market not settled after 10min of polling");
        } else {
          record(
            "settlement agreement",
            result === ourCall,
            `our 60s avg ${avg.toFixed(2)} vs strike ${next15.strike} -> ${ourCall.toUpperCase()}; ` +
              `Kalshi settled ${result.toUpperCase()} (margin $${margin.toFixed(2)})`,
          );
        }
      }
    }
  }

  proxy.stop();

  console.log("\n===================================================");
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
