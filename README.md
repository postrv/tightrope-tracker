# Tightrope Tracker

A live, transparent accountability dashboard that maps the real constraints on the UK government's growth agenda — markets, fiscal rules, labour force, and delivery.

One score. Four pillars. Every number sourced and open.

See [`downloaded-from-claude-web/SPEC.md`](./downloaded-from-claude-web/SPEC.md) for the full product & technical specification.

## Repository layout

```
apps/
  web/          Astro site (Cloudflare Pages)
  api/          Cloudflare Worker — public JSON API, MP lookup
  og/           Cloudflare Worker — OG share-image generation (Satori)
  ingest/       Cloudflare Worker — scheduled data ingestion + score recompute
packages/
  shared/       TS types, constants, score bands, pillar definitions
  methodology/  Pure scoring library (z-score, ECDF, pillar + headline maths) + tests
  data-sources/ Adapters for BoE, ONS, OBR, DMO, MHCLG, gov.uk RSS, Moneyfacts
db/
  migrations/   D1 SQL migrations
  seed/         Seed data for local dev & fresh deployments
```

## Prerequisites

- Node.js ≥ 20
- pnpm ≥ 10
- Cloudflare account with Wrangler logged in (`wrangler login`) for deploys

## Quick start

```bash
pnpm install
pnpm db:migrate:local
pnpm db:seed:local
pnpm dev              # Astro site at http://localhost:4321
pnpm dev:api          # API worker at http://localhost:8787
pnpm dev:og           # OG worker at http://localhost:8788
```

## Scoring model

Every number on the site is computed by the `@tightrope/methodology` package:

1. Raw inputs z-scored vs. a 2019-present rolling baseline (COVID 2020 Q2 excluded)
2. Direction-flipped where lower = worse (pay, FTSE 250, payroll)
3. Bounded [0,100] via ECDF
4. Pillar score = weighted arithmetic mean of its inputs (debuggable)
5. Headline score = **geometric mean** of the four pillars weighted Market 40% / Fiscal 30% / Labour 20% / Delivery 10%

Geometric mean at the headline level is the correct behaviour for systemic stress: one pillar blowing out pulls the headline hard.

The methodology page (`/methodology`) publishes every weight, input, transformation, and baseline window. Open methodology is the credibility moat.

## Deployment

Each worker has its own `wrangler.toml`. The web app deploys to Cloudflare Pages via `@astrojs/cloudflare`.

```bash
pnpm build
pnpm deploy                           # deploy all apps
pnpm db:migrate:remote                # apply pending D1 migrations to production
```

See [`.github/workflows/deploy.yml`](./.github/workflows/deploy.yml) for the CI pipeline, [`docs/DEPLOYMENT.md`](./docs/DEPLOYMENT.md) for provisioning, and [`docs/RUNBOOK.md`](./docs/RUNBOOK.md) for incident playbooks.

## License

MIT — see [LICENSE](./LICENSE).
