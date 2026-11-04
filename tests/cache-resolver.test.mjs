import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTypeScript } from './load-typescript.mjs';

const { resolveCaches } = await loadTypeScript('../src/cache.ts');

async function stalledGit(run) {
  const root = await mkdtemp(join(tmpdir(), 'pibox-stalled-git-'));
  const previousPath = process.env.PATH;
  const previousTmp = process.env.TMPDIR;
  try {
    await mkdir(join(root, 'bin'));
    await writeFile(join(root, 'bin/git'), '#!/bin/sh\nexec /bin/sleep 60\n', { mode: 0o755 });
    process.env.PATH = join(root, 'bin');
    process.env.TMPDIR = root;
    const config = { directory: root, pibox: { env: {} }, caches: { npm: { name: 'npm', scope: 'repository' } } };
    await run(config, root);
  } finally {
    process.env.PATH = previousPath;
    if (previousTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmp;
    await rm(root, { recursive: true, force: true });
  }
}

test('a stalled Git identity lookup can be aborted rather than silently using another identity', { skip: process.platform === 'win32' }, async () => {
  await stalledGit(async (config, root) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 100);
    try { await assert.rejects(resolveCaches(config, root, { signal: controller.signal }), /cache identity was aborted/); }
    finally { clearTimeout(timer); }
  });
});

test('a stalled Git identity lookup is killed by its own deadline', { skip: process.platform === 'win32', timeout: 15_000 }, async () => {
  await stalledGit(async (config, root) => {
    await assert.rejects(resolveCaches(config, root), /cache identity lookup timed out/);
  });
});
