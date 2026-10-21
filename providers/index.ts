/**
 * Quota provider registry: shared types, one self-describing module per
 * provider, and a data-driven registry for detection, credentials, and
 * discovery. See the per-provider files for endpoint details; everything
 * here is free of pi imports so it stays unit-testable.
 */

export { deepseekProvider, fetchDeepSeekBalance } from "./deepseek.ts";
export { fetchKimiQuota, kimiProvider } from "./kimi.ts";
export {
	type ConfiguredQuotaProvider,
	configuredQuotaProviders,
	detectProvider,
	PROVIDER_KINDS,
	PROVIDERS,
} from "./registry.ts";
export type {
	FetchOptions,
	McpToolUsage,
	ProviderKind,
	QuotaBalance,
	QuotaItem,
	QuotaProvider,
	QuotaSnapshot,
	QuotaWindow,
} from "./types.ts";
export { fetchZaiQuota, zaiProvider } from "./zai.ts";
