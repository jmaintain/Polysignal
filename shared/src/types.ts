/** Assets covered by the monitor. */
export type AssetId = "btc" | "eth" | "sol";

/** Market horizons (Polymarket crypto up/down series). */
export type HorizonId = "5m" | "15m" | "1h" | "1d";

export interface PriceTick {
  /** Unix ms timestamp reported by the source. */
  ts: number;
  /** Price in USD. */
  price: number;
}

export type FeedSource = "chainlink" | "binance";

export interface FeedStatus {
  connected: boolean;
  lastTickTs: number | null;
  lastPrice: number | null;
  /** ms between our clock and the source timestamp at last tick. */
  latencyMs: number | null;
  ticksPerMin: number;
}

export interface BookLevel {
  price: number;
  size: number;
}

export interface BookSide {
  bids: BookLevel[];
  asks: BookLevel[];
}

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
  slug: string;
  question: string;
  conditionId: string;
  negRisk: boolean;
  upTokenId: string;
  downTokenId: string;
  /** Session boundaries, unix ms. */
  startTs: number;
  endTs: number;
  /** Minimum tick size for orders on this market (price increments). */
  tickSize: number | null;
  gammaMarketId: string | null;
  /**
   * Taker fee schedule (crypto_fees_v2): fee/share = rate * min(p, 1-p)^exponent.
   * Null when the market is feeless.
   */
  feeSchedule: { rate: number; exponent: number } | null;
}

export type StrikeSource =
  | "boundary_tick"
  | "rtds_history"
  | "gamma_field"
  | "unknown";

export interface SessionState {
  asset: AssetId;
  horizon: HorizonId;
  market: MarketInfo | null;
  /** "Price to beat": Chainlink price at session open. */
  strike: number | null;
  strikeSource: StrikeSource;
  /** Latest Chainlink price. */
  spot: number | null;
  /** spot - strike */
  delta: number | null;
  deltaPct: number | null;
  /** Seconds remaining in the session. */
  secondsLeft: number | null;
  up: TokenBook | null;
  down: TokenBook | null;
  signal: SignalState | null;
  /** Discovery error, if the market for this horizon could not be found. */
  discoveryError: string | null;
}

export type SignalDirection = "UP" | "DOWN" | "NONE";

export interface SignalComponent {
  id: string;
  label: string;
  /** Signed score in [-1, 1]; positive favors UP. */
  score: number;
  detail: string;
}

export interface SignalState {
  /** Model probability that the session resolves UP. */
  probUp: number | null;
  /** Fair value of the UP share in dollars (= probUp). */
  fairUp: number | null;
  fairDown: number | null;
  /** Edge of buying UP at the current ask, in dollars per share. */
  upBuyEdge: number | null;
  downBuyEdge: number | null;
  /** Sigma over the remaining horizon (as a fraction of spot). */
  sigmaRemaining: number | null;
  /** Annualized volatility estimate for display. */
  annualizedVol: number | null;
  /** Chainlink-vs-Binance basis z-score (positive: Binance above Chainlink). */
  basisZ: number | null;
  basisPct: number | null;
  direction: SignalDirection;
  /** 0-100 conviction. */
  strength: number;
  components: SignalComponent[];
  /** Suggested stake as fraction of bankroll (half-Kelly, capped). */
  kellyFraction: number | null;
  /** Human-readable state, e.g. TRADEABLE / LOCKED / WARMING_UP. */
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
  feeds: Record<AssetId, Record<FeedSource, FeedStatus>>;
  sessions: SessionState[];
  trading: TradingStatus;
  /** Recent signal-log entries, newest first. */
  log: LogEntry[];
}

export interface LogEntry {
  ts: number;
  level: "info" | "signal" | "warn" | "error" | "trade";
  text: string;
}

/** Chart payload: recent ticks for the focused asset. */
export interface ChartData {
  asset: AssetId;
  chainlink: PriceTick[];
  binance: PriceTick[];
}

export type ServerMessage =
  | { kind: "state"; state: AppState }
  | { kind: "chart"; chart: ChartData }
  | { kind: "tick"; asset: AssetId; source: FeedSource; tick: PriceTick };

export type ClientMessage = { kind: "focus"; asset: AssetId };
