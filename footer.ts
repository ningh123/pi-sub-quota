/**
 * Custom footer with two alert-driven quota display modes. Quiet windows
 * show only their percentage; a reset countdown appears only when a window
 * is alerting — usage ≥ USAGE_ALERT_PERCENT or a reset within RESET_ALERT_MS.
 *
 * Mode "line" keeps a dedicated quota line under the stats whenever a
 * snapshot exists, with every window in full detail — label, meter,
 * percentage, and reset countdown — because the space is there:
 *
 *   ↑1.2k ↓3.4k 38%/200k                            (zai-coding-cn) glm-5.3 • max
 *   (Max) 5h ▓▓▓▓▓▓▓▓▓▓ 96% 41m · 58%
 *
 * Mode "inline" keeps the built-in layout and carries the quota inside the
 * provider prefix, which keeps the real provider id exactly like the built-in
 * footer:
 *
 *   ~/dev/project (main)
 *   ↑1.2k ↓3.4k 38%/200k        (zai-coding-cn 96% 41m 58%) glm-5.3 • max
 *
 * When width is tight the quota drops from the prefix entirely (back to the
 * built-in `(zai-coding-cn)`), then the prefix drops before the model info.
 *
 * Known deviations while the custom footer is installed: no virtual-model
 * routing arrow, no experimental "xp" marker, no "(auto)" compaction suffix,
 * and "(sub)" only for kimi-coding (OAuth subscription detection is not
 * reachable from extensions). Everything else renders the same way. With no
 * snapshot data at all, the built-in footer stays untouched.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { QuotaSnapshot } from "./providers/index.ts";
import type { QuotaMode } from "./settings.ts";
import { computeSessionStats, formatCwd, formatTokens, type SessionStats } from "./stats.ts";
import { buildQuotaInline, buildQuotaLine, type QuotaStyle } from "./view.ts";

/** The factory `ctx.ui.setFooter` expects, derived from its signature so TUI/Theme types need no import. */
export type FooterFactory = NonNullable<Parameters<ExtensionContext["ui"]["setFooter"]>[0]>;

/** Meter width for the "line" mode, keyed by minimum terminal width. */
const METER_WIDTHS: readonly { minWidth: number; cells: number }[] = [
	{ minWidth: 80, cells: 10 },
	{ minWidth: 60, cells: 6 },
	{ minWidth: 48, cells: 4 },
	{ minWidth: 0, cells: 0 },
];

/** Mirrors the built-in footer's status sanitizer: collapse whitespace and control characters. */
function sanitizeStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

interface StatsCache {
	entryCount: number;
	leafId: string | null;
	/** Model object identity: a different model can carry a different context window. */
	model: ExtensionContext["model"];
	/** Cached ctx.getContextUsage(): it rebuilds the session projection (O(entries)) per call. */
	contextUsage: ReturnType<ExtensionContext["getContextUsage"]>;
	stats: SessionStats;
}

export interface QuotaFooterSource {
	/** Latest in-memory snapshot, refreshed by the extension entry. */
	getSnapshot(): QuotaSnapshot | undefined;
	/** True when the shown snapshot is older than the TTL (last fetch failed). */
	isStale(): boolean;
	/** Current display mode; read every render so switching is immediate. */
	getMode(): QuotaMode;
	/** Notified whenever the snapshot, staleness, or mode changes so the footer can re-render. */
	onQuotaChange(callback: () => void): () => void;
}

