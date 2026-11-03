# Spikes

Timeboxed experiments from the [Phase 0 plan](../docs/plan/phase-0.md). They are not production code, and sit outside the
pnpm workspace, lint, and CI. Their output is the results section of
[Cloudflare validation](../docs/architecture/cloudflare-validation.md).

`lab` deploys throwaway Workers and a D1 database named `openchat-spike-*`, guarded by a random token.
`lab/client.mjs` and `lab/s2.mjs` drive them. Remove them in this order: queue consumer, Workers, queue, D1.
