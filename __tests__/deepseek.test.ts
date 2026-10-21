import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { fetchDeepSeekBalance } from "../providers/index.ts";
import { jsonResponse } from "./helpers.ts";

describe("fetchDeepSeekBalance", () => {
	it("splits the balance into topped-up and granted parts with its currency symbol", async () => {
		const fetchImpl = async () =>
			jsonResponse({
				is_available: true,
				balance_infos: [{ currency: "CNY", total_balance: "19.67", granted_balance: "1.00", topped_up_balance: "18.67" }],
			});
		const snapshot = await fetchDeepSeekBalance("key", { fetchImpl, now: () => 42 });
		assert.equal(snapshot.kind, "deepseek");
		assert.equal(snapshot.fetchedAt, 42);
		assert.deepEqual(snapshot.items, [{ type: "balance", symbol: "¥", total: 19.67, granted: 1 }]);
	});

	it("keeps every currency when CNY and USD balances coexist", async () => {
		const both = async () =>
			jsonResponse({
				balance_infos: [
					{ currency: "CNY", total_balance: "19.67", granted_balance: "1.00", topped_up_balance: "18.67" },
					{ currency: "USD", total_balance: "2.50" },
				],
			});
		const snapshot = await fetchDeepSeekBalance("key", { fetchImpl: both, now: () => 42 });
		assert.deepEqual(snapshot.items, [
			{ type: "balance", symbol: "¥", total: 19.67, granted: 1 },
			{ type: "balance", symbol: "$", total: 2.5, granted: 0 },
		]);
	});

	it("treats a non-array balance_infos as no balances", async () => {
		const bogus = async () => jsonResponse({ balance_infos: { currency: "CNY" } });
		await assert.rejects(() => fetchDeepSeekBalance("key", { fetchImpl: bogus }), /balance_infos/);
	});

	it("supports USD, tolerates a missing granted part, and falls back to the ISO code for unknown currencies", async () => {
		const usd = async () => jsonResponse({ balance_infos: [{ currency: "USD", total_balance: "2.50" }] });
		assert.deepEqual(await fetchDeepSeekBalance("key", { fetchImpl: usd }).then((s) => s.items), [
			{ type: "balance", symbol: "$", total: 2.5, granted: 0 },
		]);

		const eur = async () => jsonResponse({ balance_infos: [{ currency: "EUR", total_balance: "2.50" }] });
		assert.deepEqual(await fetchDeepSeekBalance("key", { fetchImpl: eur, now: () => 1 }).then((s) => s.items), [
			{ type: "balance", symbol: "EUR", total: 2.5, granted: 0 },
		]);

		const unusable = async () => jsonResponse({ balance_infos: [{ currency: "CNY" }] });
		await assert.rejects(() => fetchDeepSeekBalance("key", { fetchImpl: unusable }), /balance_infos/);

		const empty = async () => jsonResponse({ balance_infos: [] });
		await assert.rejects(() => fetchDeepSeekBalance("key", { fetchImpl: empty }), /balance_infos/);
	});
});
