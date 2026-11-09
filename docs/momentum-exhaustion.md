# Momentum Exhaustion Module

## Purpose

The module turns the 13/34 MACD consecutive-divergence idea into a deterministic, closed-candle research signal. It is a price/momentum module; it does not claim to identify capital flows or beneficial owners.

## Parameters

- MACD fast EMA: 13
- MACD slow EMA: 34
- MACD signal EMA: 9
- Histogram: (DIF - DEA) × 2
- ATR: Wilder ATR(13)
- Confirmed swing pivots: 2 bars left and 2 bars right
- Price and histogram pivot pairing: within 3 candles
- Minimum swing spacing: 3 candles; maximum: 80 candles
- Minimum price extension: 0.15 × ATR at the price pivot
- Minimum histogram improvement: 8% of the larger absolute histogram swing

## Divergence rules

### Bullish / bottom divergence

1. Price forms two or three confirmed lower swing lows.
2. The paired MACD histogram troughs remain below zero and rise successively (become less negative).
3. The price extension and histogram improvement must both clear the minimum thresholds.
4. After the final swing is confirmed, wait for the first closed histogram bar that turns upward while still below zero.

### Bearish / top divergence

1. Price forms two or three confirmed higher swing highs.
2. The paired MACD histogram peaks remain above zero and fall successively.
3. The price extension and histogram improvement must both clear the minimum thresholds.
4. After the final swing is confirmed, wait for the first closed histogram bar that turns downward while still above zero.

## Closed-bar and non-repainting policy

A pivot is not considered known until its two right-side candles have closed. The module therefore does not backdate a signal to an earlier intrabar histogram color transition. It waits until the divergence is confirmed, then takes the first qualifying closed-bar histogram turn. This is intentionally more conservative than a visual interpretation that may mark the first hollow bar before the swing is confirmed.

The current incomplete candle is excluded using the selected timeframe duration and current time.

## Multi-timeframe roles

- 1D: directional environment only; no standalone entry.
- 4H: directional trade context only; no standalone entry.
- 15m: the only timeframe that can produce an actionable setup. Both 4H and 1D EMA13/EMA34 bias must align with the 15m divergence direction.
- 5m / 1m: execution-only context; they never generate standalone signals.

Missing higher-timeframe data or mixed higher-timeframe direction suppresses entry/stop/target output. Opposing 4H and 1D direction blocks the setup.

## Risk reference

For a long, entry is the trigger candle close and stop is its low minus 1 × ATR(13). For a short, stop is its high plus 1 × ATR(13). The panel displays 1.5R and 2R reference targets. These are reference levels, not a claim that either target is statistically optimal.

## Limitations

- The original community phrase “solid-to-hollow” is not a universal MACD convention. This implementation defines it objectively as the first closed histogram slope reversal after the divergence pivot has been confirmed.
- No win-rate claim is made. Fees, slippage, funding, execution quality, and out-of-sample performance still require independent backtesting.
- MACD divergence is a price/momentum condition. It must be corroborated separately by Tide Radar's chain-flow, reserve, derivatives, and market-microstructure evidence.
