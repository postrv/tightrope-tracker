# Contributing

Tightrope Tracker is open source under MIT. Contributions that improve
transparency, data quality, or methodology are particularly welcome.

## Quick start

```bash
pnpm install
pnpm db:migrate:local
pnpm db:seed:local
pnpm dev
```

## Before opening a PR

1. `pnpm -r typecheck` must pass.
2. `pnpm -r test` must pass.
3. If you changed scoring logic, you've extended the methodology test suite.
4. If you changed the D1 schema, you've added a new numbered migration (never
   edited an existing one) and updated `AGENT_CONTRACTS.md` if the change
   affects the API surface.
5. If you introduced a new dependency, explain the tradeoff in the PR body.

## What not to do

- Don't add chart libraries. We hand-author SVG for a reason -- the site must
  be readable with JavaScript disabled.
- Don't add telemetry beyond the existing Plausible setup.
- Don't add any non-free data source as a primary input. Every number must be
  verifiable from a public feed.
- Don't edit the scoring methodology without an accompanying explainer in
  `apps/web/src/pages/methodology.astro`. The numbers on the site must match
  what's documented.

## Corrections

If a number on the site is wrong, please either:

1. File a GitHub issue with a screenshot + link to the source that shows the
   correct figure, or
2. Open a PR adding a row to `corrections` via a migration or a direct D1
   update, with a clear `reason` line.

All corrections are published at `/corrections` with the original value, the
corrected value, the date, and the reason.
