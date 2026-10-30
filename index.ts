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
 * footer stays completely untouched. Snapshots live in
 * `<agent-dir>/quota-cache.json` with a five-minute TTL, shared (and
 * written atomically) by every pi session on the machine.
 *
 * Fetches never run on a wall clock; they happen on demand and on activity:
 *   - `/quota` renders every configured provider from cache instantly —
 *     stale snapshots keep their numbers behind a `~` — then refreshes the
 *     stale ones in the background and re-renders once when data landed;
 *   - `/quota refresh` force-refreshes the active provider;
 *   - agent runs (`agent_start` / `agent_end`), every completed assistant
 *     turn (`message_end` — a long task burns quota turn after turn, and
 *     its boundaries alone would leave the footer stale for the whole
 *     run), and model switches refresh the active provider, TTL-gated —
 *     an idle session, mode off, and non-TUI sessions (RPC, JSON, print)
 *     send no requests at all;
 *   - subagent runs refresh it through the same gate, because they are the
 *     one kind of work this session's own events never see: a foreground
 *     pi-subagents child holds the turn open inside its `subagent` tool
 *     call, and a background child leaves the parent idle, while both burn
 *     the same account. Child progress arrives as `tool_execution_update`s
 *     of the `subagent` tool call and as the `subagent:child-status` /
 *     `subagent:jobs-changed` events pi-subagents emits on pi's shared
 *     event bus; without pi-subagents installed those simply never fire.
 * Each provider endpoint is asked at most once per minute machine-wide:
 * every attempt, successful or not, persists `lastRequests` in the cache
 * file before the request starts, so concurrent sessions and failing
 * endpoints keep their distance too (a failed request earns one immediate
 * retry inside its cycle). When a refresh fails, the last snapshot is kept
 * with a warning `~` prefix, and the failure itself is explained inside the
 * /quota panel — never as an interrupting notification.
 *
 * Display modes (persisted in `<agent-dir>/quota-settings.json`):
 *   line     dedicated quota line under the stats with labeled meters and
 *            reset countdowns for every window
 *   inline   compact percentages in the provider prefix, countdowns only
 *            while alerting (default)
 *   off      restore the built-in footer entirely
 *
 * Commands:
 *   /quota             cached quota for every configured provider, instantly;
 *                     refreshed in the background and re-rendered when done
 *   /quota refresh     force a re-fetch for the active provider (once per minute at most)
 *   /quota mode line|inline|off  change display mode (persisted)
 *   /quota help        list options
 */

import { readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
	emptyCache,
	freshSnapshot,
	isNewerCacheFile,
	parseCache,
	type QuotaCacheFile,
	requestDue,
	serializeCache,
} from "./cache.ts";
import { createQuotaFooter } from "./footer.ts";
import {
	type ConfiguredQuotaProvider,
	configuredQuotaProviders,
	detectProvider,
	type ProviderKind,
	type QuotaProvider,
	type QuotaSnapshot,
} from "./providers/index.ts";
import { DEFAULT_MODE, MODES, parseSettings, type QuotaMode, serializeSettings } from "./settings.ts";
import { formatQuota, formatQuotaPanel, type QuotaPanelRow } from "./view.ts";

const CACHE_TTL_MS = 300_000;
const TICK_MS = 60_000;
const FETCH_TIMEOUT_MS = 8000;
/** No provider endpoint is asked more often than this, machine-wide. */
const MIN_REQUEST_INTERVAL_MS = 60_000;
/** Pause before the single retry a failed fetch earns inside its cycle. */
const FETCH_RETRY_DELAY_MS = 500;

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
/**
 * Serializes refresh cycles end-to-end: a call that arrives while a cycle is
 * open waits for it and then runs its own. A manual /quota refresh can then
 * never be dropped by (or interleave with) the boot or activity refresh — it
 * queues behind it and reports the machine-wide rate limit instead of racing.
 */
let refreshQueue: Promise<void> = Promise.resolve();
/**
 * Last fetch failure per provider, remembered for the /quota panel: it
 * explains missing-or-stale numbers on the panel's own surface until a
 * fetch succeeds again, instead of interrupting the user with a notification.
 */
