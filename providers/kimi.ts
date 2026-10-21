/**
 * Kimi coding plans: `GET <base>/usages` returns the weekly request quota
 * (top-level `usage`, whose limit maps to the membership tier) plus shorter
 * windows in `limits[]`, such as the 5-hour rate limit. Works with an API
 * key or the OAuth access token pi stores for kimi-coding; `opts.baseUrl`
 * overrides the regional endpoint (api.kimi.com vs api.kimi.ai) for custom
 * providers. Endpoint details follow CodexBar's documented API.
 */

import { clampPercent, fetchJson, hostMatchesApex, urlParts } from "./http.ts";
import type { FetchOptions, QuotaProvider, QuotaSnapshot, QuotaWindow } from "./types.ts";

const KIMI_USAGE_URL = "https://api.kimi.com/coding/v1/usages";
/** Kimi membership tiers keyed by weekly request limit (per CodexBar docs). */
const KIMI_TIERS: Record<string, string> = { "1024": "andante", "2048": "moderato", "7168": "allegretto" };
const KIMI_PROVIDER_IDS = new Set(["kimi-coding", "kimi"]);

/** One Kimi usage pool: string-encoded counts and an ISO reset timestamp. */
interface KimiUsagePool {
	limit?: string;
	used?: string;
	remaining?: string;
	resetTime?: string;
}
interface KimiUsagesResponse {
	usage?: KimiUsagePool;
	limits?: { window?: { duration?: number; timeUnit?: string }; detail?: KimiUsagePool }[];
}

function kimiPercent(pool: KimiUsagePool): number {
	const limit = Number(pool.limit);
	const used = Number(pool.used);
	if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(used) || used < 0) return 0;
	return clampPercent((used / limit) * 100);
}

function kimiResetMs(pool: KimiUsagePool): number | undefined {
	if (typeof pool.resetTime !== "string") return undefined;
	// Kimi timestamps carry nanosecond precision; Date.parse keeps the ms part.
	const ms = Date.parse(pool.resetTime);
	return Number.isFinite(ms) ? ms : undefined;
}

/** Window duration in minutes; undefined for unknown time units (absent unit defaults to minutes). */
function kimiDurationMinutes(window: { duration?: number; timeUnit?: string } | undefined): number | undefined {
	const duration = window?.duration;
	if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) return undefined;
	const unit = (window?.timeUnit ?? "TIME_UNIT_MINUTE").toUpperCase();
	if (unit.endsWith("MINUTE")) return duration;
	if (unit.endsWith("HOUR")) return duration * 60;
	if (unit.endsWith("DAY")) return duration * 1440;
	return undefined;
}

function kimiWindowLabel(minutes: number): string {
	if (minutes >= 1440) return `${Math.round(minutes / 1440)}d`;
	return `${Math.round(minutes / 60)}h`;
}

/** Build the usages URL from a custom base, ignoring any query or fragment. */
function kimiUsagesUrl(baseUrl: string): string {
	try {
		const url = new URL(baseUrl);
		url.search = "";
		url.hash = "";
		url.pathname = `${url.pathname.replace(/\/+$/, "")}/usages`;
		return url.toString();
	} catch {
		throw new Error("Kimi quota fetch failed: invalid baseUrl");
	}
}

/** Fetch Kimi coding-plan usage: weekly quota plus rate-limit windows. */
export async function fetchKimiQuota(apiKey: string, opts: FetchOptions = {}): Promise<QuotaSnapshot> {
	const url = opts.baseUrl ? kimiUsagesUrl(opts.baseUrl) : KIMI_USAGE_URL;
	const body = (await fetchJson(url, apiKey, opts)) as KimiUsagesResponse;
	const toWindow = (pool: KimiUsagePool, label: string, durationMs: number): QuotaWindow => ({
		type: "window",
		resource: "tokens",
		label,
		usedPercent: kimiPercent(pool),
		resetAt: kimiResetMs(pool),
		durationMs,
	});
	const windows: QuotaWindow[] = [];
	const weekly = body?.usage;
	const weeklyLimit = Number(weekly?.limit);
	if (Number.isFinite(weeklyLimit) && weeklyLimit > 0) windows.push(toWindow(weekly ?? {}, "7d", 7 * 24 * 3_600_000));
	for (const entry of Array.isArray(body?.limits) ? body.limits : []) {
		const minutes = kimiDurationMinutes(entry?.window);
		if (minutes === undefined || !entry?.detail) continue;
		windows.push(toWindow(entry.detail, kimiWindowLabel(minutes), minutes * 60_000));
	}
	if (windows.length === 0) throw new Error("Kimi usage response had no usage windows");
	// Shortest window first: the 5-hour rate limit always reads before the weekly
	// quota, even when the weekly reset happens to come sooner.
	windows.sort((a, b) => (a.durationMs ?? Number.MAX_SAFE_INTEGER) - (b.durationMs ?? Number.MAX_SAFE_INTEGER));
	return {
		kind: "kimi",
		fetchedAt: (opts.now ?? Date.now)(),
		items: windows,
		planLevel: KIMI_TIERS[String(weeklyLimit)],
	};
}

export const kimiProvider: QuotaProvider = {
	kind: "kimi",
	planLabel: "coding plan",
	matches(providerId, baseUrl) {
		if (providerId && KIMI_PROVIDER_IDS.has(providerId.toLowerCase())) return true;
		// Host must be kimi.com / kimi.ai (or a subdomain) with a /coding path.
		// Substring matching would also catch hosts like kimi.company.com and
		// send the env-resolved Kimi key to an unrelated server.
		const parts = urlParts(baseUrl);
		if (!parts) return false;
		return hostMatchesApex(parts.host, ["kimi.com", "kimi.ai"]) && parts.path.includes("coding");
	},
	fetchQuota: fetchKimiQuota,
};
