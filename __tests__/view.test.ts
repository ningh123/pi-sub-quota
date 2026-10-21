import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { QuotaBalance, QuotaSnapshot, QuotaWindow } from "../providers/index.ts";
import {
	buildQuotaInline,
	buildQuotaLine,
	formatBalanceCompact,
	formatCountdown,
	formatQuota,
	formatQuotaPanel,
	formatResetTime,
	formatWindow,
	isWindowAlerting,
	meter,
	type QuotaPanelRow,
	usageColor,
} from "../view.ts";

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;
/** Style that wraps text in brackets so tests can assert colors and content separately. */
const styled = (color: string, text: string) => `[${color}]{${text}}`;

const window = (
	label: string,
	usedPercent: number,
	resetAt?: number,
	resource: QuotaWindow["resource"] = "tokens",
): QuotaWindow => ({
	type: "window",
	resource,
	label,
	usedPercent,
	resetAt,
});

const zaiSnapshot: QuotaSnapshot = {
	kind: "zai",
	fetchedAt: NOW,
	planLevel: "max",
	items: [window("5h", 7, NOW + 178 * MINUTE), window("7d", 57, NOW + (3 * 24 * 60 + 4 * 60) * MINUTE)],
};
const deepseekSnapshot: QuotaSnapshot = {
	kind: "deepseek",
	fetchedAt: NOW,
	items: [{ type: "balance", symbol: "¥", total: 19.67, granted: 1 }],
};

describe("meter", () => {
	it("fills with full blocks, clamps to the width, and width 0 is empty", () => {
		assert.equal(meter(0, 10), "░░░░░░░░░░");
		assert.equal(meter(50, 10), "▓▓▓▓▓░░░░░");
		assert.equal(meter(100, 10), "▓▓▓▓▓▓▓▓▓▓");
		assert.equal(meter(120, 4), "▓▓▓▓");
		assert.equal(meter(58, 10), "▓▓▓▓▓▓░░░░");
		assert.equal(meter(96, 10), "▓▓▓▓▓▓▓▓▓▓");
		assert.equal(meter(50, 0), "");
	});

	it("fills at least the first cell for any non-zero usage", () => {
		assert.equal(meter(1, 10), "▓░░░░░░░░░");
		assert.equal(meter(0.4, 10), "▓░░░░░░░░░");
		assert.equal(meter(0, 10), "░░░░░░░░░░");
	});

	it("treats non-finite usage as an empty meter", () => {
		// NaN comparisons are false, so NaN reads as zero fill; pinned here so
		// the behavior stays intentional now that cache items are validated.
		assert.equal(meter(Number.NaN, 10), "░░░░░░░░░░");
	});
});

describe("usageColor", () => {
	it("maps usage bands to green, amber, red", () => {
		assert.equal(usageColor(0), "success");
		assert.equal(usageColor(39), "success");
		assert.equal(usageColor(40), "warning");
		assert.equal(usageColor(79), "warning");
		assert.equal(usageColor(80), "error");
		assert.equal(usageColor(100), "error");
	});
});

describe("formatCountdown", () => {
	it("formats minutes under an hour", () => {
		assert.equal(formatCountdown(59 * MINUTE), "59m");
		assert.equal(formatCountdown(1 * MINUTE), "1m");
	});

	it("formats hours with minutes", () => {
		assert.equal(formatCountdown(60 * MINUTE), "1h0m");
		assert.equal(formatCountdown((2 * 60 + 58) * MINUTE), "2h58m");
	});

	it("formats days with hours", () => {
		assert.equal(formatCountdown(24 * 60 * MINUTE), "1d0h");
		assert.equal(formatCountdown((3 * 24 * 60 + 4 * 60) * MINUTE), "3d4h");
	});

	it("hides remaining time under a minute and already-expired resets", () => {
		assert.equal(formatCountdown(59_999), undefined);
		assert.equal(formatCountdown(0), undefined);
		assert.equal(formatCountdown(-5 * MINUTE), undefined);
	});
});

