import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadTypeScript } from './load-typescript.mjs';
const exec=promisify(execFile);
const {HOSTS_HELPER,needsHostMapping,hostSetupCommand,installHostMapping}=await loadTypeScript('../src/network-hosts.ts');
const {GUEST_HOSTS_SCRIPT}=await loadTypeScript('../src/network-guest-hosts.ts');
const name='web.pibox-12345678.pibox.test',other='api.pibox-87654321.pibox.test';

test('host mapping reuses unmanaged loopback entries and rejects conflicts or unsafe names',()=>{
 assert.equal(needsHostMapping('127.0.0.1 localhost\n',name),true);
 for(const ip of ['127.0.0.1','::1'])assert.equal(needsHostMapping(`${ip} alias ${name.toUpperCase()}. # unmanaged\n`,name),false);
 assert.throws(()=>needsHostMapping(`127.0.0.1 ${name}\n192.0.2.1 ${name}\n`,name),/Conflicting/);
 for(const bad of ['web.localhost','web.pibox-12345678.pibox.test;id','../hosts','web.pibox-12345678.pibox.test\n'])assert.throws(()=>hostSetupCommand(bad),/Invalid/);
});
test('privileged helper appends exact durable entries while preserving shared Portless and other workers',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'pibox-hosts-')),path=join(dir,'hosts');
 const initial=`# portless-start\n127.0.0.1 other.test\n# portless-end\n127.0.0.1 ${other} # pibox-net\n192.0.2.5 unmanaged`;
 const script=HOSTS_HELPER.replace("'/etc/hosts'",JSON.stringify(path));
 try{
  await writeFile(path,initial);await exec('/usr/bin/perl',['-e',script,'--',name]);
  const result=await readFile(path,'utf8');assert.equal(result,initial+`\n127.0.0.1 ${name} # pibox-net\n`);
  await exec('/usr/bin/perl',['-e',script,'--',name]);assert.equal(await readFile(path,'utf8'),result);
  await writeFile(path,`::1 ${name} # unmanaged\n`);await exec('/usr/bin/perl',['-e',script,'--',name]);assert.equal(await readFile(path,'utf8'),`::1 ${name} # unmanaged\n`);
  await writeFile(path,`192.0.2.1 ${name}\n`);await assert.rejects(exec('/usr/bin/perl',['-e',script,'--',name]),/Conflicting/);assert.equal(await readFile(path,'utf8'),`192.0.2.1 ${name}\n`);
  await assert.rejects(exec('/usr/bin/perl',['-e',script,'--',name+';id']),/Invalid/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('host authorization failure is surfaced without trying a fallback elevation',async()=>{
 let calls=0;await assert.rejects(installHostMapping(name,async(command,args)=>{calls++;assert.ok(command.endsWith('osascript')||command==='pkexec');assert.ok(args.includes(name)||args.some(a=>a.includes(HOSTS_HELPER.split('\n')[1])));return {code:1,stderr:'cancelled'};}),/cancelled/);assert.equal(calls,1);
});
test('guest mappings preserve other workers/unmanaged names and clean up only own entries',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'pibox-guest-hosts-')),path=join(dir,'hosts'),lock=join(dir,'lock');
 const initial=`127.0.0.1 localhost\n192.0.2.5 unmanaged\n10.0.2.2 ${other} # pibox-net:pibox-87654321\n`;
 const script=GUEST_HOSTS_SCRIPT.replaceAll("'/etc/hosts'",JSON.stringify(path)).replace("'/tmp/pibox-net-hosts.lock'",JSON.stringify(lock)).replace("await dns.lookup('host.smolvm.internal',{family:4})","{address:'10.0.2.2'}");
 const apply=names=>exec(process.execPath,['-e',script,JSON.stringify({namespace:'pibox-12345678',names})]);
 try{
  await writeFile(path,initial);await apply([name]);const added=await readFile(path,'utf8');assert.equal(added,initial+`10.0.2.2 ${name} # pibox-net:pibox-12345678\n`);
  await apply([name]);assert.equal(await readFile(path,'utf8'),added);await apply([]);assert.equal(await readFile(path,'utf8'),initial);
  const unmanaged=initial+`10.0.2.2 ${name} # unmanaged\n`;await writeFile(path,unmanaged);await apply([name]);await apply([]);assert.equal(await readFile(path,'utf8'),unmanaged);
  const conflict=initial+`127.0.0.1 ${name}\n`;await writeFile(path,conflict);await assert.rejects(apply([name]),/Conflicting/);assert.equal(await readFile(path,'utf8'),conflict);
 }finally{await rm(dir,{recursive:true,force:true});}
});
