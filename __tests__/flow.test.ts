/**
 * Integration flow tests: drive the extension entry (index.ts) against a
 * temp agent directory and a fake pi context, then render the installed
 * footer factory — verifying the wiring that pure view tests cannot reach:
 * footer installation gating per mode, lifecycle (model switch, session
 * replacement, shutdown), staleness, and what line/inline actually render.
 *
 * Network is avoided by seeding a cache; failing-fetch paths point at
 * 127.0.0.1:1 (connection refused). Credentials come only from the temp
 * agent dir's auth.json, exactly like production.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";

import type { QuotaSnapshot } from "../providers/index.ts";

const MINUTE = 60_000;

/** A snapshot of either token-window provider shape, keyed by kind. */
function windowSnapshot(kind: "zai" | "kimi", used5h: number, used7d: number, fetchedAt: number): QuotaSnapshot {
	return {
		kind,
		fetchedAt,
		planLevel: "max",
		items: [
			{
				type: "window",
				resource: "tokens",
				label: "5h",
				usedPercent: used5h,
				resetAt: fetchedAt + 4 * 60 * MINUTE,
				durationMs: 5 * 3_600_000,
			},
			{
				type: "window",
				resource: "tokens",
				label: "7d",
				usedPercent: used7d,
				resetAt: fetchedAt + 3 * 24 * 60 * MINUTE,
				durationMs: 7 * 24 * 3_600_000,
			},
		],
	};
}

const zaiSnapshot = (used5h: number, used7d: number, fetchedAt: number) => windowSnapshot("zai", used5h, used7d, fetchedAt);
const kimiSnapshot = (used5h: number, used7d: number, fetchedAt: number) => windowSnapshot("kimi", used5h, used7d, fetchedAt);

/** Fake pi surfaces: captures setFooter/notify and the registered command. */
function createFakePi() {
	const state = {
		footerFactory: undefined as ((tui: unknown, theme: unknown, data: unknown) => unknown) | undefined,
		notifications: [] as string[],
		listeners: new Map<string, (event: unknown, ctx: unknown) => Promise<void> | void>(),
		command: undefined as
			| {
					handler: (args: string, ctx: unknown) => Promise<void>;
					getArgumentCompletions?: (prefix: string) => { value: string; label: string; description: string }[];
			  }
			| undefined,
	};
	return {
		state,
		api: {
			on(event: string, listener: (event: unknown, ctx: unknown) => Promise<void> | void) {
				state.listeners.set(event, listener);
			},
			registerCommand(
				_name: string,
				def: {
					handler: (args: string, ctx: unknown) => Promise<void>;
					getArgumentCompletions?: (prefix: string) => { value: string; label: string; description: string }[];
				},
			) {
				state.command = def;
			},
		},
		ctx: {
			mode: "tui",
			model: { id: "glm-5.3", provider: "zai-coding-cn", reasoning: true },
			thinkingLevel: "max",
			getContextUsage: () => undefined,
			sessionManager: {
				getEntries: () => [],
				getLeafId: () => null,
				getCwd: () => "/dev/project",
				getSessionName: () => undefined,
			},
			ui: {
				setFooter(factory: ((tui: unknown, theme: unknown, data: unknown) => unknown) | undefined) {
					state.footerFactory = factory;
				},
				notify(message: string) {
					state.notifications.push(message);
				},
			},
		},
	};
}

/** Mount the footer component once, as pi does; render() may then be called per frame. */
function mountFooter(factory: (tui: unknown, theme: unknown, data: unknown) => unknown): {
	render(width: number): string[];
} {
	return factory(
		{ requestRender() {} },
		{ fg: (_color: string, text: string) => text },
		{
			onBranchChange: () => () => {},
			getGitBranch: () => "main",
			getAvailableProviderCount: () => 2,
			getExtensionStatuses: () => new Map(),
		},
	) as { render(width: number): string[] };
}

function renderFooter(factory: (tui: unknown, theme: unknown, data: unknown) => unknown, width: number): string[] {
	return mountFooter(factory).render(width);
}

async function seedAgentDir(dir: string, mode: string, snapshot: QuotaSnapshot | undefined, seedCache = true) {
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "quota-settings.json"), JSON.stringify({ mode }), "utf8");
	// seedCache=false leaves the cache file for a simulated second session
	// that must start from whatever an earlier session left on disk.
	if (!seedCache) return;
	await writeFile(
		join(dir, "quota-cache.json"),
		JSON.stringify({ version: 2, snapshots: snapshot ? { [snapshot.kind]: snapshot } : {} }),
		"utf8",
	);
}

/**
 * Sync() kicks refresh() off without awaiting it; installation lands a few
 * ticks later. Fails the test when the condition never arrives, so a
 * dropped refresh surfaces here instead of as a misleading later failure.
 */
async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await predicate()) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.ok(await predicate(), `timed out after ${timeoutMs}ms waiting for a condition that never arrived`);
}

/**
 * A local Kimi endpoint: /coding/v1/usages serves a weekly pool (limit 2048,
 * used 1024 → 50%), /coding/v1/me the membership tier. Responses can be
 * delayed so callers can prove something did NOT wait for the network.
 * Counted requests let tests assert the machine-wide rate limit. The first
 * `failUsagesRequests` /usages requests answer 500, to exercise retries and
 * error rendering; /me never fails (providers tolerate its loss silently).
 */