describe("formatWindow", () => {
	it("appends the reset countdown in parentheses", () => {
		assert.equal(formatWindow(window("5h", 2, NOW + 178 * MINUTE), NOW), "5h 2% (2h58m)");
	});

	it("keeps the window bare without a usable reset time", () => {
		assert.equal(formatWindow(window("5h", 2), NOW), "5h 2%");
		assert.equal(formatWindow(window("7d", 56, NOW - MINUTE), NOW), "7d 56%");
	});
});

describe("alert thresholds", () => {
	it("flags windows that are nearly exhausted or about to reset", () => {
		const quiet = window("5h", 79, NOW + 31 * MINUTE);
		assert.equal(isWindowAlerting(quiet, NOW), false);
		assert.equal(isWindowAlerting({ ...quiet, usedPercent: 80 }, NOW), true);
		assert.equal(isWindowAlerting({ ...quiet, usedPercent: 7, resetAt: NOW + 30 * MINUTE }, NOW), true);
		assert.equal(isWindowAlerting(window("5h", 7), NOW), false);
	});

	it("applies the same rule to MCP windows", () => {
		assert.equal(isWindowAlerting(window("mcp", 91, NOW + 5 * 24 * 60 * MINUTE, "mcp"), NOW), true);
		assert.equal(isWindowAlerting(window("mcp", 9, NOW + 5 * 24 * 60 * MINUTE, "mcp"), NOW), false);
	});
});

describe("formatQuota", () => {
	it("joins plan level and windows, with countdowns only on alerting windows", () => {
		// Both windows quiet: bare labels and percentages.
		assert.equal(formatQuota(zaiSnapshot, NOW), "(Max) 5h 7% · 7d 57%");
		// The 5h window at 96% is alerting, so only it carries a countdown.
		const hot: QuotaSnapshot = {
			...zaiSnapshot,
			items: [window("5h", 96, NOW + 3 * 60 * MINUTE), window("7d", 57, NOW + 3 * 24 * 60 * MINUTE)],
		};
		assert.equal(formatQuota(hot, NOW), "(Max) 5h 96% (3h0m) · 7d 57%");
	});

	it("shows the balance with its granted split on its own", () => {
		assert.equal(formatQuota(deepseekSnapshot, NOW), "¥18.67+¥1.00");
		// Multi-currency account: one balance per currency, joined with middle dots.
		const both: QuotaSnapshot = {
			...deepseekSnapshot,
			items: [...deepseekSnapshot.items, { type: "balance", symbol: "$", total: 2.4, granted: 0 }],
		};
		assert.equal(formatQuota(both, NOW), "¥18.67+¥1.00 · $2.40");
	});

	it("prefixes stale data with a tilde and returns empty for empty snapshots", () => {
		assert.equal(formatQuota(deepseekSnapshot, NOW, { stale: true }), "~¥18.67+¥1.00");
		assert.equal(formatQuota({ kind: "zai", fetchedAt: NOW, items: [] }, NOW), "");
	});
});

describe("formatBalanceCompact", () => {
	it("shows exact amounts; the split needs detail and a granted part of at least one cent", () => {
		assert.equal(formatBalanceCompact({ type: "balance", symbol: "¥", total: 19.67, granted: 1 }), "¥19.67");
		assert.equal(
			formatBalanceCompact({ type: "balance", symbol: "¥", total: 19.67, granted: 1 }, { detail: true }),
			"¥18.67+¥1.00",
		);
		// Any real granted amount shows exactly — no rounding, it is money.
		assert.equal(
			formatBalanceCompact({ type: "balance", symbol: "¥", total: 19.67, granted: 0.4 }, { detail: true }),
			"¥19.27+¥0.40",
		);
		// No granted part at all: a single number in any currency.
		assert.equal(formatBalanceCompact({ type: "balance", symbol: "$", total: 2.4, granted: 0 }, { detail: true }), "$2.40");
	});

	it("shows a depleting wallet as remaining over topped-up, regardless of detail", () => {
		const booster = { type: "balance" as const, symbol: "¥", total: 5, granted: 0, toppedUp: 20, label: "booster" };
		assert.equal(formatBalanceCompact(booster), "¥5.00/¥20.00");
		assert.equal(formatBalanceCompact(booster, { detail: true }), "¥5.00/¥20.00");
		// Fully spent still reads against the top-up: the wallet exists, it is empty.
		assert.equal(formatBalanceCompact({ ...booster, total: 0 }), "¥0.00/¥20.00");
	});
});

