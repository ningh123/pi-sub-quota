/**
 * Provider registry: everything generic lives here and is data-driven from
 * the registered providers — detection, credential resolution, discovery —
 * so no call site needs per-provider branches.
 */

import { deepseekProvider } from "./deepseek.ts";
import { kimiProvider } from "./kimi.ts";
import type { ProviderKind, QuotaProvider } from "./types.ts";
import { zaiProvider } from "./zai.ts";

/** All registered quota providers; detection order follows this list. */
export const PROVIDERS: readonly QuotaProvider[] = [zaiProvider, kimiProvider, deepseekProvider];

export const PROVIDER_KINDS: readonly ProviderKind[] = PROVIDERS.map((provider) => provider.kind);

/**
 * The provider a pi model belongs to: provider id first, then base URL. The
 * id pass runs before any baseUrl pass so a known id is never claimed by a
 * different provider's URL match (e.g. a kimi-coding model that happens to
 * sit behind a bigmodel.cn proxy URL).
 */
export function detectProvider(providerId: string | undefined, baseUrl?: string): QuotaProvider | undefined {
	const byId = PROVIDERS.find((provider) => provider.matches(providerId, undefined));
	return byId ?? PROVIDERS.find((provider) => provider.matches(undefined, baseUrl));
}

/** One quota provider configured on this machine. */
export interface ConfiguredQuotaProvider {
	provider: QuotaProvider;
	/** pi provider id whose auth.json entry holds the credential. */
	providerId: string;
}

/**
 * Discover every quota provider configured on this machine: auth.json
 * entries whose provider id maps to a registered provider. One per kind.
 * Credentials come exclusively from pi's auth.json — the same credential pi
 * itself runs the provider with — so a matched provider always has its key.
 */
export function configuredQuotaProviders(authFile: Record<string, unknown> | undefined): ConfiguredQuotaProvider[] {
	const found = new Map<ProviderKind, ConfiguredQuotaProvider>();
	if (authFile && typeof authFile === "object") {
		for (const providerId of Object.keys(authFile)) {
			const provider = detectProvider(providerId);
			if (provider && !found.has(provider.kind)) found.set(provider.kind, { provider, providerId });
		}
	}
	return [...found.values()];
}
