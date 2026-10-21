/**
 * Shared quota types. A quota snapshot is a list of self-describing items
 * (windows over some resource, or a prepaid balance) rather than a bag of
 * optional fields, so views render by item type instead of probing.
 */

export type ProviderKind = "zai" | "deepseek" | "kimi";

/** One MCP tool's usage inside an MCP quota window. */
export interface McpToolUsage {
	/** MCP tool code, e.g. "search-prime". */
	modelCode: string;
	/** Calls used in the current cycle. */
	usage: number;
}

/** A usage window over a resource (context tokens or MCP tool calls). */
export interface QuotaWindow {
	type: "window";
	/** The resource this window measures; MCP is separate from tokens. */
	resource: "tokens" | "mcp";
	/** Short window label, e.g. "5h", "7d", "mcp". */
	label: string;
	/** Used percentage, 0-100. */
	usedPercent: number;
	/** Epoch milliseconds when the window resets. */
	resetAt?: number;
	/** Window length, when known; token windows are ordered shortest first. */
	durationMs?: number;
	/** Per-tool usage breakdown (MCP windows only). */
	tools?: McpToolUsage[];
}

/**
 * A prepaid pay-as-you-go balance in one currency; a snapshot can carry
 * several when an account holds CNY and USD side by side.
 */
export interface QuotaBalance {
	type: "balance";
	/** Currency symbol, e.g. "¥" or "$". */
	symbol: string;
	/** Total balance (topped up + granted), in the account currency. */
	total: number;
	/** Granted (promotional) part of the balance; 0 when there is none. */
	granted: number;
}

/** One displayable quota item; a snapshot is an ordered list of these. */
export type QuotaItem = QuotaWindow | QuotaBalance;

/** One provider's quota at a point in time. */
export interface QuotaSnapshot {
	kind: ProviderKind;
	/** Epoch milliseconds when the snapshot was fetched. */
	fetchedAt: number;
	/** Subscription tier reported by the provider, e.g. "max", "moderato". */
	planLevel?: string;
	/**
	 * Quota items in display order: token windows shortest-duration first
	 * (the 5h window always reads before 7d, regardless of reset times),
	 * then MCP windows, then balances.
	 */
	items: QuotaItem[];
}

/** Options shared by every quota fetcher. */
export interface FetchOptions {
	/** Injectable fetch for tests; defaults to the global fetch. */
	fetchImpl?: typeof fetch;
	/** Injectable clock for tests; defaults to Date.now. */
	now?: () => number;
	/** Request timeout; defaults to 8000ms. */
	timeoutMs?: number;
	/** Provider base URL override (e.g. a Kimi region host); defaults per provider. */
	baseUrl?: string;
}

/**
 * What a quota provider offers: identity, detection, display metadata, and
 * fetching. Adding a provider means implementing this and registering it in
 * the registry — nothing else needs to grow branches.
 */
export interface QuotaProvider {
	/** Provider identity; also the cache key. */
	kind: ProviderKind;
	/** Human plan descriptor for the /quota panel header. */
	planLabel: string;
	/** True when the pi provider id or base URL belongs to this quota provider. */
	matches(providerId: string | undefined, baseUrl?: string): boolean;
	/** Fetch the quota snapshot. */
	fetchQuota(apiKey: string, opts: FetchOptions): Promise<QuotaSnapshot>;
}
