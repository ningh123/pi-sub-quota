/**
 * ZAI / GLM coding plans: token-usage windows (5h / 7d) from the account
 * monitor endpoint, plus the MCP/tool-call quota (TIME_LIMIT entries) with
 * its per-tool usage breakdown.
 */

import { clampPercent, fetchJson, hostMatchesApex, urlParts } from "./http.ts";
import type { FetchOptions, QuotaProvider, QuotaSnapshot, QuotaWindow } from "./types.ts";

const ZAI_QUOTA_URL = "https://bigmodel.cn/api/monitor/usage/quota/limit";
/** Window labels by the API's `unit` enum: 3 = 5-hour window, 6 = 7-day window. */
const ZAI_WINDOW_LABELS: Record<number, string> = { 3: "5h", 6: "7d" };
/** Window lengths by the API's `unit` enum; ordering is duration-based, not reset-based. */
const ZAI_WINDOW_DURATIONS: Record<number, number> = { 3: 5 * 3_600_000, 6: 7 * 24 * 3_600_000 };
const ZAI_PROVIDER_IDS = new Set([
	"zai-coding-cn",
	"zai-coding",
	"zai",
	"glm-coding",
	"glm-coding-cn",
	"bigmodel",
	"bigmodel-coding",
	"bigmodel-cn",
]);

interface ZaiLimit {
	type?: string;
	unit?: number;
	percentage?: number;
	nextResetTime?: number;
	/** TIME_LIMIT entries: per-tool call counts inside the MCP quota cycle. */
	usageDetails?: { modelCode?: string; usage?: number }[];
}
interface ZaiResponse {
	data?: {
		limits?: ZaiLimit[];
		/** Subscription tier: "lite", "pro", "max", ... */
		level?: string;
	};
}

/**
 * Fetch ZAI / GLM coding-plan quota. TOKENS_LIMIT entries become the token
 * windows (5h / 7d); TIME_LIMIT entries are the MCP/tool-call quota, a
 * separate resource with its own cycle, and carry the per-tool breakdown.
 */
export async function fetchZaiQuota(apiKey: string, opts: FetchOptions = {}): Promise<QuotaSnapshot> {
	const body = (await fetchJson(ZAI_QUOTA_URL, apiKey, opts)) as ZaiResponse;
	const limits = Array.isArray(body?.data?.limits) ? body.data.limits : [];
	const planLevel = typeof body?.data?.level === "string" ? body.data.level : undefined;
	const toWindow = (limit: ZaiLimit, resource: QuotaWindow["resource"], label: string, durationMs?: number): QuotaWindow => ({
		type: "window",
		resource,
		label,
		usedPercent: clampPercent(limit.percentage),
		// JSON.parse keeps 1e999 as Infinity, which is a number but not a usable time.
		resetAt: typeof limit.nextResetTime === "number" && Number.isFinite(limit.nextResetTime) ? limit.nextResetTime : undefined,
		durationMs,
		tools:
			resource === "mcp" && Array.isArray(limit.usageDetails)
				? limit.usageDetails.flatMap((detail) =>
						typeof detail?.modelCode === "string" && typeof detail?.usage === "number" && Number.isFinite(detail.usage)
							? [{ modelCode: detail.modelCode, usage: detail.usage }]
							: [],
					)
				: undefined,
	});
	const byDuration = (a: QuotaWindow, b: QuotaWindow) =>
		(a.durationMs ?? Number.MAX_SAFE_INTEGER) - (b.durationMs ?? Number.MAX_SAFE_INTEGER);
	const tokenWindows = limits
		.filter((limit) => limit?.type === "TOKENS_LIMIT")
		.map((limit) =>
			toWindow(
				limit,
				"tokens",
				ZAI_WINDOW_LABELS[limit.unit ?? -1] ?? `u${limit.unit ?? "?"}`,
				ZAI_WINDOW_DURATIONS[limit.unit ?? -1],
			),
		)
		.sort(byDuration);
	const mcpWindows = limits
		.filter((limit) => limit?.type === "TIME_LIMIT")
		.map((limit) => toWindow(limit, "mcp", "mcp"))
		.sort(byDuration);
	return {
		kind: "zai",
		fetchedAt: (opts.now ?? Date.now)(),
		items: [...tokenWindows, ...mcpWindows],
		planLevel,
	};
}

export const zaiProvider: QuotaProvider = {
	kind: "zai",
	planLabel: "coding plan",
	matches(providerId, baseUrl) {
		if (providerId && ZAI_PROVIDER_IDS.has(providerId.toLowerCase())) return true;
		// Host must be bigmodel.cn / z.ai (or a subdomain); z.ai additionally needs
		// a /coding path. Substring matching would also catch hosts like
		// bigmodel.cn.example.org, sending that provider's key to the real ZAI endpoint.
		const parts = urlParts(baseUrl);
		if (!parts) return false;
		return (
			hostMatchesApex(parts.host, ["bigmodel.cn"]) || (hostMatchesApex(parts.host, ["z.ai"]) && parts.path.includes("coding"))
		);
	},
	fetchQuota: fetchZaiQuota,
};
