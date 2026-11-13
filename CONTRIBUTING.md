# Contributing to OpenChat

Outside contributions are welcome.

## Getting started

Read [AGENTS.md](AGENTS.md), which applies to people and AI agents alike, then [local development](docs/development/local-dev.md).

```bash
pnpm install
pnpm dev:setup
pnpm dev
```

Before opening a pull request, run `pnpm verify`, which is what CI runs.

## Developer Certificate of Origin

OpenChat uses the [Developer Certificate of Origin](https://developercertificate.org/) rather than a contributor licence agreement. By signing off, you certify that you wrote the contribution or otherwise have the right to submit it under the licence of the package it changes.

Sign off each commit with `git commit -s`, which adds this line:

```text
Signed-off-by: Your Name <you@example.com>
```

CI rejects pull requests containing commits with no sign-off. To fix earlier commits on your branch, run `git rebase --signoff main`.

## Licences

Your contribution takes the licence of the package you change: AGPL-3.0-or-later for server components, and Apache-2.0 for client components. See [LICENSE](LICENSE) and [ADR-0011](docs/architecture/decisions/0011-license-boundaries.md). Permissive packages cannot depend on AGPL ones, and CI checks this.

## Changes that need extra care

- A decision that contradicts an accepted ADR needs a new ADR.
- A new technology outside the [agreed list](docs/architecture/overview.md#technology-baseline) needs an ADR.
- API changes must update `packages/api-contracts` and the generated OpenAPI file.
- Database changes must use migrations that follow the [expand/contract rules](docs/architecture/data-model.md#migration-strategy).

## Security issues

Do not open a public issue for a vulnerability. Report it privately, as [SECURITY.md](SECURITY.md) describes.
