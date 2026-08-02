/** Assets covered by the monitor. */
export type AssetId = "btc" | "eth" | "sol";

/** Market horizons (Kalshi crypto series; Kalshi has no 5m markets). */
export type HorizonId = "15m" | "1h" | "1d";

export interface PriceTick {
  /** Unix ms timestamp. */
  ts: number;
  /** Price in USD. */
  price: number;
}

/**
 * "index" is the CF Benchmarks RTI proxy (composite of the index's
 * constituent USD exchanges); "binance" is the leading-indicator feed.
 */
export type FeedSource = "index" | "binance";

export interface FeedStatus {
  connected: boolean;
  lastTickTs: number | null;
  lastPrice: number | null;
  /** ms between our clock and the source timestamp at last tick. */
  latencyMs: number | null;
  ticksPerMin: number;
  /** For the index proxy: which constituent exchanges are currently live. */
  sourcesUp?: string[];
}

export interface BookLevel {
  price: number;
  size: number;
}

/**
 * One side of a Kalshi binary market (YES = above the strike, NO = below).
 * Prices are in dollars (0..1); Kalshi quotes cents on the wire.
 */
export interface TokenBook {
  tokenId: string;
  bestBid: number | null;
  bestAsk: number | null;
  mid: number | null;
  spread: number | null;
  microprice: number | null;
  imbalance: number | null;
  bidDepth: number;
  askDepth: number;
  lastTradePrice: number | null;
  updatedTs: number | null;
}

export interface MarketInfo {
  /** Kalshi market ticker, e.g. KXBTC15M-26AUG0201-T63499.99 */
  ticker: string;
  eventTicker: string;
  seriesTicker: string;
  title: string;
  /** Human strike description from the API (yes_sub_title), if any. */
  yesSubTitle: string | null;
  /** The strike: YES resolves by the settlement average vs this price. */
  strike: number;
  /** "greater": YES = settle above strike. "less": YES = settle below. */
  strikeType: "greater" | "less";
  /** Session boundaries, unix ms (endTs = close/expiration time). */
  startTs: number;
  endTs: number;
  /** Order price increment in dollars (Kalshi: 0.01). */
  tickSize: number;
  /** Taker fee: fee/share = rate * (p*(1-p))^exponent. Null if feeless. */
  feeSchedule: { rate: number; exponent: number } | null;
  /** Seconds of the settlement averaging window (CF Benchmarks: 60). */
  settleWindowSec: number;
  /** Number of strike markets in this session (1 = single up/down market). */
  ladderSize: number;
}

export type StrikeSource = "kalshi_api" | "unknown";

/** Live settlement-window state during the final averaging minute. */
export interface SettleWindowState {
  /** Seconds of the window already observed. */
  elapsedSec: number;
  /** Mean of index ticks observed inside the window so far. */
  avgSoFar: number | null;
  /** What the full-window average would be if price froze right now. */
  projected: number | null;
}

export interface SessionState {
  asset: AssetId;
  horizon: HorizonId;
  market: MarketInfo | null;
  /** The strike ("price to beat"), from the Kalshi API. */
  strike: number | null;
  strikeSource: StrikeSource;
  /** Latest index (CF RTI proxy) price. */
  spot: number | null;
  /** spot - strike */
  delta: number | null;
  deltaPct: number | null;
  /** Seconds remaining until expiration. */
  secondsLeft: number | null;
  /** YES side (settle above strike). */
  up: TokenBook | null;
  /** NO side (settle below strike). */
  down: TokenBook | null;
  settle: SettleWindowState | null;
  signal: SignalState | null;
  discoveryError: string | null;
}

export type SignalDirection = "UP" | "DOWN" | "NONE";

export interface SignalComponent {
  id: string;
  label: string;
  /** Signed score in [-1, 1]; positive favors UP (YES). */
  score: number;
  detail: string;
}

export interface SignalState {
  /** Model probability that the market settles YES (above the strike). */
  probUp: number | null;
  fairUp: number | null;
  fairDown: number | null;
  /** Edge of buying YES at the current ask, net of fee, dollars/share. */
  upBuyEdge: number | null;
  downBuyEdge: number | null;
  /** Sigma over the remaining horizon (as a fraction of spot). */
  sigmaRemaining: number | null;
  annualizedVol: number | null;
  /** Binance-vs-index basis z-score (positive: Binance above the index). */
  basisZ: number | null;
  basisPct: number | null;
  direction: SignalDirection;
  strength: number;
  components: SignalComponent[];
  kellyFraction: number | null;
  phase: SignalPhase;
}

export type SignalPhase =
  | "WARMING_UP"
  | "TRADEABLE"
  | "NEAR_LOCK"
  | "LOCKED"
  | "NO_MARKET";

export interface PositionInfo {
  asset: string;
  outcome: string;
  tokenId: string;
  size: number;
  avgPrice: number;
  curPrice: number | null;
  title: string;
}

export interface TradingStatus {
  enabled: boolean;
  address: string | null;
  usdcBalance: number | null;
  positions: PositionInfo[];
  lastError: string | null;
}

export interface AppState {
  serverTs: number;
  /** Assets this server is tracking, in display order. */
  assets: AssetId[];
  feeds: Partial<Record<AssetId, Record<FeedSource, FeedStatus>>>;
  sessions: SessionState[];
  trading: TradingStatus;
  log: LogEntry[];
}

export interface LogEntry {
  ts: number;
  level: "info" | "signal" | "warn" | "error" | "trade";
  text: string;
}

export interface ChartData {
  asset: AssetId;
  index: PriceTick[];
  binance: PriceTick[];
}

export type ServerMessage =
  | { kind: "state"; state: AppState }
  | { kind: "chart"; chart: ChartData }
  | { kind: "tick"; asset: AssetId; source: FeedSource; tick: PriceTick };

export type ClientMessage = { kind: "focus"; asset: AssetId };
