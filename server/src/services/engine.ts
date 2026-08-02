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
  SignalState,
  StrikeSource,
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
  probUp,
  updateBasis,
  updateEwmaVar,
  type BasisState,
  type EwmaVarState,
} from "@polysignal/shared";
import {
  ASSET_IDS,
  FEE_RATE,
  HORIZONS,
  HORIZON_IDS,
  TICK_BUFFER_MS,
  VOL_HALF_LIVES,
} from "../config.js";
import { ClobMarketFeed } from "../feeds/clob.js";
import { discoverMarket, slotStartSec } from "./discovery.js";

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
  slotStart: number | null; // unix sec
  market: SessionState["market"];
  strike: number | null;
  strikeSource: StrikeSource;
  gammaStrike: number | null;
  discoveryError: string | null;
  discovering: boolean;
  lastDirection: string;
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
  private books = new Map<string, TokenBook>();
  private logEntries: LogEntry[] = [];
  private clob: ClobMarketFeed;
  private discoveryTimer: NodeJS.Timeout | null = null;
  private diagTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private liveCounts: Record<string, number> = {};
  private lastIngestErrorTs = 0;

  /** Hook for the websocket server: called for every accepted price tick. */
  onTick: ((asset: AssetId, source: FeedSource, tick: PriceTick) => void) | null = null;

  /** Supplied by the trading service; defaults to disabled. */
  tradingStatus: () => TradingStatus = () => ({
    enabled: false,
    address: null,
    usdcBalance: null,
    positions: [],
    lastError: null,
  });

  constructor() {
    for (const asset of ASSET_IDS) {
      this.assets.set(asset, {
        ticks: { chainlink: [], binance: [] },
        status: { chainlink: emptyStatus(), binance: emptyStatus() },
        vol: VOL_HALF_LIVES.map((halfLifeSec) => ({ halfLifeSec, state: null })),
        basis: initBasis(),
        latest: { chainlink: null, binance: null },
      });
      for (const horizon of HORIZON_IDS) {
        this.sessions.set(this.key(asset, horizon), {
          asset,
          horizon,
          slotStart: null,
          market: null,
          strike: null,
          strikeSource: "unknown",
          gammaStrike: null,
          discoveryError: null,
          discovering: false,
          lastDirection: "NONE",
        });
      }
    }
    this.clob = new ClobMarketFeed({
      onBook: (tokenId, book) => this.books.set(tokenId, book),
      log: (msg) => this.log("warn", msg),
    });
  }

  start(): void {
    // Kick off discovery for every session, then keep it fresh.
    for (const session of this.sessions.values()) void this.refreshSession(session);
    this.discoveryTimer = setInterval(() => {
      const now = Date.now();
      for (const session of this.sessions.values()) {
        const rolledOver = session.market !== null && now >= session.market.endTs + 1500;
        const missing = session.market === null && !session.discovering;
        if (rolledOver || missing) void this.refreshSession(session);
      }
    }, 3000);
    this.diagTimer = setInterval(() => {
      const parts: string[] = [];
      for (const asset of ASSET_IDS) {
        const cl = this.liveCounts[`${asset}:chainlink`] ?? 0;
        const bn = this.liveCounts[`${asset}:binance`] ?? 0;
        parts.push(`${asset} cl:${cl} bn:${bn}`);
      }
      this.liveCounts = {};
      this.log("info", `diag live ticks/min — ${parts.join("  ")}`);
    }, 60000);
  }

  stop(): void {
    this.stopped = true;
    if (this.discoveryTimer) clearInterval(this.discoveryTimer);
    if (this.diagTimer) clearInterval(this.diagTimer);
    this.clob.stop();
  }

  // -------------------------------------------------------------------------
  // Feed intake
  // -------------------------------------------------------------------------

  feedStatusChanged(asset: AssetId, source: FeedSource, connected: boolean): void {
    const a = this.assets.get(asset)!;
    if (a.status[source].connected !== connected) {
      this.log(connected ? "info" : "warn", `${asset.toUpperCase()} ${source} feed ${connected ? "connected" : "disconnected"}`);
    }
    a.status[source].connected = connected;
  }

  ingestTick(asset: AssetId, source: FeedSource, tick: PriceTick): void {
    const a = this.assets.get(asset)!;
    const buf = a.ticks[source];
    const last = buf[buf.length - 1];
    if (last && tick.ts <= last.ts) return; // drop stale/duplicate
    buf.push(tick);
    this.prune(buf);
    a.latest[source] = tick;
    const st = a.status[source];
    st.lastTickTs = tick.ts;
    st.lastPrice = tick.price;
    st.latencyMs = Date.now() - tick.ts;
    st.ticksPerMin = this.countTicksSince(buf, Date.now() - 60000);
    this.liveCounts[`${asset}:${source}`] = (this.liveCounts[`${asset}:${source}`] ?? 0) + 1;

    try {
      if (source === "chainlink") {
        for (const v of a.vol) {
          v.state = v.state
            ? updateEwmaVar(v.state, tick.price, tick.ts, v.halfLifeSec)
            : initEwmaVar(tick.price, tick.ts);
        }
        this.captureBoundaries(asset, tick);
      }

      // Basis uses near-simultaneous pairs only.
      const other = a.latest[source === "chainlink" ? "binance" : "chainlink"];
      if (other && Math.abs(other.ts - tick.ts) < 3000) {
        const cl = source === "chainlink" ? tick.price : other.price;
        const bn = source === "binance" ? tick.price : other.price;
        a.basis = updateBasis(a.basis, cl, bn);
      }
    } catch (err) {
      // Never let bookkeeping kill the tick stream; surface it loudly instead.
      if (Date.now() - this.lastIngestErrorTs > 10000) {
        this.lastIngestErrorTs = Date.now();
        this.log("error", `ingest processing error (${asset}/${source}): ${(err as Error).stack ?? err}`);
      }
    }

    this.onTick?.(asset, source, tick);
  }

  ingestHistory(asset: AssetId, source: FeedSource, ticks: PriceTick[]): void {
    const a = this.assets.get(asset)!;
    const buf = a.ticks[source];
    const existing = new Set(buf.map((t) => t.ts));
    for (const t of ticks) {
      if (!existing.has(t.ts)) buf.push(t);
    }
    buf.sort((x, y) => x.ts - y.ts);
    this.prune(buf);
    if (source === "chainlink") {
      this.log("info", `${asset.toUpperCase()} chainlink history dump: ${ticks.length} ticks`);
      this.recoverStrikesFromHistory(asset);
    }
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
  // Strike capture ("price to beat" = Chainlink price at session open)
  // -------------------------------------------------------------------------

  private captureBoundaries(asset: AssetId, tick: PriceTick): void {
    const a = this.assets.get(asset)!;
    for (const horizon of HORIZON_IDS) {
      const session = this.sessions.get(this.key(asset, horizon))!;
      const slot = slotStartSec(tick.ts, horizon);
      if (session.slotStart === slot) continue;

      const boundaryMs = slot * 1000;
      const prev = this.lastTickAtOrBefore(a.ticks.chainlink, boundaryMs, tick);
      session.slotStart = slot;
      if (tick.ts === boundaryMs) {
        session.strike = tick.price;
        session.strikeSource = "boundary_tick";
      } else if (prev && boundaryMs - prev.ts <= 5000) {
        session.strike = prev.price;
        session.strikeSource = "boundary_tick";
      } else if (tick.ts - boundaryMs <= 5000) {
        // Booted mid-gap: first tick shortly after the boundary.
        session.strike = tick.price;
        session.strikeSource = "boundary_tick";
      } else {
        session.strike = session.gammaStrike;
        session.strikeSource = session.gammaStrike != null ? "gamma_field" : "unknown";
      }
      if (horizon === "5m" || horizon === "15m") {
        this.log(
          "info",
          `${asset.toUpperCase()} ${horizon} session ${slot}: price to beat ${session.strike?.toFixed(2) ?? "?"} (${session.strikeSource})`,
        );
      }
    }
  }

  private lastTickAtOrBefore(
    buf: PriceTick[],
    tsMs: number,
    exclude?: PriceTick,
  ): PriceTick | null {
    for (let i = buf.length - 1; i >= 0; i--) {
      const t = buf[i];
      if (t === exclude) continue;
      if (t.ts <= tsMs) return t;
    }
    return null;
  }

  private recoverStrikesFromHistory(asset: AssetId): void {
    const a = this.assets.get(asset)!;
    for (const horizon of HORIZON_IDS) {
      const session = this.sessions.get(this.key(asset, horizon))!;
      if (session.strike !== null && session.strikeSource === "boundary_tick") continue;
      const slot = session.slotStart ?? slotStartSec(Date.now(), horizon);
      const boundaryMs = slot * 1000;
      const prev = this.lastTickAtOrBefore(a.ticks.chainlink, boundaryMs);
      if (prev && boundaryMs - prev.ts <= 10000) {
        session.slotStart = slot;
        session.strike = prev.price;
        session.strikeSource = "rtds_history";
      }
    }
  }

  // -------------------------------------------------------------------------
  // Market discovery
  // -------------------------------------------------------------------------

  private async refreshSession(session: InternalSession): Promise<void> {
    if (session.discovering || this.stopped) return;
    session.discovering = true;
    try {
      const now = Date.now();
      const { info, gammaStrike } = await discoverMarket(session.asset, session.horizon, now);
      const isNew = session.market?.slug !== info.slug;
      session.market = info;
      session.gammaStrike = gammaStrike;
      session.discoveryError = null;
      if (session.strike === null && gammaStrike !== null) {
        session.strike = gammaStrike;
        session.strikeSource = "gamma_field";
      }
      if (isNew) {
        this.log("info", `${session.asset.toUpperCase()} ${session.horizon}: tracking ${info.slug}`);
        this.updateClobSubscriptions();
      }
    } catch (err) {
      session.discoveryError = (err as Error).message;
      if (session.market && Date.now() >= session.market.endTs) {
        session.market = null; // expired; stop quoting stale odds
        this.updateClobSubscriptions();
      }
    } finally {
      session.discovering = false;
    }
  }

  private updateClobSubscriptions(): void {
    const tokens: string[] = [];
    for (const s of this.sessions.values()) {
      if (s.market && Date.now() < s.market.endTs + 5000) {
        tokens.push(s.market.upTokenId, s.market.downTokenId);
      }
    }
    this.clob.setTokens(tokens);
  }

  // -------------------------------------------------------------------------
  // State assembly
  // -------------------------------------------------------------------------

  private key(asset: AssetId, horizon: HorizonId): string {
    return `${asset}:${horizon}`;
  }

  private computeSignal(session: InternalSession, a: AssetState): SignalState | null {
    const spot = a.latest.chainlink?.price ?? null;
    const market = session.market;
    if (spot == null) return null;

    const horizonSec = HORIZONS[session.horizon].seconds;
    const secondsLeft = market ? Math.max(0, (market.endTs - Date.now()) / 1000) : null;
    const up = market ? this.books.get(market.upTokenId) ?? null : null;
    const down = market ? this.books.get(market.downTokenId) ?? null : null;

    const estimators = a.vol
      .filter((v) => v.state !== null)
      .map((v) => ({ halfLifeSec: v.halfLifeSec, state: v.state! }));
    const tau = secondsLeft ?? horizonSec;
    const sigma = blendSigma(estimators, Math.max(tau, 1));

    let p: number | null = null;
    if (session.strike != null && sigma > 0 && tau > 0) {
      p = probUp(spot, session.strike, sigma, tau);
    }

    const bz =
      a.latest.chainlink && a.latest.binance
        ? basisZ(a.basis, a.latest.chainlink.price, a.latest.binance.price)
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
        basisPct:
          a.latest.chainlink && a.latest.binance
            ? (a.latest.binance.price - a.latest.chainlink.price) / a.latest.chainlink.price
            : null,
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
      fee: market.feeSchedule ?? (FEE_RATE > 0 ? { rate: FEE_RATE, exponent: 1 } : null),
    });

    const signal: SignalState = {
      probUp: p,
      fairUp: p,
      fairDown: 1 - p,
      upBuyEdge: composite.upBuyEdge,
      downBuyEdge: composite.downBuyEdge,
      sigmaRemaining: sigma * Math.sqrt(tau),
      annualizedVol: annualizedVol(sigma),
      basisZ: bz,
      basisPct:
        a.latest.binance && a.latest.chainlink
          ? (a.latest.binance.price - a.latest.chainlink.price) / a.latest.chainlink.price
          : null,
      direction: composite.direction,
      strength: composite.strength,
      components: composite.components,
      kellyFraction: composite.kellyFraction,
      phase: composite.phase,
    };

    if (
      composite.direction !== session.lastDirection &&
      composite.direction !== "NONE" &&
      composite.strength >= 40
    ) {
      this.log(
        "signal",
        `${session.asset.toUpperCase()} ${session.horizon}: ${composite.direction} ` +
          `(${composite.strength}) fair ${(p * 100).toFixed(1)}c vs ask ` +
          `${composite.direction === "UP" ? fmtCents(up?.bestAsk) : fmtCents(down?.bestAsk)}`,
      );
    }
    session.lastDirection = composite.direction;
    return signal;
  }

  sessionStates(): SessionState[] {
    const out: SessionState[] = [];
    for (const asset of ASSET_IDS) {
      const a = this.assets.get(asset)!;
      for (const horizon of HORIZON_IDS) {
        const s = this.sessions.get(this.key(asset, horizon))!;
        const spot = a.latest.chainlink?.price ?? null;
        const strike = s.strike;
        out.push({
          asset,
          horizon,
          market: s.market,
          strike,
          strikeSource: s.strikeSource,
          spot,
          delta: spot != null && strike != null ? spot - strike : null,
          deltaPct: spot != null && strike != null ? (spot - strike) / strike : null,
          secondsLeft: s.market ? Math.max(0, (s.market.endTs - Date.now()) / 1000) : null,
          up: s.market ? this.books.get(s.market.upTokenId) ?? null : null,
          down: s.market ? this.books.get(s.market.downTokenId) ?? null : null,
          signal: this.computeSignal(s, a),
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
      // Recompute rolling tick rate even when quiet.
      for (const src of ["chainlink", "binance"] as FeedSource[]) {
        a.status[src].ticksPerMin = this.countTicksSince(a.ticks[src], Date.now() - 60000);
      }
      feeds[asset] = {
        chainlink: { ...a.status.chainlink },
        binance: { ...a.status.binance },
      };
    }
    return {
      serverTs: Date.now(),
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
      chainlink: a.ticks.chainlink.slice(-2400),
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

function fmtCents(v: number | null | undefined): string {
  return v == null ? "?" : `${(v * 100).toFixed(1)}c`;
}
