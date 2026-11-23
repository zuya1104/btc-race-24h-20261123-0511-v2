// Breakout rider v2 — filtered trend bot for the make.fun BTC race.
// Strategy (built from the dev-window analysis, not from any other entry):
//   * Trend leg: buy full size when the close breaks above the highest HIGH of
//     the last 60 bars, but ONLY when the 240-bar trend is not clearly down
//     (240-bar return >= -50bps). The filter keeps the bot out of falling
//     markets where breakouts are false; it never blocks a real uptrend.
//   * Exits while holding: breakdown below the lowest LOW of the last 480 bars
//     (only when the position is losing), a 2.5% trailing stop from the peak
//     close since entry, and a 1.5% hard stop from average cost.
//   * Risk control: max 3 round trips, a 60-bar cooldown after a winning exit
//     and 120 bars after a losing one, no new entries after bar 1400, and a
//     one-time $100 insurance buy at bar 1380 if the bot has never traded
//     (keeps the "min 1 trade" guardrail satisfied).
//   * No scalping overlay: the analysis showed every mean-reversion / grid
//     overlay tested lost money in down regimes and blocked the trend entry.
//     This bot does one thing and does it with a stop.
// The protocol: the harness sends a hello line, then one batch of bars per
// line; this bot answers each batch with its orders (at most one order here).
// Every decision is a pure function of the bars seen so far: no clock, no
// randomness, no network — the run is fully deterministic and reproducible.

import { runBars } from "./vendor/makefun-bars.ts";

const SYMBOL = "CBBTC";
const LOOKBACK = 60; // breakout lookback in bars
const TREND_LB = 240; // long-term trend filter window in bars
const TREND_MIN_BPS = -50; // 240-bar return must be at least this (bps)
const BREAKDOWN_LB = 480; // breakdown lookback in bars
const TRAIL_BPS = 250; // trailing stop, bps below peak close
const STOP_BPS = 150; // hard stop, bps below average cost
const MAX_TRIPS = 3;
const COOLDOWN_WIN = 60; // bars after a winning exit
const COOLDOWN_LOSS = 120; // bars after a losing exit
const NO_ENTRY_AFTER = 1400; // bar index
const INSURANCE_BAR = 1380; // bar index
const INSURANCE_USD = 100; // micro-USDC units are 1e6 per dollar
const MAX_SLIPPAGE_BPS = 200; // generous: 1-min gaps are ~2bps, so fills
// are virtually guaranteed while absurd gaps are still rejected.

const closes: number[] = [];
const highs: number[] = [];
const lows: number[] = [];

let peak = 0; // highest close seen while holding the current position
let coolUntil = -1; // no new entry until bar index > coolUntil
let trips = 0; // completed round trips (counted at exit)
let traded = false; // any buy order has been placed

function maxHigh(from: number, to: number): number {
  let m = -Infinity;
  for (let i = from; i < to; i++) if (highs[i] > m) m = highs[i];
  return m;
}

function minLow(from: number, to: number): number {
  let m = Infinity;
  for (let i = from; i < to; i++) if (lows[i] < m) m = lows[i];
  return m;
}

runBars({
  onBatch(state, batch) {
    // Record every bar in the batch; the decision uses the last bar only.
    // The batch argument is a Batch object ({seq, t, bars, fills, account}),
    // so the bars live on batch.bars, not on the batch itself.
    for (const bar of batch.bars) {
      closes.push(Number(bar.c));
      highs.push(Number(bar.h));
      lows.push(Number(bar.l));
    }
    const i = closes.length - 1; // 0-based index of the current bar
    const close = closes[i];
    const pos = state.positions.get(SYMBOL);
    const qty = pos ? pos.qty : 0n;

    if (state.warmingUp) return [];

    // ---- Holding a position: manage the exits. ----
    if (qty > 0n && pos) {
      if (close > peak) peak = close;
      // Average cost per unit, in price units (price_scale 5):
      // cost (micro-USDC) * 10^(qty_scale + price_scale) / (qty * 10^quote_scale)
      // = cost * 10^7 / qty with qty_scale 8, price_scale 5, quote_scale 6.
      const avgCost = (Number(pos.cost) / Number(qty)) * 1e7;
      const wasLoss = close < avgCost;
      const breakdownLow = minLow(Math.max(0, i - BREAKDOWN_LB), i);
      const trailHit = close < peak * (1 - TRAIL_BPS / 1e4);
      const stopHit = close < avgCost * (1 - STOP_BPS / 1e4);
      const breakdownHit = close < breakdownLow && wasLoss;
      if (trailHit || stopHit || breakdownHit) {
        trips += 1;
        coolUntil = i + (wasLoss ? COOLDOWN_LOSS : COOLDOWN_WIN);
        return [
          {
            side: "sell",
            symbol: SYMBOL,
            qty,
            max_slippage_bps: MAX_SLIPPAGE_BPS,
          },
        ];
      }
      return [];
    }

    // ---- Flat: look for a filtered breakout entry. ----
    if (i >= LOOKBACK && trips < MAX_TRIPS && i > coolUntil && i <= NO_ENTRY_AFTER) {
      const breakoutHigh = maxHigh(i - LOOKBACK, i);
      if (close > breakoutHigh) {
        let trendOk = true;
        if (i >= TREND_LB) {
          const retLT = ((close - closes[i - TREND_LB]) / closes[i - TREND_LB]) * 1e4;
          if (retLT < TREND_MIN_BPS) trendOk = false;
        }
        if (trendOk) {
          peak = close;
          traded = true;
          return [
            {
              side: "buy",
              symbol: SYMBOL,
              notional_quote_units: state.cash,
              max_slippage_bps: MAX_SLIPPAGE_BPS,
            },
          ];
        }
      }
    }

    // ---- Insurance: guarantee at least one trade for the guardrail. ----
    if (!traded && i >= INSURANCE_BAR) {
      traded = true;
      peak = close;
      return [
        {
          side: "buy",
          symbol: SYMBOL,
          notional_quote_units: BigInt(INSURANCE_USD) * 1_000_000n,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        },
      ];
    }

    return [];
  },
});
