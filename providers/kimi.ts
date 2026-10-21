/**
 * Kimi coding plans: `GET <base>/usages` returns the weekly request quota
 * (top-level `usage`) plus shorter windows in `limits[]`, such as the 5-hour
 * rate limit. `GET <base>/me` reports the account's membership tier
 * (`user_level_name`); the legacy limit→tier map only backs it up when that
 * endpoint is unavailable (e.g. API-key auth without account scope).
 * Works with an API key or the OAuth access token pi stores for kimi-coding;
 * `opts.baseUrl` overrides the regional endpoint (api.kimi.com vs api.kimi.ai)
 * for custom providers. Endpoint details follow CodexBar's documented API.
 */

import { clampPercent, fetchJson, hostMatchesApex, urlParts } from "./http.ts";
import type { FetchOptions, QuotaBalance, QuotaProvider, QuotaSnapshot, QuotaWindow } from "./types.ts";

const KIMI_USAGE_URL = "https://api.kimi.com/coding/v1/usages";
const KIMI_ME_URL = "https://api.kimi.com/coding/v1/me";
/** Legacy membership tiers keyed by weekly request limit (per CodexBar docs); newer plans report other limits, so `/me` is the source of truth. */
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
	/** Ratio-based pools: fraction used + ISO reset, repeating 5h/7d and adding the monthly quota. */
	usages?: KimiRatioPools;
	/** Pay-as-you-go overage wallet; absent until the account activates it. */
	booster_wallet?: KimiBoosterWallet;
}

interface KimiRatioPool {
	used_ratio?: number | string;
	reset_time?: string;
}
interface KimiRatioPools {
	limit_5h?: KimiRatioPool;
	limit_7d?: KimiRatioPool;
	/** The plan's 30-day quota; `limit_month_code` (the coding share of it) is a breakdown detail, not a window. */
	limit_month_total?: KimiRatioPool;
}

/** Money amount as documented by Kimi's own CLI: cents in `priceInCents`. */
interface KimiMoney {
	currency?: string;
	priceInCents?: string;
}
interface KimiBoosterBalance {
	type?: string;
	amount?: string | number;
	amountLeft?: string | number;
}
interface KimiBoosterWallet {
	balance?: KimiBoosterBalance;
	monthlyChargeLimit?: KimiMoney;
	monthlyUsed?: KimiMoney;
}

