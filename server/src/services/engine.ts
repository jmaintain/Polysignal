import type {
  AppState,
  AssetId,
  ChartData,
  FeedSource,
  FeedStatus,
  HorizonId,
  LogEntry,
  PriceTick,
  SessionState,
  SettleWindowState,
  SignalState,
  TokenBook,
  TradingStatus,
} from "@polysignal/shared";
import {
  annualizedVol,
  basisZ,
  blendSigma,
  compositeSignal,
  initBasis,
  initEwmaVar,
  probAvgAbove,
  updateBasis,
  updateEwmaVar,
  type BasisState,
  type EwmaVarState,
} from "@polysignal/shared";
import {
  ASSET_IDS,
  HORIZONS,
  HORIZON_IDS,
  INDEX_UNCERTAINTY,
  TICK_BUFFER_MS,
  VOL_HALF_LIVES,
} from "../config.js";
import { KalshiBooksFeed } from "../feeds/kalshiBooks.js";
import { discoverMarket, isNotListed } from "./discovery.js";
import type { KalshiApi, KalshiCredentials } from "./kalshiApi.js";

interface AssetState {
  ticks: Record<FeedSource, PriceTick[]>;
  status: Record<FeedSource, FeedStatus>;
  vol: { halfLifeSec: number; state: EwmaVarState | null }[];
  basis: BasisState;
  latest: Record<FeedSource, PriceTick | null>;
}

interface InternalSession {
  asset: AssetId;
  horizon: HorizonId;
  market: SessionState["market"];
  discoveryError: string | null;
  discovering: boolean;
  lastDirection: string;
  lastAtmCheck: number;
  /** Backoff gate so a missing series doesn't hammer the API. */
  nextRetryAt: number;
  retryDelayMs: number;
  notListed: boolean;
}

const emptyStatus = (): FeedStatus => ({
  connected: false,
  lastTickTs: null,
  lastPrice: null,
  latencyMs: null,
  ticksPerMin: 0,
});

export class Engine {
  private assets = new Map<AssetId, AssetState>();
  private sessions = new Map<string, InternalSession>();
  /** market ticker -> side -> book */
  private books = new Map<string, { up: TokenBook | null; down: TokenBook | null }>();
  private logEntries: LogEntry[] = [];
  private booksFeed: KalshiBooksFeed;
  private discoveryTimer: NodeJS.Timeout | null = null;
  private diagTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private liveCounts: Record<string, number> = {};
  private lastIngestErrorTs = 0;

  onTick: ((asset: AssetId, source: FeedSource, tick: PriceTick) => void) | null = null;

  tradingStatus: () => TradingStatus = () => ({
    enabled: false,
    address: null,
    usdcBalance: null,
    positions: [],
    lastError: null,
  });

  constructor(
    private readonly api: KalshiApi,
    creds: KalshiCredentials | null,
  ) {
    for (const asset of ASSET_IDS) {
      this.assets.set(asset, {
        ticks: { index: [], binance: [] },
        status: { index: emptyStatus(), binance: emptyStatus() },
        vol: VOL_HALF_LIVES.map((halfLifeSec) => ({ halfLifeSec, state: null })),
        basis: initBasis(),
        latest: { index: null, binance: null },
      });
      for (const horizon of HORIZON_IDS) {
        this.sessions.set(this.key(asset, horizon), {
          asset,
          horizon,
          market: null,
          discoveryError: null,
          discovering: false,
          lastDirection: "NONE",
          lastAtmCheck: 0,
          nextRetryAt: 0,
          retryDelayMs: 0,
          notListed: false,
        });
      }
    }
    this.booksFeed = new KalshiBooksFeed(api, creds, {
      onBook: (ticker, side, book) => {
        const entry = this.books.get(ticker) ?? { up: null, down: null };
        entry[side] = book;
        this.books.set(ticker, entry);
      },
      log: (msg) => this.log("warn", msg),
    });
  }

