import type {
  CredentialBroker,
  PreparedCredential,
} from "./auth-relay.js";
import type { SandboxProviderName } from "./config.js";
import type { SandboxProvider } from "./sandbox.js";
import { MicrosandboxProvider } from "./sandboxes/microsandbox.js";
import { SmolvmProvider } from "./sandboxes/smolvm.js";

export interface WorkerSandboxProvider extends SandboxProvider {
  readonly credentialBroker: CredentialBroker;
}

export function createSandboxProvider(
  provider: SandboxProviderName,
  credentials: PreparedCredential[],
): WorkerSandboxProvider {
  switch (provider) {
    case "microsandbox":
      return new MicrosandboxProvider(credentials);
    case "smolvm":
      return new SmolvmProvider(credentials);
  }
}
