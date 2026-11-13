import { readFile } from "node:fs/promises";

export function validateNetworkHostname(name: string): void {
  if (name !== name.trim() || name.length > 253 || !/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?\.pibox-[a-f0-9]{8}\.pibox\.test$/.test(name)) throw new Error("Invalid Pibox hostname");
}

/** Correct unmanaged entries are reused, never claimed or replaced. */
export function needsHostMapping(contents: string, name: string): boolean {
  validateNetworkHostname(name);
  let found = false;
  for (const line of contents.split("\n")) {
    const [address, ...names] = line.split("#", 1)[0]!.trim().split(/\s+/);
    if (!names.some(n => n.toLowerCase().replace(/\.$/, "") === name)) continue;
    if (address !== "127.0.0.1" && address !== "::1") throw new Error(`Conflicting /etc/hosts mapping for ${name}`);
    found = true;
  }
  return !found;
}

// Fixed target, live read under an advisory lock, append only. No snapshots,
// shared Portless block, external code files, or caller-supplied paths.
export const HOSTS_HELPER = String.raw`
use strict; use warnings; use Fcntl qw(:flock SEEK_SET SEEK_END);
my $name = shift @ARGV;
die "Invalid hostname\n" unless defined($name) && !@ARGV && $name =~ /\A[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?\.pibox-[a-f0-9]{8}\.pibox\.test\z/;
open(my $f, '+<', '/etc/hosts') or die "Open hosts: $!\n";
flock($f, LOCK_EX) or die "Lock hosts: $!\n";
seek($f, 0, SEEK_SET) or die "Seek hosts: $!\n";
my $found = 0; my $last = "\n";
while (my $line = <$f>) {
 $last = $line; $line =~ s/#.*//; my @parts = split(' ', $line); my $ip = shift @parts;
 for my $alias (@parts) {
  $alias = lc($alias); $alias =~ s/\.$//;
  next unless $alias eq $name;
  die "Conflicting hosts mapping\n" unless $ip eq '127.0.0.1' || $ip eq '::1';
  $found = 1;
 }
}
unless ($found) {
 seek($f, 0, SEEK_END) or die "Seek hosts: $!\n";
 print $f (($last =~ /\n\z/ ? '' : "\n") . "127.0.0.1 $name # pibox-net\n") or die "Write hosts: $!\n";
}
close($f) or die "Close hosts: $!\n";
`;

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export function hostSetupCommand(name: string): string {
  validateNetworkHostname(name);
  return `/usr/bin/perl -e ${quote(HOSTS_HELPER)} -- ${quote(name)}`;
}
export async function hostMappingNeeded(name: string): Promise<boolean> {
  return needsHostMapping(await readFile("/etc/hosts", "utf8"), name);
}

export interface HostSetupExecutor {
  (command: string, args: string[]): Promise<{ code: number; stderr: string }>;
}
/** Call only after showing the exact command and receiving explicit approval. */
export async function installHostMapping(name: string, exec: HostSetupExecutor): Promise<void> {
  const command = hostSetupCommand(name);
  const result = process.platform === "darwin"
    ? await exec("/usr/bin/osascript", ["-e", "on run argv\ndo shell script (item 1 of argv) with administrator privileges\nend run", command])
    : process.platform === "linux"
      ? await exec("pkexec", ["/usr/bin/perl", "-e", HOSTS_HELPER, "--", name])
      : (() => { throw new Error("Host setup supports macOS and Linux only"); })();
  if (result.code !== 0) throw new Error(result.stderr || "Host setup cancelled or failed");
  if (await hostMappingNeeded(name)) throw new Error("Host mapping was not installed");
}
