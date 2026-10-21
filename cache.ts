/**
 * Disk cache for quota snapshots, one file shared by all providers and keyed
 * by provider kind. Parsing and validation are pure so they can be tested;
 * file I/O lives in the extension entry.
 */

import { type McpToolUsage, PROVIDER_KINDS, type ProviderKind, type QuotaItem, type QuotaSnapshot } from "./providers/index.ts";

export const CACHE_VERSION = 2;

export interface QuotaCacheFile {
	version: number;
	snapshots: Partial<Record<ProviderKind, QuotaSnapshot>>;
	/**
	 * Last fetch attempt per provider, in ms epoch. Persisted — not kept in
	 * memory — so every pi session on the machine shares one rate limit and a
	 * failing endpoint is retried at most once per interval machine-wide.
	 */
	lastRequests?: Partial<Record<ProviderKind, number>>;
}

export function emptyCache(): QuotaCacheFile {
	return { version: CACHE_VERSION, snapshots: {} };
}

/** Per-tool usage rows must all carry a string code and a finite count. */
function isValidTools(value: unknown): value is McpToolUsage[] {
	return (
		Array.isArray(value) &&
		value.every(
			(tool) =>
				typeof tool === "object" &&
				tool !== null &&
				typeof (tool as McpToolUsage).modelCode === "string" &&
				typeof (tool as McpToolUsage).usage === "number" &&
				Number.isFinite((tool as McpToolUsage).usage),
		)
	);
}

function isValidItem(value: unknown): boolean {
	if (typeof value !== "object" || value === null) return false;
	const item = value as Partial<QuotaItem> & { type?: unknown };
	if (item.type === "window") {
		return (
			typeof item.label === "string" &&
			(item.resource === "tokens" || item.resource === "mcp") &&
			typeof item.usedPercent === "number" &&
			Number.isFinite(item.usedPercent) &&
			(item.resetAt === undefined || (typeof item.resetAt === "number" && Number.isFinite(item.resetAt))) &&
			(item.durationMs === undefined || (typeof item.durationMs === "number" && Number.isFinite(item.durationMs))) &&
			(item.tools === undefined || isValidTools(item.tools))
		);
	}
	if (item.type === "balance") {
		return (
			typeof item.symbol === "string" &&
			typeof item.total === "number" &&
			Number.isFinite(item.total) &&
			typeof item.granted === "number" &&
			Number.isFinite(item.granted)
		);
	}
	return false;
}

function isValidSnapshot(value: unknown): value is QuotaSnapshot {
	if (typeof value !== "object" || value === null) return false;
	const snap = value as Partial<QuotaSnapshot>;
	return (
		typeof snap.kind === "string" &&
		(PROVIDER_KINDS as readonly string[]).includes(snap.kind) &&
		typeof snap.fetchedAt === "number" &&
		Number.isFinite(snap.fetchedAt) &&
		(snap.planLevel === undefined || typeof snap.planLevel === "string") &&
		Array.isArray(snap.items) &&
		// Item-level corruption must not reach the renderers: a hand-edited or
		// foreign-written cache file is user-visible, and view code trusts item
		// shapes (calls .map/.charAt/.padEnd on their fields).
		snap.items.every(isValidItem)
	);
}

/**
 * Parse cache file text. Tolerates a missing file, invalid JSON, or an
 * unexpected shape by returning an empty cache instead of throwing.
 */
export function parseCache(text: string | undefined): QuotaCacheFile {
	if (!text) return emptyCache();
	try {
		const raw: unknown = JSON.parse(text);
		if (typeof raw !== "object" || raw === null) return emptyCache();
		const file = raw as { version?: unknown; snapshots?: unknown; lastRequests?: unknown };
		if (file.version !== CACHE_VERSION || typeof file.snapshots !== "object" || file.snapshots === null) {
			return emptyCache();
		}
		const snapshots: Partial<Record<ProviderKind, QuotaSnapshot>> = {};
		for (const [kind, snapshot] of Object.entries(file.snapshots)) {
			if ((PROVIDER_KINDS as readonly string[]).includes(kind) && isValidSnapshot(snapshot)) {
				snapshots[kind as ProviderKind] = snapshot;
			}
		}
		// Attempt times drive the request rate limit; an invalid entry simply
		// does not limit — it must never block parsing of the snapshots.
		const lastRequests: Partial<Record<ProviderKind, number>> = {};
		if (typeof file.lastRequests === "object" && file.lastRequests !== null) {
			for (const [kind, at] of Object.entries(file.lastRequests)) {
				if ((PROVIDER_KINDS as readonly string[]).includes(kind) && typeof at === "number" && Number.isFinite(at)) {
					lastRequests[kind as ProviderKind] = at;
				}
			}
		}
		const cache: QuotaCacheFile = { version: CACHE_VERSION, snapshots };
		if (Object.keys(lastRequests).length > 0) cache.lastRequests = lastRequests;
		return cache;
	} catch {
		return emptyCache();
	}
}

export function serializeCache(cache: QuotaCacheFile): string {
	return `${JSON.stringify(cache, null, "\t")}\n`;
}

/**
 * True when the text is a cache file written by a newer format. Such a file
 * owns the data on disk: rewriting it as this version would silently discard
 * whatever that format stored, so writers must leave it alone.
 */
export function isNewerCacheFile(text: string | undefined): boolean {
	if (!text) return false;
	try {
		const raw: unknown = JSON.parse(text);
		if (typeof raw !== "object" || raw === null) return false;
		const version = (raw as { version?: unknown }).version;
		return typeof version === "number" && Number.isFinite(version) && version > CACHE_VERSION;
	} catch {
		return false;
	}
}

/** True when the snapshot was fetched within the TTL window. */
export function freshSnapshot(snapshot: QuotaSnapshot | undefined, now: number, ttlMs: number): snapshot is QuotaSnapshot {
	return snapshot !== undefined && now - snapshot.fetchedAt < ttlMs;
}

/** True when a request may be sent: none was recorded, or the minimum interval since the last attempt has passed. */
export function requestDue(lastRequestAt: number | undefined, now: number, minIntervalMs: number): boolean {
	return lastRequestAt === undefined || now - lastRequestAt >= minIntervalMs;
}
