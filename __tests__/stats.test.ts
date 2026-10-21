import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { computeSessionStats, formatCwd, formatTokens } from "../stats.ts";

describe("computeSessionStats", () => {
	const usage = (over: Partial<{ input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }> = {}) => ({
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		...over,
		cost: { total: over.cost ?? 0 },
	});

	it("sums usage entries, assistant messages, tool results, and compaction usage", () => {
		const stats = computeSessionStats([
			{ type: "usage", usage: usage({ input: 100, output: 50, cost: 0.1 }) },
			{ type: "message", message: { role: "assistant", usage: usage({ input: 10, output: 20, cacheRead: 500, cost: 0.2 }) } },
			{ type: "message", message: { role: "toolResult", usage: usage({ cacheWrite: 300 }) } },
			{ type: "compaction", usage: usage({ input: 5 }) },
			{ type: "branch_summary", usage: usage({ output: 1 }) },
		]);
		assert.deepEqual(stats.totals, { input: 115, output: 71, cacheRead: 500, cacheWrite: 300, cost: 0.30000000000000004 });
	});

	it("tracks the latest assistant cache hit rate and ignores user messages", () => {
		const stats = computeSessionStats([
			{ type: "message", message: { role: "user" } },
			{ type: "message", message: { role: "assistant", usage: usage({ input: 100, cacheRead: 300, cacheWrite: 100 }) } },
		]);
		assert.equal(stats.latestCacheHitRate?.toFixed(1), "60.0");
	});

	it("returns zeroed totals for empty or unrecognized entries", () => {
		assert.deepEqual(computeSessionStats([]).totals, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
		assert.deepEqual(computeSessionStats([{ type: "message", message: { role: "user" } }]).totals, {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
		});
	});
});

describe("formatTokens", () => {
	it("matches the built-in footer's compact forms", () => {
		assert.equal(formatTokens(999), "999");
		assert.equal(formatTokens(9_999), "10.0k");
		assert.equal(formatTokens(123_456), "123k");
		assert.equal(formatTokens(1_200_000), "1.2M");
		assert.equal(formatTokens(12_000_000), "12M");
	});
});

describe("formatCwd", () => {
	it("collapses the home prefix to ~ and leaves other paths alone", () => {
		assert.equal(formatCwd("/Users/ning/Developer/ningh123", "/Users/ning"), "~/Developer/ningh123");
		assert.equal(formatCwd("/Users/ning", "/Users/ning"), "~");
		assert.equal(formatCwd("/tmp/project", "/Users/ning"), "/tmp/project");
		assert.equal(formatCwd("/opt/home", undefined), "/opt/home");
	});

	it("does not shorten sibling paths that merely share the home prefix", () => {
		// The built-in footer fixed exactly this: /Users/ning-dev must not become ~-dev.
		assert.equal(formatCwd("/Users/ning-dev", "/Users/ning"), "/Users/ning-dev");
		assert.equal(formatCwd("/Users/ningdev", "/Users/ning"), "/Users/ningdev");
	});
});