  start(): void {
    this.booksFeed.start();
    for (const session of this.sessions.values()) void this.refreshSession(session);
    this.discoveryTimer = setInterval(() => {
      const now = Date.now();
      for (const session of this.sessions.values()) {
        if (session.discovering || now < session.nextRetryAt) continue;
        const rolledOver = session.market !== null && now >= session.market.endTs + 1500;
        const missing = session.market === null;
        // Strike ladders (hourly/daily) re-center on the ATM strike as the
        // price moves, like Kalshi's own UI.
        const recenter =
          session.market !== null &&
          session.market.ladderSize > 1 &&
          now - session.lastAtmCheck > 45000;
        if (recenter) session.lastAtmCheck = now;
        if (rolledOver || missing || recenter) void this.refreshSession(session);
      }
    }, 3000);
    this.diagTimer = setInterval(() => {
      const parts: string[] = [];
      for (const asset of ASSET_IDS) {
        const idx = this.liveCounts[`${asset}:index`] ?? 0;
        const bn = this.liveCounts[`${asset}:binance`] ?? 0;
        parts.push(`${asset} idx:${idx} bn:${bn}`);
      }
      this.liveCounts = {};
      this.log("info", `diag live ticks/min — ${parts.join("  ")}`);
    }, 60000);
  }

  stop(): void {
    this.stopped = true;
    if (this.discoveryTimer) clearInterval(this.discoveryTimer);
    if (this.diagTimer) clearInterval(this.diagTimer);
    this.booksFeed.stop();
  }

  // -------------------------------------------------------------------------
  // Feed intake
  // -------------------------------------------------------------------------

  setIndexSources(asset: AssetId, sourcesUp: string[]): void {
    const st = this.assets.get(asset)!.status.index;
    st.sourcesUp = sourcesUp;
    st.connected = sourcesUp.length > 0;
  }

  ingestTick(asset: AssetId, source: FeedSource, tick: PriceTick): void {
    const a = this.assets.get(asset)!;
    const buf = a.ticks[source];
    const last = buf[buf.length - 1];
    if (last && tick.ts <= last.ts) return;
    buf.push(tick);
    this.prune(buf);
    a.latest[source] = tick;
    const st = a.status[source];
    if (source === "binance") st.connected = true;
    st.lastTickTs = tick.ts;
    st.lastPrice = tick.price;
    st.latencyMs = Date.now() - tick.ts;
    st.ticksPerMin = this.countTicksSince(buf, Date.now() - 60000);
    this.liveCounts[`${asset}:${source}`] = (this.liveCounts[`${asset}:${source}`] ?? 0) + 1;

    try {
      if (source === "index") {
        for (const v of a.vol) {
          v.state = v.state
            ? updateEwmaVar(v.state, tick.price, tick.ts, v.halfLifeSec)
            : initEwmaVar(tick.price, tick.ts);
        }
      }
      const other = a.latest[source === "index" ? "binance" : "index"];
      if (other && Math.abs(other.ts - tick.ts) < 3000) {
        const idx = source === "index" ? tick.price : other.price;
        const bn = source === "binance" ? tick.price : other.price;
        a.basis = updateBasis(a.basis, idx, bn);
      }
    } catch (err) {
      if (Date.now() - this.lastIngestErrorTs > 10000) {
        this.lastIngestErrorTs = Date.now();
        this.log("error", `ingest processing error (${asset}/${source}): ${(err as Error).stack ?? err}`);
      }
    }

    this.onTick?.(asset, source, tick);
  }

  private prune(buf: PriceTick[]): void {
    const cutoff = Date.now() - TICK_BUFFER_MS;
    while (buf.length > 0 && buf[0].ts < cutoff) buf.shift();
  }

  private countTicksSince(buf: PriceTick[], sinceMs: number): number {
    let n = 0;
    for (let i = buf.length - 1; i >= 0 && buf[i].ts >= sinceMs; i--) n++;
    return n;
  }

  // -------------------------------------------------------------------------
  // Market discovery
  // -------------------------------------------------------------------------

  private async refreshSession(session: InternalSession): Promise<void> {
    if (session.discovering || this.stopped) return;
    session.discovering = true;
    try {
      const spot = this.assets.get(session.asset)!.latest.index?.price ?? null;
      const now = Date.now();
      // Same session still running? Use the cheap per-event lookup.
      const preferEventTicker =
        session.market && now < session.market.endTs ? session.market.eventTicker : null;
      const { info } = await discoverMarket(
        this.api,
        session.asset,
        session.horizon,
        now,
        spot,
        { preferEventTicker, log: (m) => this.log("info", m) },
      );
      const isNew = session.market?.ticker !== info.ticker;
      const sameSession = session.market?.eventTicker === info.eventTicker;
      session.market = info;
      session.discoveryError = null;
      session.notListed = false;
      session.retryDelayMs = 0;
      session.nextRetryAt = 0;
      if (isNew) {
        this.log(
          "info",
          `${session.asset.toUpperCase()} ${session.horizon}: ${sameSession ? "re-centered on" : "tracking"} ` +
            `${info.ticker} (strike ${info.strike}${info.ladderSize > 1 ? `, ladder of ${info.ladderSize}` : ""})`,
        );
        this.updateBookSubscriptions();
      }
    } catch (err) {
      const notListed = isNotListed(err);
      const message = (err as Error).message;
      // Back off on failure: 15s, 30s, … capped at 5min, so a series the
      // exchange isn't listing right now costs one call every few minutes.
      session.retryDelayMs = Math.min(
        session.retryDelayMs > 0 ? session.retryDelayMs * 2 : 15000,
        300000,
      );
      session.nextRetryAt = Date.now() + session.retryDelayMs;
      if (!session.notListed || !notListed) {
        this.log(
          notListed ? "info" : "warn",
          `${session.asset.toUpperCase()} ${session.horizon}: ${message} (retrying in ${Math.round(session.retryDelayMs / 1000)}s)`,
        );
      }
      session.notListed = notListed;
      session.discoveryError = notListed ? `not listed right now — ${message}` : message;
      if (session.market && Date.now() >= session.market.endTs) {
        session.market = null;
        this.updateBookSubscriptions();
      }
    } finally {
      session.discovering = false;
    }
  }

