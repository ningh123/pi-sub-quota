/**
 * Persisted display settings (`<agent-dir>/quota-settings.json`).
 *
 * Parsing and serialization are pure so they can be tested; file I/O lives
 * in the extension entry.
 */

export type QuotaMode = "line" | "inline" | "off";

export const MODES: readonly QuotaMode[] = ["line", "inline", "off"];

export const DEFAULT_MODE: QuotaMode = "inline";

/** Settings written before the "bar" → "line" rename keep working. */
const LEGACY_MODE_ALIASES: Record<string, QuotaMode> = { bar: "line" };

export interface QuotaSettings {
	mode: QuotaMode;
}

export function parseSettings(text: string | undefined): QuotaSettings {
	if (!text) return { mode: DEFAULT_MODE };
	try {
		const raw: unknown = JSON.parse(text);
		if (typeof raw !== "object" || raw === null) return { mode: DEFAULT_MODE };
		const mode = (raw as { mode?: unknown }).mode;
		if (typeof mode === "string" && (MODES as readonly string[]).includes(mode)) {
			return { mode: mode as QuotaMode };
		}
		if (typeof mode === "string" && LEGACY_MODE_ALIASES[mode]) {
			return { mode: LEGACY_MODE_ALIASES[mode] };
		}
		return { mode: DEFAULT_MODE };
	} catch {
		return { mode: DEFAULT_MODE };
	}
}

export function serializeSettings(settings: QuotaSettings): string {
	return `${JSON.stringify(settings, null, "\t")}\n`;
}
