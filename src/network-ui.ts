import { type ExtensionAPI, type ExtensionCommandContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Input, SelectList, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Focusable } from "@earendil-works/pi-tui";
import type { WorkerNetwork } from "./network.js";
import { listenerKey, type GuestListener } from "./network-discovery.js";
import { validateServiceName } from "./network-portless.js";
import { hostMappingNeeded, hostSetupCommand, installHostMapping } from "./network-hosts.js";
import { cleanNetworkText as clean, defaultServiceNames, serviceLabel } from "./network-services.js";

export async function showNetworkOverlay(pi: ExtensionAPI, ctx: ExtensionCommandContext, network: WorkerNetwork, name: string): Promise<void> {
  if (ctx.mode !== "tui") throw new Error("/pibox-net requires interactive Pi");
  await ctx.ui.custom<void>((tui, theme, _keys, done) => new NetworkOverlay(
    network, name, theme, () => tui.requestRender(), () => done(),
    async (value, open) => {
      const command = open ? (process.platform === "darwin" ? "open" : "xdg-open") : (process.platform === "darwin" ? "pbcopy" : "wl-copy");
      if (open) {
        const result = await pi.exec(command, [value], { timeout: 5000 });
        if (result.code !== 0) throw new Error(result.stderr || "Could not open browser");
      } else {
        // OSC 52 works over SSH and avoids a host clipboard dependency.
        tui.terminal.write(`\x1b]52;c;${Buffer.from(value).toString("base64")}\x07`);
      }
    },
    () => Math.max(1, tui.terminal.rows - 2),
    async (hostname) => {
      const needed = await hostMappingNeeded(hostname);
      const details = `Publish http://${hostname} and add an exact guest hostname → native gateway mapping? No Docker client changes. Unpublish revokes routing and guest mappings.`;
      if (!await ctx.ui.confirm("Publish HTTP service?", details)) return false;
      if (needed) {
        if (!await ctx.ui.confirm("Authorize host hostname setup?", `Append a loopback mapping to /etc/hosts. This harmless entry remains after unpublish/shutdown; no route remains. Only this helper is elevated, never Pi. Command:\n${hostSetupCommand(hostname)}`)) return false;
        await installHostMapping(hostname, (command, args) => pi.exec(command, args));
      }
      return true;
    },
  ), { overlay: true, overlayOptions: { width: 90, margin: 1, anchor: "center" } });
}