  private updateBookSubscriptions(): void {
    const tickers: string[] = [];
    for (const s of this.sessions.values()) {
      if (s.market && Date.now() < s.market.endTs + 5000) tickers.push(s.market.ticker);
    }
    this.booksFeed.setTickers(tickers);
  }

  // -------------------------------------------------------------------------
  // Settlement window
  // -------------------------------------------------------------------------

  private settleState(session: InternalSession, a: AssetState): SettleWindowState | null {
    const market = session.market;
    if (!market) return null;
    const now = Date.now();
    const windowStart = market.endTs - market.settleWindowSec * 1000;
    if (now < windowStart) return null;
    const ticks = a.ticks.index.filter((t) => t.ts >= windowStart && t.ts <= market.endTs);
    const elapsedSec = Math.min((now - windowStart) / 1000, market.settleWindowSec);
    if (ticks.length === 0) return { elapsedSec, avgSoFar: null, projected: null };
    const avgSoFar = ticks.reduce((s, t) => s + t.price, 0) / ticks.length;
    const spot = a.latest.index?.price ?? avgSoFar;
    const w = market.settleWindowSec;
    const projected = (avgSoFar * elapsedSec + spot * (w - elapsedSec)) / w;
    return { elapsedSec, avgSoFar, projected };
  }

  // -------------------------------------------------------------------------
  // State assembly
  // -------------------------------------------------------------------------

  private key(asset: AssetId, horizon: HorizonId): string {
    return `${asset}:${horizon}`;
  }

  private computeSignal(
    session: InternalSession,
    a: AssetState,
    settle: SettleWindowState | null,
  ): SignalState | null {
    const spot = a.latest.index?.price ?? null;
    const market = session.market;
    if (spot == null) return null;

    const horizonSec = HORIZONS[session.horizon].seconds;
    const secondsLeft = market ? Math.max(0, (market.endTs - Date.now()) / 1000) : null;
    const entry = market ? this.books.get(market.ticker) : null;
    const up = entry?.up ?? null;
    const down = entry?.down ?? null;

    const estimators = a.vol
      .filter((v) => v.state !== null)
      .map((v) => ({ halfLifeSec: v.halfLifeSec, state: v.state! }));
    const tau = secondsLeft ?? horizonSec;
    const sigma = blendSigma(estimators, Math.max(tau, 1));

    let p: number | null = null;
    if (market && sigma > 0 && tau >= 0) {
      const partial =
        settle?.avgSoFar != null
          ? { avgSoFar: settle.avgSoFar, elapsedSec: settle.elapsedSec }
          : null;
      const pAbove = probAvgAbove(
        spot,
        market.strike,
        sigma,
        tau,
        market.settleWindowSec,
        partial,
        INDEX_UNCERTAINTY,
      );
      p = market.strikeType === "less" ? 1 - pAbove : pAbove;
    }

    const bz =
      a.latest.index && a.latest.binance
        ? basisZ(a.basis, a.latest.index.price, a.latest.binance.price)
        : null;
    const basisPct =
      a.latest.index && a.latest.binance
        ? (a.latest.binance.price - a.latest.index.price) / a.latest.index.price
        : null;

    if (p == null || market == null || secondsLeft == null) {
      return {
        probUp: p,
        fairUp: p,
        fairDown: p != null ? 1 - p : null,
        upBuyEdge: null,
        downBuyEdge: null,
        sigmaRemaining: sigma > 0 && tau > 0 ? sigma * Math.sqrt(tau) : null,
        annualizedVol: sigma > 0 ? annualizedVol(sigma) : null,
        basisZ: bz,
        basisPct,
        direction: "NONE",
        strength: 0,
        components: [],
        kellyFraction: null,
        phase: market == null ? "NO_MARKET" : "WARMING_UP",
      };
    }

    const composite = compositeSignal({
      probUp: p,
      upAsk: up?.bestAsk ?? null,
      upBid: up?.bestBid ?? null,
      downAsk: down?.bestAsk ?? null,
      downBid: down?.bestBid ?? null,
      basisZ: bz,
      upImbalance: up?.imbalance ?? null,
      downImbalance: down?.imbalance ?? null,
      secondsLeft,
      horizonSec,
      fee: market.feeSchedule,
    });

    if (
      composite.direction !== session.lastDirection &&
      composite.direction !== "NONE" &&
      composite.strength >= 40
    ) {
      this.log(
        "signal",
        `${session.asset.toUpperCase()} ${session.horizon}: ${composite.direction} ` +
          `(${composite.strength}) fair ${(p * 100).toFixed(1)}c`,
      );
    }
    session.lastDirection = composite.direction;

    return {
      probUp: p,
      fairUp: p,
      fairDown: 1 - p,
      upBuyEdge: composite.upBuyEdge,
      downBuyEdge: composite.downBuyEdge,
      sigmaRemaining: sigma * Math.sqrt(Math.max(tau, 0)),
      annualizedVol: annualizedVol(sigma),
      basisZ: bz,
      basisPct,
      direction: composite.direction,
      strength: composite.strength,
      components: composite.components,
      kellyFraction: composite.kellyFraction,
      phase: composite.phase,
    };
  }

