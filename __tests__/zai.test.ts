import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { fetchZaiQuota } from "../providers/index.ts";
import { jsonResponse } from "./helpers.ts";

describe("fetchZaiQuota", () => {
	const now = () => 1_700_000_000_000;

	it("maps TOKENS_LIMIT windows and TIME_LIMIT MCP quota with its per-tool breakdown", async () => {
		const fetchImpl = async () =>
			jsonResponse({
				data: {
					limits: [
						{
							type: "TIME_LIMIT",
							unit: 5,
							number: 1,
							usage: 4000,
							currentValue: 26,
							remaining: 3974,
							percentage: 1,
							nextResetTime: 1_700_010_000_000,
							usageDetails: [
								{ modelCode: "search-prime", usage: 22 },
								{ modelCode: "web-reader", usage: 4 },
								{ modelCode: "zread", usage: 0 },
							],
						},
						{ type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 56, nextResetTime: 1_700_000_360_000 },
						{ type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 2, nextResetTime: 1_700_005_000_000 },
					],
					level: "max",
				},
			});
		const snapshot = await fetchZaiQuota("key", { fetchImpl, now });
		assert.equal(snapshot.kind, "zai");
		assert.equal(snapshot.fetchedAt, now());
		assert.equal(snapshot.planLevel, "max");
		assert.deepEqual(snapshot.items, [
			{
				type: "window",
				resource: "tokens",
				label: "5h",
				usedPercent: 2,
				// Resets later than the 7d window; 5h still comes first (duration order).
				resetAt: 1_700_005_000_000,
				durationMs: 5 * 3_600_000,
				tools: undefined,
			},
			{
				type: "window",
				resource: "tokens",
				label: "7d",
				usedPercent: 56,
				resetAt: 1_700_000_360_000,
				durationMs: 7 * 24 * 3_600_000,
				tools: undefined,
			},
			{
				type: "window",
				resource: "mcp",
				label: "mcp",
				usedPercent: 1,
				resetAt: 1_700_010_000_000,
				durationMs: undefined,
				tools: [
					{ modelCode: "search-prime", usage: 22 },
					{ modelCode: "web-reader", usage: 4 },
					{ modelCode: "zread", usage: 0 },
				],
			},
		]);
	});

	it("labels unknown units defensively and drops missing reset times", async () => {
		const fetchImpl = async () => jsonResponse({ data: { limits: [{ type: "TOKENS_LIMIT", unit: 9, percentage: 10 }] } });
		const snapshot = await fetchZaiQuota("key", { fetchImpl, now });
		assert.deepEqual(snapshot.items, [
			{
				type: "window",
				resource: "tokens",
				label: "u9",
				usedPercent: 10,
				resetAt: undefined,
				durationMs: undefined,
				tools: undefined,
			},
		]);
	});

	it("clamps malformed percentages into 0-100", async () => {
		const fetchImpl = async () =>
			jsonResponse({
				data: {
					limits: [
						{ type: "TOKENS_LIMIT", unit: 3, percentage: 250 },
						{ type: "TOKENS_LIMIT", unit: 6, percentage: "bogus" },
					],
				},
			});
		const snapshot = await fetchZaiQuota("key", { fetchImpl, now });
		assert.deepEqual(
			snapshot.items.map((item) => (item.type === "window" ? item.usedPercent : -1)).sort((a, b) => a - b),
			[0, 100],
		);
	});

	it("drops non-finite reset times and per-tool usages (JSON 1e999 parses as Infinity)", async () => {
		const fetchImpl = async () =>
			jsonResponse({
				data: {
					limits: [
						{ type: "TOKENS_LIMIT", unit: 3, percentage: 10, nextResetTime: Infinity },
						{
							type: "TIME_LIMIT",
							unit: 5,
							percentage: 1,
							usageDetails: [
								{ modelCode: "infinite", usage: Infinity },
								{ modelCode: "finite", usage: 3 },
							],
						},
					],
				},
			});
		const snapshot = await fetchZaiQuota("key", { fetchImpl, now });
		const token = snapshot.items.find((item) => item.type === "window" && item.resource === "tokens");
		assert.ok(token?.type === "window");
		assert.equal(token.resetAt, undefined, "Infinity must not become a reset time");
		const mcp = snapshot.items.find((item) => item.type === "window" && item.resource === "mcp");
		assert.ok(mcp?.type === "window");
		assert.deepEqual(mcp.tools, [{ modelCode: "finite", usage: 3 }]);
	});

	it("throws on HTTP errors and tolerates an empty body", async () => {
		const failing = async () => jsonResponse({ message: "unauthorized" }, 401);
		await assert.rejects(() => fetchZaiQuota("key", { fetchImpl: failing, now }), /HTTP 401/);

		const empty = async () => jsonResponse({});
		const snapshot = await fetchZaiQuota("key", { fetchImpl: empty, now });
		assert.deepEqual(snapshot.items, []);
	});
});
