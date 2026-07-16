import { access, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { PiboxConfig } from "./config.js";

const MAX_SANDBOX_NAME_BYTES = 128;

export interface DerivedSandboxName {
  name: string;
  worktreeRoot: string;
}

export async function deriveSandboxName(
  config: PiboxConfig,
  explicitWorktree?: string,
): Promise<DerivedSandboxName> {
  const needsWorktree = config.pibox.nameSuffix === "worktree";
  const worktreeRoot = explicitWorktree
    ? await canonicalWorktree(resolve(config.directory, explicitWorktree))
    : await findNearestWorktree(config.directory, needsWorktree);

  if (config.pibox.nameSuffix === undefined) {
    assertNameLength(config.pibox.name);
    return { name: config.pibox.name, worktreeRoot };
  }

  const suffix =
    config.pibox.nameSuffix === "worktree"
      ? `${slugify(basename(worktreeRoot)) || "worktree"}-${fnv1a64(worktreeRoot)}`
      : slugify(config.pibox.nameSuffix);
  if (!suffix) throw new Error("`pibox.nameSuffix` must contain at least one ASCII letter or number");

  const suffixBytes = Buffer.byteLength(suffix);
  if (suffixBytes + 1 >= MAX_SANDBOX_NAME_BYTES) {
    throw new Error("Sandbox name suffix is too long");
  }
  const base = truncateUtf8(config.pibox.name, MAX_SANDBOX_NAME_BYTES - suffixBytes - 1);
  if (!base) throw new Error("Sandbox base name is empty after applying its suffix");
  return { name: `${base}-${suffix}`, worktreeRoot };
}

export async function findNearestWorktree(
  start: string,
  required = true,
): Promise<string> {
  let current = await realpath(start);
  while (true) {
    if (await exists(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (required) {
    throw new Error('`name-suffix = "worktree"` requires a Git worktree');
  }
  return await realpath(start);
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function fnv1a64(value: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (const byte of Buffer.from(value)) {
    hash ^= BigInt(byte);
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

function truncateUtf8(value: string, maxBytes: number): string {
  let bytes = 0;
  let output = "";
  for (const character of value) {
    const width = Buffer.byteLength(character);
    if (bytes + width > maxBytes) break;
    output += character;
    bytes += width;
  }
  return output;
}

function assertNameLength(name: string): void {
  if (!name) throw new Error("Sandbox name must not be empty");
  if (Buffer.byteLength(name) > MAX_SANDBOX_NAME_BYTES) {
    throw new Error(`Sandbox name must be at most ${MAX_SANDBOX_NAME_BYTES} UTF-8 bytes`);
  }
}

async function canonicalWorktree(path: string): Promise<string> {
  let canonical: string;
  try {
    canonical = await realpath(path);
    if (!(await stat(canonical)).isDirectory()) throw new Error("not a directory");
  } catch (error) {
    throw new Error(
      `Invalid worktree ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!(await exists(join(canonical, ".git")))) {
    throw new Error(`Worktree ${canonical} does not contain a .git file or directory`);
  }
  return canonical;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
