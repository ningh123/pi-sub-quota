import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_MODE, MODES, parseSettings, serializeSettings } from "../settings.ts";

describe("parseSettings", () => {
	it("accepts the known modes and round-trips through serializeSettings", () => {
		for (const mode of MODES) {
			const parsed = parseSettings(serializeSettings({ mode }));
			assert.deepEqual(parsed, { mode });
		}
	});

	it("falls back to the default mode for missing, corrupt, or invalid input", () => {
		assert.deepEqual(parseSettings(undefined), { mode: DEFAULT_MODE });
		assert.deepEqual(parseSettings("not json"), { mode: DEFAULT_MODE });
		assert.deepEqual(parseSettings('{"mode": "fancy"}'), { mode: DEFAULT_MODE });
		assert.deepEqual(parseSettings('{"mode": 3}'), { mode: DEFAULT_MODE });
	});

	it("maps the legacy bar mode alias from before the rename to line", () => {
		assert.deepEqual(parseSettings('{"mode": "bar"}'), { mode: "line" });
	});
});
