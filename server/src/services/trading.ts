import type { PositionInfo, TradingStatus } from "@polysignal/shared";
import { CLOB_REST_URL, DATA_API_URL, USER_AGENT } from "../config.js";

export interface TradeRequest {
  tokenId: string;
  side: "BUY" | "SELL";
  /** Limit price in dollars (0-1). */
  price: number;
  /** Shares for limit orders; USD amount for market orders. */
  size: number;
  orderKind: "limit" | "market";
  tickSize: number | null;
  negRisk: boolean;
}

export interface TradeResult {
  ok: boolean;
  orderId?: string;
  status?: string;
  error?: string;
}

/**
 * Optional manual-trading gateway around @polymarket/clob-client.
 *
 * Entirely inert unless TRADING_ENABLED=true and POLYMARKET_PRIVATE_KEY are
 * set. The private key never leaves this process; API credentials are
 * derived on first use. There is deliberately no automated execution loop —
 * every order requires an explicit dashboard action.
 */
export class TradingService {
  private client: unknown | null = null;
  private initPromise: Promise<void> | null = null;
  private status: TradingStatus = {
    enabled: false,
    address: null,
    usdcBalance: null,
    positions: [],
    lastError: null,
  };
  private positionsTimer: NodeJS.Timeout | null = null;

  constructor(private readonly log: (level: "info" | "warn" | "error" | "trade", text: string) => void) {
    this.status.enabled =
      process.env.TRADING_ENABLED === "true" && Boolean(process.env.POLYMARKET_PRIVATE_KEY);
  }

  getStatus(): TradingStatus {
    return { ...this.status, positions: [...this.status.positions] };
  }

  start(): void {
    if (!this.status.enabled) return;
    void this.ensureClient();
    this.positionsTimer = setInterval(() => void this.refreshPositions(), 20000);
    void this.refreshPositions();
  }

  stop(): void {
    if (this.positionsTimer) clearInterval(this.positionsTimer);
  }

  private async ensureClient(): Promise<void> {
    if (this.client) return;
    if (!this.initPromise) {
      this.initPromise = this.init().catch((err) => {
        this.status.lastError = `init failed: ${(err as Error).message}`;
        this.log("error", `trading init failed: ${(err as Error).message}`);
        this.initPromise = null;
        throw err;
      });
    }
    await this.initPromise;
  }

  private async init(): Promise<void> {
    const pk = process.env.POLYMARKET_PRIVATE_KEY!;
    const funder = process.env.POLYMARKET_FUNDER_ADDRESS || undefined;
    const sigType = Number(process.env.POLYMARKET_SIGNATURE_TYPE ?? (funder ? "1" : "0"));

    const { ClobClient } = await import("@polymarket/clob-client");
    const { Wallet } = await import("@ethersproject/wallet");
    const signer = new Wallet(pk);

    const bootstrap = new ClobClient(CLOB_REST_URL, 137, signer, undefined, sigType, funder);
    const creds = await bootstrap.createOrDeriveApiKey();
    this.client = new ClobClient(CLOB_REST_URL, 137, signer, creds, sigType, funder);
    this.status.address = funder ?? signer.address;
    this.log("info", `trading enabled for ${this.status.address} (sig type ${sigType})`);
    await this.refreshBalance();
  }

  private async refreshBalance(): Promise<void> {
    try {
      const client = this.client as {
        getBalanceAllowance: (p: { asset_type: string }) => Promise<{ balance?: string }>;
      };
      const res = await client.getBalanceAllowance({ asset_type: "COLLATERAL" });
      if (res?.balance != null) {
        this.status.usdcBalance = Number(res.balance) / 1e6;
      }
    } catch (err) {
      this.log("warn", `balance fetch failed: ${(err as Error).message}`);
    }
  }

  private async refreshPositions(): Promise<void> {
    if (!this.status.enabled || !this.status.address) return;
    try {
      const res = await fetch(
        `${DATA_API_URL}/positions?user=${this.status.address}&sizeThreshold=0.1&limit=50`,
        { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(10000) },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const rows = (await res.json()) as Record<string, unknown>[];
      this.status.positions = rows.map(
        (r): PositionInfo => ({
          asset: String(r.asset ?? ""),
          outcome: String(r.outcome ?? ""),
          tokenId: String(r.asset ?? ""),
          size: Number(r.size ?? 0),
          avgPrice: Number(r.avgPrice ?? 0),
          curPrice: r.curPrice != null ? Number(r.curPrice) : null,
          title: String(r.title ?? ""),
        }),
      );
    } catch (err) {
      this.status.lastError = `positions: ${(err as Error).message}`;
    }
  }

  async placeOrder(req: TradeRequest): Promise<TradeResult> {
    if (!this.status.enabled) {
      return { ok: false, error: "trading disabled (set TRADING_ENABLED=true and POLYMARKET_PRIVATE_KEY)" };
    }
    try {
      await this.ensureClient();
      const { Side, OrderType } = await import("@polymarket/clob-client");
      const client = this.client as {
        createOrder: (o: object, opts: object) => Promise<object>;
        createMarketOrder: (o: object, opts: object) => Promise<object>;
        postOrder: (o: object, t: string) => Promise<{ success?: boolean; orderID?: string; status?: string; errorMsg?: string }>;
      };
      const side = req.side === "BUY" ? Side.BUY : Side.SELL;
      const tickSize = String(req.tickSize ?? 0.001);
      const opts = { tickSize, negRisk: req.negRisk };

      let signed: object;
      let orderType: string;
      if (req.orderKind === "market") {
        signed = await client.createMarketOrder(
          { side, tokenID: req.tokenId, amount: req.size, price: req.price },
          opts,
        );
        orderType = OrderType.FAK;
      } else {
        signed = await client.createOrder(
          { tokenID: req.tokenId, price: req.price, side, size: req.size },
          opts,
        );
        orderType = OrderType.GTC;
      }
      const res = await client.postOrder(signed, orderType);
      if (res?.success === false || res?.errorMsg) {
        const error = res.errorMsg || "order rejected";
        this.log("warn", `order rejected: ${error}`);
        return { ok: false, error, status: res.status };
      }
      this.log(
        "trade",
        `${req.side} ${req.orderKind} ${req.size}${req.orderKind === "market" ? " USDC" : " shares"} @ ${(req.price * 100).toFixed(1)}c token ${req.tokenId.slice(0, 10)}…`,
      );
      void this.refreshBalance();
      void this.refreshPositions();
      return { ok: true, orderId: res?.orderID, status: res?.status };
    } catch (err) {
      const error = (err as Error).message;
      this.status.lastError = error;
      this.log("error", `order failed: ${error}`);
      return { ok: false, error };
    }
  }
}
