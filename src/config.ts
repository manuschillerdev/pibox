import { realpath, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, posix, resolve } from "node:path";
import { parse } from "smol-toml";

export const DEFAULT_CONFIG_NAME = "pibox.toml";

export type SandboxProviderName = "microsandbox" | "gondolin" | "smolvm";
export type CacheScope = "repository" | "user";

export interface CacheConfig {
  name: string;
  scope: CacheScope;
  mount?: string;
}

export interface PiboxConfig {
  path: string;
  directory: string;
  provider: SandboxProviderName;
  pibox: {
    name: string;
    nameSuffix?: string;
    workdir: string;
    env: Record<string, string>;
  };
  caches: Record<string, CacheConfig>;
  sandbox: Record<string, unknown>;
}

export interface ConfigLocationOptions {
  config?: string;
  worktree?: string;
}

export async function resolveConfigPath(
  cwd: string,
  options: ConfigLocationOptions = {},
): Promise<string> {
  const base = options.worktree
    ? await canonicalDirectory(resolve(cwd, options.worktree), "worktree")
    : await canonicalDirectory(cwd, "working directory");
  const input = options.config ?? DEFAULT_CONFIG_NAME;
  const candidate = isAbsolute(input) ? input : resolve(base, input);
  try {
    return await realpath(candidate);
  } catch (error) {
    throw new Error(
      `Unable to resolve Pibox config ${candidate}: ${errorMessage(error)}`,
    );
  }
}

export async function loadConfig(path: string): Promise<PiboxConfig> {
  let canonicalPath: string;
  let text: string;
  try {
    canonicalPath = await realpath(path);
    text = await readFile(canonicalPath, "utf8");
  } catch (error) {
    throw new Error(`Unable to read Pibox config ${path}: ${errorMessage(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = parse(text);
  } catch (error) {
    throw new Error(
      `Invalid TOML in Pibox config ${canonicalPath}: ${errorMessage(error)}`,
    );
  }

  const table = requireTable(parsed, "top-level config");
  const provider = requireProvider(table.provider);
  const piboxTable = requireTable(table.pibox, "`pibox`");
  const sandbox = requireTable(table.sandbox, "`sandbox`");
  const nameSuffix = optionalString(piboxTable, "nameSuffix");
  const workdir = requireNonEmptyString(piboxTable, "workdir");
  if (!workdir.startsWith("/")) {
    throw new Error("`pibox.workdir` must be an absolute guest path");
  }
  const env = parseEnvironment(piboxTable.env);
  const caches = parseCaches(table.caches);

  return {
    path: canonicalPath,
    directory: dirname(canonicalPath),
    provider,
    pibox: {
      name: requireNonEmptyString(piboxTable, "name"),
      ...(nameSuffix === undefined ? {} : { nameSuffix }),
      workdir,
      env,
    },
    caches,
    sandbox,
  };
}

function parseCaches(value: unknown): Record<string, CacheConfig> {
  if (value === undefined) return {};
  const table = requireTable(value, "`caches`");
  return Object.fromEntries(
    Object.entries(table).map(([name, definition]) => {
      if (!/^[a-z][a-z0-9-]*$/.test(name)) {
        throw new Error(
          `Cache name \`${name}\` must use lowercase letters, numbers, and dashes`,
        );
      }
      const cache = requireTable(definition, `\`caches.${name}\``);
      const unknown = Object.keys(cache).filter(
        (key) => key !== "scope" && key !== "mount",
      );
      if (unknown.length > 0) {
        throw new Error(
          `\`caches.${name}\` contains unsupported ${unknown.length === 1 ? "field" : "fields"}: ${unknown.join(", ")}`,
        );
      }
      const scope = optionalCacheScope(cache.scope, name);
      const configuredMount = optionalStringValue(
        cache.mount,
        `\`caches.${name}.mount\``,
      );
      const mount = configuredMount === undefined
        ? undefined
        : posix.normalize(configuredMount);
      if (
        mount !== undefined &&
        (!configuredMount?.startsWith("/") || mount === "/" || mount.includes("\0"))
      ) {
        throw new Error(
          `\`caches.${name}.mount\` must be an absolute guest path other than /`,
        );
      }
      if (mount?.includes(":")) {
        throw new Error(`\`caches.${name}.mount\` must not contain a colon`);
      }
      return [
        name,
        {
          name,
          scope,
          ...(mount === undefined ? {} : { mount }),
        },
      ];
    }),
  );
}

function parseEnvironment(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  const table = requireTable(value, "`pibox.env`");
  return Object.fromEntries(
    Object.entries(table).map(([name, environmentValue]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new Error(`Invalid environment variable name \`${name}\` in \`pibox.env\``);
      }
      if (typeof environmentValue !== "string") {
        throw new Error(`\`pibox.env.${name}\` must be a string`);
      }
      return [name, environmentValue];
    }),
  );
}

function optionalCacheScope(value: unknown, name: string): CacheScope {
  if (value === undefined || value === "repository") return "repository";
  if (value === "user") return "user";
  throw new Error(`\`caches.${name}.scope\` must be "repository" or "user"`);
}

function optionalStringValue(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function requireProvider(value: unknown): SandboxProviderName {
  if (value === "microsandbox" || value === "gondolin" || value === "smolvm") {
    return value;
  }
  throw new Error(
    '`provider` is required and must be "microsandbox", "gondolin", or "smolvm"',
  );
}

function requireTable(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a TOML table`);
  }
  return value as Record<string, unknown>;
}

function requireNonEmptyString(table: Record<string, unknown>, key: string): string {
  const value = table[key];
  if (typeof value !== "string") {
    throw new Error(`\`pibox.${key}\` is required and must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`\`pibox.${key}\` must not be empty`);
  return trimmed;
}

function optionalString(
  table: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = table[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`\`pibox.${key}\` must be a string`);
  return value;
}

async function canonicalDirectory(path: string, label: string): Promise<string> {
  try {
    const canonical = await realpath(path);
    if (!(await stat(canonical)).isDirectory()) throw new Error("not a directory");
    return canonical;
  } catch (error) {
    throw new Error(`Invalid ${label} ${path}: ${errorMessage(error)}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