function kimiPercent(pool: KimiUsagePool): number {
	const limit = Number(pool.limit);
	if (!Number.isFinite(limit) || limit <= 0) return 0;
	// Newer plans omit `used` and report `remaining` instead.
	const used = pool.used !== undefined ? Number(pool.used) : limit - Number(pool.remaining);
	if (!Number.isFinite(used) || used < 0) return 0;
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

/**
 * The `usages` ratio pools, keyed with their window length in minutes
 * (monthly ≈ 30d for ordering). Entries the backend omits are skipped.
 */
const KIMI_RATIO_POOLS: { key: keyof KimiRatioPools; minutes: number }[] = [
	{ key: "limit_5h", minutes: 300 },
	{ key: "limit_7d", minutes: 10_080 },
	{ key: "limit_month_total", minutes: 43_200 },
];

/** A ratio pool as a window; undefined when its ratio is missing or invalid. */
function kimiRatioWindow(pool: KimiRatioPool | undefined, minutes: number): QuotaWindow | undefined {
	if (!pool) return undefined;
	const ratio = Number(pool.used_ratio);
	if (!Number.isFinite(ratio) || ratio < 0) return undefined;
	const resetMs = typeof pool.reset_time === "string" ? Date.parse(pool.reset_time) : Number.NaN;
	return {
		type: "window",
		resource: "tokens",
		label: kimiWindowLabel(minutes),
		usedPercent: clampPercent(ratio * 100),
		resetAt: Number.isFinite(resetMs) ? resetMs : undefined,
		durationMs: minutes * 60_000,
	};
}

/** Build an endpoint URL from a custom base, ignoring any query or fragment. */
function kimiUrl(baseUrl: string | undefined, suffix: string, fallback: string): string {
	if (!baseUrl) return fallback;
	try {
		const url = new URL(baseUrl);
		url.search = "";
		url.hash = "";
		url.pathname = `${url.pathname.replace(/\/+$/, "")}${suffix}`;
		return url.toString();
	} catch {
		throw new Error("Kimi quota fetch failed: invalid baseUrl");
	}
}

interface KimiMeResponse {
	user_level_name?: string;
}

/** Membership tier name from the account endpoint; undefined when absent or malformed. */
function kimiPlanLevel(body: unknown): string | undefined {
	if (typeof body !== "object" || body === null) return undefined;
	const name = (body as KimiMeResponse).user_level_name;
	return typeof name === "string" && name.trim() !== "" ? name : undefined;
}

/** Booster amounts are fixed-point: value / 1e6 = cents (per Kimi's CLI). */
const KIMI_BOOSTER_SCALE = 1_000_000;

/** Positive fixed-point amount to cents; undefined for missing, invalid, or empty values. */
function kimiBoosterCents(value: string | number | undefined): number | undefined {
	const n = Number(value);
	return Number.isFinite(n) && n > 0 ? Math.round(n / KIMI_BOOSTER_SCALE) : undefined;
}

/**
 * The booster wallet as a balance item, mirroring Kimi's CLI: only a
 * BOOSTER-typed balance with a positive top-up exists — an inactive wallet
 * (no `amount`) has nothing to show. `total` is what is left to spend;
 * `toppedUp` keeps the original amount for context ("¥5.00/¥20.00").
 */
function kimiBoosterBalance(wallet: KimiBoosterWallet | undefined): QuotaBalance | undefined {
	const balance = wallet?.balance;
	if (balance?.type !== "BOOSTER") return undefined;
	const toppedUpCents = kimiBoosterCents(balance.amount);
	if (toppedUpCents === undefined) return undefined;
	const currency = wallet?.monthlyChargeLimit?.currency ?? wallet?.monthlyUsed?.currency;
	const symbol = currency === "USD" ? "$" : currency === "CNY" || currency === undefined ? "¥" : currency;
	return {
		type: "balance",
		symbol,
		total: (kimiBoosterCents(balance.amountLeft) ?? 0) / 100,
		granted: 0,
		toppedUp: toppedUpCents / 100,
		label: "booster",
	};
}

/** Fetch Kimi coding-plan usage: weekly quota plus rate-limit windows. */
export async function fetchKimiQuota(apiKey: string, opts: FetchOptions = {}): Promise<QuotaSnapshot> {
	const url = kimiUrl(opts.baseUrl, "/usages", KIMI_USAGE_URL);
	// The account call runs alongside the usage call; failing it (auth without
	// account scope, transient 5xx) only drops the tier name, never the windows.
	const meBody = fetchJson(kimiUrl(opts.baseUrl, "/me", KIMI_ME_URL), apiKey, opts)
		.then(kimiPlanLevel)
		.catch(() => undefined);
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
	// Ratio pools only fill durations the count-based windows did not cover:
	// 5h/7d repeat there with exact counts, so in practice this adds the
	// monthly quota on plans that have one.
	for (const { key, minutes } of KIMI_RATIO_POOLS) {
		if (windows.some((window) => window.durationMs === minutes * 60_000)) continue;
		const window = kimiRatioWindow(body?.usages?.[key], minutes);
		if (window) windows.push(window);
	}
	if (windows.length === 0) throw new Error("Kimi usage response had no usage windows");
	// Shortest window first: the 5-hour rate limit always reads before the weekly
	// quota, even when the weekly reset happens to come sooner.
	windows.sort((a, b) => (a.durationMs ?? Number.MAX_SAFE_INTEGER) - (b.durationMs ?? Number.MAX_SAFE_INTEGER));
	const booster = kimiBoosterBalance(body?.booster_wallet);
	return {
		kind: "kimi",
		fetchedAt: (opts.now ?? Date.now)(),
		items: booster ? [...windows, booster] : windows,
		planLevel: (await meBody) ?? KIMI_TIERS[String(weeklyLimit)],
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
