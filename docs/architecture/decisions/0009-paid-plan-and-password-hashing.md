# ADR-0009: Workers Paid baseline, scrypt for passwords

**Status:** Accepted by the owner, [Q3](../open-questions.md). Single-hash cost passed spike S3, at 284 to 385 ms of CPU. Concurrency still needs testing on Workers Paid ([results](../cloudflare-validation.md#phase-0-spike-results)). **Date:** 2026-11-03.

## Context

The Free plan allows 10 ms CPU per request, 50 D1 queries per invocation, 500 MB per database, and 100,000 requests a day. Argon2 is explicitly unsupported in `node:crypto`. WebCrypto PBKDF2 is reported to cap at 100,000 iterations, well below OWASP guidance. OWASP's strongest scrypt setting, N=2^17, needs 128 MiB, which is the whole isolate limit.

## Decision

- Workers Paid is the supported minimum.
- Hash with `node:crypto` scrypt at N=2^15, r=8, p=3 (32 MiB), one of OWASP's listed equivalents, with parameters stored per hash. Confirmed by spike S3.
- If S3 finds this impractical, the fallback is Argon2id compiled to WASM, which has a larger bundle and needs its own evaluation.

## Consequences

- Self-hosting has a small fixed cost, which should be stated prominently.
- Concurrent logins in one isolate compete for memory, so login is throttled.
