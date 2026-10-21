/**
 * Quota status formatting. All functions are pure; styling goes through an
 * injected `style(color, text)` callback so tests run without a theme.
 *
 * Rendering is item-driven: a snapshot is a list of self-describing items
 * (token windows, MCP windows, balances), so every shape below iterates
 * items and switches on their type instead of probing optional fields.
 *
 * The display is alert-driven: quiet token windows show only their
 * percentage, and a reset countdown appears only when it matters — usage ≥
 * USAGE_ALERT_PERCENT (you might hit the wall before the reset) or a reset
 * within RESET_ALERT_MS (usage is about to refresh). MCP windows are a
 * separate resource and always carry their label so they never read as
 * another token window; inline they appear only while alerting.
 *
 * - Inline, inside the footer's provider prefix (quiet → alerting):
 *
 *     (zai-coding-cn 13% 58%)  →  (zai-coding-cn 96% 41m 58%)  →  (zai-coding-cn 88% mcp 92%)
 *
 * - Dedicated quota line (mode "line", present whenever a snapshot exists;
 *   every window renders its full detail — label, meter, percentage,
 *   countdown):
 *
 *     (Max) 5h ▓▓▓▓▓▓▓▓▓▓ 96% 41m · 58%
 *
 * Percentages are colored green / amber / red by usage band; token window
 * order (5h before 7d) is stable so bare numbers read left to right.
 */

import type { QuotaBalance, QuotaSnapshot, QuotaWindow } from "./providers/index.ts";

export type QuotaColor = "success" | "warning" | "error" | "muted" | "dim";
export type QuotaStyle = (color: QuotaColor, text: string) => string;

/** A window's reset countdown shows (inline and alert line) within this remaining time. */
export const RESET_ALERT_MS = 30 * 60_000;
/** Usage from which a window counts as running hot and shows its countdown. */
export const USAGE_ALERT_PERCENT = 80;

/**
 * A window needs attention when it is nearly exhausted (you may hit the wall
 * before it resets — so the reset time becomes critical) or when it resets
 * within RESET_ALERT_MS (usage is about to refresh). Quiet windows show only
 * their percentage.
 */
export function isWindowAlerting(window: QuotaWindow, now: number): boolean {
	if (window.usedPercent >= USAGE_ALERT_PERCENT) return true;
	return window.resetAt !== undefined && window.resetAt - now <= RESET_ALERT_MS;
}

/** Color slot by used percentage: green below 40, amber to 79, red from 80. */
export function usageColor(usedPercent: number): QuotaColor {
	if (usedPercent >= 80) return "error";
	if (usedPercent >= 40) return "warning";
	return "success";
}

/** The snapshot's windows, in display order. */
function windowItems(snapshot: QuotaSnapshot | undefined): QuotaWindow[] {
	return (snapshot?.items ?? []).filter((item): item is QuotaWindow => item.type === "window");
}

/** The snapshot's balances — one per currency, usually at most one. */
function balanceItems(snapshot: QuotaSnapshot | undefined): QuotaBalance[] {
	return (snapshot?.items ?? []).filter((item): item is QuotaBalance => item.type === "balance");
}

/**
 * Meter of `width` cells with dark-shade blocks ("▓▓▓▓▓▓░░░░", the same style
 * as Claude Code's statusline context bar). Any non-zero usage fills at
 * least the first cell, so even 1% reads as a visible block instead of a
 * sliver. Width 0 returns an empty string.
 */
export function meter(usedPercent: number, width = 10): string {
	if (width <= 0) return "";
	const clamped = Math.min(100, Math.max(0, usedPercent));
	let full = Math.round((clamped / 100) * width);
	if (clamped > 0) full = Math.max(1, Math.min(width, full));
	else full = 0;
	return "▓".repeat(full) + "░".repeat(width - full);
}

/** Format remaining time as "45m", "2h58m", or "3d4h". Undefined when it is under a minute or already past. */
export function formatCountdown(remainingMs: number): string | undefined {
	const minutes = Math.floor(remainingMs / 60_000);
	if (minutes < 1) return undefined;
	const days = Math.floor(minutes / 1440);
	if (days >= 1) return `${days}d${Math.floor((minutes % 1440) / 60)}h`;
	const hours = Math.floor(minutes / 60);
	if (hours >= 1) return `${hours}h${minutes % 60}m`;
	return `${minutes}m`;
}

/** Plan levels arrive lowercase from the APIs ("max", "moderato"); display them capitalized. */
export function displayPlanLevel(planLevel: string): string {
	return planLevel.charAt(0).toUpperCase() + planLevel.slice(1);
}

function countdownFor(window: QuotaWindow, now: number): string | undefined {
	if (window.resetAt === undefined) return undefined;
	return formatCountdown(window.resetAt - now);
}

