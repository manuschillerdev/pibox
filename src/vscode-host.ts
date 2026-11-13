import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
export type HostRun = (command: string, args: string[]) => Promise<string>;
export const runHost: HostRun = async (command, args) => {
  const result = await exec(command, args, { timeout: 30_000, maxBuffer: 1_048_576 });
  return result.stdout;
};
const INCLUDE = 'Include "~/.ssh/pibox-vscode/*/config"\nHost *\n';

async function safePath(path: string, directory: boolean): Promise<void> {
  const stat = await lstat(path);
  if ((directory ? !stat.isDirectory() : !stat.isFile()) || stat.uid !== process.getuid?.() || (stat.mode & 0o022)) {
    throw new Error(`Unsafe SSH ${directory ? "directory" : "file"}: ${path}; require ownership by this user, no symlinks or group/world writes`);
  }
}
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === "ENOENT"; }

export function hasControls(value: string): boolean {
  return [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}

/** Quote paths without allowing ssh_config line or token injection. */
export function sshPath(path: string): string {
  if (!path.startsWith("/") || hasControls(path) || /["\\$]/.test(path)) throw new Error("Unsupported characters in host SSH path");
  return `"${path.replaceAll("%", "%%")}"`;
}
export function publicKey(text: string): string {
  const match = /^(ssh-ed25519 [A-Za-z0-9+/]{68})(?: [^\r\n]*)?$/.exec(text.trim());
  if (!match) throw new Error("Invalid Ed25519 public key from SSH setup");
  const wire = Buffer.from(match[1]!.slice(12), "base64");
  if (wire.length !== 51 || wire.readUInt32BE(0) !== 11 || wire.subarray(4, 15).toString() !== "ssh-ed25519" || wire.readUInt32BE(15) !== 32) {
    throw new Error("Invalid Ed25519 public key encoding");
  }
  return match[1]!;
}

export class VscodeHost {
  readonly directory: string;
  readonly alias: string;
  private readonly sshDirectory: string;
  constructor(readonly id: string, private readonly run: HostRun = runHost, home = homedir()) {
    if (!/^[a-f0-9]{32}$/.test(id)) throw new Error("Invalid SSH instance");
    this.alias = `pibox-vscode-${id}`;
    this.sshDirectory = join(home, ".ssh");
    this.directory = join(this.sshDirectory, "pibox-vscode", id);
    sshPath(this.directory);
  }
  async preflight(): Promise<void> {
    if (process.platform === "win32") throw new Error("/pibox-vscode currently requires a macOS or Linux host");
    try { await this.run("code", ["--version"]); }
    catch { throw new Error("VS Code CLI not found or failed: install 'code' in PATH before using /pibox-vscode"); }
    const extensions = await this.run("code", ["--list-extensions"]);
    if (!extensions.toLowerCase().split(/\r?\n/).includes("ms-vscode-remote.remote-ssh")) {
      throw new Error("Install Microsoft's Remote - SSH extension in the default VS Code profile first: code --install-extension ms-vscode-remote.remote-ssh");
    }
    await this.run("ssh", ["-V"]);
  }
  async prepare(): Promise<string> {
    await mkdir(this.sshDirectory, { mode: 0o700 }).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
    await safePath(this.sshDirectory, true);
    const parent = join(this.sshDirectory, "pibox-vscode");
    await mkdir(parent, { mode: 0o700 }).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
    await safePath(parent, true);
    await mkdir(this.directory, { mode: 0o700 }).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
    await safePath(this.directory, true);
    if ((await lstat(this.directory)).mode & 0o077) throw new Error("Managed SSH directory must be private (0700)");
    await this.include();
    const key = join(this.directory, "identity");
    try { await safePath(key, false); }
    catch (error) {
      if (!missing(error)) throw error;
      await this.run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
    }
    if ((await lstat(key)).mode & 0o077) throw new Error("Managed SSH identity must be private (0600)");
    return publicKey(await this.run("ssh-keygen", ["-y", "-f", key]));
  }
  private async include(): Promise<void> {
    const config = join(this.sshDirectory, "config");
    const lockPath = join(this.sshDirectory, ".pibox-vscode.lock");
    let lock;
    try { lock = await open(lockPath, "wx", 0o600); }
    catch { throw new Error(`SSH config is locked; retry, or remove ${lockPath} only if no Pibox setup is running`); }
    const temporary = join(this.sshDirectory, `.pibox-config-${randomUUID()}`);
    try {
      let before: Buffer | undefined;
      try { await safePath(config, false); before = await readFile(config); }
      catch (error) { if (!missing(error)) throw error; }
      if (before?.subarray(0, Buffer.byteLength(INCLUDE)).toString() === INCLUDE) return;
      if (before) await writeFile(join(this.sshDirectory, `config.pibox-backup-${randomUUID()}`), before, { mode: 0o600, flag: "wx" });
      await writeFile(temporary, Buffer.concat([Buffer.from(INCLUDE), before ?? Buffer.alloc(0)]), { mode: 0o600, flag: "wx" });
      // Refuse concurrent editor changes rather than overwrite them. The lock
      // serializes other Pibox processes; users should not edit during setup.
      let current: Buffer | undefined;
      try { await safePath(config, false); current = await readFile(config); }
      catch (error) { if (!missing(error)) throw error; }
      if (before ? !current?.equals(before) : current !== undefined) throw new Error("SSH config changed during setup; retry");
      await rename(temporary, config);
    } finally {
      await rm(temporary, { force: true });
      await lock.close();
      await rm(lockPath, { force: true });
    }
  }
  async configure(port: number, hostKey: string): Promise<void> {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid SSH host port");
    hostKey = publicKey(hostKey);
    const knownHosts = join(this.directory, "known_hosts");
    const pin = `${this.alias} ${hostKey}\n`;
    try {
      if (await readFile(knownHosts, "utf8") !== pin) throw new Error("Guest SSH host key changed during this worker lifetime; refusing to replace its pin");
    } catch (error) {
      if (!missing(error)) throw error;
      await writeFile(knownHosts, pin, { mode: 0o600, flag: "wx" });
    }
    const settings = [
      `Host ${this.alias}`, "HostName 127.0.0.1", `Port ${port}`, "User root",
      `IdentityFile ${sshPath(join(this.directory, "identity"))}`, "IdentitiesOnly yes", "IdentityAgent none",
      `UserKnownHostsFile ${sshPath(knownHosts)}`, "GlobalKnownHostsFile /dev/null", `HostKeyAlias ${this.alias}`,
      "StrictHostKeyChecking yes", "CheckHostIP no", "UpdateHostKeys no", "HostKeyAlgorithms ssh-ed25519",
      "ForwardAgent no", "ForwardX11 no", "GatewayPorts no", "ProxyCommand none", "ProxyJump none",
      "CanonicalizeHostname no", "ControlMaster no", "ControlPath none", "ControlPersist no",
      "PasswordAuthentication no", "KbdInteractiveAuthentication no", "PreferredAuthentications publickey",
      "BatchMode yes", "PermitLocalCommand no", "RemoteCommand none", "RequestTTY no", "ConnectTimeout 10",
    ];
    const temporary = join(this.directory, `config-${randomUUID()}`);
    try {
      await writeFile(temporary, settings.join("\n  ") + "\n", { mode: 0o600, flag: "wx" });
      await rename(temporary, join(this.directory, "config"));
    } finally { await rm(temporary, { force: true }); }
    validateEffectiveConfig(await this.run("ssh", ["-G", this.alias]), this.alias, port, this.directory);
  }
  async probe(): Promise<void> { await this.run("ssh", [this.alias, "true"]); }
  async launch(workdir: string): Promise<void> {
    if (!workdir.startsWith("/") || hasControls(workdir)) throw new Error("Invalid guest workspace path");
    await this.run("code", ["--new-window", "--remote", `ssh-remote+${this.alias}`, workdir]);
  }
  async remove(): Promise<void> { await rm(this.directory, { recursive: true, force: true }); }
}

export function validateEffectiveConfig(text: string, alias: string, port: number, directory: string): void {
  const rows = new Map<string, string[]>();
  for (const line of text.trim().split(/\r?\n/)) {
    const at = line.indexOf(" ");
    if (at < 0) continue;
    const key = line.slice(0, at), value = line.slice(at + 1);
    rows.set(key, [...rows.get(key) ?? [], value]);
  }
  const expected: Record<string, string> = {
    hostname: "127.0.0.1", port: String(port), user: "root", hostkeyalias: alias,
    stricthostkeychecking: "true", forwardagent: "no", forwardx11: "no", gatewayports: "no",
    identitiesonly: "yes", identityagent: "none", passwordauthentication: "no", kbdinteractiveauthentication: "no",
    batchmode: "yes", permitlocalcommand: "no", controlmaster: "false", canonicalizehostname: "false",
    hostkeyalgorithms: "ssh-ed25519", globalknownhostsfile: "/dev/null",
    userknownhostsfile: join(directory, "known_hosts"), identityfile: join(directory, "identity").replaceAll("%", "%%"),
  };
  for (const [key, value] of Object.entries(expected)) {
    if (rows.get(key)?.length !== 1 || rows.get(key)![0] !== value) throw new Error(`Unsafe or conflicting SSH setting '${key}'. Check ~/.ssh/config and use the default Remote - SSH config file`);
  }
  for (const key of ["proxycommand", "proxyjump", "localforward", "remoteforward", "dynamicforward", "remotecommand", "controlpath"]) {
    if (rows.has(key) && rows.get(key)!.some(value => value !== "none")) throw new Error(`Conflicting SSH setting '${key}'; remove it for the Pibox alias`);
  }
}