describe("buildQuotaInline", () => {
	it("renders bare percentages with per-window usage colors, in window order", () => {
		assert.equal(buildQuotaInline(zaiSnapshot, NOW, styled), "[success]{7%} [warning]{57%}");
	});

	it("appends a muted countdown only when a window is alerting", () => {
		// Reset imminent: countdown even at low usage.
		const soon: QuotaSnapshot = {
			kind: "zai",
			fetchedAt: NOW,
			items: [window("5h", 7, NOW + 25 * MINUTE), window("7d", 57, NOW + 5 * 24 * 60 * MINUTE)],
		};
		assert.equal(buildQuotaInline(soon, NOW, styled), "[success]{7%} [muted]{25m} [warning]{57%}");
		// Usage high: countdown even with a far reset.
		const hot: QuotaSnapshot = {
			kind: "zai",
			fetchedAt: NOW,
			items: [window("5h", 96, NOW + 3 * 60 * MINUTE), window("7d", 85, NOW + 3 * 24 * 60 * MINUTE)],
		};
		assert.equal(buildQuotaInline(hot, NOW, styled), "[error]{96%} [muted]{3h0m} [error]{85%} [muted]{3d0h}");
		// Quiet on both axes: bare percentages.
		assert.equal(
			buildQuotaInline(
				{ ...soon, items: soon.items.map((item) => (item.type === "window" ? { ...item, resetAt: NOW + 45 * MINUTE } : item)) },
				NOW,
				styled,
			),
			"[success]{7%} [warning]{57%}",
		);
	});

	it("hides quiet MCP windows and shows alerting ones with their label", () => {
		const quietMcp: QuotaSnapshot = {
			kind: "zai",
			fetchedAt: NOW,
			items: [...zaiSnapshot.items, window("mcp", 9, NOW + 5 * 24 * 60 * MINUTE, "mcp")],
		};
		assert.equal(buildQuotaInline(quietMcp, NOW, styled), "[success]{7%} [warning]{57%}");
		const hotMcp: QuotaSnapshot = {
			kind: "zai",
			fetchedAt: NOW,
			items: [...zaiSnapshot.items, window("mcp", 91, NOW + 5 * 24 * 60 * MINUTE, "mcp")],
		};
		assert.equal(buildQuotaInline(hotMcp, NOW, styled), "[success]{7%} [warning]{57%} [dim]{mcp} [error]{91%} [muted]{5d0h}");
	});

	it("renders balances in green, with the granted breakdown when width allows", () => {
		assert.equal(buildQuotaInline(deepseekSnapshot, NOW, styled), "[success]{¥19.67}");
		assert.equal(buildQuotaInline(deepseekSnapshot, NOW, styled, { balanceDetail: true }), "[success]{¥18.67+¥1.00}");
		// Multi-currency account: one balance per currency, side by side.
		const both: QuotaSnapshot = {
			...deepseekSnapshot,
			items: [...deepseekSnapshot.items, { type: "balance", symbol: "$", total: 2.4, granted: 0 }],
		};
		assert.equal(buildQuotaInline(both, NOW, styled, { balanceDetail: true }), "[success]{¥18.67+¥1.00} [success]{$2.40}");
	});

	it("marks stale data with a warning tilde", () => {
		assert.equal(buildQuotaInline(zaiSnapshot, NOW, styled, { stale: true }), "[warning]{~}[success]{7%} [warning]{57%}");
	});

	it("returns empty for missing or empty snapshots", () => {
		assert.equal(buildQuotaInline(undefined, NOW, styled), "");
		assert.equal(buildQuotaInline({ kind: "zai", fetchedAt: NOW, items: [] }, NOW, styled), "");
	});
});

