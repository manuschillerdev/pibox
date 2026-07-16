import { randomUUID } from "node:crypto";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
  createModelCredential,
  type ModelCredential,
} from "./model-credentials.js";

export interface AppliedCredential {
  provider: string;
  secretName: string;
  sourceEnvName: string;
  placeholder: string;
  allowedHosts: string[];
  metadata?: Record<string, string>;
  lastAppliedValue: string;
}

export interface PreparedCredential extends AppliedCredential {
  credential: ModelCredential;
}

export interface SkippedProvider {
  provider: string;
  reason: string;
}

export interface PreparedCredentialSet {
  credentials: PreparedCredential[];
  skipped: SkippedProvider[];
}

export interface CredentialBroker {
  refresh(credential: PreparedCredential, value: string): Promise<void>;
  cleanup(): void;
}

export class AuthRelay {
  readonly providerState = new Map<string, AppliedCredential>();
  private readonly credentials = new Map<string, PreparedCredential>();
  private readonly skippedProviders: Map<string, string>;

  constructor(
    private readonly workerId: string,
    private readonly modelRegistry: ModelRegistry,
    prepared: PreparedCredentialSet,
    private readonly broker: CredentialBroker,
  ) {
    this.skippedProviders = new Map(
      prepared.skipped.map((provider) => [provider.provider, provider.reason]),
    );
    for (const credential of prepared.credentials) {
      this.credentials.set(credential.provider, credential);
      this.providerState.set(credential.provider, stripCredential(credential));
    }
  }

  static async prepareAvailable(
    workerId: string,
    modelRegistry: ModelRegistry,
  ): Promise<PreparedCredentialSet> {
    type AvailableModel = ReturnType<ModelRegistry["getAvailable"]>[number];
    const byProvider = new Map<string, AvailableModel[]>();
    for (const model of modelRegistry.getAvailable()) {
      const models = byProvider.get(model.provider) ?? [];
      models.push(model);
      byProvider.set(model.provider, models);
    }

    const credentials: PreparedCredential[] = [];
    const skipped: SkippedProvider[] = [];
    for (const [provider, models] of [...byProvider].sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      let credential: ModelCredential;
      try {
        const sample = models[0];
        if (!sample) continue;
        credential = createModelCredential(
          provider,
          models.map((model) => ({
            provider: model.provider,
            baseUrl: model.baseUrl,
          })),
          modelRegistry.isUsingOAuth(sample),
        );
      } catch (error) {
        skipped.push({ provider, reason: errorMessage(error) });
        continue;
      }

      const hostCredential = await modelRegistry.getApiKeyForProvider(provider);
      if (!hostCredential) {
        skipped.push({
          provider,
          reason: "the host credential could not be resolved to an API key",
        });
        continue;
      }
      try {
        const created = credential.createPlaceholder(hostCredential);
        credentials.push({
          provider,
          secretName: credential.secretName,
          sourceEnvName: uniqueSourceEnvironment(workerId, provider),
          placeholder: created.placeholder,
          allowedHosts: [...credential.allowedHosts],
          ...optionalMetadata(created.metadata),
          lastAppliedValue: hostCredential,
          credential,
        });
      } catch (error) {
        skipped.push({ provider, reason: errorMessage(error) });
      }
    }

    if (credentials.length === 0) {
      const detail = skipped.length
        ? ` (${skipped.map((item) => `${item.provider}: ${item.reason}`).join("; ")})`
        : "";
      throw new Error(
        `Host Pi has no credentials that Pibox can relay; log in or configure an API key on the host${detail}`,
      );
    }
    return { credentials, skipped };
  }

  async refresh(provider: string): Promise<boolean> {
    const state = this.providerState.get(provider);
    const prepared = this.credentials.get(provider);
    if (!state || !prepared) {
      const reason = this.skippedProviders.get(provider);
      throw new Error(
        reason
          ? `Provider ${provider} was not relayed to worker ${this.workerId}: ${reason}`
          : `Provider ${provider} is not configured for worker ${this.workerId}`,
      );
    }
    const hostCredential = await resolveHostCredential(this.modelRegistry, provider);
    if (hostCredential === state.lastAppliedValue) return false;

    prepared.credential.verifyRotation(hostCredential, state.metadata);
    await this.broker.refresh(prepared, hostCredential);
    prepared.lastAppliedValue = hostCredential;
    state.lastAppliedValue = hostCredential;
    return true;
  }

  guestAuthJson(): Record<string, { type: "api_key"; key: string }> {
    return Object.fromEntries(
      [...this.credentials.values()].map((prepared) => [
        prepared.provider,
        prepared.credential.guestCredential(prepared.placeholder),
      ]),
    );
  }

  relayedProviders(): string[] {
    return [...this.providerState.keys()].sort();
  }

  cleanup(): void {
    this.broker.cleanup();
    for (const prepared of this.credentials.values()) {
      prepared.lastAppliedValue = "";
    }
    for (const state of this.providerState.values()) state.lastAppliedValue = "";
    this.credentials.clear();
    this.providerState.clear();
  }
}

async function resolveHostCredential(
  modelRegistry: ModelRegistry,
  provider: string,
): Promise<string> {
  const value = await modelRegistry.getApiKeyForProvider(provider);
  if (!value) {
    throw new Error(
      `Host Pi has no available ${provider} credential; refresh or log in to ${provider} on the host coordinator`,
    );
  }
  return value;
}

function uniqueSourceEnvironment(workerId: string, provider: string): string {
  const safeWorker = workerId.replace(/[^A-Za-z0-9]/g, "_").slice(-32);
  const safeProvider = provider.replace(/[^A-Za-z0-9]/g, "_").slice(-24);
  return `PIBOX_SOURCE_${safeWorker}_${safeProvider}_${randomUUID().replaceAll("-", "")}`;
}

function stripCredential(prepared: PreparedCredential): AppliedCredential {
  return {
    provider: prepared.provider,
    secretName: prepared.secretName,
    sourceEnvName: prepared.sourceEnvName,
    placeholder: prepared.placeholder,
    allowedHosts: prepared.allowedHosts,
    ...optionalMetadata(prepared.metadata),
    lastAppliedValue: prepared.lastAppliedValue,
  };
}

function optionalMetadata(
  metadata: Record<string, string> | undefined,
): { metadata: Record<string, string> } | Record<never, never> {
  return metadata === undefined ? {} : { metadata };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
