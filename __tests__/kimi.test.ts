import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { fetchKimiQuota } from "../providers/index.ts";
import { jsonResponse } from "./helpers.ts";

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

	it("derives the usage URL from a custom baseUrl and maps other tiers", async () => {
		let seen = "";
		const fetchImpl = async (url: string | URL | Request) => {
			seen = String(url);
			return jsonResponse({ usage: { limit: "7168", used: "0" }, limits: [] });
		};
		const snapshot = await fetchKimiQuota("key", { fetchImpl, now: () => 1, baseUrl: "https://api.kimi.ai/coding/v1/" });
		assert.equal(seen, "https://api.kimi.ai/coding/v1/usages");
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

	it("tolerates a non-array limits field and derives the URL without query or fragment", async () => {
		let seen = "";
		const fetchImpl = async (url: string | URL | Request) => {
			seen = String(url);
			return jsonResponse({ usage: { limit: "2048", used: "10" }, limits: {} });
		};
		const snapshot = await fetchKimiQuota("key", {
			fetchImpl,
			now: () => 1,
			baseUrl: "https://api.kimi.com/coding/v1?x=1#frag",
		});
		assert.equal(seen, "https://api.kimi.com/coding/v1/usages");
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
});
