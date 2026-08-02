import { createSign, constants as cryptoConstants } from "node:crypto";
import { readFileSync } from "node:fs";
import { KALSHI_API_PATH_PREFIX, KALSHI_API_URL, USER_AGENT } from "../config.js";

export interface KalshiMarket {
  ticker: string;
  event_ticker: string;
  market_type?: string;
  title?: string;
  subtitle?: string;
  yes_sub_title?: string;
  open_time?: string;
  close_time?: string;
  expected_expiration_time?: string;
  expiration_time?: string;
  status?: string;
  yes_bid?: number;
  yes_ask?: number;
  no_bid?: number;
  no_ask?: number;
  last_price?: number;
  result?: string;
  strike_type?: string;
  floor_strike?: number;
  cap_strike?: number;
  fee_waiver_expiration_time?: string;
  [key: string]: unknown;
}

export interface KalshiEvent {
  event_ticker: string;
  series_ticker?: string;
  title?: string;
  [key: string]: unknown;
}

export interface KalshiOrderbook {
  yes?: [number, number][];
  no?: [number, number][];
  /** Newer API shape: dollar-string prices with fractional sizes. */
  yes_dollars?: [string, string][];
  no_dollars?: [string, string][];
}

/**
 * The 2026 Kalshi API reports prices as dollar strings (yes_bid_dollars:
 * "0.0300") alongside — or instead of — the legacy cents integers. These
 * helpers normalize both shapes to dollars (0..1).
 */
export function priceDollars(m: KalshiMarket, base: string): number | null {
  const d = m[`${base}_dollars`];
  if (d != null) {
    const v = Number(d);
    return Number.isFinite(v) && v > 0 ? v : null;
  }
  const c = m[base];
  const v = Number(c);
  return Number.isFinite(v) && v > 0 ? v / 100 : null;
}

export function topOfBook(m: KalshiMarket): {
  yesBid: number | null;
  yesAsk: number | null;
  noBid: number | null;
  noAsk: number | null;
  last: number | null;
} {
  return {
    yesBid: priceDollars(m, "yes_bid"),
    yesAsk: priceDollars(m, "yes_ask"),
    noBid: priceDollars(m, "no_bid"),
    noAsk: priceDollars(m, "no_ask"),
    last: priceDollars(m, "last_price"),
  };
}

/** Normalize an orderbook side (either shape) to [cents, contracts][]. */
export function normalizeLevels(
  legacy: [number, number][] | undefined,
  dollars: [string, string][] | undefined,
): [number, number][] {
  if (Array.isArray(dollars)) {
    return dollars
      .map(([p, s]): [number, number] => [Math.round(Number(p) * 100), Number(s)])
      .filter(([p, s]) => p > 0 && p < 100 && s > 0);
  }
  if (Array.isArray(legacy)) {
    return legacy
      .map(([p, s]): [number, number] => [Number(p), Number(s)])
      .filter(([p, s]) => p > 0 && p < 100 && s > 0);
  }
  return [];
}

export interface KalshiCredentials {
  keyId: string;
  privateKeyPem: string;
}

/** Load API credentials from env (.env): key id + RSA private key. */
export function loadCredentials(): KalshiCredentials | null {
  const keyId = process.env.KALSHI_API_KEY_ID;
  let pem = process.env.KALSHI_PRIVATE_KEY;
  if (!pem && process.env.KALSHI_PRIVATE_KEY_PATH) {
    try {
      pem = readFileSync(process.env.KALSHI_PRIVATE_KEY_PATH, "utf8");
    } catch {
      return null;
    }
  }
  if (!keyId || !pem) return null;
  return { keyId, privateKeyPem: pem };
}

/** RSA-PSS(SHA256) signature headers per Kalshi's API-key scheme. */
export function signHeaders(
  creds: KalshiCredentials,
  method: string,
  path: string,
): Record<string, string> {
  const ts = Date.now().toString();
  const sign = createSign("SHA256");
  sign.update(`${ts}${method}${path}`);
  const signature = sign.sign(
    {
      key: creds.privateKeyPem,
      padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
      saltLength: cryptoConstants.RSA_PSS_SALTLEN_DIGEST,
    },
    "base64",
  );
  return {
    "KALSHI-ACCESS-KEY": creds.keyId,
    "KALSHI-ACCESS-SIGNATURE": signature,
    "KALSHI-ACCESS-TIMESTAMP": ts,
  };
}

