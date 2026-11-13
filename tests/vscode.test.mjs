import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTypeScript } from './load-typescript.mjs';
const { WorkerVscode, parseGuest } = await loadTypeScript('../src/vscode.ts');
const { WorkerNetwork } = await loadTypeScript('../src/network.ts');
const { registerCommands } = await loadTypeScript('../src/commands.ts');
const { Worker } = await loadTypeScript('../src/worker.ts');
const { PendingTcpPublicationError } = await loadTypeScript('../src/sandbox.ts');
const wire = Buffer.concat([Buffer.from('0000000b','hex'), Buffer.from('ssh-ed25519'), Buffer.from('00000020','hex'), Buffer.alloc(32, 1)]);
const key = `ssh-ed25519 ${wire.toString('base64')}`;
function fixture(provider='smolvm') {
  const calls=[];
  const host = {id:'a'.repeat(32),alias:'pibox-test',
    async preflight(){calls.push('preflight');},async prepare(){calls.push('key');return key;},
    async configure(port,pin){calls.push(['config',port,pin]);},async probe(){calls.push('probe');},
    async launch(path){calls.push(['launch',path]);},async remove(){calls.push('remove');},
  };
  const sandbox = {
    async startProcess(args) {
      const input=JSON.parse(args.at(-1));calls.push(input.action);
      const events = input.action==='prepare' ? [{type:'stdout',data:Buffer.from(JSON.stringify({port:3456,hostKey:key}))},{type:'exit',code:0}] : [{type:'exit',code:0}];
      return {async receive(){return events.shift();},async close(){},async write(){}};
    },
    async publishTcp(){calls.push('publish');return 45678;},async unpublishTcp(){calls.push('unpublish');},
  };
  const network=new WorkerNetwork(sandbox,'test','/workspace');
  network.discover=async()=>[{host:'127.0.0.1',address:'0.0.0.0',port:3456,process:'sshd'}];
  const vscode=new WorkerVscode(sandbox,network,provider,'/work dir/#project',host);
  return {vscode,network,host,sandbox,calls};
}
test('open prepares, pins, probes, launches actual folder and reuses native publication',async()=>{
  const f=fixture();await f.vscode.open();await f.vscode.open();
  assert.equal(f.calls.filter(c=>c==='publish').length,1);
  assert.equal(f.calls.filter(c=>c==='prepare').length,2);
  assert.deepEqual(f.calls.find(c=>Array.isArray(c)&&c[0]==='config'),['config',45678,key]);
  assert.deepEqual(f.calls.find(c=>Array.isArray(c)&&c[0]==='launch'),['launch','/work dir/#project']);
  await f.vscode.close();await f.vscode.close();await f.network.close();
  assert.equal(f.calls.filter(c=>c==='unpublish').length,1);
  assert.ok(f.calls.indexOf('unpublish')<f.calls.indexOf('remove'));
  await assert.rejects(f.vscode.open(),/closed/);
});
test('unsupported provider and unavailable code fail before all mutation',async()=>{
  const unsupported=fixture('microsandbox');await assert.rejects(unsupported.vscode.open(),/smolVM only/);assert.deepEqual(unsupported.calls,[]);
  const missing=fixture();missing.host.preflight=async()=>{throw new Error('code missing');};
  await assert.rejects(missing.vscode.open(),/code missing/);assert.deepEqual(missing.calls,[]);
});
test('launch failure rolls back native mapping and daemon before removing identity; retry succeeds',async()=>{
  const f=fixture();const launch=f.host.launch;f.host.launch=async()=>{throw new Error('code failed');};
  await assert.rejects(f.vscode.open(),/code failed/);
  assert.equal(f.network.published.size,0);
  assert.ok(f.calls.indexOf('unpublish')<f.calls.indexOf('stop'));
  assert.ok(f.calls.indexOf('stop')<f.calls.indexOf('remove'));
  f.host.launch=launch;await f.vscode.open();await f.vscode.close();await f.network.close();
});
test('failed revocation retains keys/config and a retryable network entry',async()=>{
  const f=fixture();await f.vscode.open();const unpublish=f.sandbox.unpublishTcp;
  f.sandbox.unpublishTcp=async()=>{throw new Error('native unavailable');};
  await assert.rejects(f.vscode.close(),/may remain active/);
  assert.ok(!f.calls.includes('remove'));assert.equal(f.network.published.size,1);
  f.sandbox.unpublishTcp=unpublish;await f.vscode.close();assert.ok(f.calls.includes('remove'));await f.network.close();
});
test('shutdown during provisioning waits and rolls back without opening a window',async()=>{
  const f=fixture();let release,entered;const started=new Promise(r=>entered=r);
  const start=f.sandbox.startProcess;f.sandbox.startProcess=async(args)=>{
    if(JSON.parse(args.at(-1)).action==='prepare'){entered();await new Promise(r=>release=r);}
    return start(args);
  };
  const opening=f.vscode.open();const rejected=assert.rejects(opening,/closed/);await started;
  const close=f.vscode.close();release();await rejected;await close;await f.network.close();
  assert.ok(!f.calls.includes('publish'));assert.ok(f.calls.includes('stop'));assert.ok(!f.calls.some(c=>Array.isArray(c)&&c[0]==='launch'));
});
test('concurrent opens serialize and listener unpublish can be recovered',async()=>{
  const f=fixture();await Promise.all([f.vscode.open(),f.vscode.open()]);
  assert.equal(f.calls.filter(c=>c==='publish').length,1);
  await f.network.unpublish('127.0.0.1:3456');await f.vscode.open();
  assert.equal(f.calls.filter(c=>c==='publish').length,2);await f.vscode.close();await f.network.close();
});
test('ambiguous native publication retains cleanup ownership and supports retry',async()=>{
  const f=fixture();const publish=f.sandbox.publishTcp, unpublish=f.sandbox.unpublishTcp;
  f.sandbox.publishTcp=async()=>{throw new PendingTcpPublicationError(45678,3456,new Error('native failure'));};
  f.sandbox.unpublishTcp=async()=>{throw new Error('cannot revoke');};
  await assert.rejects(f.vscode.open(),/cleanup incomplete/);assert.equal(f.network.published.size,1);assert.ok(!f.calls.includes('remove'));
  f.sandbox.publishTcp=publish;f.sandbox.unpublishTcp=unpublish;
  // The first retry reports the failed entry and completes its cleanup.
  await assert.rejects(f.vscode.open(),/conflicting or failed publication/);
  assert.equal(f.network.published.size,0);await f.vscode.open();await f.vscode.close();await f.network.close();
});
test('a competing publication is never claimed or revoked during setup rollback',async()=>{
  const f=fixture();let competing;
  f.network.publish=async listener=>{
    competing={listener:{...listener},name:'user-service',mode:'tcp',hostPort:45679,endpoint:'127.0.0.1:45679'};
    f.network.published.set('127.0.0.1:3456',competing);throw new Error('publication race');
  };
  await assert.rejects(f.vscode.open(),/publication race/);
  assert.equal(f.network.published.get('127.0.0.1:3456'),competing);assert.ok(!f.calls.includes('unpublish'));
  await f.vscode.close();assert.equal(f.network.published.size,1);await f.network.close();
});
test('queued replacement publication survives VS Code cleanup',async()=>{
  const f=fixture();await f.vscode.open();
  let release, entered;
  const started=new Promise(resolve=>entered=resolve);
  const unpublish=f.sandbox.unpublishTcp;
  f.sandbox.unpublishTcp=async()=>{entered();await new Promise(resolve=>release=resolve);await unpublish();};
  const removing=f.network.unpublish('127.0.0.1:3456');await started;
  const replacing=f.network.publish({host:'127.0.0.1',address:'0.0.0.0',port:3456,process:'sshd'},'replacement','tcp');
  const closing=f.vscode.close();
  // Let close queue its revocation while the previous record is still present.
  await new Promise(resolve=>setImmediate(resolve));
  f.sandbox.unpublishTcp=unpublish;release();
  await Promise.all([removing,replacing,closing]);
  assert.equal(f.network.published.get('127.0.0.1:3456')?.name,'replacement');
  assert.equal(f.calls.filter(c=>c==='unpublish').length,1);
  await f.network.close();
});
test('changed trusted-exec host key is never silently repinned',async()=>{
  const f=fixture();await f.vscode.open();
  const changed=Buffer.from(wire);changed[changed.length-1]=2;
  const alternate=`ssh-ed25519 ${changed.toString('base64')}`;
  const start=f.sandbox.startProcess;f.sandbox.startProcess=async args=>{
    const child=await start(args), receive=child.receive;
    child.receive=async()=>{const e=await receive();if(e?.type==='stdout')e.data=Buffer.from(JSON.stringify({port:3456,hostKey:alternate}));return e;};return child;
  };
  await assert.rejects(f.vscode.open(),/host key changed/);
  assert.equal(f.calls.filter(c=>Array.isArray(c)&&c[0]==='config').length,1);
  assert.equal(f.network.published.size,0);await f.vscode.close();await f.network.close();
});
test('rejects untrusted guest endpoint and SSH key text',()=>{
  for(const value of [null,{}, {port:0,hostKey:key}, {port:22,hostKey:key+'\nother'}, {port:22,hostKey:'ssh-ed25519 '+ 'A'.repeat(68)}]) assert.throws(()=>parseGuest(value));
  assert.deepEqual(parseGuest({port:22,hostKey:key}),{port:22,hostKey:key});
});
test('command resolves routed or named workers, confirms, handles cancellation and usage errors',async()=>{
  const commands=new Map(), calls=[], notices=[];let yes=true;
  const worker={vscode:{async preflight(){calls.push('preflight');},async open(){calls.push('open');return 'pibox-alias';}}};
  const registry={routed(){calls.push('routed');return worker;},get(name){calls.push(name);return worker;}};
  registerCommands({registerCommand(name,options){commands.set(name,options);}},registry);
  const ctx={hasUI:true,ui:{async confirm(){calls.push('confirm');return yes;},notify(...args){notices.push(args);}}};
  const command=commands.get('pibox-vscode').handler;
  await command('',ctx);assert.deepEqual(calls,['routed','preflight','confirm','open']);
  calls.length=0;yes=false;await command('named',ctx);assert.deepEqual(calls,['named','preflight','confirm']);
  calls.length=0;await command('too many',ctx);assert.deepEqual(calls,[]);assert.match(notices.at(-1)[0],/Usage/);
  calls.length=0;await command('',{...ctx,hasUI:false});assert.deepEqual(calls,['routed','preflight']);assert.match(notices.at(-1)[0],/requires UI confirmation/);
  registry.routed=()=>undefined;await command('',ctx);assert.match(notices.at(-1)[0],/Connect a worker/);
});
test('worker lifecycle closes VS Code ownership before network and VM, retries cleanup',async()=>{
  const calls=[];let fail=true;
  const worker=new Worker({id:'test',sandbox:{async stop(){calls.push('vm');}},rpc:{async getState(){return {};},async close(){calls.push('rpc');}},authRelay:{providerState:new Map(),cleanup(){}}});
  worker.workerVscode={async close(){calls.push('vscode');if(fail)throw new Error('retry');}};
  worker.workerNetwork={async close(){calls.push('network');}};
  await assert.rejects(worker.shutdown(),/retry/);assert.deepEqual(calls,['vscode','network','rpc','vm']);
  calls.length=0;fail=false;await worker.shutdown();assert.deepEqual(calls,['vscode','network','vm']);
});
