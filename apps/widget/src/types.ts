import type { DiscoverySchema } from '@openchat/api-contracts';

/** Proves that contract types reach the widget at compile time without any runtime import. */
export type DiscoveryResponseShape = typeof DiscoverySchema;