async function startKimiServer(
	delayMs = 0,
	failUsagesRequests = 0,
): Promise<{ baseUrl: string; requests: () => number; close: () => void }> {
	let requests = 0;
	let failedUsages = 0;
	const server = http.createServer((req, res) => {
		requests++;
		setTimeout(() => {
			if (!req.url?.endsWith("/me") && failedUsages++ < failUsagesRequests) {
				res.writeHead(500, { "content-type": "application/json" });
				res.end("{}");
				return;
			}
			const body = req.url?.endsWith("/me")
				? { user_level_name: "moderato" }
				: {
						usage: { limit: "2048", used: "1024", resetTime: new Date(Date.now() + 3 * 24 * 3_600_000).toISOString() },
						limits: [],
					};
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify(body));
		}, delayMs);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as { port: number }).port;
	return {
		baseUrl: `http://127.0.0.1:${port}/coding/v1`,
		requests: () => requests,
		close: () => server.close(),
	};
}

describe("extension flow", () => {
	let agentDir: string;

	// keepSharedCache: leave quota-cache.json alone so a second simulated
	// session starts from whatever the first one left on disk.
	async function boot(
		mode: string,
		snapshot: QuotaSnapshot | undefined,
		model?: Record<string, unknown>,
		ctxMode = "tui",
		keepSharedCache = false,
	) {
		await seedAgentDir(agentDir, mode, snapshot, !keepSharedCache);
		// index.ts keeps module state; re-import fresh for each scenario.
		const moduleUrl = new URL("../index.ts", import.meta.url).href;
		const mod = await import(`${moduleUrl}?boot=${Date.now()}-${Math.random()}`);
		const pi = createFakePi();
		if (model) Object.assign(pi.ctx.model as Record<string, unknown>, model);
		pi.ctx.mode = ctxMode;
		mod.default(pi.api);
		const start = pi.state.listeners.get("session_start");
		assert.ok(start, "session_start listener registered");
		await start({}, pi.ctx);
		return pi;
	}

	before(async () => {
		agentDir = await mkdtemp(join(tmpdir(), "pi-sub-quota-test-"));
		process.env.PI_CODING_AGENT_DIR = agentDir;
	});

	after(async () => {
		delete process.env.PI_CODING_AGENT_DIR;
		await rm(agentDir, { recursive: true, force: true });
	});

	it("line mode renders every window in full detail, calm or not", async () => {
		const pi = await boot("line", zaiSnapshot(13, 77, Date.now()));
		await waitFor(() => pi.state.footerFactory !== undefined);
		assert.ok(pi.state.footerFactory, "line mode must install the footer when a snapshot exists");
		const lines = renderFooter(pi.state.footerFactory, 120);
		assert.equal(lines.length, 3);
		// Meters and countdowns show unconditionally — the space is there.
		assert.match(lines[2], /^\(Max\) 5h ▓░░░░░░░░░ {2}13% (4h|3h)\d+m · 7d ▓▓▓▓▓▓▓▓░░ {2}77% (3d|2d)\d+h$/);
	});

	it("line mode keeps the same full detail while a window runs hot", async () => {
		const pi = await boot("line", zaiSnapshot(96, 77, Date.now()));
		await waitFor(() => pi.state.footerFactory !== undefined);
		assert.ok(pi.state.footerFactory);
		const lines = renderFooter(pi.state.footerFactory, 120);
		assert.equal(lines.length, 3);
		assert.match(lines[2], /^\(Max\) 5h ▓▓▓▓▓▓▓▓▓▓ {2}96% (4h|3h)\d+m · 7d ▓▓▓▓▓▓▓▓░░ {2}77% (3d|2d)\d+h$/);
	});

	it("inline mode carries quiet percentages inside the provider prefix", async () => {
		const pi = await boot("inline", zaiSnapshot(13, 77, Date.now()));
		await waitFor(() => pi.state.footerFactory !== undefined);
		assert.ok(pi.state.footerFactory);
		const lines = renderFooter(pi.state.footerFactory, 120);
		assert.equal(lines.length, 2);
		assert.match(lines[1], /\(zai-coding-cn 13% 77%\) glm-5\.3 • max$/);
	});

	it("leaves the built-in footer untouched without any data (no key, empty cache)", async () => {
		const pi = await boot("inline", undefined);
		// Give the in-flight refresh (which finds no key and no cache) time to settle.
		await new Promise((resolve) => setTimeout(resolve, 150));
		assert.equal(pi.state.footerFactory, undefined, "no snapshot and no key must not touch the footer");
	});

	it("degrades silently on fetch failure: no console output, no footer, panel explains why", async () => {
		await writeFile(
			join(agentDir, "auth.json"),
			JSON.stringify({ "kimi-coding": { type: "api_key", key: "dummy-key" } }),
			"utf8",
		);
		const errors: unknown[] = [];
		const originalError = console.error;
		console.error = (...args: unknown[]) => errors.push(args);
		try {
			// Empty cache + a stored key + an unreachable regional endpoint: the
			// fetch fails immediately (connection refused).
			const pi = await boot("inline", undefined, {
				provider: "kimi-coding",
				baseUrl: "http://127.0.0.1:1/coding/v1",
			});
			await new Promise((resolve) => setTimeout(resolve, 300));
			assert.equal(pi.state.footerFactory, undefined, "a failed fetch must not install the footer");
			assert.equal(errors.length, 0, "fetch failures must not write to the console");
			// /quota refresh also stays quiet and explains itself via notify: the
			// boot attempt already failed (and persisted its timestamp), so the
			// retry within the minute is rate-limited rather than "nothing to refresh".
			const handler = pi.state.command?.handler;
			assert.ok(handler);
			await handler("refresh", pi.ctx);
			assert.match(pi.state.notifications.at(-1) ?? "", /within the last minute/);
		} finally {
			console.error = originalError;
			await rm(join(agentDir, "auth.json"), { force: true });
		}
	});

	it("restores the built-in footer in off mode and via the mode command", async () => {
		const pi = await boot("inline", zaiSnapshot(13, 77, Date.now()));
		await waitFor(() => pi.state.footerFactory !== undefined);
		assert.ok(pi.state.footerFactory);
		const handler = pi.state.command?.handler;
		assert.ok(handler, "/quota command registered");
		await handler("mode off", pi.ctx);
		assert.equal(pi.state.footerFactory, undefined, "off mode must restore the built-in footer");
		assert.deepEqual(
			JSON.parse(await readFile(join(agentDir, "quota-settings.json"), "utf8")),
			{ mode: "off" },
			"the mode must be persisted, not just applied in memory",
		);
		await handler("mode line", pi.ctx);
		await waitFor(() => pi.state.footerFactory !== undefined);
		assert.ok(pi.state.footerFactory, "switching back to line reinstalls the footer");
	});

	it("explains an expired OAuth token instead of fetching a guaranteed 401", async () => {
		// kimi-coding logged in via OAuth, but the access token has lapsed: no
		// fetch must be attempted, and the /quota panel must say why.
		await writeFile(
			join(agentDir, "auth.json"),
			JSON.stringify({ "kimi-coding": { type: "oauth", access: "stale-token", refresh: "r", expires: Date.now() - 1 } }),
			"utf8",
		);
		try {
			const pi = await boot("inline", undefined, { provider: "kimi-coding" });
			await new Promise((resolve) => setTimeout(resolve, 150));
			assert.equal(pi.state.footerFactory, undefined, "an expired token must not install the footer");
			const handler = pi.state.command?.handler;
			assert.ok(handler);
			await handler("", pi.ctx);
			assert.match(pi.state.notifications.at(-1) ?? "", /oauth token expired/);
		} finally {
			await rm(join(agentDir, "auth.json"), { force: true });
		}
	});

	it("lists the /quota panel active provider first, then the rest alphabetically", async () => {
		// Entries without usable credentials: no fetch, but the panel order shows.
		await writeFile(
			join(agentDir, "auth.json"),
			JSON.stringify({
				"zai-coding-cn": { type: "api_key" },
				"kimi-coding": { type: "oauth" },
				deepseek: { type: "api_key" },
			}),
			"utf8",
		);
		try {
			const pi = await boot("inline", undefined); // model is zai-coding-cn → active
			const handler = pi.state.command?.handler;
			assert.ok(handler);
			await handler("", pi.ctx);
			const panel = pi.state.notifications.at(-1) ?? "";
			const zai = panel.indexOf("zai-coding-cn");
			const deepseek = panel.indexOf("deepseek");
			const kimi = panel.indexOf("kimi-coding");
			assert.ok(zai !== -1 && deepseek !== -1 && kimi !== -1, `all blocks present:\n${panel}`);
			assert.ok(zai < deepseek && deepseek < kimi, `active first, rest alphabetical:\n${panel}`);
		} finally {
			await rm(join(agentDir, "auth.json"), { force: true });
		}
	});

	it("restores the built-in footer when the model switches away and reinstalls it on return", async () => {
		const pi = await boot("inline", zaiSnapshot(13, 77, Date.now()));
		await waitFor(() => pi.state.footerFactory !== undefined);
		assert.ok(pi.state.footerFactory);
		const onSelect = pi.state.listeners.get("model_select");
		assert.ok(onSelect, "model_select listener registered");
		await onSelect({ model: { provider: "anthropic", id: "claude-4" } }, pi.ctx);
		assert.equal(pi.state.footerFactory, undefined, "a provider without quota must restore the built-in footer");
		await onSelect({ model: { provider: "zai-coding-cn", id: "glm-5.3" } }, pi.ctx);
		await waitFor(() => pi.state.footerFactory !== undefined);
		assert.ok(pi.state.footerFactory, "switching back reinstalls the footer");
	});

	it("keeps showing a cached snapshot with a ~ prefix while refreshes fail", async () => {
		await writeFile(
			join(agentDir, "auth.json"),
			JSON.stringify({ "kimi-coding": { type: "api_key", key: "dummy-key" } }),
			"utf8",
		);
		try {
			// A cache entry past its TTL plus an unreachable endpoint: the footer
			// installs from the cache and keeps the numbers marked stale (~).
			const pi = await boot("inline", kimiSnapshot(13, 77, Date.now() - 60 * MINUTE), {
				provider: "kimi-coding",
				baseUrl: "http://127.0.0.1:1/coding/v1",
			});
			await waitFor(() => pi.state.footerFactory !== undefined);
			assert.ok(pi.state.footerFactory, "a cached snapshot must install the footer even when stale");
			const lines = renderFooter(pi.state.footerFactory, 120);
			assert.match(lines[1], /\(kimi-coding ~13% 77%\)/);
		} finally {
			await rm(join(agentDir, "auth.json"), { force: true });
		}
	});

	it("reinstalls the footer after pi resets the session UI (session replacement)", async () => {
		const pi = await boot("inline", zaiSnapshot(13, 77, Date.now()));
		await waitFor(() => pi.state.footerFactory !== undefined);
		// pi clears extension UI on session invalidation (/new, /fork, /resume)
		// without notifying extensions, and reuses this module instance after.
		pi.state.footerFactory = undefined;
		const start = pi.state.listeners.get("session_start");
		assert.ok(start);
		await start({}, pi.ctx);
		await waitFor(() => pi.state.footerFactory !== undefined);
		assert.ok(pi.state.footerFactory, "session_start must be able to reinstall the footer");
	});

	it("stops the timer and restores the built-in footer on session shutdown", async () => {
		const pi = await boot("inline", zaiSnapshot(13, 77, Date.now()));
		await waitFor(() => pi.state.footerFactory !== undefined);
		const shutdown = pi.state.listeners.get("session_shutdown");
		assert.ok(shutdown, "session_shutdown listener registered");
		await shutdown({}, pi.ctx);
		assert.equal(pi.state.footerFactory, undefined, "shutdown must restore the built-in footer");
	});

	it("does not install the footer for a snapshot without items", async () => {
		const empty = zaiSnapshot(13, 77, Date.now());
		empty.items = [];
		const pi = await boot("inline", empty);
		await new Promise((resolve) => setTimeout(resolve, 150));
		assert.equal(pi.state.footerFactory, undefined, "nothing to show must not replace the built-in footer");
	});

	it("scales line-mode meters with the terminal width", async () => {
		const pi = await boot("line", zaiSnapshot(13, 77, Date.now()));
		await waitFor(() => pi.state.footerFactory !== undefined);
		assert.ok(pi.state.footerFactory);
		const meterCells = (width: number): number => {
			const lines = renderFooter(pi.state.footerFactory as NonNullable<typeof pi.state.footerFactory>, width);
			return (lines[2].match(/[▓░]/g) ?? []).length;
		};
		assert.equal(meterCells(120), 20, "two 10-cell meters from width 80");
		assert.equal(meterCells(79), 12, "two 6-cell meters below 80");
		assert.equal(meterCells(59), 8, "two 4-cell meters below 60");
		assert.equal(meterCells(47), 0, "no meter cells below 48");
	});

	it("drops the quota from the prefix before dropping the prefix at tight widths", async () => {
		const pi = await boot("inline", zaiSnapshot(13, 77, Date.now()));
		await waitFor(() => pi.state.footerFactory !== undefined);
		assert.ok(pi.state.footerFactory);
		const lines = renderFooter(pi.state.footerFactory, 44);
		assert.match(lines[1], /\(zai-coding-cn\) glm-5\.3 • max$/);
		assert.doesNotMatch(lines[1], /13%/);
	});

	it("truncates the stats segment on very narrow terminals instead of overflowing", async () => {
		const pi = await boot("inline", zaiSnapshot(13, 77, Date.now()));
		await waitFor(() => pi.state.footerFactory !== undefined);
		assert.ok(pi.state.footerFactory);
		// A long stats segment: many usage entries make it far wider than 24 columns.
		const entries = Array.from({ length: 20 }, () => ({
			type: "usage",
			usage: { input: 123456, output: 65432, cacheRead: 999999, cacheWrite: 888888, cost: { total: 1.234 } },
		}));
		(pi.ctx.sessionManager as { getEntries: () => unknown[] }).getEntries = () => entries;
		for (const width of [24, 40]) {
			const lines = renderFooter(pi.state.footerFactory, width);
			for (const line of lines) {
				assert.ok(visibleWidth(line) <= width, `width ${width}: line must not overflow: ${line}`);
			}
		}
	});

	it("reads context usage once per session state instead of on every frame", async () => {
		const pi = await boot("inline", zaiSnapshot(13, 77, Date.now()));
		// The footer closure captured ctx at install time, so patching the shared
		// object's method is observed by the component.
		let calls = 0;
		(pi.ctx as { getContextUsage: () => undefined }).getContextUsage = () => {
			calls++;
			return undefined;
		};
		await waitFor(() => pi.state.footerFactory !== undefined);
		assert.ok(pi.state.footerFactory);
		const component = mountFooter(pi.state.footerFactory);
		component.render(120);
		component.render(120);
		component.render(80);
		assert.equal(calls, 1, "unchanged session state must not re-project the session");
		// A new entry (or a model switch) is exactly what rebuilds the cache.
		const entries: unknown[] = [];
		(pi.ctx.sessionManager as { getEntries: () => unknown[] }).getEntries = () => entries;
		entries.push({ type: "usage", usage: { input: 1 } });
		component.render(120);
		assert.equal(calls, 2);
	});

	it("does not install a footer outside TUI mode (RPC, JSON, print have none)", async () => {
		// A fresh cache entry would install the footer in TUI mode; outside TUI
		// there is no footer to replace, so nothing may ever be installed.
		const pi = await boot("inline", zaiSnapshot(13, 77, Date.now()), undefined, "rpc");
		await new Promise((resolve) => setTimeout(resolve, 150));
		assert.equal(pi.state.footerFactory, undefined, "non-TUI modes must never install the footer");
	});

	it("autocompletes sub-commands and modes, naming only real modes", async () => {
		const pi = await boot("inline", undefined);
		const completions = pi.state.command?.getArgumentCompletions?.("") ?? [];
		const values = completions.map((completion) => completion.value);
		assert.deepEqual(values, ["refresh", "mode", "help"]);
		const modeCompletion = completions.find((completion) => completion.value === "mode");
		assert.match(modeCompletion?.description ?? "", /\(line, inline, off\)/);
		const modes = (pi.state.command?.getArgumentCompletions?.("mode ") ?? []).map((c) => c.value);
		assert.deepEqual(modes, ["mode line", "mode inline", "mode off"]);
	});

	it("shows the cached panel instantly, then the refreshed one when the fetch lands", async () => {
		// The endpoint answers slowly: the panel must render the stale cache
		// first and re-render once the fresh numbers arrive, never block on it.
		const server = await startKimiServer(400);
		// Boot in mode "off": sync() then skips its startup refresh entirely
		// (the panel works in every mode), so no request happens and no
		// rate-limit slot is burned before the panel's own fetch.
		await writeFile(join(agentDir, "auth.json"), JSON.stringify({ "kimi-coding": { type: "api_key" } }), "utf8");
		try {
			const pi = await boot("off", kimiSnapshot(13, 77, Date.now() - 60 * MINUTE), {
				provider: "kimi-coding",
				baseUrl: server.baseUrl,
			});
			await writeFile(
				join(agentDir, "auth.json"),
				JSON.stringify({ "kimi-coding": { type: "api_key", key: "dummy-key" } }),
				"utf8",
			);
			const notifyAt: number[] = [];
			const originalNotify = pi.ctx.ui.notify;
			pi.ctx.ui.notify = (message: string) => {
				notifyAt.push(Date.now());
				originalNotify(message);
			};
			const handler = pi.state.command?.handler;
			assert.ok(handler);
			const startedAt = Date.now();
			await handler("", pi.ctx);
			assert.equal(pi.state.notifications.length, 2, "cached panel first, refreshed panel second");
			assert.ok(notifyAt[0] - startedAt < 300, "the cached panel must appear before the fetch completes");
			assert.match(pi.state.notifications[0], /~kimi-coding/, "the first panel shows the stale cache");
			assert.match(pi.state.notifications[0], /87% left/);
			assert.doesNotMatch(pi.state.notifications[1], /~/, "the second panel is no longer stale");
			assert.match(pi.state.notifications[1], /Moderato/);
			assert.match(pi.state.notifications[1], /50% left/);
			// The fresh snapshot also landed in the shared cache file.
			const cache = JSON.parse(await readFile(join(agentDir, "quota-cache.json"), "utf8"));
			assert.equal(cache.snapshots.kimi.planLevel, "moderato");
		} finally {
			await rm(join(agentDir, "auth.json"), { force: true });
			server.close();
		}
	});

	it("renders a single panel when every snapshot is fresh", async () => {
		await writeFile(
			join(agentDir, "auth.json"),
			JSON.stringify({ "zai-coding-cn": { type: "api_key", key: "dummy-key" } }),
			"utf8",
		);
		try {
			const pi = await boot("inline", zaiSnapshot(13, 77, Date.now()));
			const handler = pi.state.command?.handler;
			assert.ok(handler);
			await handler("", pi.ctx);
			assert.equal(pi.state.notifications.length, 1, "a fresh cache needs no second panel");
			assert.match(pi.state.notifications[0], /zai-coding-cn/);
		} finally {
			await rm(join(agentDir, "auth.json"), { force: true });
		}
	});

	it("rate-limits manual refresh to one request per minute and persists the attempt", async () => {
		// Startup refreshes the stale cache once; a manual refresh right after
		// must be skipped as too recent — no second request, attempt persisted.
		const server = await startKimiServer();
		await writeFile(
			join(agentDir, "auth.json"),
			JSON.stringify({ "kimi-coding": { type: "api_key", key: "dummy-key" } }),
			"utf8",
		);
		try {
			const pi = await boot("inline", kimiSnapshot(13, 77, Date.now() - 60 * MINUTE), {
				provider: "kimi-coding",
				baseUrl: server.baseUrl,
			});
			await waitFor(() => server.requests() >= 2); // /usages + /me
			const requestsAfterBoot = server.requests();
			const handler = pi.state.command?.handler;
			assert.ok(handler);
			await handler("refresh", pi.ctx);
			assert.match(pi.state.notifications.at(-1) ?? "", /within the last minute/);
			await new Promise((resolve) => setTimeout(resolve, 100));
			assert.equal(server.requests(), requestsAfterBoot, "no second request inside the interval");
			const cache = JSON.parse(await readFile(join(agentDir, "quota-cache.json"), "utf8"));
			assert.equal(typeof cache.lastRequests?.kimi, "number", "the attempt time is persisted");
		} finally {
			await rm(join(agentDir, "auth.json"), { force: true });
			server.close();
		}
	});

	it("adopts another session's fresher snapshot when a queued refresh is limited", async () => {
		// A manual refresh waiting behind the boot cycle is rate-limited and
		// sends nothing; if another session fetched meanwhile, the machine-wide
		// cache holds fresher numbers than this process's memory — the notice
		// must show those, not the stale in-memory copy.
		const server = await startKimiServer();
		await writeFile(
			join(agentDir, "auth.json"),
			JSON.stringify({ "kimi-coding": { type: "api_key", key: "dummy-key" } }),
			"utf8",
		);
		try {
			const pi = await boot("inline", kimiSnapshot(13, 77, Date.now() - 60 * MINUTE), {
				provider: "kimi-coding",
				baseUrl: server.baseUrl,
			});
			await waitFor(() => server.requests() >= 2); // boot cycle fetched
			// Deterministic: the boot cycle's cache write must land before the
			// other session's fresher snapshot is layered on top of it.
			await waitFor(async () => (await readFile(join(agentDir, "quota-cache.json"), "utf8")).includes("moderato"));
			// Simulate the other session's fetch: fresher numbers on disk.
			await writeFile(
				join(agentDir, "quota-cache.json"),
				JSON.stringify({
					version: 2,
					snapshots: { kimi: kimiSnapshot(42, 77, Date.now()) },
					lastRequests: { kimi: Date.now() },
				}),
				"utf8",
			);
			const requestsAfterBoot = server.requests();
			const handler = pi.state.command?.handler;
			assert.ok(handler);
			await handler("refresh", pi.ctx);
			const message = pi.state.notifications.at(-1) ?? "";
			assert.match(message, /within the last minute/);
			assert.match(message, /5h 42%/, "shows the other session's fresher numbers");
			assert.equal(server.requests(), requestsAfterBoot, "no request: the shared interval holds");
		} finally {
			await rm(join(agentDir, "auth.json"), { force: true });
			server.close();
		}
	});

	it("retries a transient fetch failure once and still refreshes", async () => {
		// A single 5xx blip must not reach the user at all: the cycle retries
		// once on its own and reports success — at the cost of exactly one
		// extra request pair.
		const server = await startKimiServer(0, 1);
		try {
			// Mode off: boot starts no background refresh, so no request is sent
			// and no rate-limit slot burned before the manual one runs.
			const pi = await boot("off", kimiSnapshot(13, 77, Date.now() - 60 * MINUTE), {
				provider: "kimi-coding",
				baseUrl: server.baseUrl,
			});
			await writeFile(
				join(agentDir, "auth.json"),
				JSON.stringify({ "kimi-coding": { type: "api_key", key: "dummy-key" } }),
				"utf8",
			);
			const handler = pi.state.command?.handler;
			assert.ok(handler);
			await handler("refresh", pi.ctx);
			assert.match(pi.state.notifications.at(-1) ?? "", /Quota refreshed/);
			// /me + failed /usages, then the retry's /me + /usages: one blip, one retry.
			assert.equal(server.requests(), 4);
			assert.match(await readFile(join(agentDir, "quota-cache.json"), "utf8"), /moderato/);
		} finally {
			await rm(join(agentDir, "auth.json"), { force: true });
			server.close();
		}
	});

	it("shows a persistent fetch failure in the panel, never as a notification", async () => {
		// When the retry fails too, the user is not interrupted: the /quota
		// panel explains the outage on the provider's own line, and keeps
		// explaining it on later panels until a fetch succeeds again.
		const server = await startKimiServer(0, Number.POSITIVE_INFINITY);
		try {
			// Mode off: boot starts no background refresh, so the manual refresh
			// owns the first (and retried) attempt deterministically.
			const pi = await boot("off", kimiSnapshot(13, 77, Date.now() - 60 * MINUTE), {
				provider: "kimi-coding",
				baseUrl: server.baseUrl,
			});
			await writeFile(
				join(agentDir, "auth.json"),
				JSON.stringify({ "kimi-coding": { type: "api_key", key: "dummy-key" } }),
				"utf8",
			);
			const handler = pi.state.command?.handler;
			assert.ok(handler);
			await handler("refresh", pi.ctx);
			const messages = pi.state.notifications;
			assert.ok(
				messages.every((message) => !message.includes("refresh failed")),
				"no failure notification",
			);
			assert.match(messages.at(-1) ?? "", /quota unavailable \(HTTP 500\)/);
			// The panel is the /quota surface: a later bare /quota still explains.
			await handler("", pi.ctx);
			assert.match(pi.state.notifications.at(-1) ?? "", /quota unavailable \(HTTP 500\)/);
		} finally {
			await rm(join(agentDir, "auth.json"), { force: true });
			server.close();
		}
	});

	it("refreshes the active provider on agent activity, TTL-gated, never when fresh", async () => {
		// Boot without a credential (no request, no rate-limit slot burned),
		// then make the cache stale, due, and credentialed: firing agent_start
		// must fetch once; firing it again on the fresh cache must not.
		const server = await startKimiServer();
		await writeFile(join(agentDir, "auth.json"), JSON.stringify({ "kimi-coding": { type: "api_key" } }), "utf8");
		try {
			const pi = await boot("inline", kimiSnapshot(13, 77, Date.now() - 60 * MINUTE), {
				provider: "kimi-coding",
				baseUrl: server.baseUrl,
			});
			await writeFile(
				join(agentDir, "auth.json"),
				JSON.stringify({ "kimi-coding": { type: "api_key", key: "dummy-key" } }),
				"utf8",
			);
			// Re-seed: stale snapshot, last request just past the interval.
			await writeFile(
				join(agentDir, "quota-cache.json"),
				JSON.stringify({
					version: 2,
					snapshots: { kimi: kimiSnapshot(13, 77, Date.now() - 60 * MINUTE) },
					lastRequests: { kimi: Date.now() - 61_000 },
				}),
				"utf8",
			);
			// Let the boot refresh settle before firing agent_start: with cycles
			// serialized the event would merely queue behind it, and the sleep
			// keeps this test about agent-driven fetching, not queue ordering.
			await new Promise((resolve) => setTimeout(resolve, 50));
			const agentStart = pi.state.listeners.get("agent_start");
			assert.ok(agentStart, "agent_start listener registered");
			await agentStart({}, pi.ctx);
			await waitFor(() => server.requests() >= 2); // /usages + /me
			// Fresh now: another activity burst must be a no-op on the network.
			await new Promise((resolve) => setTimeout(resolve, 100));
			const afterFirst = server.requests();
			await agentStart({}, pi.ctx);
			await new Promise((resolve) => setTimeout(resolve, 150));
			assert.equal(server.requests(), afterFirst, "a fresh cache must not be re-fetched");
			const cache = JSON.parse(await readFile(join(agentDir, "quota-cache.json"), "utf8"));
			assert.equal(cache.snapshots.kimi.planLevel, "moderato");
		} finally {
			await rm(join(agentDir, "auth.json"), { force: true });
			server.close();
		}
	});

	it("explains a rate-limited refresh even when nothing is cached yet", async () => {
		// Mode off boots without a startup refresh, so the manual command is
		// the only fetch path and the scenario is deterministic: another
		// session asked 30s ago (persisted), nothing is cached, and the
		// command must explain the skip instead of "nothing to refresh".
		const server = await startKimiServer();
		await writeFile(
			join(agentDir, "auth.json"),
			JSON.stringify({ "kimi-coding": { type: "api_key", key: "dummy-key" } }),
			"utf8",
		);
		try {
			const pi = await boot("off", undefined, { provider: "kimi-coding", baseUrl: server.baseUrl });
			await writeFile(
				join(agentDir, "quota-cache.json"),
				JSON.stringify({ version: 2, snapshots: {}, lastRequests: { kimi: Date.now() - 30_000 } }),
				"utf8",
			);
			const handler = pi.state.command?.handler;
			assert.ok(handler);
			await handler("refresh", pi.ctx);
			const message = pi.state.notifications.at(-1) ?? "";
			assert.match(message, /within the last minute/);
			assert.match(message, /no quota data yet/);
			assert.equal(server.requests(), 0, "a limited refresh must not touch the network");
		} finally {
			await rm(join(agentDir, "auth.json"), { force: true });
			server.close();
		}
	});

	it("reports a fetch that landed despite a mid-fetch model switch", async () => {
		// A slow endpoint plus a model switch mid-fetch: the fetch succeeds
		// for the previous provider. The command must report that honestly
		// (naming the provider) instead of "nothing to refresh".
		const server = await startKimiServer(400);
		await writeFile(
			join(agentDir, "auth.json"),
			JSON.stringify({ "kimi-coding": { type: "api_key", key: "dummy-key" } }),
			"utf8",
		);
		try {
			const pi = await boot("off", undefined, { provider: "kimi-coding", baseUrl: server.baseUrl });
			const handler = pi.state.command?.handler;
			assert.ok(handler);
			const pending = handler("refresh", pi.ctx);
			const onSelect = pi.state.listeners.get("model_select");
			assert.ok(onSelect, "model_select listener registered");
			await onSelect({ model: { provider: "anthropic", id: "claude-4" } }, pi.ctx);
			await pending;
			const message = pi.state.notifications.at(-1) ?? "";
			assert.match(message, /Quota refreshed/);
			assert.match(message, /\(kimi\)/, "the report names the provider whose numbers landed");
			assert.doesNotMatch(message, /nothing to refresh/);
			assert.equal(pi.state.footerFactory, undefined, "the switched-away provider must not install the footer");
			// The fetched numbers still landed in the shared cache.
			const cache = JSON.parse(await readFile(join(agentDir, "quota-cache.json"), "utf8"));
			assert.equal(cache.snapshots.kimi.planLevel, "moderato");
		} finally {
			await rm(join(agentDir, "auth.json"), { force: true });
			server.close();
		}
	});

	it("refreshes mid-run on completed assistant turns, ignoring non-assistant messages", async () => {
		// A long task burns quota turn after turn; run boundaries alone would
		// leave the footer stale for the whole run. Each completed assistant
		// turn must re-fetch (TTL-gated), while user messages and tool results
		// — which consume no quota — must not.
		const server = await startKimiServer();
		await writeFile(
			join(agentDir, "auth.json"),
			JSON.stringify({ "kimi-coding": { type: "api_key", key: "dummy-key" } }),
			"utf8",
		);
		try {
			// Boot with a fresh snapshot: the boot cycle then takes the early
			// fresh-return path, which provably never reaches the fetch — the
			// footer install is that path's last act, so waiting for it settles
			// the cycle before the cache below goes stale and due.
			const pi = await boot("inline", kimiSnapshot(13, 77, Date.now()), {
				provider: "kimi-coding",
				baseUrl: server.baseUrl,
			});
			await waitFor(() => pi.state.footerFactory !== undefined);
			// Re-seed: stale snapshot, last request just past the interval.
			await writeFile(
				join(agentDir, "quota-cache.json"),
				JSON.stringify({
					version: 2,
					snapshots: { kimi: kimiSnapshot(13, 77, Date.now() - 60 * MINUTE) },
					lastRequests: { kimi: Date.now() - 61_000 },
				}),
				"utf8",
			);
			const messageEnd = pi.state.listeners.get("message_end");
			assert.ok(messageEnd, "message_end listener registered");
			// Non-assistant messages consume no quota and must not fetch.
			await messageEnd({ message: { role: "user", content: "hello" } }, pi.ctx);
			await messageEnd({ message: { role: "toolResult", content: [], toolCallId: "t1" } }, pi.ctx);
			await new Promise((resolve) => setTimeout(resolve, 100));
			assert.equal(server.requests(), 0, "user and tool-result messages must not trigger a fetch");
			// The run's first completed assistant turn does.
			await messageEnd({ message: { role: "assistant", content: [] } }, pi.ctx);
			await waitFor(() => server.requests() >= 2); // /usages + /me
			// Fresh now: further turns inside the TTL must not re-fetch.
			const afterFetch = server.requests();
			await messageEnd({ message: { role: "assistant", content: [] } }, pi.ctx);
			await new Promise((resolve) => setTimeout(resolve, 150));
			assert.equal(server.requests(), afterFetch, "a fresh cache must not be re-fetched mid-run");
		} finally {
			await rm(join(agentDir, "auth.json"), { force: true });
			server.close();
		}
	});

	it("shares one cache between sessions: later turns adopt instead of re-fetching", async () => {
		// Several pi sessions on one machine must not hammer a provider or
		// fight over the cache: whichever session's turn finds the shared
		// snapshot stale fetches once, and everyone else adopts the result.
		const server = await startKimiServer();
		await writeFile(
			join(agentDir, "auth.json"),
			JSON.stringify({ "kimi-coding": { type: "api_key", key: "dummy-key" } }),
			"utf8",
		);
		try {
			const model = { provider: "kimi-coding", baseUrl: server.baseUrl };
			const cacheText = () => readFile(join(agentDir, "quota-cache.json"), "utf8");
			// First session boots against a stale, due cache and fetches once.
			const first = await boot("inline", kimiSnapshot(13, 77, Date.now() - 60 * MINUTE), model);
			await waitFor(async () => (await cacheText()).includes("moderato"));
			assert.equal(server.requests(), 2, "exactly the first session's boot cycle: /usages + /me");
			// Second session, same machine, sharing the cache file: its boot
			// cycle adopts the fresh numbers and sends nothing.
			const second = await boot("inline", undefined, model, "tui", true);
			await waitFor(() => second.state.footerFactory !== undefined);
			assert.equal(server.requests(), 2, "a fresh shared cache must spare the second session's boot fetch");
			const factory = second.state.footerFactory;
			assert.ok(factory);
			// The first session completes a later turn (distinctive numbers on
			// disk, reservation within the minute): the second session's own
			// turn must adopt them without a request of its own.
			await writeFile(
				join(agentDir, "quota-cache.json"),
				JSON.stringify({
					version: 2,
					snapshots: { kimi: kimiSnapshot(42, 77, Date.now()) },
					lastRequests: { kimi: Date.now() },
				}),
				"utf8",
			);
			const secondTurn = second.state.listeners.get("message_end");
			assert.ok(secondTurn, "message_end listener registered");
			await secondTurn({ message: { role: "assistant", content: [] } }, second.ctx);
			await waitFor(() => renderFooter(factory, 120).join("\n").includes("42%"));
			assert.equal(server.requests(), 2, "adopting fresh shared numbers must not send a request");
			// Stale and due again: this time the second session's turn fetches,
			// and the first session's next turn adopts the result instead of
			// requesting again — one fetch per interval serves them all.
			await writeFile(
				join(agentDir, "quota-cache.json"),
				JSON.stringify({
					version: 2,
					snapshots: { kimi: kimiSnapshot(13, 77, Date.now() - 60 * MINUTE) },
					lastRequests: { kimi: Date.now() - 61_000 },
				}),
				"utf8",
			);
			await secondTurn({ message: { role: "assistant", content: [] } }, second.ctx);
			await waitFor(async () => (await cacheText()).includes("moderato") && server.requests() >= 4);
			const firstTurn = first.state.listeners.get("message_end");
			assert.ok(firstTurn);
			await firstTurn({ message: { role: "assistant", content: [] } }, first.ctx);
			await new Promise((resolve) => setTimeout(resolve, 150));
			assert.equal(server.requests(), 4, "the first session must adopt the second's fresh fetch");
		} finally {
			await rm(join(agentDir, "auth.json"), { force: true });
			server.close();
		}
	});

	it("sends no background requests in off mode or outside the TUI", async () => {
		// Activity refreshes only run where a footer could show them: mode
		// off and non-TUI sessions (RPC) stay completely quiet on agent
		// activity — the /quota panel fetches on demand, never in the background.
		const server = await startKimiServer();
		await writeFile(
			join(agentDir, "auth.json"),
			JSON.stringify({ "kimi-coding": { type: "api_key", key: "dummy-key" } }),
			"utf8",
		);
		try {
			const model = { provider: "kimi-coding", baseUrl: server.baseUrl };
			const off = await boot("off", kimiSnapshot(13, 77, Date.now() - 60 * MINUTE), model);
			const offStart = off.state.listeners.get("agent_start");
			assert.ok(offStart, "agent_start listener registered");
			await offStart({}, off.ctx);
			await off.state.listeners.get("agent_end")?.({}, off.ctx);
			const rpc = await boot("inline", kimiSnapshot(13, 77, Date.now() - 60 * MINUTE), model, "rpc");
			const rpcStart = rpc.state.listeners.get("agent_start");
			assert.ok(rpcStart);
			await rpcStart({}, rpc.ctx);
			await new Promise((resolve) => setTimeout(resolve, 150));
			assert.equal(server.requests(), 0, "off and non-TUI sessions must not fetch on activity");
		} finally {
			await rm(join(agentDir, "auth.json"), { force: true });
			server.close();
		}
	});
});
