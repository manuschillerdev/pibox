import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Machine } from 'smolmachines';
import { loadTypeScript } from './load-typescript.mjs';

const { SmolvmProvider } = await loadTypeScript('../src/sandboxes/smolvm.ts');
const { execute } = await loadTypeScript('../src/sandbox.ts');
const { AuthRelay } = await loadTypeScript('../src/auth-relay.ts');
const { createModelCredential, syntheticCodexJwt } = await loadTypeScript('../src/model-credentials.ts');
const { credentialArgs, sendCredentialValues } = await loadTypeScript('../src/sandboxes/smolvm-credentials.ts');

function prepared(provider = 'test', value = 'synthetic-key-first') {
  const credential = createModelCredential(provider, [{ provider, baseUrl: 'https://api.example.test' }], false);
  const placeholder = credential.createPlaceholder(value);
  return { provider, credential, secretName: credential.secretName, sourceEnvName: `PIBOX_SOURCE_TEST_${provider.replaceAll('-', '_')}`,
    lastAppliedValue: value, allowedHosts: credential.allowedHosts, ...placeholder };
}

async function fixture(run) {
  const dir = await mkdtemp(join(tmpdir(), 'pibox-broker-test-'));
  const statePath = join(dir, 'state.json'), cli = join(dir, 'smolvm');
  const socketPath = join(dir, 'credentials.sock');
  const state = async () => JSON.parse(await readFile(statePath, 'utf8'));
  await writeFile(statePath, JSON.stringify({ machines: {}, calls: [] }));
  await writeFile(cli, `#!${process.execPath}
const fs=require('node:fs');
const path=${JSON.stringify(statePath)}, dir=${JSON.stringify(dir)};
const state=JSON.parse(fs.readFileSync(path,'utf8')), args=process.argv.slice(2);
const action=args[1], name=args[args.indexOf('--name')+1];
const options=key=>args.flatMap((value,i)=>value===key?[args[i+1]]:[]);
state.calls.push({action,args, env:Object.fromEntries(Object.entries(process.env).filter(([key])=>key.startsWith('PIBOX_AUTH_')||key.startsWith('PIBOX_SOURCE_')))});
if(action==='create') state.machines[name]={state:'stopped', labels:Object.fromEntries(options('--label').map(value=>value.split('='))), bindings:options('--credential'), smolfile:fs.readFileSync(options('--smolfile')[0],'utf8')};
if(action==='start') state.machines[name].state='running';
if(action==='stop') state.machines[name].state='stopped';
if(action==='delete') delete state.machines[name];
if(action==='data-dir') console.log(dir);
if(action==='exec') {
 const env=Object.fromEntries(state.machines[name].bindings.map(value=>{const [binding,rest]=value.split('=');return [rest.split('@')[0], 'SMOL_PLACEHOLDER_'+binding+'_abcdef'];}));
 for(const pair of options('--env')) { const i=pair.indexOf('=');env[pair.slice(0,i)]=pair.slice(i+1); }
 console.log(JSON.stringify(env));
}
fs.writeFileSync(path,JSON.stringify(state));
`);
  await chmod(cli, 0o700);
  let response = 'ok\n';
  const updates = [];
  const server = createServer({ allowHalfOpen: true }, socket => {
    let input = '';
    socket.on('data', chunk => { input += chunk; });
    socket.on('end', () => {
      updates.push(JSON.parse(input).values);
      socket.end(response);
    });
  });
  server.listen(socketPath); await once(server, 'listening'); await chmod(socketPath, 0o600);
  const previous = { HOME: process.env.HOME, PIBOX_SMOLVM_CLI: process.env.PIBOX_SMOLVM_CLI, PIBOX_SMOLVM_AUTH_POLICY: process.env.PIBOX_SMOLVM_AUTH_POLICY };
  const originalOpen = Machine.open, originalList = Machine.list;
  process.env.HOME = dir; process.env.PIBOX_SMOLVM_CLI = cli; delete process.env.PIBOX_SMOLVM_AUTH_POLICY;
  Machine.open = async name => {
    if (!(await state()).machines[name]) throw Object.assign(new Error('not found'), { code: 'NOT_FOUND' });
    return { state: async () => (await state()).machines[name].state };
  };
  Machine.list = async () => Object.entries((await state()).machines).map(([name, machine]) => ({ name, ...machine }));
  try { await run({ state, updates, socketPath, reply: value => { response = value; } }); }
  finally {
    Machine.open = originalOpen; Machine.list = originalList;
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
}

test('smolVM uses native bindings without guest-secret opt-in; keys only reach the host socket', async () => {
  await fixture(async ({ state, updates }) => {
    const generic = prepared();
    const codexValue = syntheticCodexJwt('test-account').replace(/\.pibox$/, '.synthetic-signature');
    const codex = prepared('openai-codex', codexValue);
    const provider = new SmolvmProvider([generic, codex]);
    const box = await provider.create('brokered', { net: true, net_backend: 'virtio-net' }, []);
    try {
      const env = JSON.parse((await execute(box, ['env'])).stdout);
      assert.match(env[generic.secretName], /^SMOL_PLACEHOLDER_/);
      assert.equal(env[codex.secretName], codex.placeholder);
      assert.match(env[`${codex.secretName}_BROKER`], /^SMOL_PLACEHOLDER_/);
      assert.equal(updates[0][generic.secretName], generic.lastAppliedValue);
      assert.equal(updates[0][codex.secretName], `Bearer ${codexValue}`);
      const record = JSON.stringify(await state());
      for (const value of [generic.lastAppliedValue, codexValue]) assert.ok(!record.includes(value), 'no key in argv, child env, Smolfile or machine metadata');
      assert.ok(!(await state()).calls.some(call => call.args.includes('--secret-env') || call.args.includes('--secret-file')));
      assert.equal(process.env[generic.sourceEnvName], undefined);
      const create = (await state()).calls.find(call => call.action === 'create');
      assert.ok(create.args.includes(`${codex.secretName}=${codex.secretName}_BROKER@chatgpt.com:set-header=authorization`));
    } finally { await box.remove(); await provider.credentialBroker.cleanup(); }
  });
});

test('host credential rotation is acknowledged before AuthRelay advances; errors never echo values', async () => {
  await fixture(async ({ state, updates, reply }) => {
    const credential = prepared();
    let key = credential.lastAppliedValue;
    const provider = new SmolvmProvider([credential]);
    const box = await provider.create('rotation', { net: true }, []);
    const relay = new AuthRelay('rotation', { getApiKeyForProvider: async () => key }, { credentials: [credential], skipped: [] }, provider.credentialBroker);
    try {
      key = 'synthetic-key-rotated';
      assert.equal(await relay.refresh('test'), true);
      assert.equal(updates.at(-1)[credential.secretName], key);
      assert.equal(relay.providerState.get('test').lastAppliedValue, key);
      assert.equal((await state()).calls.filter(call => call.action === 'start').length, 1);
      key = 'synthetic-key-refused'; reply(`error: ${key}\n`);
      await assert.rejects(relay.refresh('test'), error => {
        assert.ok(!error.message.includes(key)); return /acknowledged/.test(error.message);
      });
      assert.equal(relay.providerState.get('test').lastAppliedValue, 'synthetic-key-rotated');
      reply('ok\n');
      await relay.cleanup();
      assert.equal(updates.at(-1)[credential.secretName], '');
    } finally { reply('ok\n'); await box.remove(); await relay.cleanup(); }
  });
});

test('stopped reuse supplies fresh keys and old stopped cleanup cannot revoke a new controller', async () => {
  await fixture(async ({ updates, state }) => {
    const first = new SmolvmProvider([prepared()]);
    const old = await first.create('reuse', { net: true }, []);
    await old.stop();
    const second = new SmolvmProvider([prepared('test', 'synthetic-next-session')]);
    const box = await second.create('reuse', { net: true }, []);
    try {
      const count = updates.length;
      await first.credentialBroker.cleanup();
      assert.equal(updates.length, count);
      assert.equal(updates.at(-1)[prepared().secretName], 'synthetic-next-session');
      assert.equal((await state()).calls.filter(call => call.action === 'create').length, 1);
    } finally { await box.remove(); await second.credentialBroker.cleanup(); }
  });
});

test('legacy opt-in cannot restore plaintext injection and credential overrides are refused', async () => {
  await fixture(async ({ state }) => {
    process.env.PIBOX_SMOLVM_AUTH_POLICY = 'guest-environment';
    const credential = prepared();
    for (const config of [
      { env: [`${credential.secretName}=bad`] },
      { secrets: { [credential.secretName]: { from_env: 'REAL_KEY' } } },
      { dev: { env: [`${credential.secretName}=bad`] } },
    ]) await assert.rejects(new SmolvmProvider([credential]).create('unsafe', config, []), /must not override/);
    assert.equal((await state()).calls.length, 0);
    const provider = new SmolvmProvider([credential]);
    const box = await provider.create('safe', { net: true }, []);
    await execute(box, ['env']);
    assert.ok(!(await state()).calls.some(call => call.args.includes('--secret-env')));
    await box.remove(); await provider.credentialBroker.cleanup();
  });
});

test('invalid credential bindings fail before native mutation', () => {
  for (const hosts of [[], ['api.example.test:443'], ['*.example.test'], ['https://api.example.test'], ['api.example.test:set-header=host']]) {
    assert.throws(() => credentialArgs([{ ...prepared(), allowedHosts: hosts }]), /Invalid native credential/);
  }
});

test('unsafe control socket permissions fail before sending credentials', async () => {
  await fixture(async ({ socketPath, updates }) => {
    await chmod(socketPath, 0o666);
    await assert.rejects(sendCredentialValues(socketPath, { test: 'synthetic-key' }), /Unsafe/);
    assert.equal(updates.length, 0);
  });
});

test('Codex rotation retains account identity and sends only complete bearer values to the host', async () => {
  await fixture(async ({ updates }) => {
    const key = syntheticCodexJwt('account-a').replace(/\.pibox$/, '.fake-first');
    const credential = prepared('openai-codex', key);
    const provider = new SmolvmProvider([credential]);
    const box = await provider.create('codex', { net: true }, []);
    let next = key.replace('fake-first', 'fake-second');
    const relay = new AuthRelay('codex', { getApiKeyForProvider: async () => next }, { credentials: [credential], skipped: [] }, provider.credentialBroker);
    try {
      await relay.refresh('openai-codex');
      assert.equal(updates.at(-1)[credential.secretName], `Bearer ${next}`);
      const count = updates.length;
      next = syntheticCodexJwt('account-b');
      await assert.rejects(relay.refresh('openai-codex'), /account changed/);
      assert.equal(updates.length, count);
    } finally { await box.remove(); await relay.cleanup(); }
  });
});
