/**
 * pi-sub-quota — subscription quota and prepaid balance inside pi's footer.
 *
 * When the active model belongs to a coding-plan provider (zai-coding-cn and
 * friends, DeepSeek, Kimi), the footer carries the quota, colored by usage
 * band. The display is alert-driven: quiet windows show only their
 * percentage, and a reset countdown appears only when a window runs hot
 * (usage ≥ 80% — you might hit the wall before it resets) or resets within
 * 30 minutes. Inline shape (default; the provider keeps its real id):
 *
 *   ↑12.3k ↓45k 38%/200k          (zai-coding-cn 13% 58%) glm-5.3 • max
 *   ↑12.3k ↓45k 38%/200k        (zai-coding-cn 96% 41m 58%) glm-5.3 • max
 *
 * Or as a dedicated line (mode "line") with full detail for every window:
 *
 *   ↑12.3k ↓45k 38%/200k                     (zai-coding-cn) glm-5.3 • max
 *   (Max) 5h ▓░░░░░░░░░ 13% 4h43m · 7d ▓▓▓▓▓▓▓▓░░ 77% 3d2h
 *
 * The custom footer is only installed when there is something to show: a
 * quota provider is active and a snapshot with at least one item exists.
 * With no data at all (missing API key, empty cache, failed fetch) — and in
 * off mode, or after switching to a provider without quota — the built-in
 * footer stays completely untouched. Snapshots are fetched at most every
 * five minutes, cached in `<agent-dir>/quota-cache.json`, and when a
 * refresh fails the last snapshot is kept with a warning `~` prefix until a
 * fetch succeeds again.
 *
 * Display modes (persisted in `<agent-dir>/quota-settings.json`):
 *   line     dedicated quota line under the stats with labeled meters and
 *            reset countdowns for every window
 *   inline   compact percentages in the provider prefix, countdowns only
 *            while alerting (default)
 *   off      restore the built-in footer entirely
 *
 * Commands:
 *   /quota             show quota for every configured provider
 *   /quota refresh     force a re-fetch for the active provider
 *   /quota mode line|inline|off  change display mode (persisted)
 *   /quota help        list options
 */

import { readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { emptyCache, freshSnapshot, isNewerCacheFile, parseCache, type QuotaCacheFile, serializeCache } from "./cache.ts";
import { createQuotaFooter } from "./footer.ts";
import { configuredQuotaProviders, detectProvider, type QuotaProvider, type QuotaSnapshot } from "./providers/index.ts";
import { DEFAULT_MODE, MODES, parseSettings, type QuotaMode, serializeSettings } from "./settings.ts";
import { formatQuota, formatQuotaPanel, type QuotaPanelRow } from "./view.ts";

const CACHE_TTL_MS = 300_000;
const TICK_MS = 60_000;
const FETCH_TIMEOUT_MS = 8000;

/** The model fields detection needs; structurally compatible with pi's Model. */
interface ActiveModel {
	provider?: string;
	baseUrl?: string;
}

let tickTimer: ReturnType<typeof setInterval> | undefined;
let activeProvider: QuotaProvider | undefined;
let activeProviderId: string | undefined;
/** Base URL of the active model's provider, passed to fetchers that support regional endpoints (Kimi). */
let activeBaseUrl: string | undefined;
let currentMode: QuotaMode | undefined;
let refreshing = false;
/** True when the shown snapshot predates a failed refresh. */
let stale = false;
let currentSnapshot: QuotaSnapshot | undefined;
let footerInstalled = false;
/** Context of the latest session/model event, used to (un)install the footer. */
let activeCtx: ExtensionContext | undefined;
/** Listeners notified whenever the snapshot, staleness, or mode changes (footer re-renders). */
const snapshotListeners = new Set<() => void>();

function publishSnapshot(): void {
	for (const listener of snapshotListeners) listener();
}

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

/** True when the auth entry is an OAuth credential whose access token has lapsed. */
function oauthExpired(entry: unknown): boolean {
	if (typeof entry !== "object" || entry === null) return false;
	const expires = (entry as { expires?: unknown }).expires;
	return typeof expires === "number" && expires <= Date.now() + 30_000;
}

/**
 * Read the credential for a provider from pi's auth.json: the OAuth access
 * token (`access`) for OAuth providers such as kimi-coding, the API `key`
 * otherwise. The file is re-read on every fetch so a token pi refreshed
 * mid-session is picked up on the next tick. A lapsed OAuth token counts as
 * no credential — pi only refreshes it when it calls the provider itself,
 * so requesting with it would be a guaranteed 401.
 */
async function readAuthKey(providerId: string | undefined): Promise<string | undefined> {
	try {
		const text = await readFile(join(agentDir(), "auth.json"), "utf8");
		const entry = providerId ? JSON.parse(text)?.[providerId] : undefined;
		if (typeof entry !== "object" || entry === null) return undefined;
		if (oauthExpired(entry)) return undefined;
		const key = entry.access ?? entry.key;
		return typeof key === "string" ? key : undefined;
	} catch {
		return undefined; // No auth.json or unreadable: environment keys may still work.
	}
}

async function readAuthFile(): Promise<Record<string, unknown> | undefined> {
	try {
		const text = await readFile(join(agentDir(), "auth.json"), "utf8");
		const parsed: unknown = JSON.parse(text);
		return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

async function readCacheFile(): Promise<QuotaCacheFile> {
	try {
		return parseCache(await readFile(join(agentDir(), "quota-cache.json"), "utf8"));
	} catch {
		return emptyCache();
	}
}

/** Display mode, persisted across sessions; read once, then cached in memory. */
async function loadMode(): Promise<QuotaMode> {
	if (currentMode) return currentMode;
	try {
		const text = await readFile(join(agentDir(), "quota-settings.json"), "utf8");
		currentMode = parseSettings(text).mode;
	} catch {
		currentMode = parseSettings(undefined).mode;
	}
	return currentMode;
}

async function saveMode(mode: QuotaMode): Promise<void> {
	currentMode = mode;
	try {
		await writeFile(join(agentDir(), "quota-settings.json"), serializeSettings({ mode }), "utf8");
	} catch {
		// Best effort: the in-memory mode still applies to this session.
	}
	publishSnapshot();
}

/** Read-modify-write with a rename, so concurrent pi sessions never read a torn file. */
async function writeCacheSnapshot(snapshot: QuotaSnapshot): Promise<void> {
	const path = join(agentDir(), "quota-cache.json");
	try {
		const text = await readFile(path, "utf8").catch(() => undefined);
		// A file written by a newer cache format owns the data; rewriting it as
		// this version would silently discard whatever that format stored.
		if (isNewerCacheFile(text)) return;
		const cache = parseCache(text);
		cache.snapshots[snapshot.kind] = snapshot;
		// A unique tmp name per writer: two sessions sharing one fixed tmp path
		// could interleave writes into the same file and rename a torn result.
		const tmp = `${path}.${process.pid}-${Math.random().toString(36).slice(2)}.tmp`;
		await writeFile(tmp, serializeCache(cache), "utf8");
		await rename(tmp, path);
	} catch {
		// Best effort: the cache only avoids a refetch, a failed write is harmless.
	}
}

async function fetchSnapshot(
	provider: QuotaProvider,
	providerId: string | undefined,
	baseUrl?: string,
): Promise<QuotaSnapshot | undefined> {
	// Credentials come exclusively from pi's auth.json: the same credential pi
	// itself runs the provider with, so a matched provider always has its key
	// and no environment fallback can pair a key with a foreign host.
	const apiKey = await readAuthKey(providerId);
	if (!apiKey) return undefined;
	return provider.fetchQuota(apiKey, { now: Date.now, timeoutMs: FETCH_TIMEOUT_MS, baseUrl });
}

async function refresh(force: boolean): Promise<QuotaSnapshot | undefined> {
	const provider = activeProvider;
	if (!provider || refreshing) return currentSnapshot;
	/** True when the model switched to another provider since this refresh started. */
	const switchedProvider = () => provider.kind !== activeProvider?.kind;
	refreshing = true;
	try {
		if (!force) {
			const cached = await readCacheFile().then((cache) => cache.snapshots[provider.kind]);
			if (!switchedProvider() && freshSnapshot(cached, Date.now(), CACHE_TTL_MS)) {
				currentSnapshot = cached;
				stale = false;
				await syncFooterInstall();
				publishSnapshot();
				return currentSnapshot;
			}
			// Show the last snapshot of any age while a refresh is in flight, so the
			// footer never waits on the network with nothing to display.
			if (!currentSnapshot && cached && !switchedProvider()) {
				currentSnapshot = cached;
				stale = true;
				await syncFooterInstall();
				publishSnapshot();
			}
		}
		let next: QuotaSnapshot | undefined;
		try {
			next = await fetchSnapshot(provider, activeProviderId, activeBaseUrl);
			if (next) await writeCacheSnapshot(next);
		} catch {
			// Expected while offline or on provider errors: keep showing the
			// last snapshot (marked stale below) instead of logging — pi shows
			// extension stderr to the user, and a dropped status fetch is not
			// an error worth interrupting anyone for.
		}
		// The model switched mid-fetch: the result belongs to the previous
		// provider and must never bleed into the new provider's prefix.
		if (next && switchedProvider()) next = undefined;
		if (next) {
			currentSnapshot = next;
			stale = false;
		} else if (!currentSnapshot && !switchedProvider()) {
			// No fresh data and nothing in memory: fall back to the last snapshot of any age.
			currentSnapshot = await readCacheFile().then((cache) => cache.snapshots[provider.kind]);
			stale = true;
		} else if (currentSnapshot) {
			// Keep showing the last snapshot, marked stale.
			stale = true;
		}
		await syncFooterInstall();
		publishSnapshot();
	} finally {
		refreshing = false;
	}
	// A model switch that arrived while this refresh was in flight left its
	// own sync() call a no-op behind the refreshing guard; catch up for the
	// new provider immediately instead of waiting for the next tick.
	if (activeProvider && activeProvider.kind !== provider.kind) void refresh(false).catch(() => {});
	return currentSnapshot;
}

function stopTimer(): void {
	if (tickTimer !== undefined) {
		clearInterval(tickTimer);
		tickTimer = undefined;
	}
}

function startTimer(): void {
	if (tickTimer !== undefined) return;
	// Refresh() reads the cache first, so the tick only hits the network
	// about once per TTL. Unref'd so the timer never keeps pi alive.
	tickTimer = setInterval(() => {
		// Swallow rejections: a status side channel must never surface an
		// unhandled-rejection crash if a refresh path throws unexpectedly.
		void refresh(false).catch(() => {});
	}, TICK_MS);
	tickTimer.unref?.();
}

function installFooter(): void {
	// pi's guidance for terminal-only UI: setFooter is a no-op outside TUI mode,
	// so never go through the install machinery there.
	if (footerInstalled || !activeCtx || activeCtx.mode !== "tui") return;
	activeCtx.ui.setFooter(
		createQuotaFooter(activeCtx, {
			getSnapshot: () => currentSnapshot,
			isStale: () => stale,
			getMode: () => currentMode ?? DEFAULT_MODE,
			onQuotaChange(callback) {
				snapshotListeners.add(callback);
				return () => snapshotListeners.delete(callback);
			},
		}),
	);
	footerInstalled = true;
}

function uninstallFooter(): void {
	if (!footerInstalled) return;
	activeCtx?.ui.setFooter(undefined);
	footerInstalled = false;
}

/**
 * Install the custom footer only while it has something to show — a quota
 * provider is active, the mode is not "off", and a snapshot of that same
 * provider with at least one item exists. With no data at all (missing API
 * key, empty cache, failed fetch) the built-in footer is left completely
 * untouched. Inline mode carries the quota inside the provider prefix;
 * line mode adds a dedicated line with every window in full detail.
 */
async function syncFooterInstall(): Promise<void> {
	const mode = await loadMode();
	if (
		!activeProvider ||
		mode === "off" ||
		!currentSnapshot ||
		// A snapshot of a different provider (a model switch raced a fetch) or
		// one without items must never install under the new provider's prefix.
		currentSnapshot.kind !== activeProvider.kind ||
		currentSnapshot.items.length === 0
	) {
		uninstallFooter();
	} else {
		installFooter();
	}
}

/**
 * Track the active model: clear the snapshot when the quota provider changes
 * (so another provider's numbers never bleed into the new prefix), then let
 * refresh() decide whether the custom footer should be installed.
 */
async function sync(ctx: ExtensionContext, model: ActiveModel | undefined): Promise<void> {
	activeCtx = ctx;
	const provider = detectProvider(model?.provider, model?.baseUrl);
	if (provider?.kind !== activeProvider?.kind) {
		currentSnapshot = undefined;
		stale = false;
	}
	activeProvider = provider;
	activeProviderId = model?.provider;
	activeBaseUrl = model?.baseUrl;
	const mode = await loadMode();
	// Outside TUI mode (RPC, JSON, print) there is no footer to replace, so
	// neither the tick timer nor the install machinery has anything to do.
	if (!provider || mode === "off" || ctx.mode !== "tui") {
		stopTimer();
		currentSnapshot = undefined;
		stale = false;
		uninstallFooter();
		return;
	}
	startTimer();
	void refresh(false).catch(() => {});
}

/** Load or fetch quota for every configured provider and render the panel. */
async function describeAllProviders(): Promise<string> {
	const authFile = await readAuthFile();
	const configured = configuredQuotaProviders(authFile);
	if (configured.length === 0) return "no quota providers configured";
	const cache = await readCacheFile();
	// Active provider first, the rest alphabetical by display label —
	// predictable and stable, independent of auth.json key order.
	const ordered = [...configured].sort((a, b) => {
		if (a.provider.kind === activeProvider?.kind) return -1;
		if (b.provider.kind === activeProvider?.kind) return 1;
		return a.providerId < b.providerId ? -1 : a.providerId > b.providerId ? 1 : 0;
	});
	const rows = await Promise.all(
		ordered.map(async (entry): Promise<QuotaPanelRow> => {
			const { provider } = entry;
			const row: QuotaPanelRow = {
				label: entry.providerId,
				planLabel: provider.planLabel,
				active: provider.kind === activeProvider?.kind,
			};
			const cached = cache.snapshots[provider.kind];
			let snapshot: QuotaSnapshot | undefined;
			let stale = false;
			let fetchError: string | undefined;
			if (freshSnapshot(cached, Date.now(), CACHE_TTL_MS)) {
				snapshot = cached;
			} else {
				try {
					snapshot = await fetchSnapshot(provider, entry.providerId);
				} catch (error) {
					// Keep the reason short: the panel is narrow, and the endpoint
					// is implied by the provider block it belongs to.
					fetchError = error instanceof Error ? error.message.replace(/ from \S+.*$/, "") : String(error);
				}
				if (snapshot) {
					await writeCacheSnapshot(snapshot);
				} else if (cached) {
					// Fetch failed: fall back to the cached snapshot of any age, marked stale.
					snapshot = cached;
					stale = true;
				}
			}
			const note = !snapshot
				? fetchError
					? `quota unavailable (${fetchError})`
					: oauthExpired(authFile?.[entry.providerId])
						? "oauth token expired; it refreshes the next time pi uses this provider"
						: undefined
				: undefined;
			return { ...row, planLevel: snapshot?.planLevel, snapshot, stale, note };
		}),
	);
	return `${formatQuotaPanel(rows, Date.now())}\n\n/quota refresh · /quota mode line|inline|off · /quota help`;
}

function describeSnapshot(snapshot: QuotaSnapshot | undefined): string {
	if (!snapshot) return "no quota data yet";
	const age = Math.max(0, Math.round((Date.now() - snapshot.fetchedAt) / 1000));
	const line = formatQuota(snapshot, Date.now()) || "(empty)";
	return `${stale ? "~" : ""}${line} — fetched ${age}s ago (${snapshot.kind})`;
}

/** Sub-command hints for /quota autocompletion. */
const SUBCOMMANDS: { value: string; label: string; description: string }[] = [
	{ value: "refresh", label: "refresh", description: "force a re-fetch for the active provider" },
	{ value: "mode", label: "mode", description: "switch display mode (line, inline, off)" },
	{ value: "help", label: "help", description: "show usage" },
];

/** Mode hints for /quota mode autocompletion. */
const MODE_DESCRIPTIONS: Record<QuotaMode, string> = {
	line: "dedicated line with labeled meters and reset countdowns for every window",
	inline: "compact percentages in the provider prefix, countdowns only while alerting (usage ≥ 80% or reset within 30m)",
	off: "restore the built-in footer",
};

export default function (pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		// pi resets extension UI (including the footer) on every session
		// invalidation — /new, /fork, /resume in the same cwd — without telling
		// extensions, and this module instance is reused for those. Forget the
		// installed flag so sync() can reinstall the footer for the new session.
		footerInstalled = false;
		await sync(ctx, ctx.model);
	});
	pi.on("model_select", async (event, ctx) => {
		await sync(ctx, event.model);
	});
	pi.on("session_shutdown", () => {
		// The runtime is about to be torn down (quit, /reload, session
		// replacement): stop the tick timer so a reused module instance never
		// accumulates live timers and never touches a dead context afterwards.
		stopTimer();
		uninstallFooter();
	});

	pi.registerCommand("quota", {
		description: "Show coding-plan quota for every configured provider",
		getArgumentCompletions: (prefix) => {
			if (prefix.startsWith("mode")) {
				const modePrefix = prefix.slice(4).trim();
				return MODES.filter((mode) => mode.startsWith(modePrefix)).map((mode) => ({
					value: `mode ${mode}`,
					label: mode,
					description: MODE_DESCRIPTIONS[mode],
				}));
			}
			return SUBCOMMANDS.filter((sub) => sub.value.startsWith(prefix)).map((sub) => ({
				value: sub.value,
				label: sub.label,
				description: sub.description,
			}));
		},
		handler: async (args, ctx) => {
			const [sub, arg] = args.trim().toLowerCase().split(/\s+/);
			if (sub === "refresh") {
				if (refreshing) {
					ctx.ui.notify("Quota: a refresh is already in progress", "info");
					return;
				}
				const snapshot = await refresh(true);
				ctx.ui.notify(
					snapshot ? `Quota refreshed: ${describeSnapshot(snapshot)}` : "Quota: nothing to refresh",
					snapshot ? "info" : "warning",
				);
				return;
			}
			if (sub === "mode") {
				if ((MODES as readonly string[]).includes(arg)) {
					await saveMode(arg as QuotaMode);
					await sync(ctx, ctx.model);
					ctx.ui.notify(`Quota display mode: ${arg}`, "info");
				} else {
					ctx.ui.notify(`Usage: /quota mode line|inline|off (current: ${await loadMode()})`, "info");
				}
				return;
			}
			if (sub === "help") {
				const mode = await loadMode();
				const state =
					mode === "off"
						? "mode off"
						: activeProvider
							? `mode ${mode}, active (${activeProvider.kind})`
							: `mode ${mode}, inactive (no quota provider)`;
				ctx.ui.notify(
					`/quota — quota in the footer, currently ${state}. Usage: /quota [refresh|mode line|inline|off|help]`,
					"info",
				);
				return;
			}
			// No argument (or anything unrecognized): show every configured provider.
			ctx.ui.notify(await describeAllProviders(), "info");
		},
	});
}