const lastErrors = new Map<ProviderKind, { message: string; at: number }>();
/** True when the shown snapshot predates a failed refresh. */
let stale = false;
let currentSnapshot: QuotaSnapshot | undefined;
let footerInstalled = false;
/** Context of the latest session/model event, used to (un)install the footer. */
let activeCtx: ExtensionContext | undefined;
/** Listeners notified whenever the snapshot, staleness, or mode changes (footer re-renders). */
const snapshotListeners = new Set<() => void>();
/** Last fetch attempt per provider in this process — the cache file shares them across sessions. */
const lastAttempts = new Map<ProviderKind, number>();

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

/** True when the auth entry carries a credential a fetch could use: an unexpired OAuth access token or an API key. */
function hasUsableCredential(entry: unknown): boolean {
	if (typeof entry !== "object" || entry === null) return false;
	if (oauthExpired(entry)) return false;
	const { access, key } = entry as { access?: unknown; key?: unknown };
	return typeof (access ?? key) === "string";
}

/**
 * Read the credential for a provider from pi's auth.json: the OAuth access
 * token (`access`) for OAuth providers such as kimi-coding, the API `key`
 * otherwise. The file is re-read on every fetch so a token pi refreshed
 * mid-session is picked up on the next request. A lapsed OAuth token counts as
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

/** The cache write in flight, if any; in-process writers queue behind it. */
let cacheWriteChain: Promise<void> = Promise.resolve();

/**
 * Read-modify-write with a rename, so concurrent pi sessions never read a
 * torn file. Writes are serialized in-process first: the /quota panel
 * refreshes several providers in parallel, and two interleaved
 * read-modify-write cycles would silently drop whichever update renamed
 * first. performCacheWrite never rejects, so the chain cannot break.
 */
async function writeCacheFile(update: (cache: QuotaCacheFile) => void): Promise<void> {
	const write = cacheWriteChain.then(() => performCacheWrite(update));
	cacheWriteChain = write;
	await write;
}

async function performCacheWrite(update: (cache: QuotaCacheFile) => void): Promise<void> {
	const path = join(agentDir(), "quota-cache.json");
	try {
		const text = await readFile(path, "utf8").catch(() => undefined);
		// A file written by a newer cache format owns the data; rewriting it as
		// this version would silently discard whatever that format stored.
		if (isNewerCacheFile(text)) return;
		const cache = parseCache(text);
		update(cache);
		// A unique tmp name per writer: two sessions sharing one fixed tmp path
		// could interleave writes into the same file and rename a torn result.
		const tmp = `${path}.${process.pid}-${Math.random().toString(36).slice(2)}.tmp`;
		await writeFile(tmp, serializeCache(cache), "utf8");
		await rename(tmp, path);
	} catch {
		// Best effort: the cache only avoids a refetch, a failed write is harmless.
	}
}

/** Store a fetched snapshot, keeping every other provider's data and attempt times. */
async function writeCacheSnapshot(snapshot: QuotaSnapshot): Promise<void> {
	await writeCacheFile((cache) => {
		cache.snapshots[snapshot.kind] = snapshot;
	});
}

/** Persist a fetch-attempt time so every pi session on the machine shares one rate limit. */
async function writeCacheLastRequest(kind: ProviderKind, now: number): Promise<void> {
	await writeCacheFile((cache) => {
		cache.lastRequests = { ...cache.lastRequests, [kind]: now };
	});
}

/** One provider's fetch outcome, including why no fresh data arrived. */
type FetchOutcome =
	| { status: "fetched"; snapshot: QuotaSnapshot }
	| { status: "limited" }
	| { status: "no-credential" }
	| { status: "error"; message: string };

/**
 * Reserve the next request slot for a provider: true when at least
 * MIN_REQUEST_INTERVAL_MS has passed since any session last attempted a
 * fetch. The attempt time is persisted before the request starts, so even
 * concurrent sessions and failing endpoints keep at least a minute between
 * attempts machine-wide. Two bounded excesses remain: a read-write race can
 * admit one duplicate reservation, and a failed attempt earns one immediate
 * in-cycle retry — both are extra status requests only, never data ones.
 */
async function reserveFetchSlot(kind: ProviderKind): Promise<boolean> {
	const now = Date.now();
	const local = lastAttempts.get(kind);
	if (local !== undefined && !requestDue(local, now, MIN_REQUEST_INTERVAL_MS)) return false;
	const persisted = (await readCacheFile()).lastRequests?.[kind];
	if (typeof persisted === "number" && !requestDue(persisted, now, MIN_REQUEST_INTERVAL_MS)) {
		// Adopt the other session's timestamp so this process counts down from it.
		lastAttempts.set(kind, Math.max(persisted, local ?? 0));
		return false;
	}
	lastAttempts.set(kind, now);
	await writeCacheLastRequest(kind, now);
	return true;
}

