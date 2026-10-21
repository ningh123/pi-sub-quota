/**
 * DeepSeek: prepaid pay-as-you-go balances, one item per currency (an
 * account can hold CNY and USD side by side), each split into topped-up and
 * granted parts so the views can show "¥12+¥1 $3" or rounded totals.
 */

import { fetchJson, hostMatchesApex, urlParts } from "./http.ts";
import type { FetchOptions, QuotaProvider, QuotaSnapshot } from "./types.ts";

const DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance";
const CURRENCY_SYMBOLS: Record<string, string> = { CNY: "¥", USD: "$" };
const DEEPSEEK_PROVIDER_IDS = new Set(["deepseek", "deepseek-cn"]);

interface DeepSeekBalanceInfo {
	currency?: string;
	total_balance?: string;
	granted_balance?: string;
	topped_up_balance?: string;
}
interface DeepSeekResponse {
	balance_infos?: DeepSeekBalanceInfo[];
}

function parseAmount(value: string | undefined): number {
	const n = typeof value === "string" ? Number(value) : Number.NaN;
	return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Fetch the DeepSeek prepaid balances, one item per currency: an account can
 * hold CNY and USD side by side, each split into topped-up and granted parts.
 */
export async function fetchDeepSeekBalance(apiKey: string, opts: FetchOptions = {}): Promise<QuotaSnapshot> {
	const body = (await fetchJson(DEEPSEEK_BALANCE_URL, apiKey, opts)) as DeepSeekResponse;
	const items = (Array.isArray(body?.balance_infos) ? body.balance_infos : [])
		.filter((info) => typeof info?.total_balance === "string")
		.map((info) => ({
			type: "balance" as const,
			// Unknown currencies fall back to their ISO code instead of a bare,
			// symbol-less number ("EUR2.50" beats "2.50").
			symbol: CURRENCY_SYMBOLS[info.currency ?? ""] ?? info.currency ?? "",
			total: parseAmount(info.total_balance),
			granted: parseAmount(info.granted_balance),
		}));
	if (items.length === 0) throw new Error("DeepSeek balance response had no balance_infos");
	return { kind: "deepseek", fetchedAt: (opts.now ?? Date.now)(), items };
}

export const deepseekProvider: QuotaProvider = {
	kind: "deepseek",
	planLabel: "pay as you go",
	matches(providerId, baseUrl) {
		if (providerId && DEEPSEEK_PROVIDER_IDS.has(providerId.toLowerCase())) return true;
		// Host must be deepseek.com or a subdomain — a substring check would also
		// catch deepseek.company.com and similar unrelated hosts.
		return hostMatchesApex(urlParts(baseUrl)?.host, ["deepseek.com"]);
	},
	fetchQuota: fetchDeepSeekBalance,
};