export function createQuotaFooter(ctx: ExtensionContext, source: QuotaFooterSource): FooterFactory {
	return (tui, theme, footerData) => {
		const unsubscribeBranch = footerData.onBranchChange(() => tui.requestRender());
		// Snapshots land asynchronously after the footer mounts; without this the
		// quota would only appear the next time something else triggers a render.
		const unsubscribeQuota = source.onQuotaChange(() => tui.requestRender());
		const style: QuotaStyle = (color, text) => theme.fg(color, text);
		const dim = (text: string) => theme.fg("dim", text);
		let cache: StatsCache | undefined;

		const sessionStats = () => {
			const manager = ctx.sessionManager;
			const entries = manager.getEntries();
			const leafId = manager.getLeafId();
			const model = ctx.model;
			if (!cache || cache.entryCount !== entries.length || cache.leafId !== leafId || cache.model !== model) {
				// Entries are append-only and every append moves the leaf, so these
				// keys bound every input of both scans — the totals and the context
				// usage projection. The footer renders on every frame, so neither may
				// run per frame; the built-in footer caches them the same way.
				cache = {
					entryCount: entries.length,
					leafId,
					model,
					contextUsage: ctx.getContextUsage(),
					stats: computeSessionStats(entries),
				};
			}
			return cache;
		};

		return {
			dispose: () => {
				unsubscribeBranch();
				unsubscribeQuota();
			},
			invalidate() {},
			render(width: number): string[] {
				const model = ctx.model;
				const { stats, contextUsage } = sessionStats();
				const { totals, latestCacheHitRate } = stats;

				// Line 1: cwd (+ branch, session name), dim like the built-in footer.
				let pwd = formatCwd(ctx.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE);
				const branch = footerData.getGitBranch();
				if (branch) pwd += ` (${branch})`;
				const sessionName = ctx.sessionManager.getSessionName();
				if (sessionName) pwd += ` • ${sessionName}`;

				// Stats segments, styled per part so color resets cannot clear the dim baseline.
				const parts: string[] = [];
				if (totals.input) parts.push(dim(`↑${formatTokens(totals.input)}`));
				if (totals.output) parts.push(dim(`↓${formatTokens(totals.output)}`));
				if (totals.cacheRead) parts.push(dim(`R${formatTokens(totals.cacheRead)}`));
				if (totals.cacheWrite) parts.push(dim(`W${formatTokens(totals.cacheWrite)}`));
				if ((totals.cacheRead > 0 || totals.cacheWrite > 0) && latestCacheHitRate !== undefined) {
					parts.push(dim(`CH${latestCacheHitRate.toFixed(1)}%`));
				}
				// Kimi Coding is subscription-backed despite API-key auth; same marker as the built-in footer.
				const usingSubscription = model?.provider === "kimi-coding";
				if (totals.cost || usingSubscription) {
					parts.push(dim(`$${totals.cost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`));
				}

				// Context segment, colored by pressure like the built-in footer.
				// Built-in parity: an unknown percent (post-compaction) reads "?/200k"
				// with no percent sign, while absent usage data reads "0.0%/0k".
				const contextWindow = contextUsage?.contextWindow ?? model?.contextWindow ?? 0;
				const percent = contextUsage?.percent ?? null;
				const percentText = percent !== null ? `${percent.toFixed(1)}%` : contextUsage ? "?" : "0.0%";
				const contextDisplay = `${percentText}/${formatTokens(contextWindow)}`;
				const contextPart =
					percent !== null && percent > 90
						? theme.fg("error", contextDisplay)
						: percent !== null && percent > 70
							? theme.fg("warning", contextDisplay)
							: dim(contextDisplay);

				// Right side: model name and thinking level, optionally behind a provider prefix.
				let modelInfo = model?.id ?? "no-model";
				if (model?.reasoning) {
					const level = ctx.thinkingLevel ?? "off";
					modelInfo = level === "off" ? `${modelInfo} • thinking off` : `${modelInfo} • ${level}`;
				}
				const showsPrefix = model !== undefined && footerData.getAvailableProviderCount() > 1;

				const now = Date.now();
				const snapshot = source.getSnapshot();
				const stale = source.isStale();
				const lines: string[] = [truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."))];

				/**
				 * Fit the stats line like the built-in footer: the first candidate that
				 * fits with at least two spaces of padding wins; on tight widths the
				 * bare model info is truncated from the right instead of dropped; and
				 * when even the stats alone exceed the width they are truncated with an
				 * ellipsis (built-in parity) rather than overflowing the terminal.
				 */
				const fitStatsLine = (candidates: readonly string[]): string => {
					let left = [...parts, contextPart].filter(Boolean).join(" ");
					let leftWidth = visibleWidth(left);
					// Built-in parity: stats wider than the terminal are truncated with an
					// ellipsis instead of overflowing the line.
					if (leftWidth > width) {
						left = truncateToWidth(left, width, "...");
						leftWidth = visibleWidth(left);
					}
					for (const candidate of candidates) {
						const rightWidth = visibleWidth(candidate);
						if (leftWidth + 2 + rightWidth <= width) {
							return left + " ".repeat(width - leftWidth - rightWidth) + candidate;
						}
					}
					const availableForRight = width - leftWidth - 2;
					if (availableForRight > 0) {
						const truncated = truncateToWidth(candidates[candidates.length - 1], availableForRight, "");
						return left + " ".repeat(Math.max(0, width - leftWidth - visibleWidth(truncated))) + truncated;
					}
					return left;
				};

				if (source.getMode() === "line") {
					// Line mode: the stats line keeps the built-in shape; the quota line is
					// always present while a snapshot exists and renders every window in
					// full detail — label, meter, percentage, countdown.
					const candidates: string[] = [];
					if (model && showsPrefix) candidates.push(dim(`(${model.provider}) ${modelInfo}`));
					candidates.push(dim(modelInfo));
					lines.push(fitStatsLine(candidates));

					const meterWidth = METER_WIDTHS.find((entry) => width >= entry.minWidth)?.cells ?? 0;
					const quotaLine = buildQuotaLine(snapshot, now, style, meterWidth, { stale });
					if (quotaLine) lines.push(truncateToWidth(quotaLine, width, dim("...")));
				} else {
					// Inline mode: the prefix carries the quota behind the real provider id
					// (never a renamed one). Styled in segments so the colored quota does
					// not break the dim baseline. Countdowns appear only on alerting
					// windows; a granted balance degrades from "¥18.67+¥1.00" to the
					// exact total "¥19.67" when tight, then the quota drops to the
					// built-in prefix.
					const candidates: string[] = [];
					if (model) {
						const hasBalanceBreakdown = (snapshot?.items ?? []).some((item) => item.type === "balance" && item.granted >= 0.01);
						for (const balanceDetail of hasBalanceBreakdown ? [true, false] : [false]) {
							const inline = buildQuotaInline(snapshot, now, style, { stale, balanceDetail });
							if (inline) candidates.push(dim(`(${model.provider} `) + inline + dim(`) ${modelInfo}`));
						}
					}
					if (model && showsPrefix) candidates.push(dim(`(${model.provider}) ${modelInfo}`));
					// Bare model info is always the last resort, as in the built-in footer.
					candidates.push(dim(modelInfo));
					lines.push(fitStatsLine(candidates));
				}

				// Extension statuses keep their own line, as in the built-in footer.
				const statuses = footerData.getExtensionStatuses();
				if (statuses.size > 0) {
					const statusLine = [...statuses.entries()]
						.sort(([a], [b]) => a.localeCompare(b))
						.map(([, text]) => sanitizeStatusText(text))
						.join(" ");
					lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
				}
				return lines;
			},
		};
	};
}
