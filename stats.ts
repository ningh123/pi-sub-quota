/**
 * Session usage statistics for the custom footer.
 *
 * Re-implements the totals pi's built-in footer computes (usage entries,
 * assistant messages, tool results with usage, compaction summaries), with no
 * pi imports so the logic stays unit-testable. Entry shapes are matched
 * structurally, mirroring `addUsageToTotals` and the cache-hit-rate heuristic
 * from pi's footer component.
 */

/** Cumulative token usage and cost across a whole session. */
export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

/** What the footer needs to render its stats line. */
export interface SessionStats {
	totals: UsageTotals;
	/** Latest assistant-message cache hit rate in percent, when a message reported one. */
	latestCacheHitRate?: number;
}

/** Loose entry shape: everything the stats scan reads, provider-agnostic. */
interface StatsEntry {
	type?: string;
	kind?: string;
	message?: {
		role?: string;
		usage?: UsageLike;
	};
	usage?: UsageLike;
}

interface UsageLike {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: { total?: number };
}

function addTo(totals: UsageTotals, usage: UsageLike | undefined): void {
	if (!usage) return;
	totals.input += usage.input ?? 0;
	totals.output += usage.output ?? 0;
	totals.cacheRead += usage.cacheRead ?? 0;
	totals.cacheWrite += usage.cacheWrite ?? 0;
	totals.cost += usage.cost?.total ?? 0;
}

/** Sum usage over every session entry, tracking the latest cache hit rate like the built-in footer. */
export function computeSessionStats(entries: readonly StatsEntry[]): SessionStats {
	const totals: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	let latestCacheHitRate: number | undefined;
	for (const entry of entries) {
		if (entry.type === "usage") {
			addTo(totals, entry.usage);
		} else if (entry.type === "message" && entry.message?.role === "assistant") {
			const usage = entry.message.usage;
			addTo(totals, usage);
			if (usage) {
				const promptTokens = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
				latestCacheHitRate = promptTokens > 0 ? ((usage.cacheRead ?? 0) / promptTokens) * 100 : undefined;
			}
		} else if (entry.type === "message" && entry.message?.role === "toolResult") {
			addTo(totals, entry.message.usage);
		} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
			addTo(totals, entry.usage);
		}
	}
	return { totals, latestCacheHitRate };
}

/** Compact token formatting, matching the built-in footer: 999, 9.9k, 123k, 1.2M, 12M. */
export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

/** Collapse the home directory prefix to `~`, like the built-in footer's pwd line. */
export function formatCwd(cwd: string, home: string | undefined): string {
	// The separator guard keeps sibling paths that merely share the prefix
	// (home "/Users/ning", cwd "/Users/ning-dev") unshortened, like the
	// built-in footer, which resolves via relative() and rejects ".." results.
	if (!home || (cwd !== home && !cwd.startsWith(`${home}/`))) return cwd;
	const rest = cwd.slice(home.length);
	return rest === "" ? "~" : `~${rest}`;
}