/**
 * Fetch one provider's quota and cache the snapshot, honoring the
 * machine-wide request interval. Credentials come exclusively from pi's
 * auth.json: the same credential pi itself runs the provider with, so no
 * environment fallback can pair a key with a foreign host.
 */
async function fetchAndCache(provider: QuotaProvider, providerId: string | undefined, baseUrl?: string): Promise<FetchOutcome> {
	const apiKey = await readAuthKey(providerId);
	if (!apiKey) return { status: "no-credential" };
	if (!(await reserveFetchSlot(provider.kind))) return { status: "limited" };
	// One retry: quota endpoints blip (5xx, connection resets) and a single
	// immediate re-request usually clears it. The slot this cycle reserved
	// covers both tries, so the machine-wide interval still bounds the pair.
	for (let attempt = 0; ; attempt++) {
		try {
			const snapshot = await provider.fetchQuota(apiKey, { now: Date.now, timeoutMs: FETCH_TIMEOUT_MS, baseUrl });
			lastErrors.delete(provider.kind);
			await writeCacheSnapshot(snapshot);
			return { status: "fetched", snapshot };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (attempt < 1) {
				await new Promise((resolve) => setTimeout(resolve, FETCH_RETRY_DELAY_MS));
				continue;
			}
			// Expected while offline or on provider errors: keep showing the
			// last snapshot; the /quota panel explains the outage on its own surface.
			lastErrors.set(provider.kind, { message, at: Date.now() });
			return { status: "error", message };
		}
	}
}

/** What a refresh cycle produced for the active provider. */
interface RefreshResult {
	/** Latest snapshot for the active provider, from memory or cache. */
	snapshot?: QuotaSnapshot;
	/** True when this call brought back fresh numbers. */
	fetched: boolean;
	/** True when the request was skipped: some session asked within the last minute. */
	limited: boolean;
	/** Set when this cycle's own fetch failed (after its retry); the panel, not a notification, shows it. */
	error?: string;
}

function refresh(opts: { force?: boolean } = {}): Promise<RefreshResult> {
	// Capture the active provider here, not when the queued cycle starts: a
	// model switch between the two would pair the cycle with the wrong (or no)
	// provider, and a manual refresh must report the provider it was asked about.
	const provider = activeProvider;
	if (!provider) return Promise.resolve({ snapshot: currentSnapshot, fetched: false, limited: false });
	const providerId = activeProviderId;
	const baseUrl = activeBaseUrl;
	const cycle = refreshQueue.then(() => runRefreshCycle(provider, providerId, baseUrl, opts));
	// The queue itself never rejects, or one failed cycle would poison every later one.
	refreshQueue = cycle.then(
		() => undefined,
		() => undefined,
	);
	return cycle;
}

