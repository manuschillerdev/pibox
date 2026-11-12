import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadTypeScript } from './load-typescript.mjs';

const { DEFAULT_CONFIG, DEFAULT_CONFIG_NAME, resolveConfigPath } = await loadTypeScript('../src/config.ts');

test('creates the default Pibox configuration when none exists', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pibox-config-'));
  try {
    const configPath = await resolveConfigPath(directory);
    assert.equal(configPath, await realpath(path.join(directory, DEFAULT_CONFIG_NAME)));
    assert.equal(await readFile(configPath, 'utf8'), DEFAULT_CONFIG);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('does not create an explicitly requested missing configuration', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pibox-config-'));
  try {
    await assert.rejects(
      resolveConfigPath(directory, { config: 'custom.toml' }),
      /Unable to resolve Pibox config/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
