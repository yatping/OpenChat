# ADR-0012: Build the iOS app locally, with EAS optional

**Status:** Accepted, 2026-11-05

## Context

The original plan named EAS for iOS builds and signing. The project's owner already builds and signs their other Expo apps on their own Mac with `expo prebuild` and fastlane, and no longer uses EAS for them. The specification already requires that customers can build without EAS.

## Decision

- The project's builds use `expo prebuild` followed by Xcode or fastlane, on the operator's own machine.
- The native `ios/` directory is generated and never committed.
- Signing files and App Store Connect keys stay outside this repository. Build tooling reads their paths from the environment or an ignored `.env` file.
- The app does not depend on EAS services. A customer can still use EAS to build a variant.

## Consequences

- No third party holds signing credentials, and builds have no per-build cost.
- A build needs a Mac with Xcode.
- This replaces EAS in the technology baseline. The `eas.json` example in the iOS build guide no longer applies.
