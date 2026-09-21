/**
 * Official Command Code provider for pi. Requires pi 0.86 or newer for the
 * stable native-provider exports used below.
 *
 * The model list and the route for each model come from
 * https://api.commandcode.ai/provider/v1/models at startup. No part of the
 * catalog is hardcoded, so new Command Code models appear without a change
 * here. Capability metadata comes from the endpoint when available; known
 * families have temporary fallbacks until the endpoint supplies it.
 *
 * That endpoint returns ids, names, context windows and routes, but no prices,
 * so pi reports $0 per model. `toModel` already reads `pricing`,
 * `max_output_tokens`, `modalities` and `reasoning`, so the API can close that
 * gap on its own. See https://commandcode.ai/models for the real prices.
 *
 * Usage:
 *   pi install https://github.com/CommandCodeAI/pi-commandcode-provider
 *   # then /login command-code, or set CMD_API_KEY=...
 */

import {
	createProvider,
	envApiKeyAuth,
	type Api,
	type Model,
	type Provider,
	type ProviderEnv,
} from "@earendil-works/pi-ai";
// pi resolves bundled pi-ai imports for installed extensions by name, and only
// the root, /compat, /oauth and /providers/all are mapped. The /api/*.lazy
// subpaths are not, so they fail to load from an npm install. /compat
// re-exports the same lazy factories.
import { anthropicMessagesApi, openAICompletionsApi, openAIResponsesApi } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = "command-code";
const PROVIDER_NAME = "Command Code";
// The Anthropic SDK appends /v1/messages to the base URL. The OpenAI SDKs
// append /chat/completions and /responses.
const BASE_URL = "https://api.commandcode.ai/provider";
const OPENAI_BASE_URL = `${BASE_URL}/v1`;
const MODELS_URL = `${OPENAI_BASE_URL}/models`;
const MODELS_TIMEOUT_MS = 10_000;

const ZDR_HEADER = "x-cmd-zdr";
const ZDR_ENV = "CMD_ZDR";
const MODELS_URL_ENV = "CMD_MODELS_URL";

const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const FALLBACK_MAX_TOKENS = 32_768;
const FALLBACK_CONTEXT_WINDOW = 131_072;

/**
 * One entry from /provider/v1/models. The API does not return the fields after
 * `supported_endpoints` yet. This reads them anyway, so the extension picks
 * them up as soon as the API sends them.
 */
interface CommandCodeModelListItem {
	id: string;
	name?: string;
	context_length?: number;
	supported_endpoints?: string[];
	pricing?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
	max_output_tokens?: number;
	modalities?: { input?: string[] };
	reasoning?: boolean;
}

/**
 * Capability defaults per model family, used until /models reports them.
 */
