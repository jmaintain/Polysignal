/**
 * Kalshi diagnostic probe: discovers the real crypto series tickers, market
 * field shapes, orderbook format, fee metadata, and (with an API key) tests
 * websocket auth — so the port runs on verified facts, not guesses.
 *
 *   npm run probe                    (from the repo root)
 *
 * Optional .env for the WS auth test:
 *   KALSHI_API_KEY_ID=...
 *   KALSHI_PRIVATE_KEY_PATH=./kalshi-key.pem   (or KALSHI_PRIVATE_KEY inline)
 */
import "dotenv/config";
import { createSign, constants as cryptoConstants } from "node:crypto";
import { readFileSync } from "node:fs";
import WebSocket from "ws";

const BASE = "https://api.elections.kalshi.com/trade-api/v2";
const WS_URL = "wss://api.elections.kalshi.com/trade-api/ws/v2";

const trunc = (v: unknown, n = 110): string => {
  const s = JSON.stringify(v);
  return s == null ? "null" : s.length > n ? s.slice(0, n) + "…" : s;
};

async function get(path: string): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`GET ${path} -> HTTP ${res.status}`);
  return res.json();
}

function dumpObj(obj: Record<string, unknown>, prefix: string): void {
  for (const [k, v] of Object.entries(obj)) console.log(`  ${prefix}${k}: ${trunc(v)}`);
}

