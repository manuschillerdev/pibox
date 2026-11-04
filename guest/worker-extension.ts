import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface GuestCredential {
  type?: unknown;
  key?: unknown;
}

export default async function workerExtension(pi: ExtensionAPI): Promise<void> {
  const profileDir = process.env.PI_CODING_AGENT_DIR;
  if (!profileDir) {
    throw new Error("PI_CODING_AGENT_DIR is required by the Pibox worker extension");
  }
  const auth = JSON.parse(
    await readFile(join(profileDir, "auth.json"), "utf8"),
  ) as Record<string, GuestCredential>;
  type ProviderConfig = Parameters<ExtensionAPI["registerProvider"]>[1];
  const models = JSON.parse(
    await readFile(join(profileDir, "pibox-models.json"), "utf8"),
  ) as Record<string, Pick<ProviderConfig, "baseUrl" | "models">>;
  for (const [provider, credential] of Object.entries(auth)) {
    if (credential.type !== "api_key" || typeof credential.key !== "string") {
      continue;
    }
    pi.registerProvider(provider, {
      ...models[provider],
      apiKey: credential.key,
    });
  }

  pi.on("model_select", (event, ctx) => {
    ctx.ui.setStatus(
      "pibox-model",
      `${event.model.provider}/${event.model.id}`,
    );
  });
}
