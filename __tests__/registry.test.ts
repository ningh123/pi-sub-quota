import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { configuredQuotaProviders, deepseekProvider, detectProvider, kimiProvider, zaiProvider } from "../providers/index.ts";

describe("detectProvider", () => {
	it("maps known provider ids to their provider", () => {
		assert.equal(detectProvider("zai-coding-cn"), zaiProvider);
		assert.equal(detectProvider("ZAI-Coding-CN"), zaiProvider);
		assert.equal(detectProvider("glm-coding-cn"), zaiProvider);
		assert.equal(detectProvider("kimi-coding"), kimiProvider);
		assert.equal(detectProvider("DeepSeek"), deepseekProvider);
	});

	it("falls back to the baseUrl for custom providers on the real hosts", () => {
		assert.equal(detectProvider("my-proxy", "https://open.bigmodel.cn/api/coding/paas/v4"), zaiProvider);
		assert.equal(detectProvider("my-proxy", "https://api.z.ai/api/coding/paas/v4"), zaiProvider);
		assert.equal(detectProvider("my-proxy", "https://api.kimi.com/coding/v1"), kimiProvider);
		assert.equal(detectProvider("my-proxy", "https://api.kimi.ai/coding/v1"), kimiProvider);
		assert.equal(detectProvider("my-proxy", "https://api.deepseek.com"), deepseekProvider);
	});

	it("matches subdomains of the known hosts", () => {
		assert.equal(detectProvider("my-proxy", "https://cn.bigmodel.cn/api/paas/v4"), zaiProvider);
		assert.equal(detectProvider("my-proxy", "https://regional.api.kimi.ai/coding/v1"), kimiProvider);
	});

	it("rejects lookalike hosts that merely embed a known domain", () => {
		// Substring matching here would pair a credential with an unrelated host.
		assert.equal(detectProvider("corp-proxy", "https://kimi.company.com/coding/v1"), undefined);
		assert.equal(detectProvider("corp-proxy", "https://kimi.com.example.org/coding/v1"), undefined);
		assert.equal(detectProvider("corp-proxy", "https://bigmodel.cn.example.org/api/coding/paas/v4"), undefined);
		assert.equal(detectProvider("corp-proxy", "https://evil-z.ai.community/coding/v1"), undefined);
		assert.equal(detectProvider("corp-proxy", "https://deepseek.company.com/v1"), undefined);
	});

	it("does not match a plain z.ai or kimi.com URL without a coding path", () => {
		assert.equal(detectProvider("my-proxy", "https://api.z.ai/api/paas/v4"), undefined);
		assert.equal(detectProvider("my-proxy", "https://api.kimi.com/v1"), undefined);
	});

	it("resolves the provider id before the base URL and returns undefined for unrelated input", () => {
		// The id names kimi; a bigmodel.cn proxy URL must not claim the model for zai.
		assert.equal(detectProvider("kimi-coding", "https://open.bigmodel.cn/api/coding/paas/v4"), kimiProvider);
		assert.equal(detectProvider("anthropic"), undefined);
		assert.equal(detectProvider("opencode", "https://opencode.ai/zen/v1"), undefined);
		assert.equal(detectProvider(undefined), undefined);
		assert.equal(detectProvider("my-proxy", "not a url"), undefined);
		// A known coding-plan base URL matches even without a provider id.
		assert.equal(detectProvider(undefined, "https://open.bigmodel.cn/api/coding/paas/v4"), zaiProvider);
	});
});

describe("configuredQuotaProviders", () => {
	it("maps auth.json provider ids to providers, one per kind", () => {
		const configured = configuredQuotaProviders({
			"zai-coding-cn": { type: "api_key", key: "zai" },
			"glm-coding": { type: "api_key", key: "glm" },
			anthropic: { type: "api_key", key: "x" },
			"kimi-coding": { type: "oauth", access: "k" },
		});
		assert.deepEqual(configured, [
			{ provider: zaiProvider, providerId: "zai-coding-cn" },
			{ provider: kimiProvider, providerId: "kimi-coding" },
		]);
	});

	it("returns empty without auth.json configuration", () => {
		assert.deepEqual(configuredQuotaProviders(undefined), []);
	});
});
