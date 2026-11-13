// Opt-in: disposable Debian smolVM, temporary SSH files, no Pi credentials,
// no ~/.ssh changes and no actual VS Code window.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTypeScript } from './load-typescript.mjs';
const { SmolvmProvider }=await loadTypeScript('../src/sandboxes/smolvm.ts');
const { WorkerNetwork }=await loadTypeScript('../src/network.ts');
const { WorkerVscode }=await loadTypeScript('../src/vscode.ts');
const { VscodeHost, runHost }=await loadTypeScript('../src/vscode-host.ts');
const { execute }=await loadTypeScript('../src/sandbox.ts');
const home=await mkdtemp(join(tmpdir(),'pibox-vscode-live-'));
const id=randomBytes(16).toString('hex');
const name=`pibox-vscode-test-${id.slice(0,12)}`;
let sandbox,network,vscode;
let launched=0, failLaunch=false;
const run=async(command,args)=>{
 if(command==='ssh' && args[0]!=='-V') return runHost(command,['-F',join(host.directory,'config'),...args]);
 return runHost(command,args);
};
const host=new VscodeHost(id,run,home);
const guest=async(args)=>{const r=await execute(sandbox,args);assert.equal(r.code,0,r.stderr);return r.stdout;};
try {
 console.log(await runHost('smolvm',['--version']));
 sandbox=await new SmolvmProvider([]).create(name,{
  image:'ghcr.io/manuschillerdev/pibox-base:bookworm',net:true,net_backend:'virtio-net',cpus:2,memory:2048,storage:20,overlay:10,
 },[]);
 const boot=await guest(['cat','/proc/sys/kernel/random/boot_id']);
 await guest(['mkdir','-p','/workspace/ssh test','/root/.ssh']);
 await guest(['/bin/sh','-c',"printf 'untouched-user-keys\\n' > /root/.ssh/authorized_keys"]);
 const policy=await guest(['cat','/usr/sbin/policy-rc.d']);
 network=new WorkerNetwork(sandbox,name,'/live-vscode');
 vscode=new WorkerVscode(sandbox,network,'smolvm','/workspace/ssh test',{
  id,alias:host.alias,
  preflight:async()=>{await runHost('ssh',['-V']);},
  prepare:async()=>{
   await mkdir(host.directory,{recursive:true,mode:0o700});
   const identity=join(host.directory,'identity');
   try {await readFile(identity);}catch(e){if(e.code!=='ENOENT')throw e;await runHost('ssh-keygen',['-q','-t','ed25519','-N','','-f',identity]);}
   return runHost('ssh-keygen',['-y','-f',identity]);
  },
  configure:host.configure.bind(host),probe:host.probe.bind(host),remove:host.remove.bind(host),
  launch:async path=>{assert.equal(path,'/workspace/ssh test');if(failLaunch)throw new Error('simulated launch failure');launched++;},
 });
 await vscode.open();assert.equal(launched,1);assert.equal(network.published.size,1);
 assert.equal((await run('ssh',[host.alias,'id -u'])).trim(),'0');
 const first=[...network.published.values()][0];
 await vscode.open();assert.equal(launched,2);assert.equal([...network.published.values()][0].hostPort,first.hostPort);
 const pinPath=join(host.directory,'known_hosts'), pin=await readFile(pinPath);
 await writeFile(pinPath,'');await assert.rejects(host.probe());await writeFile(pinPath,pin);
 assert.equal(await guest(['cat','/proc/sys/kernel/random/boot_id']),boot);
 assert.equal(await guest(['cat','/usr/sbin/policy-rc.d']),policy);
 assert.equal(await guest(['cat','/root/.ssh/authorized_keys']),'untouched-user-keys\n');
 assert.ok(!(await network.discover()).some(l=>l.port===22),'installation must not start the default SSH daemon');
 failLaunch=true;await assert.rejects(vscode.open(),/simulated launch failure/);
 assert.equal(network.published.size,0);
 await guest(['test','!','-e',`/run/pibox-vscode-${id}`]);
 failLaunch=false;await vscode.open();
 await vscode.close();await network.close();
 assert.equal(network.published.size,0);
 console.log('PASS: real Debian SSH installation, root public-key auth, pinned host verification, native loopback publish, idempotent open, failure rollback and cleanup; preserved policy/authorized_keys, no default sshd, no VM restart');
}finally{
 try {await vscode?.close();await network?.close();}finally{await sandbox?.remove();await rm(home,{recursive:true,force:true});}
}