/** Minimum gap between outbound requests (Kalshi rate-limits aggressively). */
const REQUEST_GAP_MS = 150;

export class KalshiApi {
  private lastRequestAt = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly creds: KalshiCredentials | null = null) {}

  get authenticated(): boolean {
    return this.creds !== null;
  }

  /** Serialize requests with a minimum gap; retry once on HTTP 429. */
  private async throttled<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const wait = this.lastRequestAt + REQUEST_GAP_MS - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastRequestAt = Date.now();
    });
    this.queue = run.catch(() => {});
    await run;
    try {
      return await fn();
    } catch (err) {
      if (String((err as Error).message).includes("HTTP 429")) {
        await new Promise((r) => setTimeout(r, 1200));
        this.lastRequestAt = Date.now();
        return fn();
      }
      throw err;
    }
  }

  private async request<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    opts: { query?: Record<string, string | number | undefined>; body?: unknown; auth?: boolean } = {},
  ): Promise<T> {
    return this.throttled(() => this.requestOnce(method, path, opts));
  }

  private async requestOnce<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    opts: { query?: Record<string, string | number | undefined>; body?: unknown; auth?: boolean } = {},
  ): Promise<T> {
    const qs = Object.entries(opts.query ?? {})
      .filter(([, v]) => v !== undefined && v !== "")
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join("&");
    const url = `${KALSHI_API_URL}${path}${qs ? `?${qs}` : ""}`;
    const headers: Record<string, string> = {
      accept: "application/json",
      "user-agent": USER_AGENT,
    };
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    if (opts.auth) {
      if (!this.creds) throw new Error("Kalshi API key not configured");
      // Signature covers the path without the query string.
      Object.assign(headers, signHeaders(this.creds, method, `${KALSHI_API_PATH_PREFIX}${path}`));
    }
    const res = await fetch(url, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`${method} ${path} -> HTTP ${res.status}${text ? ` ${text.slice(0, 160)}` : ""}`);
    }
    return (await res.json()) as T;
  }

  // ---- public market data -------------------------------------------------

  getMarkets(query: {
    series_ticker?: string;
    event_ticker?: string;
    tickers?: string;
    status?: string;
    limit?: number;
    cursor?: string;
  }): Promise<{ markets: KalshiMarket[]; cursor?: string }> {
    return this.request("GET", "/markets", { query });
  }

  getMarket(ticker: string): Promise<{ market: KalshiMarket }> {
    return this.request("GET", `/markets/${ticker}`);
  }

  getOrderbook(
    ticker: string,
    depth = 8,
  ): Promise<{ orderbook?: KalshiOrderbook; orderbook_fp?: KalshiOrderbook }> {
    return this.request("GET", `/markets/${ticker}/orderbook`, { query: { depth } });
  }

  getEvents(query: {
    status?: string;
    series_ticker?: string;
    limit?: number;
    cursor?: string;
  }): Promise<{ events: KalshiEvent[]; cursor?: string }> {
    return this.request("GET", "/events", { query });
  }

  // ---- portfolio (signed) -------------------------------------------------

  getBalance(): Promise<{ balance: number }> {
    return this.request("GET", "/portfolio/balance", { auth: true });
  }

  getPositions(): Promise<{ market_positions?: Record<string, unknown>[] }> {
    return this.request("GET", "/portfolio/positions", { auth: true });
  }

  createOrder(body: {
    ticker: string;
    client_order_id: string;
    side: "yes" | "no";
    action: "buy" | "sell";
    count: number;
    type: "limit";
    yes_price?: number;
    no_price?: number;
  }): Promise<{ order?: { order_id?: string; status?: string } }> {
    return this.request("POST", "/portfolio/orders", { auth: true, body });
  }
}
