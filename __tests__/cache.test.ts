import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CACHE_VERSION, emptyCache, freshSnapshot, isNewerCacheFile, parseCache, serializeCache } from "../cache.ts";
import type { QuotaSnapshot } from "../providers/index.ts";

const zaiSnapshot: QuotaSnapshot = {
	kind: "zai",
	fetchedAt: 1_000,
	items: [
		{ type: "window", resource: "tokens", label: "5h", usedPercent: 2, resetAt: 61_000 },
		{ type: "window", resource: "tokens", label: "7d", usedPercent: 56, resetAt: 361_000 },
	],
};
const deepseekSnapshot: QuotaSnapshot = {
	kind: "deepseek",
	fetchedAt: 2_000,
	items: [{ type: "balance", symbol: "¥", total: 19.67, granted: 1 }],
};

describe("parseCache", () => {
	it("round-trips through serializeCache", () => {
		const cache = emptyCache();
		cache.snapshots.zai = zaiSnapshot;
		cache.snapshots.deepseek = deepseekSnapshot;
		const parsed = parseCache(serializeCache(cache));
		assert.deepEqual(parsed, cache);
	});

	it("returns an empty cache for missing, corrupt, or foreign input", () => {
		assert.deepEqual(parseCache(undefined), emptyCache());
		assert.deepEqual(parseCache("not json"), emptyCache());
		assert.deepEqual(parseCache(`{"version": 99, "snapshots": {}}`), emptyCache());
		assert.deepEqual(parseCache(`{"version": 1, "snapshots": {}}`), emptyCache());
	});

	it("drops invalid kinds and malformed snapshots but keeps the rest", () => {
		const text = JSON.stringify({
			version: 2,
			snapshots: {
				anthropic: { kind: "zai", fetchedAt: 1, windows: [] },
				zai: { fetchedAt: "not-a-number", items: [] },
				deepseek: deepseekSnapshot,
			},
		});
		const parsed = parseCache(text);
		assert.deepEqual(parsed.snapshots, { deepseek: deepseekSnapshot });
	});

	it("drops snapshots whose items are corrupted, so renders can trust item shapes", () => {
		// A hand-edited or foreign-written cache file must never crash the footer.
		const text = JSON.stringify({
			version: 2,
			snapshots: {
				zai: { kind: "zai", fetchedAt: 1, items: [null] },
				kimi: { kind: "kimi", fetchedAt: 2, items: [{ type: "weird" }, {}] },
				deepseek: { kind: "deepseek", fetchedAt: 3, items: [{ type: "balance", symbol: "¥", total: "x", granted: 0 }] },
			},
		});
		assert.deepEqual(parseCache(text).snapshots, {});
	});

	it("validates window labels, resources, durations, tool breakdowns, and balance symbols", () => {
		// Every field the renderers call string/array methods on must be the
		// right type, or a corrupted file could crash /quota and the footer.
		const bad = (over: Record<string, unknown>) => ({
			type: "window",
			resource: "mcp",
			label: "mcp",
			usedPercent: 1,
			...over,
		});
		const text = JSON.stringify({
			version: 2,
			snapshots: {
				zai: {
					kind: "zai",
					fetchedAt: 1,
					items: [
						bad({ label: 5 }),
						bad({ resource: "gpu" }),
						bad({ durationMs: "soon" }),
						bad({ tools: "corrupted" }),
						bad({ tools: [{ modelCode: "x" }] }),
						bad({ tools: [{ modelCode: "x", usage: "many" }] }),
						{ type: "balance", symbol: 1, total: 1, granted: 0 },
					],
				},
			},
		});
		assert.deepEqual(parseCache(text).snapshots, {});
	});

	it("keeps snapshots with valid tool breakdowns and string plan levels", () => {
		const snapshot = {
			kind: "zai",
			fetchedAt: 1,
			planLevel: "max",
			items: [
				{
					type: "window",
					resource: "mcp",
					label: "mcp",
					usedPercent: 1,
					resetAt: 61_000,
					durationMs: 86_400_000,
					tools: [{ modelCode: "search-prime", usage: 3 }],
				},
			],
		};
		const parsed = parseCache(JSON.stringify({ version: 2, snapshots: { zai: snapshot } }));
		assert.deepEqual(parsed.snapshots, { zai: snapshot });
	});

	it("rejects non-string plan levels that would crash displayPlanLevel", () => {
		const text = JSON.stringify({ version: 2, snapshots: { zai: { kind: "zai", fetchedAt: 1, planLevel: 42, items: [] } } });
		assert.deepEqual(parseCache(text).snapshots, {});
	});

	it("rejects non-finite numbers that survive JSON parsing (1e999 → Infinity)", () => {
		// Written as raw JSON so 1e999 really parses to Infinity.
		const infiniteReset =
			'{"version":2,"snapshots":{"zai":{"kind":"zai","fetchedAt":1,"items":[{"type":"window","resource":"tokens","label":"5h","usedPercent":10,"resetAt":1e999}]}}}';
		assert.deepEqual(parseCache(infiniteReset).snapshots, {});
		const infinitePercent = '{"version":2,"snapshots":{"zai":{"kind":"zai","fetchedAt":1e999,"items":[]}}}';
		assert.deepEqual(parseCache(infinitePercent).snapshots, {});
		// The same snapshot with finite values stays.
		const finite = JSON.stringify({ version: 2, snapshots: { zai: zaiSnapshot } });
		assert.deepEqual(parseCache(finite).snapshots, { zai: zaiSnapshot });
	});
});

describe("isNewerCacheFile", () => {
	it("flags only files written by a newer cache format", () => {
		assert.equal(isNewerCacheFile(undefined), false);
		assert.equal(isNewerCacheFile("not json"), false);
		assert.equal(isNewerCacheFile(JSON.stringify({ version: CACHE_VERSION, snapshots: {} })), false);
		assert.equal(isNewerCacheFile(JSON.stringify({ version: CACHE_VERSION + 1, snapshots: {} })), true);
		assert.equal(isNewerCacheFile(JSON.stringify({ version: "2" })), false);
	});
});

describe("freshSnapshot", () => {
	const ttl = 300_000;

	it("accepts snapshots inside the TTL and rejects older ones", () => {
		assert.equal(freshSnapshot(zaiSnapshot, 1_000 + ttl - 1, ttl), true);
		assert.equal(freshSnapshot(zaiSnapshot, 1_000 + ttl, ttl), false);
		assert.equal(freshSnapshot(zaiSnapshot, 1_000 + ttl + 1, ttl), false);
	});

	it("rejects missing snapshots and tolerates clock skew from the future", () => {
		assert.equal(freshSnapshot(undefined, 1_000, ttl), false);
		// A fetchedAt slightly in the future (clock skew) has negative age, which still counts as fresh.
		assert.equal(freshSnapshot(zaiSnapshot, 0, ttl), true);
	});
});
