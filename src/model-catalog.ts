import type { ExtensionAPI, ModelRegistry } from "@earendil-works/pi-coding-agent";

type ProviderConfig = Parameters<ExtensionAPI["registerProvider"]>[1];

/** Relay model metadata without copying host credentials or arbitrary headers. */
export function guestModelCatalog(
  models: ReturnType<ModelRegistry["getAvailable"]>,
  relayedProviders: Iterable<string>,
): Record<string, Pick<ProviderConfig, "baseUrl" | "models">> {
  const providers = Object.create(null) as Record<
    string,
    { baseUrl: string; models: NonNullable<ProviderConfig["models"]> }
  >;
  const relayed = new Set(relayedProviders);
  for (const model of models) {
    if (!relayed.has(model.provider)) continue;
    const provider = providers[model.provider] ??= {
      baseUrl: model.baseUrl,
      models: [],
    };
    // NVIDIA's polling header is part of the request protocol, not auth.
    // An explicit numeric allowlist avoids forwarding host Authorization,
    // cookies, API keys, or custom headers masquerading as model metadata.
    const polling = Object.entries(model.headers ?? {}).find(
      ([name, value]) => name.toLowerCase() === "nvcf-poll-seconds" && /^\d+$/.test(value),
    )?.[1];
    const headers = {
      ...(polling ? { "NVCF-POLL-SECONDS": polling } : {}),
      ...(model.provider === "kimi-coding" ? { "User-Agent": "KimiCLI/1.5" } : {}),
      ...(model.provider === "github-copilot" ? {
        "User-Agent": "GitHubCopilotChat/0.35.0",
        "Editor-Version": "vscode/1.107.0",
        "Editor-Plugin-Version": "copilot-chat/0.35.0",
        "Copilot-Integration-Id": "vscode-chat",
      } : {}),
    };
    provider.models.push({
      id: model.id,
      name: model.name,
      api: model.api,
      baseUrl: model.baseUrl,
      reasoning: model.reasoning,
      input: model.input,
      cost: model.cost,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      thinkingLevelMap: model.thinkingLevelMap,
      compat: model.compat,
      ...(Object.keys(headers).length ? { headers } : {}),
    });
  }
  return providers;
}
