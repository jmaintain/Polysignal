# Polysignal

Real-time monitor for **Polymarket crypto up/down markets** (BTC, ETH, SOL × 5m / 15m / 1h / daily), built around one principle: **watch the exact price feed the market resolves against.**

Polymarket resolves its crypto up/down markets with **Chainlink Data Streams**. Polysignal consumes Polymarket's own Real-Time Data Service topic `crypto_prices_chainlink` — the live mirror of that resolution feed — so the spot price, the "price to beat", and every signal are computed against the number that actually settles the market. (Tools that watch Binance spot and call it "Chainlink" — like this project's predecessor — systematically mis-price sessions, because the oracle print and any single venue routinely diverge by a few basis points, which is the entire game on a 5-minute binary.)

## What it does

- **Chainlink-true spot + "price to beat"** for every asset/horizon, with the strike captured from the Chainlink tick at each session boundary (the resolution definition), with fallbacks (RTDS history dump, Gamma fields) clearly labeled by source.
- **Live market odds** from the CLOB order-book websocket (best bid/ask, mid, microprice, depth imbalance) for the UP and DOWN tokens of every tracked session.
- **Model fair value from functional math** (pure, unit-tested functions in `shared/src/math.ts`):
  - EWMA variance-rate estimation on irregularly spaced Chainlink ticks, at four half-lives (1m / 5m / 30m / 6h), blended by remaining horizon;
  - binary-option pricing under driftless GBM — `P(UP) = Φ((ln(S/K) − σ²τ/2)/(σ√τ))`;
  - buy-edge vs. best ask (fee-aware), binary delta, breakeven move;
  - half-Kelly stake suggestion, hard-capped at 10%.
- **Signals** combining three orthogonal sources, each shown with its own score and rationale:
  1. **Model edge** — fair value vs. market ask;
  2. **Basis lead** — z-score of (Binance − Chainlink)/Chainlink: spot venues lead the oracle aggregate, so a stretched basis anticipates the next oracle prints;
  3. **Book pressure** — depth imbalance on the UP vs DOWN books.
  Sessions gate to `WARMING_UP` / `TRADEABLE` / `NEAR_LOCK` / `LOCKED` so the near-expiry chaos is never presented as an opportunity.
- **Dashboard**: dark trading UI with the asset matrix, focused-market panel, live Chainlink-vs-Binance chart with strike line, and a signal/event log.
- **Optional manual trading** (off by default): one-click limit/market orders through the official CLOB client, signed locally with your key. **There is deliberately no automated trading loop.**

## Quick start

```bash
npm install
npm run dev        # server on :8788, dashboard on http://localhost:5173
```

Production-ish: `npm run build && npm start` then open http://localhost:8788.

## Validation (definition of done)

```bash
npm run validate             # ~40s live check
npm run validate -- --strike # + waits through a 5m boundary to verify strike capture
```

The harness proves, against live endpoints:
1. `crypto_prices_chainlink` streams fresh ticks for BTC/ETH/SOL (feed is live, timestamps recent and monotone);
2. Chainlink prices agree with the independent Binance topic (median basis < 0.5%) and, when reachable, external references (Kraken/Coinbase);
3. Gamma discovery finds the active up/down market for every asset/horizon with a sane end time;
4. CLOB books are live and UP + DOWN mids sum to ≈ $1;
5. (`--strike`) the tick captured at a session boundary matches the new session's reference.

There is also an offline plumbing test that needs no network: `npm exec -w server tsx src/smoke.ts`.

## Optional: connect your Polymarket account

Copy `.env.example` to `.env`, set `TRADING_ENABLED=true`, `POLYMARKET_PRIVATE_KEY`, and (for email/browser accounts) `POLYMARKET_FUNDER_ADDRESS` + `POLYMARKET_SIGNATURE_TYPE`. Restart the server; the dashboard's trade panel unlocks. Orders are signed in-process and posted directly to the CLOB — the key never leaves your machine.

## Architecture

```
Polymarket RTDS (wss://ws-live-data.polymarket.com)
  ├─ crypto_prices_chainlink  ← resolution-source prices (1 conn/symbol)
  └─ crypto_prices (Binance)  ← leading-indicator prices
Gamma API (gamma-api.polymarket.com)     ← market discovery (slug = btc-updown-15m-<slot>)
CLOB WS (ws-subscriptions-clob…/ws/market) ← UP/DOWN order books
        │
        ▼
server/ (Node + TS)          shared/ (pure math + types, unit-tested)
  feeds/rtds.ts  feeds/clob.ts
  services/discovery.ts  services/engine.ts  services/trading.ts
  server.ts (REST + WS)  validate.ts (live proof)  smoke.ts (offline proof)
        │  websocket state push (2 Hz) + per-tick stream
        ▼
web/ (React + Vite)  — matrix, focus panel, canvas chart, signal log, trade panel
```

## Honest limitations

- The RTDS chainlink topic is Polymarket's published mirror of its resolution feed; final settlement uses the onchain-verified Chainlink Data Streams report at the boundary timestamp. Sub-second differences around the exact boundary tick are possible.
- The fair-value model is driftless GBM with EWMA vol — a strong baseline for these horizons, not an oracle. Signals are information, not advice.
- Daily/hourly slug conventions are auto-discovered with fallbacks; if Polymarket renames a series, discovery logs the miss rather than guessing silently.
