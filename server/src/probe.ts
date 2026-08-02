/**
 * Diagnostic probe: prints raw feed frames and market-discovery data so
 * protocol assumptions can be verified against the live services.
 *
 *   npm run probe          (from the repo root)
 */
import WebSocket from "ws";
import { GAMMA_URL, RTDS_URL, USER_AGENT } from "./config.js";
import { fetchJson, slotStartSec } from "./services/discovery.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Sample {
  rawFrames: string[];
  ticks: { ts: number; value: number }[];
  historyCount: number;
  historyFirstTs: number | null;
  historyLastTs: number | null;
}

function sampleTopic(topic: string, symbol: string, seconds: number): Promise<Sample> {
  return new Promise((resolve) => {
    const out: Sample = { rawFrames: [], ticks: [], historyCount: 0, historyFirstTs: null, historyLastTs: null };
    const ws = new WebSocket(RTDS_URL);
    const ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send("ping"), 5000);
    ws.on("open", () => {
      ws.send(
        JSON.stringify({
          action: "subscribe",
          subscriptions: [{ topic, type: "update", filters: JSON.stringify({ symbol }) }],
        }),
      );
    });
    ws.on("message", (raw) => {
      const text = raw.toString();
      if (!text.includes("payload")) return;
      if (out.rawFrames.length < 2) out.rawFrames.push(text.slice(0, 600));
      try {
        const msg = JSON.parse(text);
        const p = msg.payload ?? {};
        if (Array.isArray(p.data)) {
          out.historyCount = p.data.length;
          if (p.data.length > 0) {
            out.historyFirstTs = Number(p.data[0].timestamp);
            out.historyLastTs = Number(p.data[p.data.length - 1].timestamp);
          }
        } else if (p.value != null) {
          out.ticks.push({ ts: Number(p.timestamp), value: Number(p.value) });
        }
      } catch {
        /* ignore */
      }
    });
    ws.on("error", (err) => console.log(`  [${topic}/${symbol}] ws error: ${String(err)}`));
    setTimeout(() => {
      clearInterval(ping);
      ws.close();
      resolve(out);
    }, seconds * 1000);
  });
}

function describeTicks(s: Sample, label: string) {
  console.log(`\n--- ${label} ---`);
  for (const f of s.rawFrames) console.log(`  raw: ${f}`);
  console.log(`  history dump: ${s.historyCount} rows, ts ${s.historyFirstTs} .. ${s.historyLastTs}`);
  if (s.historyFirstTs) {
    console.log(
      `    (as dates, assuming ms: ${new Date(s.historyFirstTs).toISOString()} .. ${new Date(s.historyLastTs!).toISOString()})`,
    );
  }
  console.log(`  live ticks in sample: ${s.ticks.length}`);
  if (s.ticks.length > 1) {
    const first = s.ticks[0];
    const last = s.ticks[s.ticks.length - 1];
    console.log(`  first tick: ts=${first.ts} value=${first.value}`);
    console.log(`  last  tick: ts=${last.ts} value=${last.value}`);
    console.log(`  ts as date (assuming ms): ${new Date(last.ts).toISOString()} | now: ${new Date().toISOString()}`);
    const dts = s.ticks.slice(1).map((t, i) => t.ts - s.ticks[i].ts);
    const distinct = new Set(s.ticks.map((t) => t.value)).size;
    console.log(
      `  dt(ms) min/median/max: ${Math.min(...dts)}/${[...dts].sort((a, b) => a - b)[Math.floor(dts.length / 2)]}/${Math.max(...dts)}; distinct prices: ${distinct}/${s.ticks.length}`,
    );
  }
}

async function tryslug(slug: string): Promise<string> {
  try {
    const events = await fetchJson<Record<string, unknown>[]>(
      `${GAMMA_URL}/events?slug=${encodeURIComponent(slug)}`,
      8000,
    );
    if (Array.isArray(events) && events.length > 0) {
      const markets = (events[0] as { markets?: unknown[] }).markets;
      return `FOUND (markets: ${Array.isArray(markets) ? markets.length : 0})`;
    }
    return "empty";
  } catch (err) {
    return `error: ${(err as Error).message}`;
  }
}

