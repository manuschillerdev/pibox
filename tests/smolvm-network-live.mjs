// Explicit opt-in: creates and deletes one disposable local smolVM, no credentials.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { request } from 'node:https';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, createServer } from 'node:net';
import { Machine } from 'smolmachines';
import { once } from 'node:events';
import { loadTypeScript } from './load-typescript.mjs';
const { SmolvmProvider }=await loadTypeScript('../src/sandboxes/smolvm.ts');
const { WorkerNetwork }=await loadTypeScript('../src/network.ts');
const { execute }=await loadTypeScript('../src/sandbox.ts');
const { EmbeddedPortless }=await loadTypeScript('../src/network-portless.ts');
const { NetworkCertificates }=await loadTypeScript('../src/network-tls.ts');
const directory=await mkdtemp(join(tmpdir(),'pibox-native-tls-'));
const certificates=new NetworkCertificates(directory);
const ca=await certificates.ca();
const name=`pibox-net-test-${process.pid}-${Date.now()}`;
const cli=process.env.PIBOX_SMOLVM_CLI || 'smolvm';
let sandbox,network,socket;
const run=async(command)=>{const r=await execute(sandbox,command);assert.equal(r.code,0,r.stderr);return r.stdout;};
const get=url=>new Promise((resolve,reject)=>{
  const parsed=new URL(url);const req=request({hostname:'127.0.0.1',servername:parsed.hostname,ca,port:parsed.port||443,headers:{host:parsed.host},agent:false},res=>{
    let body='';res.on('data',chunk=>body+=chunk);res.on('end',()=>resolve(body));
  });req.on('error',reject);req.end();
});
try {
  console.log(execFileSync(cli,['--version'],{encoding:'utf8'}).trim());
  const reservation=createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');
  const configuredHost=reservation.address().port;await new Promise(r=>reservation.close(r));
  sandbox=await new SmolvmProvider([]).create(name,{net:true,net_backend:'virtio-net',cpus:1,memory:512,storage:2,dev:{ports:[`${configuredHost}:3458`]}},[]);
  await run(['/bin/sh','-c','apk add --no-cache nodejs curl ca-certificates && mkdir -p /opt/pibox/node/bin && ln -s /usr/bin/node /opt/pibox/node/bin/node']);
  await run(['/bin/sh','-c',`nohup node -e 'require("http").createServer((req,res)=>res.end("native-smolvm-ok")).listen(3456,"0.0.0.0");require("net").createServer(s=>s.pipe(s)).listen(3457,"0.0.0.0")' >/tmp/server.log 2>&1 </dev/null &`]);
  const boot=await run(['cat','/proc/sys/kernel/random/boot_id']);
  network=new WorkerNetwork(sandbox,name,'/native-probe',new EmbeddedPortless(443,certificates,0));
  let listeners=[];
  for(let i=0;i<20;i++){listeners=await network.discover();if(listeners.some(l=>l.port===3456))break;await new Promise(r=>setTimeout(r,100));}
  const http=listeners.find(l=>l.port===3456),tcp=listeners.find(l=>l.port===3457);
  assert.ok(http);assert.ok(tcp);
  await network.publish(http,'web','http');
  const web=network.published.get(`${http.host}:${http.port}`);
  assert.equal(await get(web.endpoint),'native-smolvm-ok');
  await network.publish(tcp,'echo','tcp');
  const echo=network.published.get(`${tcp.host}:${tcp.port}`);
  socket=connect(echo.hostPort,'127.0.0.1');await once(socket,'connect');
  socket.write('before');assert.equal((await once(socket,'data'))[0].toString(),'before');
  await network.unpublish(`${tcp.host}:${tcp.port}`);
  socket.write('after');assert.equal((await once(socket,'data'))[0].toString(),'after');
  await assert.rejects(new Promise((resolve,reject)=>{const c=connect(echo.hostPort,'127.0.0.1');c.once('connect',()=>{c.destroy();resolve();});c.once('error',reject);}));
  socket.destroy();socket=undefined;
  assert.equal(await run(['cat','/proc/sys/kernel/random/boot_id']),boot,'VM must not restart');
  await network.unpublish(`${http.host}:${http.port}`);await assert.rejects(get(web.endpoint));
  await network.close();
  const native=await Machine.open(name,{target:'local'});
  assert.deepEqual(await native.ports(),[{host:configuredHost,guest:3458,protocol:'tcp'}]);
  console.log('PASS native publish + embedded HTTPS + discovery; raw TCP survives unpublish, new connections refused; boot ID unchanged; configured native mapping preserved');
} finally {
  socket?.destroy();
  try {await network?.close();} finally {await sandbox?.remove();await rm(directory,{recursive:true,force:true});}
}
