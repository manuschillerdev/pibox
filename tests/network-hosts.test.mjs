import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadTypeScript } from './load-typescript.mjs';
const exec=promisify(execFile);
const {GUEST_HOSTS_SCRIPT}=await loadTypeScript('../src/network-guest-hosts.ts');
const name='web.pibox-12345678.localhost',other='api.pibox-87654321.localhost';

test('guest .localhost mappings preserve other workers and unmanaged names, and clean up only own entries',async()=>{
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
