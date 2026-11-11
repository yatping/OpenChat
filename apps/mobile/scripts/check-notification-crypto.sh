#!/bin/sh
# Compiles the notification extension's decryption with a small harness, and checks it against RFC 9180 and a
# notification sealed by packages/notification-protocol. Needs a Mac with Xcode, because CryptoKit is Apple's.
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
MOBILE="$(dirname "$HERE")"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
xcrun swiftc -O -o "$OUT/check" \
  "$MOBILE/plugins/notification-service/ios/NotificationCrypto.swift" \
  "$MOBILE/modules/notification-keys/ios/PreviewKeychain.swift" \
  "$HERE/notification-crypto-check/main.swift"
"$OUT/check" "$MOBILE/../../packages/notification-protocol/test/notification-vector.json"
