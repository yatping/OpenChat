# Security policy

## Reporting a vulnerability

Report it privately, through GitHub: on this repository, **Security**, then **Report a vulnerability**, or go straight to <https://github.com/yatping/OpenChat/security/advisories/new>. Only the maintainers see it.

Do not open a public issue, pull request or discussion about it.

Please include what is affected, how to reproduce it, and what an attacker could do with it. A proof of concept helps. If you need to show data, use test data you created, not anyone else's.

## What is in scope

| In scope | Where to report |
|---|---|
| The code in this repository: the API Worker, the dashboard, the website widget, the CLI, and the server's side of push | Here |
| The official OpenChat iPhone app | Here |
| The managed notification relay, `openchat-relay.orangolabs.com`, run by Orango Labs | Here |
| An OpenChat installation that someone else runs, such as a company's support chat | **Its operator**, at `/.well-known/security.txt` on its address, if it has one. If the cause is in OpenChat's code, report that here too |

Not in scope: denial of service by volume, social engineering, physical attacks, reports from automated scanners without a demonstrated problem, and vulnerabilities in Cloudflare, Apple or other providers, which go to them.

## What happens next

| When | What |
|---|---|
| Within 5 working days | We acknowledge the report |
| Within 15 working days | We say whether we can reproduce it, and how serious we think it is |
| Within 90 days of the report | A fix is released, unless we agree another date with you |

We will keep you informed, and tell you before anything is published. Once a fix is released, we publish a GitHub security advisory, and credit you if you would like to be credited. OpenChat has no bug bounty.

Operators of installations upgrade on their own schedule, so a release with a security fix says so in its release notes, and says how urgent upgrading is.

## Research in good faith

If you follow this policy, avoid harming people, their privacy and their data, test only against your own installation or accounts you control, stop and report as soon as you find a vulnerability, and give us reasonable time to fix it before disclosing, we will not pursue or support legal action against you for that research.

This applies to this project and the managed relay only. It cannot speak for the operators of other installations, or for Cloudflare or Apple.

## Supported versions

OpenChat is before 1.0. Security fixes go into the latest release only. Upgrade with `pnpm oc upgrade`, as [deployment](docs/operations/deployment.md#upgrades-oc-upgrade) describes.

## For operators

An installation publishes `/.well-known/security.txt` (RFC 9116) once you give it a contact:

```sh
pnpm oc deploy --env production --security-contact mailto:security@example.com
```

See [security](docs/architecture/security.md#disclosure).
