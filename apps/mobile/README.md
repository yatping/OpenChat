# OpenChat mobile

The iOS app, built with Expo. It is in progress as Milestone 2. Today it can connect to installations, sign in, switch between them, and sign out. The design is in [the iOS build guide](../../docs/ios-build/expo-and-white-label.md).

```sh
pnpm prebuild
(cd ios && pod install)
pnpm start
```

Then build and run `ios/OpenChat.xcworkspace` in Xcode. Signing files never go in this repository.
