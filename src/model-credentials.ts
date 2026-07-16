import { createHash } from "node:crypto";

const CODEX_PROVIDER = "openai-codex";
const CODEX_CLAIM = "https://api.openai.com/auth";

export interface ModelEndpoint {
  provider: string;
  baseUrl: string;
}

export interface CredentialPlaceholder {
  placeholder: string;
  metadata?: Record<string, string>;
}

export interface ModelCredential {
  provider: string;
  secretName: string;
  allowedHosts: string[];
  createPlaceholder(hostCredential: string): CredentialPlaceholder;
  guestCredential(placeholder: string): {
    type: "api_key";
    key: string;
  };
  verifyRotation(
    hostCredential: string,
    metadata: Record<string, string> | undefined,
  ): void;
}

export function createModelCredential(
  provider: string,
  models: ModelEndpoint[],
  usesOAuth: boolean,
): ModelCredential {
  if (provider === CODEX_PROVIDER) return openAICodexCredential;
  if (usesOAuth) {
    throw new Error(
      `Provider ${provider} uses OAuth request semantics that require an explicit Pibox adapter`,
    );
  }

  const allowedHosts = endpointHosts(models);
  if (allowedHosts.length === 0) {
    throw new Error(
      `Provider ${provider} has no HTTPS model endpoint that can receive a brokered credential`,
    );
  }
  const secretName = providerSecretName(provider);
  return {
    provider,
    secretName,
    allowedHosts,
    createPlaceholder() {
      return {
        placeholder: `$PIBOX_PLACEHOLDER_${secretName.slice("PIBOX_AUTH_".length)}`,
      };
    },
    guestCredential() {
      return { type: "api_key", key: `$${secretName}` };
    },
    verifyRotation() {},
  };
}

export const openAICodexCredential: ModelCredential = {
  provider: CODEX_PROVIDER,
  secretName: "PIBOX_AUTH_OPENAI_CODEX",
  allowedHosts: ["chatgpt.com"],

  createPlaceholder(hostCredential) {
    const accountId = extractCodexAccountId(hostCredential);
    return {
      placeholder: syntheticCodexJwt(accountId),
      metadata: { accountId },
    };
  },

  guestCredential() {
    return { type: "api_key", key: "$PIBOX_AUTH_OPENAI_CODEX" };
  },

  verifyRotation(hostCredential, metadata) {
    const accountId = extractCodexAccountId(hostCredential);
    if (accountId !== metadata?.accountId) {
      throw new Error(
        "The host openai-codex account changed; recreate the worker so its synthetic account placeholder can be replaced safely",
      );
    }
  },
};

export function extractCodexAccountId(token: string): string {
  const segments = token.split(".");
  if (segments.length !== 3 || !segments[1]) {
    throw new Error("The host openai-codex credential is not a three-segment access JWT");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8"));
  } catch {
    throw new Error("Unable to decode the host openai-codex access JWT");
  }
  if (typeof payload !== "object" || payload === null) {
    throw new Error("The host openai-codex access JWT has an invalid payload");
  }
  const claim = (payload as Record<string, unknown>)[CODEX_CLAIM];
  if (typeof claim !== "object" || claim === null) {
    throw new Error(`The host openai-codex access JWT is missing ${CODEX_CLAIM}`);
  }
  const accountId = (claim as Record<string, unknown>).chatgpt_account_id;
  if (typeof accountId !== "string" || !accountId) {
    throw new Error("The host openai-codex access JWT is missing chatgpt_account_id");
  }
  return accountId;
}

export function syntheticCodexJwt(accountId: string): string {
  const header = encodeJson({ alg: "none", typ: "JWT" });
  const payload = encodeJson({
    [CODEX_CLAIM]: { chatgpt_account_id: accountId },
  });
  return `${header}.${payload}.pibox`;
}

function endpointHosts(models: ModelEndpoint[]): string[] {
  const hosts = new Set<string>();
  for (const model of models) {
    try {
      const endpoint = new URL(model.baseUrl);
      if (endpoint.protocol === "https:" || endpoint.protocol === "wss:") {
        hosts.add(endpoint.hostname.toLowerCase());
      }
    } catch {
      // The provider is rejected below if no valid TLS endpoint remains.
    }
  }
  return [...hosts].sort();
}

function providerSecretName(provider: string): string {
  const slug = provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const hash = createHash("sha256").update(provider).digest("hex").slice(0, 12).toUpperCase();
  return `PIBOX_AUTH_${slug.slice(0, 32) || "PROVIDER"}_${hash}`;
}

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