const FAMILIES: { match: RegExp; reasoning: boolean; vision: boolean }[] = [
	{ match: /^claude-/, reasoning: true, vision: true },
	{ match: /^gpt-/, reasoning: true, vision: true },
	{ match: /^google\//, reasoning: true, vision: true },
];

/**
 * Claude models from Opus 4.6, Sonnet 4.6 and Fable 5 onward reject
 * `thinking: {type: "enabled"}` and require `{type: "adaptive"}` with
 * `output_config.effort`. Without this match, pi sends the budget form and the
 * gateway answers 400.
 */
const ADAPTIVE_THINKING = /(opus[-.](4[-.]6|4[-.]7|4[-.]8|5)|sonnet[-.](4[-.]6|5)|fable[-.]5|mythos[-.]5)/;

function envValue(name: string, env?: ProviderEnv): string | undefined {
	return env?.[name] || (typeof process !== "undefined" ? process.env[name] : undefined) || undefined;
}

function toModel(item: CommandCodeModelListItem): Model<Api> | undefined {
	const endpoints = item.supported_endpoints ?? [];
	// Claude answers on /messages only and returns 400 on any other route.
	// OpenAI ids go to Responses. Everything else uses Chat Completions.
	const api: Api | undefined = endpoints.includes("/messages")
		? "anthropic-messages"
		: endpoints.includes("/responses") && item.id.startsWith("gpt-")
			? "openai-responses"
			: endpoints.includes("/chat/completions")
				? "openai-completions"
				: endpoints.includes("/responses")
					? "openai-responses"
					: undefined;
	if (!api) return undefined;

	const family = FAMILIES.find((entry) => entry.match.test(item.id));
	const vision = item.modalities?.input ? item.modalities.input.includes("image") : (family?.vision ?? false);
	const model: Model<Api> = {
		id: item.id,
		name: item.name || item.id,
		api,
		provider: PROVIDER_ID,
		baseUrl: api === "anthropic-messages" ? BASE_URL : OPENAI_BASE_URL,
		reasoning: item.reasoning ?? family?.reasoning ?? true,
		input: vision ? ["text", "image"] : ["text"],
		cost: item.pricing
			? {
					input: item.pricing.input ?? 0,
					output: item.pricing.output ?? 0,
					cacheRead: item.pricing.cache_read ?? 0,
					cacheWrite: item.pricing.cache_write ?? 0,
				}
			: NO_COST,
		contextWindow: item.context_length || FALLBACK_CONTEXT_WINDOW,
		maxTokens: item.max_output_tokens || FALLBACK_MAX_TOKENS,
		// CMD_ZDR=1 enforces zero-data-retention routing, the same switch the
		// Command Code CLI has. The gateway then serves the request from a
		// zero-data-retention upstream, or fails with 422 instead of using an
		// upstream that retains data. The header goes on the model because that
		// is the field pi merges into each request.
		...(envValue(ZDR_ENV) === "1" ? { headers: { [ZDR_HEADER]: "1" } } : {}),
	};

	if (api === "openai-completions") {
		// Several upstreams behind this route reject the `developer` role that pi
		// sends to reasoning models. Every upstream accepts `system`.
		model.compat = { supportsDeveloperRole: false, maxTokensField: "max_tokens" };
	} else if (api === "anthropic-messages" && ADAPTIVE_THINKING.test(item.id)) {
		model.compat = { forceAdaptiveThinking: true };
	}
	return model;
}

export async function loadModels(url = MODELS_URL, signal?: AbortSignal): Promise<Model<Api>[]> {
	const response = await fetch(url, { signal: signal ?? AbortSignal.timeout(MODELS_TIMEOUT_MS) });
	if (!response.ok) throw new Error(`Command Code /models returned ${response.status}`);
	const body = (await response.json()) as { data?: CommandCodeModelListItem[] };
	const items = Array.isArray(body.data) ? body.data : [];
	return items.map(toModel).filter((model): model is Model<Api> => model !== undefined);
}

export function commandCodeProvider(models: Model<Api>[]): Provider<Api> {
	return createProvider<Api>({
		id: PROVIDER_ID,
		name: PROVIDER_NAME,
		auth: { apiKey: envApiKeyAuth("Command Code API key", ["CMD_API_KEY", "COMMAND_CODE_API_KEY"]) },
		models,
		api: {
			"anthropic-messages": anthropicMessagesApi(),
			"openai-completions": openAICompletionsApi(),
			"openai-responses": openAIResponsesApi(),
		},
	});
}

export default async function activate(pi: ExtensionAPI): Promise<void> {
	try {
		pi.registerProvider(commandCodeProvider(await loadModels(envValue(MODELS_URL_ENV) ?? MODELS_URL)));
	} catch (error) {
		// No catalog means no models. Report that instead of registering an
		// empty provider.
		const reason = error instanceof Error ? error.message : String(error);
		pi.on("session_start", async (_event, ctx) => {
			ctx.ui.notify(`Command Code: could not load the model list (${reason}).`, "warning");
		});
	}
}