describe("buildQuotaLine", () => {
	it("renders every window in full detail: label, meter, aligned percentage, countdown", () => {
		assert.equal(
			buildQuotaLine(zaiSnapshot, NOW, styled, 10),
			"[dim]{(Max)} " +
				"[dim]{5h} [success]{▓░░░░░░░░░} [success]{  7%} [muted]{2h58m}" +
				"[dim]{ · }" +
				"[dim]{7d} [warning]{▓▓▓▓▓▓░░░░} [warning]{ 57%} [muted]{3d4h}",
		);
	});

	it("drops meter cells at width 0 and renders balances plainly", () => {
		assert.equal(buildQuotaLine(deepseekSnapshot, NOW, styled, 0), "[success]{¥18.67+¥1.00}");
		assert.equal(
			buildQuotaLine(
				{
					...zaiSnapshot,
					items: zaiSnapshot.items.map((item) => (item.type === "window" ? { ...item, resetAt: undefined } : item)),
				},
				NOW,
				styled,
				0,
			),
			"[dim]{(Max)} [dim]{5h} [success]{  7%}[dim]{ · }[dim]{7d} [warning]{ 57%}",
		);
	});

	it("renders MCP windows with the same full detail as token windows", () => {
		const snapshot: QuotaSnapshot = {
			kind: "zai",
			fetchedAt: NOW,
			planLevel: "max",
			items: [
				window("5h", 7, NOW + 178 * MINUTE),
				window("7d", 96, NOW + 41 * MINUTE),
				window("mcp", 9, NOW + 5 * 24 * 60 * MINUTE, "mcp"),
			],
		};
		assert.equal(
			buildQuotaLine(snapshot, NOW, styled, 10),
			"[dim]{(Max)} " +
				"[dim]{5h} [success]{▓░░░░░░░░░} [success]{  7%} [muted]{2h58m}" +
				"[dim]{ · }" +
				"[dim]{7d} [error]{▓▓▓▓▓▓▓▓▓▓} [error]{ 96%} [muted]{41m}" +
				"[dim]{ · }" +
				"[dim]{mcp} [success]{▓░░░░░░░░░} [success]{  9%} [muted]{5d0h}",
		);
	});

	it("marks stale data and returns empty for missing or empty snapshots", () => {
		assert.equal(
			buildQuotaLine(zaiSnapshot, NOW, styled, 10, { stale: true }),
			`[warning]{~}[dim]{(Max)} [dim]{5h} [success]{▓░░░░░░░░░} [success]{  7%} [muted]{2h58m}[dim]{ · }[dim]{7d} [warning]{▓▓▓▓▓▓░░░░} [warning]{ 57%} [muted]{3d4h}`,
		);
		assert.equal(buildQuotaLine(undefined, NOW, styled, 10), "");
		assert.equal(buildQuotaLine({ kind: "zai", fetchedAt: NOW, items: [] }, NOW, styled, 10), "");
	});
});

describe("formatResetTime", () => {
	it("formats resets as local absolute times: clock today, weekday within the week, date beyond", () => {
		const now = new Date(2026, 8, 15, 10, 30).getTime(); // Tuesday, Sep 15 2026
		assert.equal(formatResetTime(new Date(2026, 8, 15, 13, 47).getTime(), now), "13:47");
		assert.equal(formatResetTime(new Date(2026, 8, 18, 15, 0).getTime(), now), "Fri 15:00");
		assert.equal(formatResetTime(new Date(2026, 9, 1, 9, 0).getTime(), now), "Oct 01");
	});
});

