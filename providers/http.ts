/**
 * Shared HTTP helpers for quota fetchers: bearer-auth JSON GET with an
 * abort-based timeout, defensive percent clamping, and safe base-URL
 * parsing for host-based provider detection.
 */

import type { FetchOptions } from "./types.ts";

export async function fetchJson(url: string, apiKey: string, opts: FetchOptions): Promise<unknown> {
	const doFetch = opts.fetchImpl ?? fetch;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 8000);
	try {
		const res = await doFetch(url, {
			headers: { Authorization: `Bearer ${apiKey}` },
			signal: controller.signal,
		});
		if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
		try {
			return await res.json();
		} catch {
			// A 200 with a non-JSON body (portal redirects do this) would otherwise
			// surface a parser message quoting raw response text in the /quota panel.
			throw new Error("invalid JSON response from quota endpoint");
		}
	} finally {
		clearTimeout(timeout);
	}
}

/** Round into 0-100, treating non-finite input as 0. */
export function clampPercent(value: unknown): number {
	const n = typeof value === "number" && Number.isFinite(value) ? value : 0;
	return Math.min(100, Math.max(0, Math.round(n)));
}

/** Lowercased host and path of a base URL, or undefined when it does not parse. */
export function urlParts(baseUrl: string | undefined): { host: string; path: string } | undefined {
	if (!baseUrl) return undefined;
	try {
		const url = new URL(baseUrl);
		return { host: url.hostname.toLowerCase(), path: url.pathname.toLowerCase() };
	} catch {
		return undefined;
	}
}

/** True when the host is exactly one of the apex domains or a subdomain of one. */
export function hostMatchesApex(host: string | undefined, apexes: readonly string[]): boolean {
	return host !== undefined && apexes.some((apex) => host === apex || host.endsWith(`.${apex}`));
}