  sessionStates(): SessionState[] {
    const out: SessionState[] = [];
    for (const asset of ASSET_IDS) {
      const a = this.assets.get(asset)!;
      for (const horizon of HORIZON_IDS) {
        const s = this.sessions.get(this.key(asset, horizon))!;
        const spot = a.latest.index?.price ?? null;
        const strike = s.market?.strike ?? null;
        const entry = s.market ? this.books.get(s.market.ticker) : null;
        const settle = this.settleState(s, a);
        out.push({
          asset,
          horizon,
          market: s.market,
          strike,
          strikeSource: s.market ? "kalshi_api" : "unknown",
          spot,
          delta: spot != null && strike != null ? spot - strike : null,
          deltaPct: spot != null && strike != null ? (spot - strike) / strike : null,
          secondsLeft: s.market ? Math.max(0, (s.market.endTs - Date.now()) / 1000) : null,
          up: entry?.up ?? null,
          down: entry?.down ?? null,
          settle,
          signal: this.computeSignal(s, a, settle),
          discoveryError: s.discoveryError,
        });
      }
    }
    return out;
  }

  appState(): AppState {
    const feeds = {} as AppState["feeds"];
    for (const asset of ASSET_IDS) {
      const a = this.assets.get(asset)!;
      for (const src of ["index", "binance"] as FeedSource[]) {
        a.status[src].ticksPerMin = this.countTicksSince(a.ticks[src], Date.now() - 60000);
        const fresh =
          a.status[src].lastTickTs != null && Date.now() - a.status[src].lastTickTs! < 10000;
        if (!fresh) a.status[src].connected = (a.status[src].sourcesUp?.length ?? 0) > 0 && fresh;
      }
      feeds[asset] = { index: { ...a.status.index }, binance: { ...a.status.binance } };
    }
    return {
      serverTs: Date.now(),
      assets: [...ASSET_IDS],
      feeds,
      sessions: this.sessionStates(),
      trading: this.tradingStatus(),
      log: this.logEntries.slice(-120).reverse(),
    };
  }

  chartData(asset: AssetId): ChartData {
    const a = this.assets.get(asset)!;
    return {
      asset,
      index: a.ticks.index.slice(-2400),
      binance: a.ticks.binance.slice(-2400),
    };
  }

  marketFor(asset: AssetId, horizon: HorizonId) {
    return this.sessions.get(this.key(asset, horizon))?.market ?? null;
  }

  log(level: LogEntry["level"], text: string): void {
    this.logEntries.push({ ts: Date.now(), level, text });
    if (this.logEntries.length > 500) this.logEntries.splice(0, this.logEntries.length - 500);
    // eslint-disable-next-line no-console
    console.log(`[${new Date().toISOString()}] ${level.toUpperCase()} ${text}`);
  }
}
