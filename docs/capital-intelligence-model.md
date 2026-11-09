# Tide Radar capital intelligence model

## Goal

Build a probabilistic map of capital participants and capital movement across on-chain wallets, exchange custody pools, spot markets, and derivatives markets. The system is not intended to identify every beneficial owner. It records observable facts, source-backed labels, and evidence-weighted inferences separately.

## Core layers

- \`capital_entities\`: exchanges, mining pools, miners, foundations, treasuries, funds, custodians, market makers, and inferred whale clusters.
- \`capital_entity_accounts\`: wallet/account references attached to an entity, including hot/cold/deposit/withdrawal/treasury roles, attribution basis, source, and confidence.
- \`capital_flows\`: transfers and exchange/bridge flows with optional entity attribution and a confidence score.
- \`capital_relationships\`: ownership, custody, operational-wallet, funding, counterparty, and behavioral-correlation edges between entities.
- \`capital_market_observations\`: time-stamped spot and derivatives measurements used to align market behavior with capital flows.

## Attribution rules

1. An exchange hot/cold wallet is an exchange-level capital pool; user-level attribution is not required.
2. A wallet label is stored with its source and confidence. Never silently promote an inferred cluster to a known entity.
3. Time alignment, size consistency, repeated behavior, and cross-market confirmation can raise or lower an inference score.
4. A chain transfer into an exchange is an exchange inflow, not proof of an immediate spot sale or derivative position.
5. Open interest is aggregate outstanding contract exposure, not a directional long/short balance. Combine it with price, funding, taker flow, and other evidence.
6. Spot/derivatives basis is a derived observation and is marked estimated.
7. Keep source facts and model inferences distinguishable in storage and in the UI.

## First market context feed

The scheduled collector archives OKX public spot and swap prices, swap open interest, current funding rate, and spot/swap basis for BTC, ETH, and WLD. It uses public endpoints and does not require private account keys. These observations provide a common time axis for later entity-flow correlation.

## Next implementation stages

1. Add a source-backed wallet/entity seed catalogue for BTC and ETH, including exchange hot/cold pools, miners/mining pools, foundations, project treasuries, custodians, and funds.
2. Add public-chain transfer ingestion and exchange-wallet flow classification.
3. Add cross-market correlation features and confidence scoring.
4. Build the Capital Intelligence interface and historical case review.
