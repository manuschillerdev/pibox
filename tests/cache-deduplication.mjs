// Real Git worktrees + production cache resolver/adapter, no model credentials.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Image, Sandbox } from 'microsandbox';
import { loadTypeScript } from './load-typescript.mjs';
import { withDeadline } from './deadline.mjs';
import { settleCreationForCleanup } from './provisioning.mjs';

const DEFAULT_IMAGE = 'ghcr.io/manuschillerdev/pibox-base@sha256:3b434f5560dcc0085d3c0a8113077ac4011831592cb2d18649a20bdc1a8949eb';
const image = process.env.PIBOX_TEST_IMAGE ?? DEFAULT_IMAGE;
assert.match(image, /@sha256:[a-f0-9]{64}$/, 'PIBOX_TEST_IMAGE must use an immutable image digest');
if (!process.env.PIBOX_TEST_IMAGE) assert.equal(process.arch, 'x64', 'Set PIBOX_TEST_IMAGE to a digest for this architecture');
const reportPath = process.env.PIBOX_TEST_REPORT ?? join(tmpdir(), `pibox-cache-evidence-${process.pid}-${Date.now()}.json`);
const root = await mkdtemp(join(tmpdir(), 'pibox-dedup-test-'));
const previousGit = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('GIT_')));
for (const key of Object.keys(previousGit)) delete process.env[key];
await writeFile(join(root, 'gitconfig'), '');
await mkdir(join(root, 'hooks'));
Object.assign(process.env, {
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(root, 'gitconfig'), GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'commit.gpgSign', GIT_CONFIG_VALUE_0: 'false',
  GIT_CONFIG_KEY_1: 'core.hooksPath', GIT_CONFIG_VALUE_1: join(root, 'hooks'),
});
const interrupt = new AbortController();
const handlers = new Map(['SIGINT', 'SIGTERM'].map(signal => [signal, () => interrupt.abort(new Error(`Interrupted by ${signal}`))]));
for (const [signal, handler] of handlers) process.once(signal, handler);
const attempted = new Set();
const vms = new Map();
const creations = new Map();
const results = [];
const evidence = {
  status: 'running', timestamp: new Date().toISOString(), platform: process.platform, architecture: process.arch,
  image, scope: 'Microsandbox cache storage and offline reuse; not RAM/CPU deduplication', measurements: {},
};
const sha256 = data => createHash('sha256').update(data).digest('hex');
const { resolveCaches: resolveActualCaches } = await loadTypeScript('../src/cache.ts');
const { MicrosandboxProvider } = await loadTypeScript('../src/sandboxes/microsandbox.ts');
const bounded = (operation, label, timeout = 120_000, options = {}) => withDeadline(operation, label, timeout, { signal: interrupt.signal, ...options });
async function resolveCaches(config, directory) {
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = root;
  try {
    return await bounded(() => resolveActualCaches(config, directory, { signal: interrupt.signal }), `resolve caches for ${directory}`);
  }
  finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
  }
}
async function treeSnapshot(path) {
  const files = [];
  const unique = new Set();
  let logicalBytes = 0;
  let allocatedBytes = 0;
  async function walk(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
      const full = join(directory, entry.name);
      const stat = await lstat(full);
      if (entry.isDirectory()) await walk(full);
      else {
        files.push({ path: full.slice(path.length), device: stat.dev, inode: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs });
        const identity = `${stat.dev}:${stat.ino}`;
        if (!unique.has(identity)) {
          unique.add(identity); logicalBytes += stat.size; allocatedBytes += stat.blocks * 512;
        }
      }
    }
  }
  await walk(path);
  return { files: files.length, uniqueInodes: unique.size, logicalBytes, fileAllocatedBytes: allocatedBytes, manifestSha256: sha256(JSON.stringify(files)) };
}
async function toolSnapshot(caches) {
  const path = join(caches.caches.find(c => c.name === 'mise').hostPath, 'data/installs/node/24.4.1');
  const binary = join(path, 'bin/node');
  const stat = await lstat(binary);
  return { tree: await treeSnapshot(path), binary: { device: stat.dev, inode: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, sha256: sha256(await readFile(binary)) } };
}
async function command(file, args) {
  const running = promisify(execFile)(file, args, { env: process.env, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  running.child.stdin.end();
  return (await bounded(() => running, `${file} ${args.join(' ')}`, 125_000, { cancel: () => running.child.kill('SIGTERM') })).stdout;
}
const git = (dir, ...args) => command('git', ['-C', dir, ...args]);
const config = (directory, scope) => ({ directory, pibox: { env: {} }, caches: Object.fromEntries(
  ['npm', 'pnpm', 'mise'].map(name => [name, { name, scope }]),
) });
async function boot(caches, offline = false) {
  const name = `pibox-dedup-${process.pid}-${Date.now()}`;
  attempted.add(name); // Track partial provisioning, not just successful creates.
  const creating = Promise.resolve().then(() => new MicrosandboxProvider([]).create(name, {
    image, cpus: 1, memory: 1024, detached: true, ...(offline ? { disableNetwork: true } : {}),
  }, caches.mounts)).then(instance => { vms.set(name, instance); return instance; });
  creations.set(name, creating);
  await bounded(() => creating, `create ${name}`);
  return name;
}
async function shellResult(vm, caches, script) {
  let process;
  let output = '';
  let errors = '';
  try {
    return await bounded(async () => {
      process = await vms.get(vm).startProcess(['/bin/sh', '-ec', script], { env: { ...caches.environment, CI: 'true' } });
      while (true) {
        const event = await process.receive();
        if (!event) throw new Error('Command ended without exit status');
        if (event.type === 'stdout') output += Buffer.from(event.data).toString();
        else if (event.type === 'stderr') errors += Buffer.from(event.data).toString();
        else if (event.type === 'exit') return { exitCode: event.code, stdout: output, stderr: errors };
      }
    }, `guest command in ${vm}: ${script}`, 120_000, { cancel: () => process?.close() });
  } catch (error) {
    throw new Error(`${error.message}\nstdout: ${output}\nstderr: ${errors}`, { cause: error });
  } finally {
    if (process) await withDeadline(() => process.close(), `close command in ${vm}`, 10_000);
  }
}
async function shell(vm, caches, script) {
  const result = await shellResult(vm, caches, script);
  assert.equal(result.exitCode, 0, `Guest command failed: ${script}\n${result.stderr}\n${result.stdout}`);
  return result.stdout;
}
async function removeVm(name) {
  if (creations.has(name)) {
    await settleCreationForCleanup(creations.get(name), () => removeVm(name));
  }
  try {
    await withDeadline(() => vms.get(name)?.remove() ?? Sandbox.remove(name), `remove ${name}`, 20_000);
  } catch (error) {
    if (!/not found|does not exist/i.test(error.message)) throw error;
  }
  vms.delete(name); creations.delete(name); attempted.delete(name);
}
const install = (dir, offline = true) => `mkdir -p ${dir}; cd ${dir}; npm install is-number@7.0.0 --ignore-scripts --no-audit --no-fund --fetch-timeout=15000 --fetch-retries=0 ${offline ? '--offline' : ''}; node -e "if(!require('is-number')(42))process.exit(1)"`;
const toolCheck = `mise exec node@24.4.1 -- node -e 'const fs=require("fs"); if(process.version!=="v24.4.1" || fs.realpathSync(process.execPath)!==fs.realpathSync(process.env.MISE_DATA_DIR+"/installs/node/24.4.1/bin/node"))process.exit(1); console.log(process.execPath,process.version)'`;
let pnpmLock = '';
function pnpmInstall(dir, offline = true) {
  const lock = offline ? `printf %s '${Buffer.from(pnpmLock).toString('base64')}' | base64 -d > pnpm-lock.yaml;` : '';
  return `mkdir -p ${dir}; cd ${dir}; printf '%s' '{"name":"dedup-test","version":"1.0.0","private":true,"dependencies":{"is-number":"7.0.0"}}' > package.json; ${lock}
    store=$(mise exec pnpm@10.13.1 -- pnpm store path); case "$store" in "$npm_config_store_dir"/*) ;; *) echo "wrong pnpm store: $store" >&2; exit 4;; esac;
    mise exec node@24.4.1 pnpm@10.13.1 -- pnpm install --ignore-scripts --reporter append-only ${offline ? '--offline --frozen-lockfile' : '--no-frozen-lockfile'};
    mise exec node@24.4.1 -- node -e 'if(!require("is-number")(42))process.exit(1)'; printf 'store=%s\n' "$store"`;
}
async function scenario(name, fn) {
  const start = Date.now(); await fn();
  results.push({ scenario: name, result: 'PASS', seconds: ((Date.now() - start) / 1000).toFixed(1) });
  console.log(`PASS: ${name}`);
}
let failure;
try {
  await writeFile(reportPath, JSON.stringify(evidence, null, 2) + '\n');
  const repo = join(root, 'repo'); const other = join(root, 'other'); const worktree = join(root, 'worktree');
  for (const dir of [repo, other]) {
    await mkdir(dir); await git(dir, 'init', '-q', '--template', join(root, 'hooks'));
    await writeFile(join(dir, 'README'), 'cache test\n'); await git(dir, 'add', 'README');
    await git(dir, '-c', 'user.name=Pibox Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'test');
  }
  await git(repo, 'worktree', 'add', '--detach', worktree, 'HEAD');
  const main = await resolveCaches(config(repo, 'repository'), repo);
  const linked = await resolveCaches(config(worktree, 'repository'), worktree);
  const isolated = await resolveCaches(config(other, 'repository'), other);
  assert.equal(main.environment.npm_config_store_dir, '/var/cache/pibox/pnpm');
  let first = await boot(main);
  evidence.guestVersions = await shell(first, main, 'node --version; npm --version; mise --version');
  evidence.microsandboxSdkVersion = JSON.parse(await readFile(new URL('../node_modules/microsandbox/package.json', import.meta.url), 'utf8')).version;
  evidence.cachedImage = await bounded(() => Image.get(image), 'inspect pinned image');
  assert.equal(evidence.cachedImage.manifestDigest, image.split('@')[1]);
  const probe = 'curl -I --connect-timeout 3 --max-time 5 --fail https://registry.npmjs.org/is-number';
  evidence.onlineProbe = await shellResult(first, main, probe);
  assert.equal(evidence.onlineProbe.exitCode, 0, 'Online network control must succeed before testing isolation');
  await scenario('1. Cold npm install survives VM removal; fresh VM installs offline', async () => {
    await shell(first, main, install('/tmp/cold', false)); await shell(first, main, 'npm cache verify');
    evidence.measurements.npmContentBeforeConsumers = await treeSnapshot(join(main.caches.find(c => c.name === 'npm').hostPath, '_cacache/content-v2'));
    await removeVm(first); first = await boot(main); await shell(first, main, install('/tmp/warm'));
  });
  const second = await boot(linked, true);
  await scenario('2. Linked worktree shares npm/pnpm caches and the actual mise executable', async () => {
    assert.deepEqual(main.mounts, linked.mounts);
    evidence.offlineProbe = await shellResult(second, linked, probe);
    assert.ok([5, 6, 7, 28].includes(evidence.offlineProbe.exitCode), JSON.stringify(evidence.offlineProbe));
    assert.match(evidence.offlineProbe.stderr, /resolve|connect|network|timed out/i);
    await shell(second, linked, install('/tmp/worktree'));
    await shell(first, main, 'mise install node@24.4.1 pnpm@10.13.1');
    await shell(first, main, pnpmInstall('/tmp/pnpm-cold', false));
    pnpmLock = await shell(first, main, 'cat /tmp/pnpm-cold/pnpm-lock.yaml');
    evidence.measurements.pnpmConsumer = await shell(second, linked, pnpmInstall('/tmp/pnpm-warm'));
    evidence.measurements.toolBeforeConsumer = await toolSnapshot(main);
    evidence.measurements.producerExecutable = await shell(first, main, toolCheck);
    evidence.measurements.consumerExecutable = await shell(second, linked, `MISE_OFFLINE=1 mise install node@24.4.1; ${toolCheck}`);
    evidence.measurements.toolAfterConsumer = await toolSnapshot(linked);
    assert.deepEqual(evidence.measurements.toolBeforeConsumer, evidence.measurements.toolAfterConsumer);
    evidence.measurements.sameHostCachePaths = main.mounts.map((mount, i) => ({ producer: mount.source, consumer: linked.mounts[i].source, target: mount.target }));
  });
  await scenario('3. User-scoped caches share across unrelated repositories', async () => {
    const a = await resolveCaches(config(repo, 'user'), repo); const b = await resolveCaches(config(other, 'user'), other);
    assert.deepEqual(a.mounts, b.mounts);
    const vmA = await boot(a);
    try { await shell(vmA, a, install('/tmp/user-cold', false)); } finally { await removeVm(vmA); }
    const vmB = await boot(b, true);
    try { await shell(vmB, b, install('/tmp/user-warm')); } finally { await removeVm(vmB); }
  });
  await scenario('4. Repository scope isolates unrelated repositories', async () => {
    assert.notEqual(main.mounts[0].source, isolated.mounts[0].source);
    const vm = await boot(isolated, true);
    try {
      const miss = await shellResult(vm, isolated, install('/tmp/must-miss'));
      assert.notEqual(miss.exitCode, 0); assert.match(miss.stderr, /ENOTCACHED/);
    } finally { await removeVm(vm); }
  });
  await scenario('5. Concurrent consumers reuse packages and installed tool without corruption', async () => {
    await Promise.all([
      shell(first, main, install('/tmp/concurrent-a') + '; ' + pnpmInstall('/tmp/pnpm-a') + '; ' + toolCheck),
      shell(second, linked, install('/tmp/concurrent-b') + '; ' + pnpmInstall('/tmp/pnpm-b') + '; ' + toolCheck),
    ]);
    await shell(first, main, 'npm cache verify');
    evidence.measurements.toolAfterConcurrentConsumers = await toolSnapshot(main);
    assert.deepEqual(evidence.measurements.toolAfterConcurrentConsumers, evidence.measurements.toolBeforeConsumer);
    evidence.measurements.npmContent = await treeSnapshot(join(main.caches.find(c => c.name === 'npm').hostPath, '_cacache/content-v2'));
    assert.deepEqual(evidence.measurements.npmContent, evidence.measurements.npmContentBeforeConsumers);
  });
  evidence.status = 'passed';
} catch (error) {
  failure = error; evidence.status = 'failed'; evidence.error = error.stack ?? String(error);
} finally {
  evidence.results = results; evidence.cleanup = [];
  for (const vm of attempted) {
    try { await removeVm(vm); evidence.cleanup.push({ vm, removed: true }); }
    catch (error) { evidence.cleanup.push({ vm, removed: false, error: error.message }); evidence.status = 'failed'; }
  }
  evidence.finalizationErrors = [];
  if (attempted.size === 0) {
    try { await withDeadline(() => rm(root, { recursive: true, force: true }), 'remove test cache directory', 20_000); }
    catch (error) {
      evidence.status = 'failed'; evidence.retainedCacheDirectory = root;
      evidence.finalizationErrors.push(`Cache removal: ${error.message}`);
    }
  } else evidence.retainedCacheDirectory = root;
  evidence.sourceSha256 = {};
  for (const path of ['src/cache.ts', 'src/cache-presets.ts', 'src/sandboxes/microsandbox.ts', 'tests/cache-deduplication.mjs', 'tests/load-typescript.mjs', 'tests/deadline.mjs', 'tests/provisioning.mjs']) {
    try { evidence.sourceSha256[path] = sha256(await readFile(new URL('../' + path, import.meta.url))); }
    catch (error) {
      evidence.status = 'failed'; evidence.finalizationErrors.push(`Hashing ${path}: ${error.message}`);
    }
  }
  for (const key of Object.keys(process.env).filter(key => key.startsWith('GIT_'))) delete process.env[key];
  Object.assign(process.env, previousGit);
  for (const [signal, handler] of handlers) process.removeListener(signal, handler);
  try { await writeFile(reportPath, JSON.stringify(evidence, null, 2) + '\n'); }
  catch (error) {
    evidence.status = 'failed';
    console.error(`Cannot publish evidence to ${reportPath}: ${error.message}\n${JSON.stringify(evidence, null, 2)}`);
    process.exitCode = 1;
  }
  console.log(`Evidence (${evidence.status}): ${reportPath}`);
}
if (failure) throw failure;
assert.equal(evidence.status, 'passed', 'VM cleanup failed; see evidence report and retained cache directory');
console.table(results);
