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
import { discoverMarket, isNotListed } from "./services/discovery.js";
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

/**
 * Realized volatility (per sqrt-second) from ticks resampled onto a grid.
 * Comparing across sampling intervals is the standard signature test for
 * microstructure noise: if sigma at 1s far exceeds sigma at 15s, the
 * short-interval estimate is measuring venue jitter, not price movement —
 * and an inflated sigma drags every model probability toward 50 cents.
 */
function realizedVol(ticks: PriceTick[], sampleSec: number): number {
  if (ticks.length < 3) return NaN;
  const sampled: number[] = [];
  let nextTs = ticks[0].ts;
  for (const t of ticks) {
    if (t.ts >= nextTs) {
      sampled.push(t.price);
      nextTs = t.ts + sampleSec * 1000;
    }
  }
  if (sampled.length < 4) return NaN;
  const rets = sampled.slice(1).map((p, i) => Math.log(p / sampled[i]));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const varr = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(varr / sampleSec);
}

const annualize = (sigmaPerSqrtSec: number) => sigmaPerSqrtSec * Math.sqrt(365 * 24 * 3600);

async function main() {
  // Accept the flag or an env var — npm can swallow forwarded args.
  const settleMode =
    process.argv.includes("--settle") ||
    process.env.SETTLE === "1" ||
    process.env.SETTLE === "true" ||
    process.env.npm_config_settle === "true";
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
        // Retry once across a session rollover: at :00/:15/:30/:45 the old
        // 15m market is untradeable and the new one may not be listed yet,
        // which is an exchange timing artifact rather than a defect.
        let info;
        try {
          ({ info } = await discoverMarket(api, asset, horizon, Date.now(), spot));
        } catch (err) {
          if (!isNotListed(err)) throw err;
          console.log(`    ${asset.toUpperCase()} ${horizon}: nothing listed, retrying in 10s…`);
          await sleep(10000);
          ({ info } = await discoverMarket(api, asset, horizon, Date.now(), spot));
        }
        const secsLeft = (info.endTs - Date.now()) / 1000;
        const okWindow = secsLeft > 0 && secsLeft <= HORIZONS[horizon].seconds + 3600;
        // The tracked strike must be the at-the-money rung. A truncated
        // ladder shows up here as a strike far from spot.
        const drift = spot != null ? Math.abs(info.strike - spot) / spot : 0;
        const atmOk = spot == null || drift <= (horizon === "1d" ? 0.05 : 0.01);
        record(
          `${asset.toUpperCase()} ${horizon} market`,
          okWindow && atmOk,
          `${info.ticker} strike ${info.strike} (${(drift * 100).toFixed(2)}% from spot` +
            `${info.ladderSize > 1 ? `, ladder of ${info.ladderSize}` : ""}) ends in ${Math.round(secsLeft)}s`,
        );
        found.push({ asset, horizon, ticker: info.ticker, strike: info.strike, endTs: info.endTs });
      } catch (err) {
        // A series the exchange simply isn't listing right now is not a
        // defect in this tool — report it, don't fail the run.
        record(
          `${asset.toUpperCase()} ${horizon} market`,
          isNotListed(err) ? null : false,
          (err as Error).message,
        );
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
          record(
            `book ${m.ticker}`,
            false,
            `one-sided book — nobody is quoting this strike ` +
              `(yes_bid ${tob.yesBid}, yes_ask ${tob.yesAsk}); usually means a non-ATM strike was picked`,
          );
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
        console.log(
          `  our 60s average: ${avg.toFixed(2)} from ${windowTicks.length} ticks ` +
            `(strike ${next15.strike}) -> ${ourCall.toUpperCase()}; waiting for settlement…`,
        );
        let result = "";
        let settleValue: number | null = null;
        for (let i = 0; i < 40 && !result; i++) {
          await sleep(15000);
          try {
            const m = await api.getMarket(next15.ticker);
            result = String(m.market.result ?? "");
            // CF Benchmarks' actual settlement number, when published.
            const raw =
              m.market.expiration_value ??
              (m.market as Record<string, unknown>).settlement_value ??
              (m.market as Record<string, unknown>).expiration_value_dollars;
            const parsed = Number(String(raw ?? "").replace(/[$,]/g, ""));
            if (Number.isFinite(parsed) && parsed > 0) settleValue = parsed;
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
            `our 60s avg ${avg.toFixed(2)} -> ${ourCall.toUpperCase()}; ` +
              `Kalshi settled ${result.toUpperCase()} (we were $${margin.toFixed(2)} from the strike)`,
          );
          // The stronger check: our index average vs CF Benchmarks' own.
          if (settleValue != null) {
            const errPct = Math.abs(avg - settleValue) / settleValue;
            record(
              "index accuracy vs CF Benchmarks",
              errPct < 0.001,
              `ours ${avg.toFixed(2)} vs official ${settleValue.toFixed(2)} — ` +
                `${(errPct * 10000).toFixed(1)} bps error`,
            );
          } else {
            record(
              "index accuracy vs CF Benchmarks",
              null,
              "Kalshi published no settlement value for this market",
            );
          }
        }
      }
    }
  }

  if (settleMode) {
    console.log("\nPhase 5: volatility scale (microstructure-noise check)");
    for (const asset of ASSET_IDS) {
      const ticks = index[asset];
      const s1 = realizedVol(ticks, 1);
      const s5 = realizedVol(ticks, 5);
      const s15 = realizedVol(ticks, 15);
      if (!Number.isFinite(s15) || !Number.isFinite(s1)) {
        record(`${asset.toUpperCase()} vol scale`, null, "not enough ticks");
        continue;
      }
      const ratio = s1 / s15;
      record(
        `${asset.toUpperCase()} vol scale`,
        ratio < 1.5,
        `ann. vol 1s ${(annualize(s1) * 100).toFixed(0)}% / 5s ${(annualize(s5) * 100).toFixed(0)}% / ` +
          `15s ${(annualize(s15) * 100).toFixed(0)}% (1s/15s ratio ${ratio.toFixed(2)}` +
          `${ratio >= 1.5 ? " — 1s sampling is inflated by venue jitter" : ""})`,
      );
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
