# Tightrope Tracker

**Live:** [tightropetracker.uk](https://tightropetracker.uk)

A transparent accountability dashboard mapping the real constraints on the UK government's growth agenda. One score, four pillars — **Market**, **Fiscal**, **Labour**, **Delivery** — every number sourced from an open, primary dataset.

## What this is (and isn't)

Tightrope Tracker measures **the gap between the government's stated commitments and the observable conditions for delivering them**. It is non-partisan by design: the same methodology would score any government on the same axes, using the same public data.

- It **is** a live snapshot, a published methodology, and a reproducible scoring pipeline.
- It **isn't** a forecast, an opinion column, or a grading of any party.

Every figure on the site links back to its source — BoE IADB, ONS, OBR, DMO, MHCLG, Moneyfacts, gov.uk RSS — and every weight, transformation, and baseline window is published on the [methodology page](https://tightropetracker.uk/methodology).

## Scoring model

1. Raw inputs are ranked against a 2019-present empirical baseline (2020 Q2 excluded for COVID distortion). Z-scores are still computed and displayed for context, but they are not the score input.
2. The empirical percentile is direction-adjusted: for rising-bad inputs (gilt yields, borrowing, inactivity) the score is `1 - p`; for rising-good inputs (real pay, fiscal headroom, delivery progress) the score is `p`.
3. The adjusted percentile is bounded to `[0, 100]`, where **higher means more room to move** and **lower means conditions are worse**.
4. Each **pillar score** is a weighted arithmetic mean of its indicators (transparent to debug).
5. The **headline score** is a **weighted geometric mean** of the four pillars — Market 40%, Fiscal 30%, Labour 20%, Delivery 10%.

Geometric mean at the headline level is deliberate: one weak pillar pulls the headline down hard. That is the correct behaviour for a tightrope metric — a failing support cannot be papered over by strength elsewhere.

Score schema v2, introduced on 2026-04-28, converted the published score from a pressure-oriented axis to this high-good axis so the public number matches ordinary reader intuition: falling score = worsening conditions.

## Repository layout

```
apps/
  web/          Astro site (Cloudflare Pages)
  api/          Worker — public JSON API, MP postcode lookup
  og/           Worker — social share-card rendering (Satori)
  ingest/       Worker — scheduled data ingestion + score recompute
packages/
  shared/       Types, constants, pillar + band definitions
  methodology/  Pure scoring library (z-score, ECDF, weighted means) + tests
  data-sources/ Adapters: BoE, ONS, OBR, DMO, MHCLG, gov.uk RSS, Moneyfacts
db/
  migrations/   D1 SQL migrations
  seed/         Seed data for local dev + fresh deployments
docs/
  DEPLOYMENT.md Cloudflare provisioning walkthrough
  OBR_PROXIES.md Market indicators that proxy OBR growth/inflation inputs
  RUNBOOK.md    Incident playbooks
```

## Quick start

Requires Node ≥ 20 and pnpm ≥ 10.

```bash
pnpm install
pnpm db:migrate:local
pnpm db:seed:local
pnpm dev              # Astro site at http://localhost:4321
pnpm dev:api          # API worker at http://localhost:8787
pnpm dev:og           # OG worker at http://localhost:8788
pnpm dev:ingest       # Ingest worker (scheduled) at http://localhost:8789
```

All tests and typecheck:

```bash
pnpm -r typecheck
pnpm -r test
```

## Public API

The API is free and unauthenticated — embed the live score anywhere.

```
GET https://api.tightropetracker.uk/api/v1/score
GET https://api.tightropetracker.uk/api/v1/delivery
GET https://api.tightropetracker.uk/api/v1/timeline
GET https://api.tightropetracker.uk/api/v1/mp?postcode=SW1A+1AA
```

Or drop an iframe:

```html
<iframe src="https://tightropetracker.uk/embed/headline"
        width="100%" height="220" frameborder="0"></iframe>
```

## Deployment

Each worker has its own `wrangler.toml`; the web app deploys to Cloudflare Pages via `@astrojs/cloudflare`. CI handles deploys on push to `main`.

```bash
pnpm build
pnpm deploy                           # deploy all apps
pnpm db:migrate:remote                # apply pending D1 migrations to production
```

- [`docs/DEPLOYMENT.md`](./docs/DEPLOYMENT.md) — first-time Cloudflare provisioning
- [`docs/RUNBOOK.md`](./docs/RUNBOOK.md) — incident playbooks
- [`docs/OBR_PROXIES.md`](./docs/OBR_PROXIES.md) — rationale for each market indicator
- [`.github/workflows/deploy.yml`](./.github/workflows/deploy.yml) — CI pipeline

## Contributing

Contributions that improve transparency, data quality, or methodology are especially welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the short-list of expectations before you open a PR.

## License

MIT — see [LICENSE](./LICENSE). Data is attributed to its upstream publishers per their own licence terms; see the [sources page](https://tightropetracker.uk/sources) for the full list.