export class NetworkOverlay implements Focusable {
  private list: SelectList;
  private rows: GuestListener[] = [];
  private selected: GuestListener | undefined;
  private readonly input = new Input();
  private mode: "http" | "tcp" = "http";
  private busy = false;
  private disposed = false;
  private tooSmall = false;
  private message = "Discovering guest TCP listeners…";
  private permissionError = "";
  private entries: GuestListener[] = [];
  private timer: ReturnType<typeof setInterval>;
  private _focused = false;
  get focused(): boolean { return this._focused; }
  set focused(value: boolean) { this._focused = value; this.input.focused = value; }
  constructor(
    private readonly network: WorkerNetwork,
    _name: string,
    private readonly theme: Theme,
    private readonly renderAgain: () => void,
    private readonly done: () => void,
    private readonly external: (value: string, open: boolean) => Promise<void>,
    private readonly availableHeight: () => number = () => 24,
    private readonly confirmHttp: (hostname: string) => Promise<boolean> = () => Promise.resolve(false),
  ) {
    this.list = this.makeList();
    this.input.onSubmit = () => { void this.save(); };
    this.input.onEscape = () => { this.selected = undefined; this.renderAgain(); };
    this.timer = setInterval(() => { if (!this.selected && !this.busy) void this.refresh(); }, 5000);
    void this.refresh();
    void network.permission().catch((error: unknown) => { this.permissionError = String(error); }).then(() => { if (!this.disposed) this.renderAgain(); });
  }
  private makeList(width = 80, maxVisible = 8): SelectList {
    const previous = this.list?.getSelectedItem()?.value;
    const combined = new Map(this.rows.map((row) => [listenerKey(row), row]));
    // Prefer fresh metadata, but retain stopped/failed publications for cleanup.
    for (const [key, service] of this.network.published) if (!combined.has(key)) combined.set(key, service.listener);
    this.entries = [...combined.values()].sort((a, b) => a.port - b.port || listenerKey(a).localeCompare(listenerKey(b)));
    const serviceWidth = Math.max(1, width - 28);
    const items = this.entries.map((row) => {
      const key = listenerKey(row), publication = this.network.published.get(key);
      const listening = this.rows.some((r) => listenerKey(r) === key);
      const status = publication?.error ? "Cleanup needed" : !listening ? "Not listening" : publication ? "Published" : "Private";
      const label = width >= 40
        ? `${String(row.port).padEnd(7)}${pad(serviceLabel(row), serviceWidth)}  ${status}`
        : `${row.port} ${serviceLabel(row)} · ${status}`;
      return { value: key, label };
    });
    const list = new SelectList(items, maxVisible, {
      selectedPrefix: (s) => this.theme.fg("accent", s), selectedText: (s) => this.theme.fg("accent", s),
      description: (s) => this.theme.fg("muted", s), scrollInfo: (s) => this.theme.fg("dim", s), noMatch: (s) => this.theme.fg("muted", s),
    });
    list.onSelect = (item) => {
      this.selected = combined.get(item.value);
      const service = this.network.published.get(item.value);
      const defaults = defaultServiceNames(this.entries);
      this.input.setValue(service?.name || defaults.get(item.value)!);
      this.mode = service?.mode || "http";
      this.message = "";
      this.renderAgain();
    };
    list.onCancel = this.done;
    const index = items.findIndex((item) => item.value === previous);
    if (index >= 0) list.setSelectedIndex(index);
    return list;
  }
  private async refresh(): Promise<void> {
    if (this.busy || this.disposed) return;
    this.busy = true;
    try {
      this.rows = await this.network.discover();
      if (this.disposed) return;
      this.list = this.makeList();
      this.message = "";
    } catch (error) { this.message = String(error); }
    finally { this.busy = false; if (!this.disposed) this.renderAgain(); }
  }
  private async save(): Promise<void> {
    if (!this.selected || this.busy) return;
    const listener = this.selected;
    const name = this.input.getValue().trim();
    this.busy = true;
    this.message = "Publishing…"; this.renderAgain();
    try {
      validateServiceName(name);
      await this.network.permission();
      const current = this.network.published.get(listenerKey(listener));
      if (current && current.name === name && current.mode === this.mode && !current.error) {
        this.selected = undefined;
      } else {
        if (this.mode === "http" && !await this.confirmHttp(`${name}.${this.network.portless.namespace}.pibox.test`)) { this.message = "Publication cancelled"; return; }
        // Changes replace only Pibox-owned publications.
        if (current) await this.network.unpublish(listenerKey(listener));
        await this.network.publish(listener, name, this.mode);
        this.selected = undefined;
      }
    } catch (error) { this.message = String(error); }
    finally { this.busy = false; this.renderAgain(); }
    if (!this.selected) await this.refresh();
  }
  private async unpublish(): Promise<void> {
    const key = this.selected ? listenerKey(this.selected) : this.list.getSelectedItem()?.value;
    if (!key || this.busy) return;
    this.busy = true;
    try { await this.network.unpublish(key); this.selected = undefined; }
    catch (error) { this.message = String(error); }
    finally { this.busy = false; this.renderAgain(); }
    if (!this.selected) await this.refresh();
  }
  handleInput(data: string): void {
    if (this.tooSmall) {
      if (matchesKey(data, "escape")) this.done();
      return;
    }
    if (this.busy) { if (matchesKey(data, "escape") && !this.selected) this.done(); return; }
    if (this.selected) {
      if (matchesKey(data, "tab")) this.mode = this.mode === "http" ? "tcp" : "http";
      else if (matchesKey(data, "ctrl+u")) void this.unpublish();
      else {
        this.input.handleInput(data);
        const value = this.input.getValue(), safe = clean(value);
        if (safe !== value) this.input.setValue(safe);
      }
    } else if (data === "r") void this.refresh();
    else if (data === "u") void this.unpublish();
    else if (data === "c" || data === "o") {
      const key = this.list.getSelectedItem()?.value;
      const service = key ? this.network.published.get(key) : undefined;
      if (service && (data === "c" || service.mode === "http")) {
        void this.external(service.endpoint, data === "o").then(() => {
          this.message = data === "c" ? "Copied (requires terminal OSC 52 support)" : "Opened in browser";
          this.renderAgain();
        }, (error: unknown) => { this.message = String(error); this.renderAgain(); });
      }
    } else this.list.handleInput(data);
    this.renderAgain();
  }
  render(width: number): string[] {
    width = Math.max(0, Math.min(90, width));
    const height = Math.max(1, Math.min(26, this.availableHeight()));
    this.tooSmall = width < 24 || height < 12;
    if (this.tooSmall) {
      return [truncateToWidth("Esc close · Resize terminal", width)].slice(0, height);
    }
    const inner = width - 4;
    const lines: string[] = [];
    let footer: string[];
    const short = inner < 65;
    if (this.selected) {
      const row = this.selected;
      // Controls come first so clipping details or feedback never hides an active field.
      lines.push("Name", ...this.input.render(inner));
      lines.push(`Access: ${this.mode === "http" ? "HTTP" : "TCP"} · Tab`);
      lines.push(this.theme.bold(serviceLabel(row)), this.theme.fg("dim", `${clean(row.address)}:${row.port}${row.docker ? ` → container :${row.docker.containerPort}` : ""}`));
      if (height >= 17) {
        const value = clean(this.input.getValue());
        lines.push(this.theme.fg("muted", this.mode === "http" ? `http://${value}.${this.network.portless.namespace}.pibox.test` : "A host-loopback TCP endpoint"));
      }
      footer = short ? ["Enter Save · Ctrl+U", "Esc Back"] : ["Enter Save · Ctrl+U Unpublish · Esc Back"];
    } else {
      const publication = this.network.published.get(this.list.getSelectedItem()?.value || "");
      const open = publication?.mode === "http" ? "O Open · " : "";
      footer = !publication ? ["Enter Publish · ↑↓ Select", "R Refresh · Esc Close"]
        : inner < 40 ? ["Enter Edit · U Unpub", `${open}C Copy`, "R Refresh · Esc"]
        : short ? ["Enter Edit · U Unpublish", `${open}C Copy · R Refresh · Esc Close`]
        : [`Enter Edit · U Unpublish · ${open}C Copy`, "↑↓ Select · R Refresh · Esc Close"];
      // Reserve space for header, selected details, feedback and footer before the list.
      const visible = Math.max(1, Math.min(8, height - 12));
      this.list = this.makeList(inner, visible);
      lines.push(this.theme.fg("dim", inner >= 40 ? `  ${"PORT".padEnd(7)}${pad("SERVICE", inner - 28)}  ACCESS` : "PORT / SERVICE"));
      lines.push(...this.list.render(inner));
      if (!this.entries.length) lines[lines.length - 1] = "No services. Start an app, then R to refresh.";
      const key = this.list.getSelectedItem()?.value;
      const row = this.entries.find((entry) => listenerKey(entry) === key);
      const service = key ? this.network.published.get(key) : undefined;
      if (row) {
        if (height >= 17) lines.push("");
        const detail = service?.error || service?.endpoint || `${serviceLabel(row)} · Private · Enter to publish`;
        const detailLines = wrapTextWithAnsi(clean(detail), inner);
        lines.push(...detailLines.slice(0, height >= 18 ? 2 : 1).map((line) => this.theme.fg(service?.error ? "warning" : "accent", line)));
        if (service?.readiness && height >= 19) {
          const ready = (value: string) => {
            const status = /HTTP (\d{3})/.exec(value)?.[1];
            if (!value.startsWith("HTTP reachable") || !status) return "setup/check needed";
            return Number(status) >= 500 ? `HTTP ${status} · upstream unavailable` : `HTTP ${status}`;
          };
          lines.push(`Host: ${ready(service.readiness.host)} · Guest: ${ready(service.readiness.guest)}`);

        }
      }
    }
    const selectedError = this.selected ? this.network.published.get(listenerKey(this.selected))?.error : undefined;
    const feedback = this.permissionError || this.message || selectedError;

    // Keep controls and both borders visible, even on short terminals.
    const bodyBudget = height - footer.length - 5;
    const body = lines.slice(0, bodyBudget - (feedback ? 1 : 0));
    if (feedback) body.push(this.theme.fg(this.permissionError ? "warning" : "muted", clean(feedback)));
    const title = ` Network · ${this.network.portless.namespace} `;
    const border = (text: string) => this.theme.fg("borderAccent", text);
    const framed = [border(`╭${pad(title, width - 2, "─")}╮`)];
    const row = (content: string) => border("│") + " " + pad(content, inner) + " " + border("│");
    framed.push(row(""), ...body.map(row), row(""), ...footer.map((line) => row(this.theme.fg("dim", line))), border(`╰${"─".repeat(width - 2)}╯`));
    return framed.map((line) => this.theme.bg("customMessageBg", line));
  }
  invalidate(): void { this.list.invalidate(); this.input.invalidate(); }
  dispose(): void { this.disposed = true; clearInterval(this.timer); }
}

function pad(text: string, width: number, fill = " "): string {
  const clipped = truncateToWidth(text, width);
  return clipped + fill.repeat(Math.max(0, width - visibleWidth(clipped)));
}
