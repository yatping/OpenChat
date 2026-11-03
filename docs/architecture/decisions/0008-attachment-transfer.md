# ADR-0008: Stream attachments through the Worker

**Status:** Accepted. **Date:** 2026-11-03.

## Context

Presigned R2 URLs cannot be created through the binding. They need separately created S3 credentials and do not work on custom domains. That adds a step and a secret for every self-hoster. Upload size cannot be clearly enforced in a presigned PUT either.

## Decision

Uploads and downloads pass through the Worker to the R2 binding as streams, with magic-byte checks on the first chunk and safe response headers. The default limit is 25 MB.

## Consequences

- No extra credentials, and each access is authorised at request time.
- Requests are limited to 100 MB on Free and Pro zones. This also rules out very large files, which is acceptable for chat.
- Each transfer counts as a Worker request. Streaming uses little CPU, so this should cost little. Verify in Milestone 1.
