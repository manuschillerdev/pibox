import {
  keyHint,
  type ExtensionContext,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  truncateToWidth,
  type TUI,
} from "@earendil-works/pi-tui";
import {
  STARTUP_PHASES,
  type StartupOptions,
  type StartupPhase,
  type StartupProgressEvent,
} from "./startup.js";

const PHASE_LABELS: Record<StartupPhase, string> = {
  "reading-configuration": "Reading configuration",
  "creating-sandbox": "Creating sandbox",
  "running-startup-scripts": "Running startup scripts",
  "starting-worker-pi": "Starting worker Pi",
  "connecting-rpc": "Connecting RPC",
};

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const MAX_DETAIL_LINES = 100;
const VISIBLE_DETAIL_LINES = 12;

type StartupResult<T> =
  | { success: true; value: T }
  | { success: false; error: unknown };

export async function runWithStartupUi<T>(
  ctx: Pick<ExtensionContext, "hasUI" | "mode" | "ui">,
  operation: (options: StartupOptions) => Promise<T>,
): Promise<T> {
  const mode = (ctx as { mode?: string }).mode;
  const isTui = mode === "tui" || (mode === undefined && ctx.hasUI);
  if (!isTui) return await operation({});

  const result = await ctx.ui.custom<StartupResult<T>>(
    (tui, theme, keybindings, done) => {
      const progress = new StartupProgressComponent(tui, theme, keybindings);
      void operation({ onProgress: (event) => progress.update(event) }).then(
        (value) => done({ success: true, value }),
        (error: unknown) => done({ success: false, error }),
      );
      return progress;
    },
  );

  if (!result.success) throw result.error;
  return result.value;
}

class StartupProgressComponent implements Component {
  private readonly completed = new Set<StartupPhase>();
  private readonly details: string[] = [];
  private active: StartupPhase = STARTUP_PHASES[0];
  private expanded = false;
  private spinnerFrame = 0;
  private readonly animation: NodeJS.Timeout;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
  ) {
    this.animation = setInterval(() => {
      this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER_FRAMES.length;
      this.tui.requestRender();
    }, 80);
  }

  update(event: StartupProgressEvent): void {
    if (event.kind === "started") {
      this.active = event.phase;
    } else if (event.kind === "completed") {
      this.completed.add(event.phase);
    }
    if (event.text) this.appendDetail(event.text);
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    if (!this.keybindings.matches(data, "app.tools.expand")) return;
    this.expanded = !this.expanded;
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const lineWidth = Math.max(1, width);
    const lines = [
      this.theme.fg("border", "─".repeat(lineWidth)),
      "",
      this.theme.fg("accent", this.theme.bold(" Starting Pibox…")),
      "",
      ...STARTUP_PHASES.map((phase) => this.renderPhase(phase)),
    ];

    if (this.expanded) {
      lines.push("", this.theme.fg("muted", " Startup details"));
      const visible = this.details.slice(-VISIBLE_DETAIL_LINES);
      if (visible.length === 0) {
        lines.push(this.theme.fg("dim", "  No details yet"));
      } else {
        lines.push(...visible.map((line) => this.theme.fg("dim", `  ${line}`)));
      }
    }

    lines.push(
      "",
      this.theme.fg("dim", ` ${keyHint("app.tools.expand", "toggle details")}`),
      "",
      this.theme.fg("border", "─".repeat(lineWidth)),
    );
    return lines.map((line) => truncateToWidth(line, lineWidth, ""));
  }

  invalidate(): void {}

  dispose(): void {
    clearInterval(this.animation);
  }

  private renderPhase(phase: StartupPhase): string {
    if (this.completed.has(phase)) {
      return ` ${this.theme.fg("success", "✓")} ${PHASE_LABELS[phase]}`;
    }
    if (phase === this.active) {
      const spinner = SPINNER_FRAMES[this.spinnerFrame] ?? "●";
      return ` ${this.theme.fg("accent", spinner)} ${PHASE_LABELS[phase]}`;
    }
    return this.theme.fg("dim", ` ○ ${PHASE_LABELS[phase]}`);
  }

  private appendDetail(text: string): void {
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trimEnd();
      if (trimmed) this.details.push(trimmed);
    }
    if (this.details.length > MAX_DETAIL_LINES) {
      this.details.splice(0, this.details.length - MAX_DETAIL_LINES);
    }
  }
}
