/**
 * Score the recorder's output: does the settlement-average edge exist?
 *
 *   npm run score
 *
 * Reads data/markets-*.csv and answers three questions:
 *   1. How accurate is our index proxy against real settlements? (bps)
 *   2. How often does our projected settlement disagree with the book,
 *      and when it does, who is right?
 *   3. Would trading those disagreements have made money after fees?
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { KALSHI_FEE_RATE, RECORD_DIR } from "./config.js";

interface Row {
  [key: string]: string;
}

function loadRows(): Row[] {
  let files: string[];
  try {
    files = readdirSync(RECORD_DIR).filter((f) => f.startsWith("markets-") && f.endsWith(".csv"));
  } catch {
    console.log(`No recordings found in ${RECORD_DIR}. Run the dashboard for a while first.`);
    process.exit(0);
  }
  const rows: Row[] = [];
  for (const f of files) {
    const text = readFileSync(path.join(RECORD_DIR, f), "utf8").trim();
    const lines = text.split("\n");
    if (lines.length < 2) continue;
    const header = lines[0].split(",");
    for (const line of lines.slice(1)) {
      const cells = line.split(",");
      const row: Row = {};
      header.forEach((h, i) => (row[h] = cells[i] ?? ""));
      rows.push(row);
    }
  }
  return rows;
}

const num = (v: string): number | null => {
  if (v === "" || v == null) return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

function quantile(xs: number[], q: number): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))));
  return s[i];
}

/** Kalshi taker fee per contract at a price in dollars. */
const fee = (p: number) => KALSHI_FEE_RATE * p * (1 - p);

function main() {
  const rows = loadRows().filter((r) => r.result === "yes" || r.result === "no");
  if (rows.length === 0) {
    console.log("No settled markets recorded yet. Leave the dashboard running through a few expiries.");
    process.exit(0);
  }

  console.log(`Polysignal edge report — ${rows.length} settled market(s)\n`);

  // ---- 1. Index proxy accuracy ------------------------------------------
  const errs = rows.map((r) => num(r.proxy_err_bps)).filter((x): x is number => x != null);
  const margins = rows
    .map((r) => num(r.settle_margin))
    .filter((x): x is number => x != null)
    .map(Math.abs);
  console.log("1. Index proxy accuracy vs official settlements");
  if (errs.length > 0) {
    console.log(
      `   error: median ${quantile(errs, 0.5).toFixed(2)}bp, p90 ${quantile(errs, 0.9).toFixed(2)}bp, ` +
        `max ${Math.max(...errs).toFixed(2)}bp  (n=${errs.length})`,
    );
  } else {
    console.log("   no official settlement values published yet");
  }
  if (margins.length > 0) {
    console.log(
      `   settlement margins: median $${quantile(margins, 0.5).toFixed(2)}, ` +
        `p10 $${quantile(margins, 0.1).toFixed(2)} (how close these actually land)`,
    );
  }
  const calls = rows.filter((r) => r.call_correct !== "");
  const correct = calls.filter((r) => r.call_correct === "1").length;
  if (calls.length > 0) {
    console.log(`   our 60s average called the right side: ${correct}/${calls.length} (${pct(correct / calls.length)})`);
  }

  // ---- 2. Divergence: our projection vs the book -------------------------
  console.log("\n2. When our projected settlement disagreed with the market");
  const buckets = [0.05, 0.1, 0.2, 0.3];
  console.log("   gap    | count | our side won | market side won | avg gap");
  for (const b of buckets) {
    const hits = rows.filter((r) => {
      const d = num(r.max_div_points);
      return d != null && d >= b;
    });
    if (hits.length === 0) {
      console.log(`   >${(b * 100).toFixed(0).padStart(2)}pts |     0 |            — |               — |       —`);
      continue;
    }
    const won = hits.filter((r) => r.max_div_side === r.result).length;
    const avgGap =
      hits.reduce((s, r) => s + (num(r.max_div_points) ?? 0), 0) / hits.length;
    console.log(
      `   >${(b * 100).toFixed(0).padStart(2)}pts | ${String(hits.length).padStart(5)} | ` +
        `${String(won).padStart(12)} | ${String(hits.length - won).padStart(15)} | ` +
        `${(avgGap * 100).toFixed(1).padStart(6)}pts`,
    );
  }

  // ---- 3. Would it have made money? --------------------------------------
  console.log("\n3. Hypothetical P&L — take every disagreement, 1 contract, cross the spread");
  console.log("   (buy our side at the offer, hold to settlement, Kalshi fees deducted)");
  for (const b of buckets) {
    let pnl = 0;
    let n = 0;
    let wins = 0;
    for (const r of rows) {
      const gap = num(r.max_div_points);
      const side = r.max_div_side;
      const yesBid = num(r.max_div_yes_bid);
      const yesAsk = num(r.max_div_yes_ask);
      if (gap == null || gap < b || !side || yesBid == null || yesAsk == null) continue;
      // Buying YES lifts the offer; buying NO pays 1 - yes_bid.
      const entry = side === "yes" ? yesAsk : 1 - yesBid;
      if (!(entry > 0 && entry < 1)) continue;
      const won = side === r.result;
      pnl += (won ? 1 - entry : -entry) - fee(entry);
      n += 1;
      if (won) wins += 1;
    }
    if (n === 0) {
      console.log(`   >${(b * 100).toFixed(0).padStart(2)}pts: no trades`);
      continue;
    }
    console.log(
      `   >${(b * 100).toFixed(0).padStart(2)}pts: ${String(n).padStart(4)} trades, ` +
        `${pct(wins / n)} win rate, net $${pnl.toFixed(2)} ` +
        `(${(pnl / n) * 100 >= 0 ? "+" : ""}${((pnl / n) * 100).toFixed(2)}c per trade)`,
    );
  }

  // ---- Calibration: us vs the market -------------------------------------
  console.log("\n4. Forecast quality at T-30s (Brier score, lower is better)");
  let ourBrier = 0;
  let mktBrier = 0;
  let nb = 0;
  for (const r of rows) {
    const ours = num(r.t30_our_prob);
    const mkt = num(r.t30_yes_mid);
    if (ours == null || mkt == null) continue;
    const outcome = r.result === "yes" ? 1 : 0;
    ourBrier += (ours - outcome) ** 2;
    mktBrier += (mkt - outcome) ** 2;
    nb += 1;
  }
  if (nb > 0) {
    console.log(`   ours ${(ourBrier / nb).toFixed(4)} vs market ${(mktBrier / nb).toFixed(4)} (n=${nb})`);
    console.log(
      ourBrier < mktBrier
        ? "   -> our projection beat the market's price on this sample"
        : "   -> the market's price beat our projection on this sample",
    );
  } else {
    console.log("   not enough paired snapshots yet");
  }

  console.log(
    `\nSample size ${rows.length}. Treat anything under ~100 settled markets as a hint, not a result.`,
  );
}

main();
