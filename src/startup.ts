export const STARTUP_PHASES = [
  "reading-configuration",
  "creating-sandbox",
  "running-startup-scripts",
  "starting-worker-pi",
  "connecting-rpc",
] as const;

export type StartupPhase = (typeof STARTUP_PHASES)[number];

export interface StartupProgressEvent {
  phase: StartupPhase;
  kind: "started" | "completed" | "detail";
  text?: string;
}

export interface StartupOptions {
  onProgress?: (event: StartupProgressEvent) => void;
}
