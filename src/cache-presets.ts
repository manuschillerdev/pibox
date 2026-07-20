import { posix } from "node:path";

interface CachePresetEnvironment {
  subpath?: string;
  prefix?: string;
}

interface CachePreset {
  mount: string;
  environment: Readonly<Record<string, CachePresetEnvironment>>;
}

const CACHE_MOUNT_ROOT = "/var/cache/pibox";

const CACHE_PRESETS = {
  npm: preset("npm", {
    npm_config_cache: {},
  }),
  pnpm: preset("pnpm", {
    PNPM_CONFIG_STORE_DIR: {},
  }),
  yarn: preset("yarn", {
    YARN_CACHE_FOLDER: {},
  }),
  bun: preset("bun", {
    BUN_INSTALL_CACHE_DIR: {},
  }),
  pip: preset("pip", {
    PIP_CACHE_DIR: {},
  }),
  uv: preset("uv", {
    UV_CACHE_DIR: {},
  }),
  poetry: preset("poetry", {
    POETRY_CACHE_DIR: {},
  }),
  maven: preset("maven", {
    MAVEN_ARGS: { prefix: "-Dmaven.repo.local=" },
  }),
  gradle: preset("gradle", {
    GRADLE_USER_HOME: {},
  }),
  cargo: preset("cargo", {
    CARGO_HOME: {},
  }),
  go: preset("go", {
    GOMODCACHE: { subpath: "modules" },
    GOCACHE: { subpath: "build" },
  }),
  nuget: preset("nuget", {
    NUGET_PACKAGES: { subpath: "packages" },
    NUGET_HTTP_CACHE_PATH: { subpath: "http" },
  }),
  composer: preset("composer", {
    COMPOSER_CACHE_DIR: {},
  }),
  bundler: preset("bundler", {
    BUNDLE_USER_CACHE: {},
  }),
  deno: preset("deno", {
    DENO_DIR: {},
  }),
  mise: preset("mise", {
    MISE_DATA_DIR: { subpath: "data" },
    MISE_CACHE_DIR: { subpath: "cache" },
  }),
} as const satisfies Readonly<Record<string, CachePreset>>;

export function cachePreset(name: string): CachePreset | undefined {
  return (CACHE_PRESETS as Readonly<Record<string, CachePreset>>)[name];
}

export function resolvePresetEnvironment(
  preset: CachePreset,
  mount: string,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(preset.environment).map(([name, definition]) => {
      const path = definition.subpath ? posix.join(mount, definition.subpath) : mount;
      return [name, `${definition.prefix ?? ""}${path}`];
    }),
  );
}

function preset(
  name: string,
  environment: Readonly<Record<string, CachePresetEnvironment>>,
): CachePreset {
  return {
    mount: `${CACHE_MOUNT_ROOT}/${name}`,
    environment,
  };
}
