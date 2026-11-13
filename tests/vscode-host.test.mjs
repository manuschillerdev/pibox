import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTypeScript } from './load-typescript.mjs';
const { VscodeHost, runHost, sshPath, validateEffectiveConfig } = await loadTypeScript('../src/vscode-host.ts');
const id='b'.repeat(32);
async function fixture() {
 const home=await mkdtemp(join(tmpdir(),'pibox-vscode-host-'));
 const calls=[];
 let host;
 const run=async(command,args)=>{
  calls.push([command,args]);
  if(command==='code')return args[0]==='--list-extensions'?'ms-vscode-remote.remote-ssh\n':'1.99.0\n';
  if(command==='ssh' && args[0]==='-G')return runHost(command,['-F',join(host.directory,'config'),...args]);
  return runHost(command,args);
 };
 host=new VscodeHost(id,run,home);
 return {host,home,calls,async close(){await rm(home,{recursive:true,force:true});}};
}
test('managed include preserves original bytes, backs up once, keeps private keys and pins securely',async()=>{
 const f=await fixture();try{
  await mkdir(join(f.home,'.ssh'),{mode:0o700});
  const config=join(f.home,'.ssh/config');const original=Buffer.from('# my config\r\nHost my-host\r\n  HostName example.com');
  await writeFile(config,original,{mode:0o600});
  await f.host.preflight();const key=await f.host.prepare();const again=await f.host.prepare();assert.equal(key,again);
  const updated=await readFile(config);assert.ok(updated.subarray(updated.length-original.length).equals(original));
  const backups=(await readdir(join(f.home,'.ssh'))).filter(n=>n.startsWith('config.pibox-backup'));
  assert.equal(backups.length,1);assert.deepEqual(await readFile(join(f.home,'.ssh',backups[0])),original);
  assert.equal((await stat(join(f.host.directory,'identity'))).mode&0o777,0o600);
  assert.equal((await stat(f.host.directory)).mode&0o777,0o700);
  await f.host.configure(45678,key);await f.host.configure(45679,key);
  const configText=await readFile(join(f.host.directory,'config'),'utf8');assert.match(configText,/StrictHostKeyChecking yes/);assert.match(configText,/ForwardAgent no/);
  await f.host.launch('/workspace/space # %');assert.deepEqual(f.calls.at(-1),['code',['--new-window','--remote',`ssh-remote+${f.host.alias}`,'/workspace/space # %']]);
  await f.host.remove();assert.equal(await readFile(config,'utf8'),updated.toString());
 }finally{await f.close();}
});
test('host key pin changes are rejected without replacement',async()=>{
 const f=await fixture();try{
  const key=await f.host.prepare();await f.host.configure(45678,key);
  const path=join(f.host.directory,'known_hosts');await writeFile(path,'different pin\n');
  await assert.rejects(f.host.configure(45678,key),/host key changed/);assert.equal(await readFile(path,'utf8'),'different pin\n');
 }finally{await f.close();}
});
test('config symlinks and existing locks fail without changing their targets',async()=>{
 const f=await fixture();try{
  await mkdir(join(f.home,'.ssh'),{mode:0o700});const target=join(f.home,'original');await writeFile(target,'unchanged');
  await symlink(target,join(f.home,'.ssh/config'));await assert.rejects(f.host.prepare(),/Unsafe SSH file/);assert.equal(await readFile(target,'utf8'),'unchanged');
  await rm(join(f.home,'.ssh/config'));await writeFile(join(f.home,'.ssh/.pibox-vscode.lock'),'busy');
  await assert.rejects(f.host.prepare(),/locked/);assert.equal(await readFile(join(f.home,'.ssh/.pibox-vscode.lock'),'utf8'),'busy');
 }finally{await f.close();}
});
test('effective SSH config rejects unsafe overrides, extra identities and forwarding',async()=>{
 const f=await fixture();try{
  const key=await f.host.prepare();await f.host.configure(45678,key);
  const text=await runHost('ssh',['-G','-F',join(f.host.directory,'config'),f.host.alias]);
  validateEffectiveConfig(text,f.host.alias,45678,f.host.directory);
  for(const unsafe of [text.replace('stricthostkeychecking true','stricthostkeychecking false'),text+'\nidentityfile /tmp/unrelated\n',text+'\nproxycommand bad command\n',text+'\nlocalforward *:5000 localhost:22\n']){
   assert.throws(()=>validateEffectiveConfig(unsafe,f.host.alias,45678,f.host.directory),/conflict|Conflicting|Unsafe/);
  }
 }finally{await f.close();}
});
test('SSH config path quoting rejects control/injection characters and escapes tokens',()=>{
 assert.equal(sshPath('/home/space %user/key'),'"/home/space %%user/key"');
 for(const path of ['/home/a\nHost *','/home/a"','relative','/home/a\\b'])assert.throws(()=>sshPath(path));
});