async function main() {
  console.log(`Kalshi probe @ ${new Date().toISOString()}\n`);

  // ---- 1. Exchange status (also verifies connectivity) -------------------
  try {
    const status = await get("/exchange/status");
    console.log(`exchange/status: ${trunc(status)}`);
  } catch (err) {
    console.log(`exchange/status FAILED: ${(err as Error).message}`);
    console.log("Cannot reach Kalshi — aborting probe.");
    process.exit(1);
  }

  // ---- 2. Find crypto series ---------------------------------------------
  console.log("\n--- series discovery ---");
  const seriesTickers = new Set<string>();
  // Try the series listing with plausible category names.
  for (const cat of ["Crypto", "crypto", "Cryptocurrency", "Financials"]) {
    try {
      const body = (await get(`/series?category=${encodeURIComponent(cat)}`)) as {
        series?: { ticker: string; title?: string; frequency?: string }[];
      };
      const hits = (body.series ?? []).filter((s) =>
        /BTC|ETH|SOL|BITCOIN|ETHEREUM|SOLANA/i.test(`${s.ticker} ${s.title ?? ""}`),
      );
      if (hits.length > 0) {
        console.log(`  category "${cat}":`);
        for (const s of hits) {
          console.log(`    ${s.ticker}  freq=${s.frequency ?? "?"}  ${s.title ?? ""}`);
          seriesTickers.add(s.ticker);
        }
      }
    } catch (err) {
      console.log(`  category "${cat}": ${(err as Error).message}`);
    }
  }
  // Fallback: scan open events for crypto-looking tickers.
  try {
    let cursor = "";
    for (let page = 0; page < 5; page++) {
      const body = (await get(
        `/events?status=open&limit=200${cursor ? `&cursor=${cursor}` : ""}`,
      )) as { events?: { event_ticker: string; series_ticker?: string; title?: string }[]; cursor?: string };
      for (const e of body.events ?? []) {
        if (/BTC|ETH|SOL/i.test(e.event_ticker)) {
          if (e.series_ticker) seriesTickers.add(e.series_ticker);
        }
      }
      cursor = body.cursor ?? "";
      if (!cursor) break;
    }
    console.log(`  crypto-ish series from open events: ${[...seriesTickers].join(", ") || "(none)"}`);
  } catch (err) {
    console.log(`  event scan: ${(err as Error).message}`);
  }

  // ---- 3. For each series: sample an open market in full -----------------
  console.log("\n--- open markets per series (first market dumped in full) ---");
  const sampleTickers: string[] = [];
  for (const st of [...seriesTickers].slice(0, 12)) {
    try {
      const body = (await get(`/markets?series_ticker=${st}&status=open&limit=3`)) as {
        markets?: Record<string, unknown>[];
      };
      const mkts = body.markets ?? [];
      console.log(`\n  series ${st}: ${mkts.length} open (showing close times + strikes)`);
      for (const m of mkts) {
        console.log(
          `    ${m.ticker}  close=${m.close_time}  strike_type=${m.strike_type} floor=${m.floor_strike} cap=${m.cap_strike} yes_bid=${m.yes_bid} yes_ask=${m.yes_ask}`,
        );
      }
      if (mkts[0]) {
        sampleTickers.push(String(mkts[0].ticker));
        console.log(`  full dump of ${mkts[0].ticker}:`);
        dumpObj(mkts[0], "    market.");
      }
    } catch (err) {
      console.log(`  series ${st}: ${(err as Error).message}`);
    }
  }

  // ---- 4. Orderbook shape -------------------------------------------------
  console.log("\n--- orderbook shape ---");
  for (const t of sampleTickers.slice(0, 2)) {
    try {
      const body = await get(`/markets/${t}/orderbook?depth=5`);
      console.log(`  ${t}: ${trunc(body, 400)}`);
    } catch (err) {
      console.log(`  ${t}: ${(err as Error).message}`);
    }
  }

  // ---- 5. A settled market (result fields for the backtest) ---------------
  console.log("\n--- settled market sample (per series) ---");
  for (const st of [...seriesTickers].slice(0, 6)) {
    try {
      const body = (await get(`/markets?series_ticker=${st}&status=settled&limit=1`)) as {
        markets?: Record<string, unknown>[];
      };
      const m = body.markets?.[0];
      if (m) {
        console.log(
          `  ${st}: ${m.ticker} result=${m.result} floor=${m.floor_strike} settlement fields: ` +
            trunc(
              Object.fromEntries(
                Object.entries(m).filter(([k]) => /result|settle|expiration_value|expected/i.test(k)),
              ),
              300,
            ),
        );
      }
    } catch (err) {
      console.log(`  ${st}: ${(err as Error).message}`);
    }
  }

  // ---- 6. WS auth test (only if a key is configured) ----------------------
  console.log("\n--- websocket auth test ---");
  const keyId = process.env.KALSHI_API_KEY_ID;
  let privateKey = process.env.KALSHI_PRIVATE_KEY;
  if (!privateKey && process.env.KALSHI_PRIVATE_KEY_PATH) {
    try {
      privateKey = readFileSync(process.env.KALSHI_PRIVATE_KEY_PATH, "utf8");
    } catch (err) {
      console.log(`  cannot read KALSHI_PRIVATE_KEY_PATH: ${(err as Error).message}`);
    }
  }
  if (!keyId || !privateKey) {
    console.log("  skipped (set KALSHI_API_KEY_ID and KALSHI_PRIVATE_KEY[_PATH] in .env to test)");
  } else {
    await new Promise<void>((resolve) => {
      const ts = Date.now().toString();
      const sign = createSign("SHA256");
      sign.update(`${ts}GET/trade-api/ws/v2`);
      const signature = sign.sign(
        { key: privateKey!, padding: cryptoConstants.RSA_PKCS1_PSS_PADDING, saltLength: 32 },
        "base64",
      );
      const ws = new WebSocket(WS_URL, {
        headers: {
          "KALSHI-ACCESS-KEY": keyId,
          "KALSHI-ACCESS-SIGNATURE": signature,
          "KALSHI-ACCESS-TIMESTAMP": ts,
        },
      });
      const timer = setTimeout(() => {
        console.log("  ws: timeout waiting for messages");
        ws.close();
        resolve();
      }, 15000);
      let count = 0;
      ws.on("open", () => {
        console.log("  ws: connected + authenticated OK");
        ws.send(
          JSON.stringify({
            id: 1,
            cmd: "subscribe",
            params: { channels: ["ticker"], market_tickers: sampleTickers.slice(0, 2) },
          }),
        );
      });
      ws.on("message", (raw) => {
        if (count++ < 4) console.log(`  ws msg: ${raw.toString().slice(0, 250)}`);
        if (count >= 4) {
          clearTimeout(timer);
          ws.close();
          resolve();
        }
      });
      ws.on("error", (err) => {
        console.log(`  ws error: ${String(err)}`);
        clearTimeout(timer);
        resolve();
      });
    });
  }

  console.log("\nprobe complete");
  process.exit(0);
}

main().catch((err) => {
  console.error("probe crashed:", err);
  process.exit(2);
});