async function runRefreshCycle(
	provider: QuotaProvider,
	providerId: string | undefined,
	baseUrl: string | undefined,
	opts: { force?: boolean },
): Promise<RefreshResult> {
	/** True when the model switched to another provider since this refresh started. */
	const switchedProvider = () => provider.kind !== activeProvider?.kind;
	refreshing = true;
	let fetched = false;
	let limited = false;
	let fetchError: string | undefined;
	/** The snapshot this cycle fetched, if any — reported even when a mid-fetch model switch keeps it out of the footer. */
	let fetchedSnapshot: QuotaSnapshot | undefined;
	try {
		if (!opts.force) {
			const cached = await readCacheFile().then((cache) => cache.snapshots[provider.kind]);
			if (!switchedProvider() && freshSnapshot(cached, Date.now(), CACHE_TTL_MS)) {
				currentSnapshot = cached;
				stale = false;
				await syncFooterInstall();
				publishSnapshot();
				return { snapshot: currentSnapshot, fetched: false, limited: false, error: undefined };
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
		const outcome = await fetchAndCache(provider, providerId, baseUrl);
		limited = outcome.status === "limited";
		fetchError = outcome.status === "error" ? outcome.message : undefined;
		fetchedSnapshot = outcome.status === "fetched" ? outcome.snapshot : undefined;
		fetched = fetchedSnapshot !== undefined;
		let next = fetchedSnapshot;
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
			// Keep showing the last snapshot. A failed refresh marks it stale; a
			// rate-limited or credential-less skip only when it is past the TTL.
			// A limited skip sent nothing, and this cycle may have waited in the
			// queue first: another session can have fetched meanwhile, so adopt the
			// machine-wide cache's snapshot when it is newer than memory. Memory is
			// captured before the await — sync() can clear currentSnapshot while the
			// file is read — and the switch is re-checked after it so an old
			// provider's numbers never bleed into the new one's memory.
			if (outcome.status === "limited" && !switchedProvider()) {
				const memory = currentSnapshot;
				if (memory) {
					const machine = await readCacheFile().then((cache) => cache.snapshots[provider.kind]);
					if (machine && machine.fetchedAt > memory.fetchedAt && !switchedProvider()) currentSnapshot = machine;
				}
			}
			stale = outcome.status === "error" || !freshSnapshot(currentSnapshot, Date.now(), CACHE_TTL_MS);
		}
		await syncFooterInstall();
		publishSnapshot();
	} finally {
		refreshing = false;
	}
	// A model switch that arrived while this refresh was in flight left its
	// own sync() call a no-op behind the refreshing guard; catch up for the
	// new provider immediately instead of waiting for the next activity.
	if (activeProvider && activeProvider.kind !== provider.kind) void refresh().catch(() => {});
	// Report what this call produced: the fetched snapshot even when a
	// mid-fetch model switch kept it out of the footer (describeSnapshot
	// names its kind), else the active provider's latest from memory.
	return { snapshot: fetchedSnapshot ?? currentSnapshot, fetched, limited, error: fetchError };
}

function stopTimer(): void {
	if (tickTimer !== undefined) {
		clearInterval(tickTimer);
		tickTimer = undefined;
	}
}

function startTimer(): void {
	if (tickTimer !== undefined) return;
	// Render-only tick: countdowns and reset times stay current once a minute
	// without touching the network — fetches happen on activity (agent runs,
	// model switches) and on demand (/quota), never on a wall clock. Unref'd
	// so the timer never keeps pi alive.
	tickTimer = setInterval(() => publishSnapshot(), TICK_MS);
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
	void refresh().catch(() => {});
}

/**
 * Streaming activity (agent run started or finished, an assistant turn
 * completed): the active subscription's numbers may have moved with the
 * work. Refresh in the background, TTL- and rate-gated — at most one
 * request per CACHE_TTL_MS while the session is active, none while it
 * sits idle or displays no footer (mode off, non-TUI). Never awaited:
 * the agent loop must not wait on a status fetch.
 */
function onAgentActivity(): void {
	// Off and non-TUI sessions show nothing (the /quota panel fetches on
	// demand), so a background refresh there would be cost without a viewer.
	if (currentMode === "off" || (activeCtx !== undefined && activeCtx.mode !== "tui")) return;
	void refresh().catch(() => {});
}

/** Short fetch-failure text for the panel; the endpoint is implied by the provider block it belongs to. */
function panelFetchError(message: string): string {
	return message.replace(/ from \S+.*$/, "");
}

/**
 * One configured provider as a panel row, rendered from cache alone: fresh
 * snapshots as-is, stale ones with their numbers kept and marked `~`,
 * missing ones as a note — "fetching…" while a refresh is in flight, the
 * failure reason or retry countdown after it failed. A remembered failure
 * rides along with the numbers it explains, so stale data always says why.
 */
function panelRow(
	entry: ConfiguredQuotaProvider,
	authFile: Record<string, unknown> | undefined,
	cached: QuotaSnapshot | undefined,
	opts: { pending: boolean; fetchError?: string; retryInSeconds?: number },
	now: number,
): QuotaPanelRow {
	const row: QuotaPanelRow = {
		label: entry.providerId,
		planLabel: entry.provider.planLabel,
		active: entry.provider.kind === activeProvider?.kind,
	};
	if (cached) {
		// Any age: show the numbers now — old ones marked stale (~), replaced
		// by the pending refresh when it lands. freshSnapshot is a type guard,
		// so the age check is inlined to keep `cached` narrowed here.
		const fresh = now - cached.fetchedAt < CACHE_TTL_MS;
		const failure = opts.fetchError ? `quota unavailable (${panelFetchError(opts.fetchError)})` : undefined;
		return fresh
			? { ...row, planLevel: cached.planLevel, snapshot: cached, note: failure }
			: { ...row, planLevel: cached.planLevel, snapshot: cached, stale: true, note: failure };
	}
	if (opts.pending) return { ...row, note: "fetching…" };
	if (opts.fetchError) return { ...row, note: `quota unavailable (${panelFetchError(opts.fetchError)})` };
	if (oauthExpired(authFile?.[entry.providerId])) {
		return { ...row, note: "oauth token expired; it refreshes the next time pi uses this provider" };
	}
	if (opts.retryInSeconds !== undefined) return { ...row, note: `quota unavailable (retry in ${opts.retryInSeconds}s)` };
	return row;
}

/** The /quota panel text for one cache state; pending and errors describe an in-flight refresh. */
function renderPanel(
	ordered: readonly ConfiguredQuotaProvider[],
	authFile: Record<string, unknown> | undefined,
	cache: QuotaCacheFile,
	pending: ReadonlySet<ProviderKind>,
	errors: ReadonlyMap<ProviderKind, string>,
): string {
	const now = Date.now();
	const rows = ordered.map((entry): QuotaPanelRow => {
		const kind = entry.provider.kind;
		const lastRequestAt = cache.lastRequests?.[kind];
		// A credential-less provider never fetches, so a recent attempt only
		// matters as a retry note when a request could follow.
		const retryInSeconds =
			pending.has(kind) || !hasUsableCredential(authFile?.[entry.providerId])
				? undefined
				: lastRequestAt !== undefined && !requestDue(lastRequestAt, now, MIN_REQUEST_INTERVAL_MS)
					? Math.ceil((lastRequestAt + MIN_REQUEST_INTERVAL_MS - now) / 1000)
					: undefined;
		return panelRow(
			entry,
			authFile,
			cache.snapshots[kind],
			{
				pending: pending.has(kind),
				fetchError: errors.get(kind),
				retryInSeconds,
			},
			now,
		);
	});
	return `${formatQuotaPanel(rows, now)}\n\n/quota refresh · /quota mode line|inline|off · /quota help`;
}

/**
 * Show the /quota panel without waiting on the network: the cached state of
 * every configured provider renders immediately (stale snapshots keep their
 * numbers behind `~`, missing ones read "fetching…"), then the stale or
 * missing providers refresh in the background and the panel re-renders
 * once — unless nothing changed (every fetch failed with only stale
 * numbers shown, which the first panel already says with its `~` marks).
 */
async function showQuotaPanel(ctx: ExtensionContext): Promise<void> {
	const authFile = await readAuthFile();
	const configured = configuredQuotaProviders(authFile);
	if (configured.length === 0) {
		ctx.ui.notify("no quota providers configured", "info");
		return;
	}
	// Active provider first, the rest alphabetical by display label —
	// predictable and stable, independent of auth.json key order.
	const ordered = [...configured].sort((a, b) => {
		if (a.provider.kind === activeProvider?.kind) return -1;
		if (b.provider.kind === activeProvider?.kind) return 1;
		return a.providerId < b.providerId ? -1 : a.providerId > b.providerId ? 1 : 0;
	});
	const cache = await readCacheFile();
	const now = Date.now();
	// A remembered failure explains missing-or-stale numbers for its provider
	// until fresher data lands; fetch errors belong on this panel, nowhere else.
	const rememberedErrors = (snapshots: QuotaCacheFile["snapshots"]): Map<ProviderKind, string> => {
		const remembered = new Map<ProviderKind, string>();
		for (const entry of ordered) {
			const failure = lastErrors.get(entry.provider.kind);
			if (!failure) continue;
			const snapshot = snapshots[entry.provider.kind];
			if (!snapshot || snapshot.fetchedAt < failure.at) remembered.set(entry.provider.kind, failure.message);
		}
		return remembered;
	};
	// Providers needing a fetch: a stale-or-missing snapshot, a usable
	// credential, and the machine-wide request interval elapsed. The rate
	// limit itself lives in fetchAndCache; this only keeps the first render
	// honest about what is about to happen.
	const due = ordered.filter(
		(entry) =>
			!freshSnapshot(cache.snapshots[entry.provider.kind], now, CACHE_TTL_MS) &&
			hasUsableCredential(authFile?.[entry.providerId]) &&
			requestDue(cache.lastRequests?.[entry.provider.kind], now, MIN_REQUEST_INTERVAL_MS),
	);
	const first = renderPanel(
		ordered,
		authFile,
		cache,
		new Set(due.map((entry) => entry.provider.kind)),
		rememberedErrors(cache.snapshots),
	);
	ctx.ui.notify(first, "info");
	if (due.length === 0) return;
	const errors = new Map<ProviderKind, string>();
	await Promise.allSettled(
		due.map(async (entry) => {
			// The active provider keeps its regional base URL; the rest use
			// their default endpoint.
			const baseUrl = entry.provider.kind === activeProvider?.kind ? activeBaseUrl : undefined;
			const outcome = await fetchAndCache(entry.provider, entry.providerId, baseUrl);
			if (outcome.status === "error") errors.set(entry.provider.kind, outcome.message);
		}),
	);
	const refreshed = await readCacheFile();
	// This pass's own errors win; remembered ones fill in every other provider.
	for (const [kind, message] of rememberedErrors(refreshed.snapshots)) {
		if (!errors.has(kind)) errors.set(kind, message);
	}
	// A fresh snapshot for the active provider also updates the footer —
	// unless an activity refresh is mid-flight, which owns that state.
	if (!refreshing && activeProvider) {
		const activeCached = refreshed.snapshots[activeProvider.kind];
		if (activeCached && freshSnapshot(activeCached, Date.now(), CACHE_TTL_MS)) {
			currentSnapshot = activeCached;
			stale = false;
			await syncFooterInstall();
			publishSnapshot();
		}
	}
	const second = renderPanel(ordered, authFile, refreshed, new Set(), errors);
	if (second !== first) ctx.ui.notify(second, "info");
}

function describeSnapshot(snapshot: QuotaSnapshot | undefined): string {
	if (!snapshot) return "no quota data yet";
	const age = Math.max(0, Math.round((Date.now() - snapshot.fetchedAt) / 1000));
	const line = formatQuota(snapshot, Date.now()) || "(empty)";
	return `${stale ? "~" : ""}${line} — fetched ${age}s ago (${snapshot.kind})`;
}

/** Sub-command hints for /quota autocompletion. */
const SUBCOMMANDS: { value: string; label: string; description: string }[] = [
	{ value: "refresh", label: "refresh", description: "force a re-fetch for the active provider (once per minute at most)" },
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
	// Run boundaries and completed assistant turns are the activity
	// signal: refreshes ride on real work instead of a wall clock, so an
	// idle session sends no requests at all. Mid-run turns matter because
	// one task can burn quota for hours while its boundaries alone would
	// leave the footer stale throughout.
	pi.on("agent_start", onAgentActivity);
	pi.on("agent_end", onAgentActivity);
	pi.on("message_end", (event) => {
		// Only assistant turns consume provider quota; user messages and
		// tool results ride inside the same run without spending any.
		if (event.message.role === "assistant") onAgentActivity();
	});
	// Subagent children burn the same account while the parent session
	// itself stays quiet: a foreground child holds the turn open inside its
	// `subagent` tool call (no assistant turns or run boundaries until it
	// returns), and a background child leaves the parent idle in a separate
	// process. Neither fires the activity events above, so a long delegation
	// would freeze the footer exactly when quota moves fastest. Route child
	// progress — streaming updates of the parent's `subagent` tool call, and
	// the events pi-subagents emits on pi's shared event bus — through the
	// same gated refresh. Updates of other tools are not provider activity,
	// and without pi-subagents the bus events simply never fire.
	pi.on("tool_execution_update", (event) => {
		if (event.toolName === "subagent") onAgentActivity();
	});
	// Optional chaining: hosts older than the shared event bus still load.
	pi.events?.on("subagent:child-status", onAgentActivity);
	pi.events?.on("subagent:jobs-changed", onAgentActivity);
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
				// Cycles are serialized, so a manual refresh waits for any
				// in-flight one and then runs — and reports the rate limit — itself.
				const result = await refresh({ force: true });
				// A failed fetch is not worth interrupting anyone: the /quota panel
				// explains the outage on its own surface, with the numbers it has.
				if (result.error !== undefined) {
					await showQuotaPanel(ctx);
					return;
				}
				// Without a credential there is nothing to fetch; and without data
				// or a rate-limit skip, nothing worth reporting either.
				if (!result.fetched && !result.limited) {
					ctx.ui.notify("Quota: nothing to refresh", "warning");
					return;
				}
				ctx.ui.notify(
					result.fetched
						? `Quota refreshed: ${describeSnapshot(result.snapshot)}`
						: `Quota: requested within the last minute — ${describeSnapshot(result.snapshot)}`,
					"info",
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
			// No argument (or anything unrecognized): cached numbers instantly,
			// refreshed in the background and re-rendered when they land.
			await showQuotaPanel(ctx);
		},
	});
}
