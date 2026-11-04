/** One build of the app. Every value here ends up readable inside the app, so nothing here can be secret. */
export interface AppVariant {
  id: string;
  appName: string;
  slug: string;
  urlScheme: string;
  bundleIdentifier: string;
  lockedInstallationUrl?: string;
  push: {
    enabled: boolean;
    allowedRelays: { id: string; url: string }[];
  };
  branding: { primaryColor: string };
  assets: { icon: string; splash: string };
}
