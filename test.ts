/**
 * Deterministic model-mapping test and optional live check against the Command
 * Code API.
 *
 *   node test.ts                                      # mapping test
 *   node test.ts --live                               # list the live catalog
 *   CMD_API_KEY=... node test.ts --live               # one model per API
 *   CMD_API_KEY=... node test.ts --live claude-sonnet-5
 *   CMD_API_KEY=... node test.ts --live --all
 *   CMD_API_KEY=... node test.ts --live --reasoning high claude-sonnet-5
 *
 * With no CMD_API_KEY set, it prints the routing table, which shows what the
 * live /models endpoint serves.
 */

import assert from "node:assert/strict";
import { createModels, type Api, type Model, type ThinkingLevel } from "@earendil-works/pi-ai";
import { commandCodeProvider, loadModels } from "./index.ts";

const DEFAULT_IDS = ["claude-sonnet-5", "gpt-5.6-luna", "moonshotai/Kimi-K3"];

const WEATHER_TOOL = {
	name: "get_weather",
	description: "Get the current weather for a city.",
	parameters: {
		type: "object" as const,
		properties: { city: { type: "string" as const, description: "City name" } },
		required: ["city"],
		additionalProperties: false,
	},
};

async function testModelMapping(): Promise<void> {
	const fixture = {
		data: [
			{ id: "claude-opus-5", supported_endpoints: ["/messages"], context_length: 200_000 },
			{ id: "gpt-test", supported_endpoints: ["/chat/completions", "/responses"] },
			{ id: "vendor/new-model", supported_endpoints: ["/chat/completions", "/responses"] },
			{
				id: "vendor/capable-model",
				supported_endpoints: ["/chat/completions"],
				reasoning: true,
				modalities: { input: ["text", "image"] },
				max_output_tokens: 8_192,
			},
			{ id: "vendor/unsupported", supported_endpoints: ["/unknown"] },
		],
	};
	const url = `data:application/json,${encodeURIComponent(JSON.stringify(fixture))}`;
	const models = await loadModels(url);

	assert.equal(models.length, 4);
	assert.deepEqual(
		models.map(({ id, api, reasoning, input }) => ({ id, api, reasoning, input })),
		[
			{ id: "claude-opus-5", api: "anthropic-messages", reasoning: true, input: ["text", "image"] },
			{ id: "gpt-test", api: "openai-responses", reasoning: true, input: ["text", "image"] },
			{ id: "vendor/new-model", api: "openai-completions", reasoning: true, input: ["text"] },
			{
				id: "vendor/capable-model",
				api: "openai-completions",
				reasoning: true,
				input: ["text", "image"],
			},
		],
	);
	assert.equal(models[0]?.contextWindow, 200_000);
	assert.equal(models[3]?.maxTokens, 8_192);
	assert.deepEqual(models[0]?.compat, { forceAdaptiveThinking: true });
	assert.deepEqual(models[2]?.compat, { supportsDeveloperRole: false, maxTokensField: "max_tokens" });
}

async function main(): Promise<void> {
	if (!process.argv.includes("--live")) {
		await testModelMapping();
		console.log("model mapping: ok");
		return;
	}

	const apiKey = process.env.CMD_API_KEY;
	const args = process.argv.slice(2).filter((arg) => arg !== "--live");
	const all = args.includes("--all");
	const reasoningIndex = args.indexOf("--reasoning");
	const reasoning = reasoningIndex >= 0 ? (args[reasoningIndex + 1] as ThinkingLevel) : undefined;
	const requested = args.filter(
		(arg, index) => !arg.startsWith("--") && (reasoningIndex < 0 || index !== reasoningIndex + 1),
	);

	const catalog = await loadModels();
	console.log(`catalog: ${catalog.length} models (live)`);
	const byApi = new Map<Api, number>();
	for (const model of catalog) byApi.set(model.api, (byApi.get(model.api) ?? 0) + 1);
	for (const [api, count] of [...byApi].sort()) console.log(`  ${api}: ${count}`);
	const priced = catalog.filter((model) => model.cost.input > 0).length;
	console.log(`  priced by the API: ${priced}/${catalog.length}`);

	if (!apiKey) {
		console.log("\nCMD_API_KEY is unset, skipping live completions.");
		return;
	}

	const models = createModels();
	models.setProvider(commandCodeProvider(catalog));
	const targets: Model<Api>[] = all
		? catalog
		: (requested.length > 0 ? requested : DEFAULT_IDS).map((id) => {
				const model = catalog.find((entry) => entry.id === id);
				if (!model) throw new Error(`unknown model: ${id}`);
				return model;
			});

	let failed = 0;
	for (const model of targets) {
		const result = await models.completeSimple(
			model,
			{
				systemPrompt: "Call the tool. Do not answer from memory.",
				messages: [{ role: "user", content: "Weather in Lisbon?", timestamp: Date.now() }],
				tools: [WEATHER_TOOL],
			},
			{ apiKey, maxTokens: reasoning ? 4096 : 512, ...(reasoning ? { reasoning } : {}) },
		);
		const calls = result.content.filter((block) => block.type === "toolCall").length;
		const thinking = result.content.filter((block) => block.type === "thinking").length;
		const status = result.stopReason === "error" ? "ERROR" : calls > 0 ? "tool" : result.stopReason;
		if (result.stopReason === "error") failed++;
		console.log(
			`${String(status).padEnd(6)} ${model.api.padEnd(19)} ${model.id.padEnd(38)}` +
				`${reasoning ? ` think=${thinking}/${result.usage.reasoning ?? 0}` : ""}` +
				`${result.errorMessage ? ` ${result.errorMessage.slice(0, 100)}` : ""}`,
		);
	}
	console.log(`\n${targets.length} models | failed=${failed}`);
	if (failed > 0) process.exitCode = 1;
}

await main();
