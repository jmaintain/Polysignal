import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AssetId, HorizonId, SessionState } from "@polysignal/shared";
import { RECORD_DIR } from "../config.js";
import type { Engine } from "./engine.js";
import type { KalshiApi } from "./kalshiApi.js";

/**
 * Final-minute recorder.
 *
 * Kalshi settles on the average of a market's last 60 seconds, but the
 * order book trades on the latest price. This records both, once per
 * second, for every market's closing minute — then waits for the official
 * settlement and writes what actually happened. `npm run score` turns the
 * result into an answer to the only question that matters: when our
 * projected settlement disagrees with the market price, who is right?
 */

interface Snapshot {
  ts: number;
  secondsLeft: number;
  index: number | null;
  avgSoFar: number | null;
  projected: number | null;
  yesBid: number | null;
  yesAsk: number | null;
  ourProb: number | null;
}

interface Tracked {
  ticker: string;
  asset: AssetId;
  horizon: HorizonId;
  strike: number;
  endTs: number;
  snapshots: Snapshot[];
  finalized: boolean;
}

const SNAPSHOT_HEADER = [
  "ticker", "asset", "horizon", "iso", "seconds_left", "strike",
  "index", "avg_so_far", "projected", "yes_bid", "yes_ask", "our_prob",
].join(",");

const MARKET_HEADER = [
  "ticker", "asset", "horizon", "close_iso", "strike",
  "our_avg60", "official_settle", "proxy_err_bps",
  "result", "our_call", "call_correct", "settle_margin",
  "t60_index", "t60_proj", "t60_yes_mid", "t60_our_prob",
  "t30_index", "t30_proj", "t30_yes_mid", "t30_our_prob",
  "t15_index", "t15_proj", "t15_yes_mid", "t15_our_prob",
  "t05_index", "t05_proj", "t05_yes_mid", "t05_our_prob",
  "max_div_points", "max_div_seconds_left", "max_div_side",
  "max_div_yes_bid", "max_div_yes_ask", "max_div_our_prob",
].join(",");

const n = (v: number | null | undefined, digits = 4): string =>
  v == null || !Number.isFinite(v) ? "" : v.toFixed(digits);

export class Recorder {
  private tracked = new Map<string, Tracked>();
  private timer: NodeJS.Timeout | null = null;
  private snapshotFile = "";
  private marketFile = "";
  private recordedCount = 0;

  constructor(
    private readonly engine: Engine,
    private readonly api: KalshiApi,
    private readonly windowSec = 60,
  ) {}