/** Format one window as "5h 2% (2h58m)"; the countdown is dropped when unknown or expired. */
export function formatWindow(window: QuotaWindow, now: number): string {
	const head = `${window.label} ${window.usedPercent}%`;
	if (window.resetAt === undefined) return head;
	const countdown = formatCountdown(window.resetAt - now);
	return countdown ? `${head} (${countdown})` : head;
}

/**
 * Plain-text single line for `/quota refresh` and logs, following the same
 * alert rule as the footer: reset countdowns appear only on alerting windows
 * (usage ≥ USAGE_ALERT_PERCENT or reset within RESET_ALERT_MS). Empty string
 * when there is nothing to show.
 */
export function formatQuota(snapshot: QuotaSnapshot, now: number, opts?: { stale?: boolean }): string {
	const parts: string[] = [];
	for (const item of snapshot.items) {
		if (item.type === "window") {
			parts.push(isWindowAlerting(item, now) ? formatWindow(item, now) : `${item.label} ${item.usedPercent}%`);
		} else {
			parts.push(formatBalanceCompact(item, { detail: true }));
		}
	}
	const line = parts.join(" · ");
	if (!line) return "";
	const prefix = snapshot.planLevel ? `(${displayPlanLevel(snapshot.planLevel)}) ` : "";
	return opts?.stale ? `~${prefix}${line}` : `${prefix}${line}`;
}

/**
 * Compact balance for the footer prefix, exact to the cent — a prepaid
 * balance is money, so nothing is rounded. With `detail` and a granted part
 * of at least one cent, topped-up and granted amounts sit side by side,
 * each with its currency symbol ("¥18.67+¥1.00") so multi-currency accounts
 * stay readable; otherwise the exact total ("¥19.67").
 */
export function formatBalanceCompact(balance: QuotaBalance, opts?: { detail?: boolean }): string {
	const cents = (value: number) => value.toFixed(2);
	if (!opts?.detail || balance.granted < 0.01) return `${balance.symbol}${cents(balance.total)}`;
	return `${balance.symbol}${cents(balance.total - balance.granted)}+${balance.symbol}${cents(balance.granted)}`;
}

/**
 * Styled inline quota for the footer's provider prefix: bare percentages
 * with per-window usage colors, or "¥18.67+¥1.00" for balances (one per currency). A token window's
 * reset countdown appears only when it is alerting; MCP windows are a
 * separate resource and appear — always labeled — only while alerting,
 * since three bare percentages would read as three token windows. A stale
 * snapshot keeps its numbers behind a warning tilde. Empty string when
 * there is nothing to show.
 */
export function buildQuotaInline(
	snapshot: QuotaSnapshot | undefined,
	now: number,
	style: QuotaStyle,
	opts?: { stale?: boolean; alerts?: boolean; balanceDetail?: boolean },
): string {
	if (!snapshot) return "";
	const parts: string[] = [];
	for (const item of snapshot.items) {
		if (item.type === "balance") {
			parts.push(style("success", formatBalanceCompact(item, { detail: opts?.balanceDetail })));
			continue;
		}
		const alerting = opts?.alerts !== false && isWindowAlerting(item, now);
		if (item.resource === "mcp" && !alerting) continue;
		if (item.resource === "mcp") parts.push(style("dim", item.label));
		parts.push(style(usageColor(item.usedPercent), `${item.usedPercent}%`));
		if (alerting) {
			const countdown = countdownFor(item, now);
			if (countdown) parts.push(style("muted", countdown));
		}
	}
	const line = parts.join(" ");
	if (!line) return "";
	return opts?.stale ? `${style("warning", "~")}${line}` : line;
}

/**
 * Styled dedicated quota line for line mode. The line has room, so every
 * window always renders its full detail — label, meter, percentage, and
 * reset countdown — with no display strategy; that is inline's job. Balances
 * and the plan tier opens the line in parentheses (`(Max)`, matching the
 * provider prefix style). `meterWidth` 0 drops the meter cells.
 * Empty string when there is nothing to show.
 */
export function buildQuotaLine(
	snapshot: QuotaSnapshot | undefined,
	now: number,
	style: QuotaStyle,
	meterWidth: number,
	opts?: { stale?: boolean },
): string {
	if (!snapshot) return "";
	const parts: string[] = [];
	for (const item of snapshot.items) {
		if (item.type === "balance") {
			parts.push(style("success", formatBalanceCompact(item, { detail: true })));
			continue;
		}
		const color = usageColor(item.usedPercent);
		const segments = [style("dim", item.label)];
		const cells = meter(item.usedPercent, meterWidth);
		if (cells) segments.push(style(color, cells));
		// Right-aligned so consecutive windows keep their columns scannable.
		segments.push(style(color, `${item.usedPercent}%`.padStart(4)));
		const countdown = countdownFor(item, now);
		if (countdown) segments.push(style("muted", countdown));
		parts.push(segments.join(" "));
	}
	const line = parts.join(style("dim", " · "));
	if (!line) return "";
	const tier = snapshot.planLevel ? `${style("dim", `(${displayPlanLevel(snapshot.planLevel)})`)} ` : "";
	return opts?.stale ? `${style("warning", "~")}${tier}${line}` : `${tier}${line}`;
}

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function pad2(value: number): string {
	return String(value).padStart(2, "0");
}

