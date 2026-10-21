/**
 * Shared test helpers. Lives outside the `*.test.ts` glob so node --test
 * never picks it up as a test file; importing helpers from a test file would
 * re-run that file's suites inside every importing process.
 */

/** A JSON Response fake for injected fetch implementations. */
export function jsonResponse(body: unknown, status = 200): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => body,
	} as Response;
}