  start(): void {
    mkdirSync(RECORD_DIR, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    this.snapshotFile = path.join(RECORD_DIR, `snapshots-${day}.csv`);
    this.marketFile = path.join(RECORD_DIR, `markets-${day}.csv`);
    if (!existsSync(this.snapshotFile)) writeFileSync(this.snapshotFile, SNAPSHOT_HEADER + "\n");
    if (!existsSync(this.marketFile)) writeFileSync(this.marketFile, MARKET_HEADER + "\n");
    this.engine.log(
      "info",
      `recorder: capturing final ${this.windowSec}s of each market to ${this.marketFile} (RECORD=false to disable)`,
    );
    this.timer = setInterval(() => this.sample(), 1000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private sample(): void {
    const now = Date.now();
    for (const s of this.engine.sessionStates()) {
      if (!s.market || s.secondsLeft == null) continue;
      // Capture the closing window plus a couple of seconds of lead-in.
      if (s.secondsLeft > this.windowSec + 2 || s.secondsLeft < 0) continue;
      const key = s.market.ticker;
      let t = this.tracked.get(key);
      if (!t) {
        t = {
          ticker: key,
          asset: s.asset,
          horizon: s.horizon,
          strike: s.market.strike,
          endTs: s.market.endTs,
          snapshots: [],
          finalized: false,
        };
        this.tracked.set(key, t);
      }
      const snap = this.snapshot(now, s);
      t.snapshots.push(snap);
      this.writeSnapshot(t, snap);
    }

    // Finalize markets whose window has closed.
    for (const t of this.tracked.values()) {
      if (!t.finalized && now > t.endTs + 2000) {
        t.finalized = true;
        void this.finalize(t);
      }
    }
  }

  private snapshot(now: number, s: SessionState): Snapshot {
    return {
      ts: now,
      secondsLeft: s.secondsLeft ?? 0,
      index: s.spot,
      avgSoFar: s.settle?.avgSoFar ?? null,
      projected: s.settle?.projected ?? null,
      yesBid: s.up?.bestBid ?? null,
      yesAsk: s.up?.bestAsk ?? null,
      ourProb: s.signal?.probUp ?? null,
    };
  }

  private writeSnapshot(t: Tracked, s: Snapshot): void {
    const row = [
      t.ticker, t.asset, t.horizon, new Date(s.ts).toISOString(),
      s.secondsLeft.toFixed(1), n(t.strike, 4),
      n(s.index, 4), n(s.avgSoFar, 4), n(s.projected, 4),
      n(s.yesBid, 4), n(s.yesAsk, 4), n(s.ourProb, 6),
    ].join(",");
    try {
      appendFileSync(this.snapshotFile, row + "\n");
    } catch (err) {
      this.engine.log("warn", `recorder: snapshot write failed: ${(err as Error).message}`);
    }
  }

  /** Poll for the official result, then write the summary row. */
  private async finalize(t: Tracked): Promise<void> {
    let result = "";
    let settleValue: number | null = null;
    for (let i = 0; i < 40 && !result; i++) {
      await new Promise((r) => setTimeout(r, 15000));
      try {
        const m = await this.api.getMarket(t.ticker);
        result = String(m.market.result ?? "");
        const raw =
          m.market.expiration_value ??
          (m.market as Record<string, unknown>).settlement_value;
        const parsed = Number(String(raw ?? "").replace(/[$,]/g, ""));
        if (Number.isFinite(parsed) && parsed > 0) settleValue = parsed;
      } catch {
        /* keep polling */
      }
    }

    const inWindow = t.snapshots.filter((s) => s.secondsLeft <= this.windowSec);
    const withAvg = inWindow.filter((s) => s.avgSoFar != null);
    const ourAvg = withAvg.length > 0 ? withAvg[withAvg.length - 1].avgSoFar! : null;
    const ourCall = ourAvg == null ? "" : ourAvg > t.strike ? "yes" : "no";
    const proxyErrBps =
      ourAvg != null && settleValue != null
        ? (Math.abs(ourAvg - settleValue) / settleValue) * 10000
        : null;

    const at = (target: number) => {
      let best: Snapshot | null = null;
      for (const s of inWindow) {
        if (!best || Math.abs(s.secondsLeft - target) < Math.abs(best.secondsLeft - target)) {
          best = s;
        }
      }
      return best;
    };
    const mid = (s: Snapshot | null) =>
      s && s.yesBid != null && s.yesAsk != null ? (s.yesBid + s.yesAsk) / 2 : null;

    // Largest disagreement between our projected settlement and the book.
    let maxDiv: { pts: number; s: Snapshot; side: "yes" | "no" } | null = null;
    for (const s of inWindow) {
      const m = mid(s);
      if (m == null || s.ourProb == null) continue;
      const diff = s.ourProb - m;
      if (!maxDiv || Math.abs(diff) > maxDiv.pts) {
        maxDiv = { pts: Math.abs(diff), s, side: diff > 0 ? "yes" : "no" };
      }
    }

    const cp = (target: number) => {
      const s = at(target);
      return [n(s?.index ?? null, 2), n(s?.projected ?? null, 2), n(mid(s), 4), n(s?.ourProb ?? null, 6)];
    };

    const row = [
      t.ticker, t.asset, t.horizon, new Date(t.endTs).toISOString(), n(t.strike, 4),
      n(ourAvg, 4), n(settleValue, 4), n(proxyErrBps, 3),
      result, ourCall,
      result && ourCall ? (result === ourCall ? "1" : "0") : "",
      settleValue != null ? n(settleValue - t.strike, 4) : "",
      ...cp(60), ...cp(30), ...cp(15), ...cp(5),
      maxDiv ? n(maxDiv.pts, 4) : "",
      maxDiv ? maxDiv.s.secondsLeft.toFixed(1) : "",
      maxDiv ? maxDiv.side : "",
      maxDiv ? n(maxDiv.s.yesBid, 4) : "",
      maxDiv ? n(maxDiv.s.yesAsk, 4) : "",
      maxDiv ? n(maxDiv.s.ourProb, 6) : "",
    ].join(",");

    try {
      appendFileSync(this.marketFile, row + "\n");
      this.recordedCount += 1;
      const correct = result && ourCall ? (result === ourCall ? "correct" : "WRONG") : "unsettled";
      this.engine.log(
        "info",
        `recorder: ${t.ticker} settled ${result || "?"} — our avg ${n(ourAvg, 2)} vs official ` +
          `${n(settleValue, 2)} (${proxyErrBps != null ? `${proxyErrBps.toFixed(1)}bp` : "n/a"}), ` +
          `${correct}; ${this.recordedCount} market(s) recorded today`,
      );
    } catch (err) {
      this.engine.log("warn", `recorder: summary write failed: ${(err as Error).message}`);
    }
    this.tracked.delete(t.ticker);
  }
}