async function main() {
  console.log(`Polysignal probe @ ${new Date().toISOString()}`);

  // ---- 1. RTDS raw frames (20s each topic, BTC only) --------------------
  const [cl, bn] = await Promise.all([
    sampleTopic("crypto_prices_chainlink", "btc/usd", 20),
    sampleTopic("crypto_prices", "BTCUSDT", 20),
  ]);
  describeTicks(cl, "crypto_prices_chainlink btc/usd");
  describeTicks(bn, "crypto_prices BTCUSDT");

  // ---- 2. Current 15m market: full field dump ---------------------------
  const slot15 = slotStartSec(Date.now(), "15m");
  const slug15 = `btc-updown-15m-${slot15}`;
  console.log(`\n--- gamma event fields for ${slug15} ---`);
  try {
    const events = await fetchJson<Record<string, unknown>[]>(`${GAMMA_URL}/events?slug=${slug15}`);
    const ev = events?.[0];
    if (!ev) {
      console.log("  event not found!");
    } else {
      const dump = (obj: Record<string, unknown>, prefix: string) => {
        for (const [k, v] of Object.entries(obj)) {
          if (k === "markets") continue;
          const s = JSON.stringify(v);
          console.log(`  ${prefix}${k}: ${s == null ? "null" : s.length > 110 ? s.slice(0, 110) + "…" : s}`);
        }
      };
      dump(ev, "event.");
      const market = (ev as { markets?: Record<string, unknown>[] }).markets?.[0];
      if (market) dump(market, "market.");
    }
  } catch (err) {
    console.log(`  error: ${(err as Error).message}`);
  }

  // ---- 3. Hourly/daily slug candidates ----------------------------------
  console.log("\n--- 1h/1d slug candidates ---");
  const nowSec = Math.floor(Date.now() / 1000);
  const hourSlot = Math.floor(nowSec / 3600) * 3600;
  const daySlot = Math.floor(nowSec / 86400) * 86400;
  const et = new Date().toLocaleString("en-US", {
    timeZone: "America/New_York",
    month: "numeric", day: "numeric", hour: "numeric", hour12: true,
  });
  const m = et.match(/(\d+)\/(\d+),\s*(\d+)\s*(AM|PM)/i);
  const MONTHS = ["january","february","march","april","may","june","july","august","september","october","november","december"];
  const monthName = m ? MONTHS[Number(m[1]) - 1] : "august";
  const day = m ? m[2] : "1";
  const hour = m ? `${m[3]}${m[4].toLowerCase()}` : "12am";
  const candidates = [
    `btc-updown-1h-${hourSlot}`,
    `btc-updown-60m-${hourSlot}`,
    `btc-up-or-down-1h-${hourSlot}`,
    `bitcoin-up-or-down-${monthName}-${day}-${hour}-et`,
    `btc-updown-1d-${daySlot}`,
    `btc-updown-24h-${daySlot}`,
    `btc-updown-daily-${daySlot}`,
    `bitcoin-up-or-down-on-${monthName}-${day}`,
    `bitcoin-up-or-down-${monthName}-${day}`,
  ];
  for (const slug of candidates) {
    console.log(`  ${slug}: ${await tryslug(slug)}`);
  }

  // ---- 4. Search for the real series names ------------------------------
  console.log("\n--- gamma public-search for up/down series ---");
  for (const q of ["bitcoin up or down", "btc-updown"]) {
    try {
      const res = await fetch(
        `${GAMMA_URL}/public-search?q=${encodeURIComponent(q)}&limit_per_type=8`,
        { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(8000) },
      );
      if (!res.ok) {
        console.log(`  "${q}": HTTP ${res.status}`);
        continue;
      }
      const body = (await res.json()) as { events?: { slug?: string; title?: string; endDate?: string }[] };
      console.log(`  "${q}":`);
      for (const e of body.events ?? []) {
        console.log(`    ${e.slug}  (${e.title ?? ""}, ends ${e.endDate ?? "?"})`);
      }
    } catch (err) {
      console.log(`  "${q}": ${(err as Error).message}`);
    }
  }

  await sleep(100);
  process.exit(0);
}

main().catch((err) => {
  console.error("probe crashed:", err);
  process.exit(2);
});
