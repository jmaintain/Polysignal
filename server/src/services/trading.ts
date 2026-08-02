import { randomUUID } from "node:crypto";
import type { PositionInfo, TradingStatus } from "@polysignal/shared";
import type { KalshiApi } from "./kalshiApi.js";

export interface TradeRequest {
  ticker: string;
  side: "yes" | "no";
  action: "buy" | "sell";
  /** Limit price in cents (1-99). */
  priceCents: number;
  /** Number of contracts. */
  count: number;
}

export interface TradeResult {
  ok: boolean;
  orderId?: string;
  status?: string;
  error?: string;
}

/**
 * Optional manual-trading gateway for Kalshi.
 *
 * Inert unless TRADING_ENABLED=true and a Kalshi API key is configured.
 * Orders are limit orders signed with your API key; there is deliberately
 * no automated execution loop — every order is an explicit dashboard action.
 */
export class TradingService {
  private status: TradingStatus = {
    enabled: false,
    address: null,
    usdcBalance: null,
    positions: [],
    lastError: null,
  };
  private refreshTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly api: KalshiApi,
    private readonly log: (level: "info" | "warn" | "error" | "trade", text: string) => void,
  ) {
    this.status.enabled = process.env.TRADING_ENABLED === "true" && api.authenticated;
    if (process.env.TRADING_ENABLED === "true" && !api.authenticated) {
      this.log("warn", "TRADING_ENABLED set but no Kalshi API key configured — trading stays off");
    }
  }

  getStatus(): TradingStatus {
    return { ...this.status, positions: [...this.status.positions] };
  }

  start(): void {
    if (!this.status.enabled) return;
    this.status.address = process.env.KALSHI_API_KEY_ID
      ? `key ${process.env.KALSHI_API_KEY_ID.slice(0, 8)}…`
      : null;
    void this.refresh();
    this.refreshTimer = setInterval(() => void this.refresh(), 20000);
  }

  stop(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
  }

  private async refresh(): Promise<void> {
    try {
      const bal = await this.api.getBalance();
      this.status.usdcBalance = bal.balance / 100; // cents -> dollars
    } catch (err) {
      this.status.lastError = `balance: ${(err as Error).message}`;
    }
    try {
      const res = await this.api.getPositions();
      const rows = res.market_positions ?? [];
      this.status.positions = rows
        .filter((r) => Number(r.position) !== 0)
        .map((r): PositionInfo => {
          const net = Number(r.position);
          return {
            asset: String(r.ticker ?? ""),
            outcome: net > 0 ? "YES" : "NO",
            tokenId: String(r.ticker ?? ""),
            size: Math.abs(net),
            avgPrice:
              Number(r.market_exposure ?? 0) > 0 && net !== 0
                ? Number(r.market_exposure) / 100 / Math.abs(net)
                : 0,
            curPrice: null,
            title: String(r.ticker ?? ""),
          };
        });
    } catch (err) {
      this.status.lastError = `positions: ${(err as Error).message}`;
    }
  }

  async placeOrder(req: TradeRequest): Promise<TradeResult> {
    if (!this.status.enabled) {
      return {
        ok: false,
        error: "trading disabled (set TRADING_ENABLED=true and a Kalshi API key in .env)",
      };
    }
    const price = Math.round(req.priceCents);
    if (!(price >= 1 && price <= 99) || !(req.count >= 1)) {
      return { ok: false, error: "invalid price/count" };
    }
    try {
      const body = {
        ticker: req.ticker,
        client_order_id: randomUUID(),
        side: req.side,
        action: req.action,
        count: Math.floor(req.count),
        type: "limit" as const,
        ...(req.side === "yes" ? { yes_price: price } : { no_price: price }),
      };
      const res = await this.api.createOrder(body);
      this.log(
        "trade",
        `${req.action} ${req.count}x ${req.side.toUpperCase()} ${req.ticker} @ ${price}c -> ${res.order?.status ?? "submitted"}`,
      );
      void this.refresh();
      return { ok: true, orderId: res.order?.order_id, status: res.order?.status };
    } catch (err) {
      const error = (err as Error).message;
      this.status.lastError = error;
      this.log("error", `order failed: ${error}`);
      return { ok: false, error };
    }
  }
}
