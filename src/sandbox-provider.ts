import type {
  CredentialBroker,
  PreparedCredential,
} from "./auth-relay.js";
import type { SandboxProviderName } from "./config.js";
import type { SandboxProvider } from "./sandbox.js";
import { prepareMicrosandboxNative } from "./sandboxes/microsandbox-native.js";

export interface WorkerSandboxProvider extends SandboxProvider {
  readonly credentialBroker: CredentialBroker;
}

export async function createSandboxProvider(
  provider: SandboxProviderName,
  credentials: PreparedCredential[],
): Promise<WorkerSandboxProvider> {
  switch (provider) {
    case "microsandbox": {
      prepareMicrosandboxNative();
      const { MicrosandboxProvider } = await import("./sandboxes/microsandbox.js");
      return new MicrosandboxProvider(credentials);
    }
    case "smolvm": {
      const { SmolvmProvider } = await import("./sandboxes/smolvm.js");
      return new SmolvmProvider(credentials);
    }
  }
}
