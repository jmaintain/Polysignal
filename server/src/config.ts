import type { AssetId, HorizonId } from "@polysignal/shared";

export const RTDS_URL = "wss://ws-live-data.polymarket.com";
export const CLOB_WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
export const CLOB_REST_URL = "https://clob.polymarket.com";
export const GAMMA_URL = "https://gamma-api.polymarket.com";
export const DATA_API_URL = "https://data-api.polymarket.com";

export interface AssetConfig {
  id: AssetId;
  name: string;
  /** RTDS crypto_prices_chainlink symbol. */
  chainlinkSymbol: string;
  /** RTDS crypto_prices (Binance) symbol. */
  binanceSymbol: string;
  /** Slug prefix for updown series, e.g. "btc" -> btc-updown-15m-<slot>. */
  slugPrefix: string;
  /** Full name used by legacy slugs, e.g. "bitcoin-up-or-down-...". */
  legacyName: string;
}

export const ASSETS: Record<AssetId, AssetConfig> = {
  btc: {
    id: "btc",
    name: "Bitcoin",
    chainlinkSymbol: "btc/usd",
    binanceSymbol: "BTCUSDT",
    slugPrefix: "btc",
    legacyName: "bitcoin",
  },
  eth: {
    id: "eth",
    name: "Ethereum",
    chainlinkSymbol: "eth/usd",
    binanceSymbol: "ETHUSDT",
    slugPrefix: "eth",
    legacyName: "ethereum",
  },
  sol: {
    id: "sol",
    name: "Solana",
    chainlinkSymbol: "sol/usd",
    binanceSymbol: "SOLUSDT",
    slugPrefix: "sol",
    legacyName: "solana",
  },
};

export interface HorizonConfig {
  id: HorizonId;
  seconds: number;
  label: string;
  /** Infix used in updown slugs (btc-updown-<infix>-<slot>). */
  slugInfix: string;
}

export const HORIZONS: Record<HorizonId, HorizonConfig> = {
  "5m": { id: "5m", seconds: 300, label: "5 min", slugInfix: "5m" },
  "15m": { id: "15m", seconds: 900, label: "15 min", slugInfix: "15m" },
  "1h": { id: "1h", seconds: 3600, label: "1 hour", slugInfix: "1h" },
  "1d": { id: "1d", seconds: 86400, label: "Daily", slugInfix: "1d" },
};

export const ASSET_IDS = Object.keys(ASSETS) as AssetId[];
export const HORIZON_IDS = Object.keys(HORIZONS) as HorizonId[];

/** Vol estimator half-lives (seconds), fast to slow. */
export const VOL_HALF_LIVES = [60, 300, 1800, 21600];

/** Fee rate charged on winnings; Polymarket updown markets are currently 0. */
export const FEE_RATE = Number(process.env.FEE_RATE ?? "0");

export const SERVER_PORT = Number(process.env.PORT ?? "8788");

/** How much tick history to retain per asset/source (for charts + vol). */
export const TICK_BUFFER_MS = 45 * 60 * 1000;

export const USER_AGENT = "polysignal/1.0 (open-source monitor)";
