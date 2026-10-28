# OBR-proxy indicators in the Market pillar

The Office for Budget Responsibility publishes the Economic and Fiscal Outlook
(EFO) twice a year. Its fiscal arithmetic is driven by a handful of
macro-economic inputs -- CPI inflation, real GDP growth, earnings growth,
unemployment, productivity -- that evolve continuously in markets between OBR
publications. The indicators in this block are real-time market-implied
proxies for those inputs. They exist so the Tightrope Tracker can surface
"the OBR's central forecast is probably getting stale" weeks before the next
EFO lands.

All sit in the **Market Stability** pillar (40% of headline).

## Inflation inputs

| Indicator            | Proxies                                      | Lead vs. OBR           |
|----------------------|----------------------------------------------|------------------------|
| `breakeven_5y`       | OBR CPI path over the 5y forecast horizon    | daily vs. semi-annual  |
| `breakeven_10y`      | OBR long-horizon CPI, debt-interest forecast | daily                  |
| `brent_gbp`          | OBR CPI energy subcomponent, fuel-duty line  | daily                  |

**Mechanism.** The five-year breakeven reads the BoE's published inflation
zero-coupon series **IUDSIZC** directly. The Bank has already derived this
inflation curve from nominal and real curves. The distinct real-yield series
is **IUDSRZC**; subtracting IUDSIZC from a nominal yield is an incorrect way
to measure inflation compensation. This definition was corrected on
28 October 2026; earlier stored derived readings require an explicit data
correction and must not be interpreted as market moves.

The measure is average **RPI-linked inflation compensation** over the next
five years. Risk and liquidity premia and the RPI/CPI basis mean it is not a
pure inflation expectation or a direct CPI forecast. The BoE also notes that
RPI alignment with CPIH from February 2030 affects interpretation across that
date. Sources: [BoE series catalogue](https://www.bankofengland.co.uk/boeapps/database/FromShowColumns.asp?searchText=yield),
[yield-curve definitions](https://www.bankofengland.co.uk/statistics/details/further-details-about-yields-data),
and [yield-curve caveats](https://www.bankofengland.co.uk/statistics/yield-curves).

Brent in GBP feeds directly into the CPI energy subcomponent and
into fuel-duty receipts -- OBR's medium-term CPI profile bakes in a Brent path
pulled from the futures curve at forecast close, so a large move in Brent
between EFOs signals that the pre-baked profile is wrong.

## Real-rate regime

| Indicator            | Proxies                                      |
|----------------------|----------------------------------------------|
| `gilt_il_10y_real`   | OBR real rate / potential-output assumption  |

**Mechanism.** OBR uses a real rate assumption when deriving trend growth and
debt sustainability. The 10-year real index-linked gilt yield is the closest
clean market read on that rate. A sharp move tightens or loosens the real
financing environment in a way OBR cannot reflect until its next publication.

## Growth inputs

| Indicator             | Proxies                                         | Lead vs. OBR |
|-----------------------|-------------------------------------------------|--------------|
| `housebuilder_idx`    | Residential investment, construction GVA        | 3-6 months   |
| `services_pmi`        | Services GVA (~80% of UK GDP)                   | ~1 quarter   |
| `consumer_confidence` | Household consumption (largest GDP expenditure) | ~1 quarter   |
| `rics_price_balance`  | House-price expectations, residential inv.      | 1-2 quarters |
| `ftse_250` (existing) | Domestic-earnings-skewed equity read            | coincident   |

**Mechanism.** OBR's GDP forecast is a composition of expenditure and output
measures. The Services PMI is a timely diffusion index over services output
which dominates UK GVA; consumer confidence leads the household-consumption
expenditure line; the RICS price balance and the listed UK-housebuilder
composite both lead residential investment. The housebuilder composite is an
equal-weighted, rebased index of Persimmon, Barratt Redrow, Taylor Wimpey,
Berkeley, and Vistry -- five of the largest pure-play UK residential
developers, so their share prices move well before the housing-starts data the
OBR sees.

## Feed status and licensing

| Indicator            | Feed type                    | Licence / caveats                                             |
|----------------------|------------------------------|---------------------------------------------------------------|
| `breakeven_5y`       | Live -- BoE IADB CSV         | BoE public-sector statistics, free reuse with attribution.    |
| `breakeven_10y`      | Live -- BoE IADB CSV         | As above.                                                     |
| `gilt_il_10y_real`   | Live -- BoE IADB CSV         | As above.                                                     |
| `brent_gbp`          | Fixture (weekly refresh)     | EIA data is US federal public domain; GBP/USD conversion uses BoE XUDLUSS. Source XLS is not Worker-parseable. |
| `housebuilder_idx`   | EODHD completed-session closes | The composite calculation is ours. Missing or incomplete source data keeps the last verified reading and produces a degraded audit status. |
| `services_pmi`       | Fixture (monthly)            | S&P Global licensed series; we mirror only the headline press-release figure as fair-dealing summary. |
| `consumer_confidence`| Fixture (monthly)            | NielsenIQ publishes the GfK barometer headline; release links are retained per point. |
| `rics_price_balance` | Fixture (monthly)            | RICS subscription-gated; headline net balance only.           |

## Seasonal-adjustment gotchas

- The Services PMI headline is seasonally adjusted by S&P Global; do not
  re-adjust it in the methodology layer.
- RICS price balances are sometimes republished seasonally adjusted the month
  after initial release -- prefer the SA series when both are available.
- NielsenIQ/GfK consumer confidence is reported as a signed index; read
  month-on-month changes rather than the absolute level during shocks.
- Breakevens carry a liquidity premium and an inflation-risk premium that move
  with rates volatility; do not interpret small daily moves as pure CPI moves.

## Ethical / rate-limit constraints

- BoE IADB: no explicit rate limit; we already serialise BoE fetches in
  `apps/ingest/src/pipelines/market.ts`. Four extra daily series codes piggy-
  back on the existing five -- negligible extra load.
- Licensed headline series (PMI, GfK, RICS): we must cap reuse at the
  published monthly headline; any sub-index or back-set is subscription
  territory. The fixture pattern enforces this by design.
- EIA: public domain, no rate limits on the XLS endpoint; we use the fixture
  only because XLS is not a viable Worker parser target.