function startOfDayMs(ts: number): number {
	const date = new Date(ts);
	date.setHours(0, 0, 0, 0);
	return date.getTime();
}

/**
 * Absolute local reset time: "13:47" later today, "Fri 15:00" within the
 * coming week, "Sep 01" beyond. Unlike a countdown it stays valid without
 * ticking and reads as a concrete planning point.
 */
export function formatResetTime(resetAt: number, now: number): string {
	const reset = new Date(resetAt);
	if (reset.toDateString() === new Date(now).toDateString()) {
		return `${pad2(reset.getHours())}:${pad2(reset.getMinutes())}`;
	}
	const daysAhead = Math.round((startOfDayMs(resetAt) - startOfDayMs(now)) / 86_400_000);
	if (daysAhead <= 6) {
		return `${WEEKDAY_SHORT[reset.getDay()]} ${pad2(reset.getHours())}:${pad2(reset.getMinutes())}`;
	}
	return `${MONTH_SHORT[reset.getMonth()]} ${pad2(reset.getDate())}`;
}

/** One provider block in the `/quota` panel. */
export interface QuotaPanelRow {
	/** Real provider id, e.g. "zai-coding-cn". */
	label: string;
	/** Plan descriptor from the provider, e.g. "coding plan" or "pay as you go". */
	planLabel: string;
	/** Subscription tier reported by the provider, e.g. "max". */
	planLevel?: string;
	/** True for the provider pi currently runs with. */
	active?: boolean;
	/** True when the shown snapshot predates a failed refresh. */
	stale?: boolean;
	snapshot?: QuotaSnapshot;
	/** Placeholder text for providers whose endpoint is not implemented yet. */
	note?: string;
}

/** Exact balance for the panel header: "¥19.67 + ¥1.00 granted" or "¥19.67". */
function formatBalancePanel(balance: QuotaBalance): string {
	// Same one-cent threshold as formatBalanceCompact, so footer and panel
	// always agree on whether a granted part is shown at all.
	const granted = balance.granted >= 0.01 ? ` + ${balance.symbol}${balance.granted.toFixed(2)} granted` : "";
	return `${balance.symbol}${balance.total.toFixed(2)}${granted}`;
}

/**
 * Plain-text panel for `/quota`: one block per provider — a header line
 * with the plan, tier, an "active" marker for the provider pi currently
 * runs with, and the balances (one per currency) for pay-as-you-go
 * providers — then one line
 * per window showing the used quota as a plain meter (the bar fills with
 * pressure, like the footer's alert line), "NN% left" as text, and the
 * absolute reset time. MCP windows add their per-tool usage line, and a
 * blank line separates provider blocks:
 *
 *   zai-coding-cn  coding plan · Max · active
 *     5h   ▓▓▓▓▓▓▓▓▓░    8% left   reset 21:36
 *     7d   ▓▓▓▓▓▓▓░░░   26% left   reset Fri 23:13
 *     mcp  ░░░░░░░░░░   99% left   reset Nov 07
 *          └ search-prime 22 · web-reader 4 · zread 0
 *
 *   deepseek  pay as you go · ¥19.67 + ¥1.00 granted · $2.50
 */
export function formatQuotaPanel(rows: QuotaPanelRow[], now: number): string {
	const labelWidth = Math.max(2, ...rows.flatMap((row) => windowItems(row.snapshot).map((window) => window.label.length)));
	return rows
		.map((row) => {
			const snapshot = row.snapshot;
			const balances = balanceItems(snapshot).map(formatBalancePanel);
			const header = [
				row.planLabel,
				row.planLevel ? displayPlanLevel(row.planLevel) : undefined,
				...balances,
				row.active ? "active" : undefined,
			]
				.filter(Boolean)
				.join(" · ");
			const lines = [`${row.stale ? "~" : ""}${row.label}  ${header}`];
			if (row.note) {
				lines.push(`  ${row.note}`);
			} else if (!snapshot) {
				lines.push("  quota unavailable");
			} else {
				for (const window of windowItems(snapshot)) {
					const left = 100 - window.usedPercent;
					const reset =
						window.resetAt !== undefined && window.resetAt > now ? `   reset ${formatResetTime(window.resetAt, now)}` : "";
					lines.push(
						`  ${window.label.padEnd(labelWidth)}  ${meter(window.usedPercent)}  ${String(left).padStart(3)}% left${reset}`,
					);
					if (window.tools && window.tools.length > 0) {
						const tools = window.tools.map((tool) => `${tool.modelCode} ${tool.usage}`).join(" · ");
						lines.push(`${" ".repeat(labelWidth + 4)}└ ${tools}`);
					}
				}
			}
			return lines.join("\n");
		})
		.join("\n\n");
}
