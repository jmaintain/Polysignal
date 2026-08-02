# Polysignal

Real-time monitor for **Kalshi crypto markets** (BTC, ETH, SOL × 15m / 1h / daily), built around one principle: **model the exact settlement rule the market resolves on.**

Kalshi's crypto markets settle on **CF Benchmarks' Real-Time Index** (BRTI for Bitcoin, and the corresponding RTIs for ETH/SOL) — and not on a closing print, but on the **simple average of the final 60 one-second index prices**. Polysignal streams a live proxy of that index, prices every market against the *average*-settlement rule (including inside the final minute, where part of the average is already known), and shows where the market's odds diverge from the model. Kalshi is CFTC-regulated and available in all 50 US states, Arizona included.

## What it does

- **CF-RTI proxy feed**: a 1 Hz composite (median) of the index's constituent USD exchanges — Coinbase, Kraken, Bitstamp — mirroring the RTI's cadence. It is a proxy, not the licensed index; `npm run validate -- --settle` grades it against Kalshi's *actual settlements* so its accuracy is proven, not assumed. Binance streams alongside as a leading indicator (it is not an RTI constituent, which is what makes it an orthogonal signal).
- **Strikes straight from the API**: the "price to beat" is the market's published strike — exact, no capture heuristics. Ladders (hourly/daily) auto-select the at-the-money strike.
- **Average-settlement pricing** (pure, unit-tested math in `shared/src/math.ts`):
  - outside the final minute: effective horizon `(τ − 60s) + 20s` (variance of a Brownian time-average);
  - inside the final minute: the observed partial average is blended in, and the probability **pins to 1/0 once the average is mathematically banked** — the regime where these markets misprice most;
  - EWMA vol at four half-lives blended by remaining horizon; edges **net of Kalshi's taker fee** (7% × P × (1−P)); half-Kelly sizing capped at 10%.
- **Signals**: model edge vs market (60%), Binance-leads-index basis z-score (25%), YES/NO order-book pressure (15%) — each shown with its own score and plain-language rationale.
- **Simple Mode**: 🟢/🟡/⚪ verdicts, plain-English sentences, confidence dial, and STRONG-transition alerts for non-trader use; Expert Mode keeps every number.
- **Optional manual trading** (off by default): one-click limit orders via your Kalshi API key. **No automated trading loop exists in this codebase.**

## Quick start

```bash
npm install
npm run dev        # server on :8788, dashboard on http://localhost:5173
```

Monitor-only works with zero configuration (public REST market data). For sub-second full-depth order books and the trading panel, create a free API key on Kalshi (Settings → API keys), save the RSA private key it gives you, and fill in `.env` (see `.env.example`).

## Validation

```bash
npm run probe                 # dump live Kalshi series/market/orderbook facts
npm run validate              # ~40s: feeds, discovery, book identities
npm run validate -- --settle  # + waits for a real 15m expiry and checks our
                              #   60s average against the actual settlement
```

Offline plumbing test (no network): `npm exec -w server tsx src/smoke.ts`.

## Architecture

```
Coinbase ─┐
Kraken  ──┼─ median @1Hz ─→ CF-RTI proxy (settlement source model)
Bitstamp ─┘                       │
Binance bookTicker ─→ lead indicator (basis z-score)
                                  ▼
Kalshi REST/WS ─→ discovery (series scan → ATM strike), YES/NO books
                                  │
                                  ▼
server/ (Node+TS)   shared/ (pure math + Simple Mode logic, 51 tests)
  feeds/exchanges.ts  feeds/kalshiBooks.ts
  services/indexProxy.ts  services/kalshiApi.ts  services/discovery.ts
  services/engine.ts  services/trading.ts
  server.ts  validate.ts  probe.ts  smoke.ts
                                  │  websocket push (2 Hz) + per-tick stream
                                  ▼
web/ (React+Vite) — matrix, focus panel (expert + simple), chart, trading
```

## Honest limitations

- The index proxy tracks CF Benchmarks closely but is not the licensed feed; near-strike settlements within the proxy's error band (typically a few basis points) are genuinely uncertain — the dashboard's edge math treats the strike as exact, so don't trade the last cent of a coin-flip settlement.
- Series auto-discovery classifies Kalshi series by close-time cadence; if Kalshi restructures a series, pin it via `KALSHI_SERIES_*` env vars (`npm run probe` shows what's live).
- The fair-value model is driftless GBM with EWMA vol — a strong baseline, not an oracle. Signals are information, not financial advice.
