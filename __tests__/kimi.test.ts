import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { fetchKimiQuota } from "../providers/index.ts";
import { jsonResponse } from "./helpers.ts";

/** fetch fake routing by URL suffix: the /me account body and the /usages body. */
function kimiFetch(me: unknown, usages: unknown, meStatus = 200) {
	return async (url: string | URL | Request): Promise<Response> => {
		const isMe = String(url).endsWith("/me");
		return jsonResponse(isMe ? me : usages, isMe ? meStatus : 200);
	};
}

/** Response shape documented by CodexBar for `GET <base>/coding/v1/usages`. */
const usagesBody = {
	usage: { limit: "2048", used: "214", remaining: "1834", resetTime: "2026-01-06T13:33:02.717479433Z" },
	limits: [
		{
			window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
			detail: { limit: "200", used: "139", remaining: "61", resetTime: "2026-01-09T15:23:13.716839300Z" },
		},
	],
};

describe("fetchKimiQuota", () => {
	it("maps the weekly pool and the 5-hour rate window, tiered and sorted by reset", async () => {
		const fetchImpl = async () => jsonResponse(usagesBody);
		const snapshot = await fetchKimiQuota("key", { fetchImpl, now: () => 42 });
		assert.equal(snapshot.kind, "kimi");
		assert.equal(snapshot.fetchedAt, 42);
		assert.equal(snapshot.planLevel, "moderato");
		// The weekly pool resets sooner here on purpose: duration order still puts 5h first.
		assert.deepEqual(snapshot.items, [
			{
				type: "window",
				resource: "tokens",
				label: "5h",
				usedPercent: 70,
				resetAt: Date.parse("2026-01-09T15:23:13.716839300Z"),
				durationMs: 5 * 3_600_000,
			},
			{
				type: "window",
				resource: "tokens",
				label: "7d",
				usedPercent: 10,
				resetAt: Date.parse("2026-01-06T13:33:02.717479433Z"),
				durationMs: 7 * 24 * 3_600_000,
			},
		]);
	});

	it("derives both endpoint URLs from a custom baseUrl and maps legacy tiers", async () => {
		const seen: string[] = [];
		const fetchImpl = async (url: string | URL | Request) => {
			const target = String(url);
			seen.push(target);
			return jsonResponse(target.endsWith("/me") ? {} : { usage: { limit: "7168", used: "0" }, limits: [] });
		};
		const snapshot = await fetchKimiQuota("key", { fetchImpl, now: () => 1, baseUrl: "https://api.kimi.ai/coding/v1/" });
		assert.deepEqual([...seen].sort(), ["https://api.kimi.ai/coding/v1/me", "https://api.kimi.ai/coding/v1/usages"]);
		assert.equal(snapshot.planLevel, "allegretto");
		assert.deepEqual(snapshot.items, [
			{ type: "window", resource: "tokens", label: "7d", usedPercent: 0, resetAt: undefined, durationMs: 7 * 24 * 3_600_000 },
		]);
	});

	it("labels other window durations and skips unknown time units", async () => {
		const fetchImpl = async () =>
			jsonResponse({
				usage: { limit: "1024", used: "512" },
				limits: [
					{ window: { duration: 1, timeUnit: "TIME_UNIT_DAY" }, detail: { limit: "100", used: "100" } },
					{ window: { duration: 12, timeUnit: "TIME_UNIT_HOUR" }, detail: { limit: "100", used: "50" } },
					{ window: { duration: 5, timeUnit: "TIME_UNIT_FORTNIGHT" }, detail: { limit: "100", used: "10" } },
				],
			});
		const snapshot = await fetchKimiQuota("key", { fetchImpl, now: () => 1 });
		assert.equal(snapshot.planLevel, "andante");
		assert.deepEqual(snapshot.items, [
			{ type: "window", resource: "tokens", label: "12h", usedPercent: 50, resetAt: undefined, durationMs: 12 * 3_600_000 },
			{ type: "window", resource: "tokens", label: "1d", usedPercent: 100, resetAt: undefined, durationMs: 24 * 3_600_000 },
			{ type: "window", resource: "tokens", label: "7d", usedPercent: 50, resetAt: undefined, durationMs: 7 * 24 * 3_600_000 },
		]);
	});

	it("tolerates a non-array limits field and derives URLs without query or fragment", async () => {
		const seen: string[] = [];
		const fetchImpl = async (url: string | URL | Request) => {
			const target = String(url);
			seen.push(target);
			return jsonResponse(target.endsWith("/me") ? {} : { usage: { limit: "2048", used: "10" }, limits: {} });
		};
		const snapshot = await fetchKimiQuota("key", {
			fetchImpl,
			now: () => 1,
			baseUrl: "https://api.kimi.com/coding/v1?x=1#frag",
		});
		assert.deepEqual([...seen].sort(), ["https://api.kimi.com/coding/v1/me", "https://api.kimi.com/coding/v1/usages"]);
		assert.deepEqual(snapshot.items, [
			{ type: "window", resource: "tokens", label: "7d", usedPercent: 0, resetAt: undefined, durationMs: 7 * 24 * 3_600_000 },
		]);
	});

	it("throws a clear error for an invalid baseUrl", async () => {
		const fetchImpl = async () => jsonResponse({ usage: { limit: "1024", used: "1" } });
		await assert.rejects(() => fetchKimiQuota("key", { fetchImpl, now: () => 1, baseUrl: "not a url" }), /invalid baseUrl/);
	});

	it("treats malformed counts as zero usage and throws when no windows exist", async () => {
		const bogus = async () =>
			jsonResponse({ usage: { limit: "0", used: "10" }, limits: [{ window: { duration: 300 }, detail: {} }] });
		const snapshot = await fetchKimiQuota("key", { fetchImpl: bogus, now: () => 1 });
		assert.deepEqual(snapshot.items, [
			{ type: "window", resource: "tokens", label: "5h", usedPercent: 0, resetAt: undefined, durationMs: 5 * 3_600_000 },
		]);

		const empty = async () => jsonResponse({});
		await assert.rejects(() => fetchKimiQuota("key", { fetchImpl: empty, now: () => 1 }), /no usage windows/);
	});

	it("reads the tier from /me and derives usage from remaining (new plan format)", async () => {
		const usages = {
			usage: { limit: "100", remaining: "40", resetTime: "2026-10-23T11:26:52.819308Z" },
			limits: [
				{
					window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
					detail: { limit: "100", remaining: "40", resetTime: "2026-10-21T22:26:52.819308Z" },
				},
			],
		};
		const snapshot = await fetchKimiQuota("key", {
			fetchImpl: kimiFetch({ user_level_name: "Allegretto" }, usages),
			now: () => 1,
		});
		assert.equal(snapshot.planLevel, "Allegretto");
		assert.deepEqual(snapshot.items, [
			{
				type: "window",
				resource: "tokens",
				label: "5h",
				usedPercent: 60,
				resetAt: Date.parse("2026-10-21T22:26:52.819308Z"),
				durationMs: 5 * 3_600_000,
			},
			{
				type: "window",
				resource: "tokens",
				label: "7d",
				usedPercent: 60,
				resetAt: Date.parse("2026-10-23T11:26:52.819308Z"),
				durationMs: 7 * 24 * 3_600_000,
			},
		]);
	});

	it("prefers the /me tier name over the legacy limit map", async () => {
		const snapshot = await fetchKimiQuota("key", {
			fetchImpl: kimiFetch({ user_level_name: "Allegretto" }, { usage: { limit: "2048", used: "10" } }),
			now: () => 1,
		});
		assert.equal(snapshot.planLevel, "Allegretto");
	});

	it("falls back to the legacy limit map when /me fails or lacks a name", async () => {
		const failed = await fetchKimiQuota("key", {
			fetchImpl: kimiFetch({}, { usage: { limit: "2048", used: "10" } }, 500),
			now: () => 1,
		});
		assert.equal(failed.planLevel, "moderato");

		const unnamed = await fetchKimiQuota("key", {
			fetchImpl: kimiFetch({ user_level_name: "" }, { usage: { limit: "1024", used: "10" } }),
			now: () => 1,
		});
		assert.equal(unnamed.planLevel, "andante");
	});

	it("adds the monthly ratio pool and skips ratios duplicating count-based windows", async () => {
		const usages = {
			usage: { limit: "100", used: "10" },
			limits: [{ window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" }, detail: { limit: "100", used: "20" } }],
			usages: {
				// 5h/7d repeat the count-based windows: the richer counts must win.
				limit_5h: { used_ratio: 0.99, reset_time: "2026-10-21T22:26:51Z" },
				limit_7d: { used_ratio: 0.98, reset_time: "2026-10-23T11:26:51Z" },
				limit_month_total: { used_ratio: 0.25, reset_time: "2026-11-01T00:00:00Z" },
			},
		};
		const snapshot = await fetchKimiQuota("key", { fetchImpl: kimiFetch({}, usages), now: () => 1 });
		assert.deepEqual(snapshot.items, [
			{ type: "window", resource: "tokens", label: "5h", usedPercent: 20, resetAt: undefined, durationMs: 5 * 3_600_000 },
			{ type: "window", resource: "tokens", label: "7d", usedPercent: 10, resetAt: undefined, durationMs: 7 * 24 * 3_600_000 },
			{
				type: "window",
				resource: "tokens",
				label: "30d",
				usedPercent: 25,
				resetAt: Date.parse("2026-11-01T00:00:00Z"),
				durationMs: 30 * 24 * 3_600_000,
			},
		]);
	});

	it("falls back to ratio pools alone when no count-based windows exist", async () => {
		const usages = {
			usages: {
				limit_5h: { used_ratio: "0.5", reset_time: "2026-10-21T22:26:51Z" },
				limit_month_total: { used_ratio: 1 },
			},
		};
		const snapshot = await fetchKimiQuota("key", { fetchImpl: kimiFetch({}, usages), now: () => 1 });
		assert.deepEqual(snapshot.items, [
			{
				type: "window",
				resource: "tokens",
				label: "5h",
				usedPercent: 50,
				resetAt: Date.parse("2026-10-21T22:26:51Z"),
				durationMs: 5 * 3_600_000,
			},
			{ type: "window", resource: "tokens", label: "30d", usedPercent: 100, resetAt: undefined, durationMs: 30 * 24 * 3_600_000 },
		]);
	});

	it("maps a topped-up booster wallet to a remaining/toppedUp balance", async () => {
		// Amounts are fixed-point (÷1e6 = cents), per Kimi's CLI: ¥200 topped up, ¥100 left.
		const usages = {
			usage: { limit: "100", remaining: "40" },
			booster_wallet: {
				balance: { type: "BOOSTER", amount: "20000000000", amountLeft: "10000000000" },
				monthlyChargeLimit: { currency: "CNY", priceInCents: "20000" },
				monthlyUsed: { currency: "CNY", priceInCents: "5000" },
			},
		};
		const snapshot = await fetchKimiQuota("key", { fetchImpl: kimiFetch({}, usages), now: () => 1 });
		assert.deepEqual(snapshot.items.at(-1), {
			type: "balance",
			symbol: "¥",
			total: 100,
			granted: 0,
			toppedUp: 200,
			label: "booster",
		});
	});

	it("keeps an empty booster wallet (inactive, no amount) out of the snapshot", async () => {
		const usages = {
			usage: { limit: "100", remaining: "100" },
			booster_wallet: {
				// Real shape of an inactive wallet: metadata only, no amounts.
				balance: { feature: "FEATURE_OMNI", type: "BOOSTER", unit: "UNIT_CURRENCY" },
				status: "STATUS_DISABLED",
				topupLimit: { currency: "CNY", priceInCents: "300000" },
				monthlyUsed: { currency: "CNY", priceInCents: "0" },
			},
		};
		const snapshot = await fetchKimiQuota("key", {
			fetchImpl: kimiFetch({ user_level_name: "Allegretto" }, usages),
			now: () => 1,
		});
		assert.equal(snapshot.planLevel, "Allegretto");
		assert.ok(snapshot.items.every((item) => item.type !== "balance"));
	});
});