describe("formatQuotaPanel", () => {
	const now = new Date(2026, 8, 15, 10, 30).getTime();
	const zai: QuotaPanelRow = {
		label: "zai-coding-cn",
		planLabel: "coding plan",
		planLevel: "max",
		active: true,
		snapshot: {
			kind: "zai",
			fetchedAt: now,
			planLevel: "max",
			items: [
				window("5h", 38, new Date(2026, 8, 15, 13, 47).getTime()),
				window("7d", 45, new Date(2026, 8, 18, 15, 0).getTime()),
				{
					type: "window",
					resource: "mcp",
					label: "mcp",
					usedPercent: 1,
					resetAt: new Date(2026, 10, 7, 9, 0).getTime(),
					tools: [
						{ modelCode: "search-prime", usage: 22 },
						{ modelCode: "web-reader", usage: 4 },
					],
				},
			],
		},
	};
	const deepseek: QuotaPanelRow = {
		label: "deepseek",
		planLabel: "pay as you go",
		snapshot: deepseekSnapshot,
	};
	const kimi: QuotaPanelRow = { label: "kimi-coding", planLabel: "coding plan", note: "quota endpoint not supported yet" };

	it("renders one block per provider: remaining meters, absolute resets, MCP tools, header balance", () => {
		assert.equal(
			formatQuotaPanel([zai, deepseek, kimi], now),
			[
				[
					"zai-coding-cn  coding plan · Max · active",
					`  5h   ${"▓".repeat(4)}${"░".repeat(6)}   62% left   reset 13:47`,
					`  7d   ${"▓".repeat(5)}${"░".repeat(5)}   55% left   reset Fri 15:00`,
					`  mcp  ${"▓".repeat(1)}${"░".repeat(9)}   99% left   reset Nov 07`,
					"       └ search-prime 22 · web-reader 4",
				].join("\n"),
				"deepseek  pay as you go · ¥19.67 + ¥1.00 granted",
				["kimi-coding  coding plan", "  quota endpoint not supported yet"].join("\n"),
			].join("\n\n"),
		);
	});

	it("marks stale blocks with a tilde and providers without data as unavailable", () => {
		assert.equal(
			formatQuotaPanel(
				[
					{ ...deepseek, stale: true },
					{ label: "deepseek", planLabel: "pay as you go" },
				],
				now,
			),
			["~deepseek  pay as you go · ¥19.67 + ¥1.00 granted", "", "deepseek  pay as you go", "  quota unavailable"].join("\n"),
		);
	});

	it("joins several currency balances on the provider header", () => {
		const both: QuotaPanelRow = {
			label: "deepseek",
			planLabel: "pay as you go",
			snapshot: {
				kind: "deepseek",
				fetchedAt: now,
				items: [...deepseekSnapshot.items, { type: "balance", symbol: "$", total: 2.5, granted: 0 }],
			},
		};
		assert.equal(formatQuotaPanel([both], now), "deepseek  pay as you go · ¥19.67 + ¥1.00 granted · $2.50");
	});

	it("applies the same one-cent threshold as the compact balance", () => {
		// A granted part under a cent shows no split — footer and panel agree.
		const tiny: QuotaPanelRow = {
			label: "deepseek",
			planLabel: "pay as you go",
			snapshot: {
				kind: "deepseek",
				fetchedAt: now,
				items: [{ type: "balance", symbol: "¥", total: 19.67, granted: 0.004 }],
			},
		};
		assert.equal(formatQuotaPanel([tiny], now), "deepseek  pay as you go · ¥19.67");
	});

	it("labels a depleting wallet on the provider header", () => {
		const kimi: QuotaPanelRow = {
			label: "kimi-coding",
			planLabel: "coding plan",
			planLevel: "allegretto",
			snapshot: {
				kind: "kimi",
				fetchedAt: now,
				items: [{ type: "balance", symbol: "¥", total: 100, granted: 0, toppedUp: 200, label: "booster" }],
			},
		};
		assert.equal(formatQuotaPanel([kimi], now), "kimi-coding  coding plan · Allegretto · booster ¥100.00/¥200.00");
	});
});

describe("QuotaBalance helper types compile", () => {
	it("keeps the balance item shape explicit", () => {
		const balance: QuotaBalance = { type: "balance", symbol: "¥", total: 1, granted: 0 };
		assert.equal(balance.type, "balance");
	});
});
