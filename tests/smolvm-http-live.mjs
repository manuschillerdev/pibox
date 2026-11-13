// Explicit opt-in: creates/deletes ONE uniquely named VM. No model credentials,
// host resolver/trust changes, or access to existing VMs/containers.
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { once } from 'node:events';
import { connect } from 'node:net';
import { loadTypeScript } from './load-typescript.mjs';
const { SmolvmProvider }=await loadTypeScript('../src/sandboxes/smolvm.ts');
const { WorkerNetwork }=await loadTypeScript('../src/network.ts');
const { EmbeddedPortless }=await loadTypeScript('../src/network-portless.ts');
const { execute }=await loadTypeScript('../src/sandbox.ts');
const name=`pibox-http-test-${process.pid}-${Date.now()}`;
// Explicit test-only override; production always defaults to 80, never falls back.
const testPort=Number(process.env.PIBOX_TEST_HTTP_PORT ?? 80);
assert.ok(Number.isInteger(testPort) && testPort >= 0 && testPort <= 65535);
const proxy=new EmbeddedPortless(testPort);
let sandbox,network;const idle=[];
const run=async(command)=>{const result=await execute(sandbox,command);assert.equal(result.code,0,result.stderr);return result.stdout.trim();};
try {
 sandbox=await new SmolvmProvider([]).create(name,{net:true,net_backend:'virtio-net',cpus:2,memory:2048,storage:8,overlay:4},[]);
 await run(['sh','-c','apk add --no-cache nodejs curl && mkdir -p /opt/pibox/node/bin && ln -s /usr/bin/node /opt/pibox/node/bin/node']);
 await run(['sh','-c',`nohup node -e 'const h=require("http"),c=require("crypto");const s=h.createServer((q,r)=>{if(q.url==="/unavailable")r.statusCode=502;r.end("canonical-http-ok");});s.on("upgrade",(q,x)=>{const a=c.createHash("sha1").update(q.headers["sec-websocket-key"]+"258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");x.write("HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: "+a+"\\r\\n\\r\\n");x.write(Buffer.from([129,2,111,107]));});s.listen(3456,"0.0.0.0");' >/tmp/app.log 2>&1 </dev/null &`]);
 await run(['sh','-c',`printf '192.0.2.1 unmanaged.example # keep-this\n' >> /etc/hosts`]);
 const boot=await run(['cat','/proc/sys/kernel/random/boot_id']);
 network=new WorkerNetwork(sandbox,name,'/http-test',proxy);
 const listeners=await network.discover(),listener=listeners.find(l=>l.port===3456);assert.ok(listener);
 await network.publish(listener,'web','http');const service=network.published.get(`${listener.host}:${listener.port}`);assert.ok(service);
 const url=new URL(service.endpoint);assert.equal(url.protocol,'http:');if(testPort===80)assert.equal(url.port,'');
 const actualPort=Number(url.port||80);
 console.log(`Canonical test URL: ${url} (explicit test port ${actualPort}; production port 80)`);
 const lookup=(_host,_options,done)=>done(null,[{address:'127.0.0.1',family:4}]);
 const hostGet=(options={})=>new Promise((resolve,reject)=>{const req=request(url,{lookup,agent:false,...options},res=>{let body='';res.on('data',d=>body+=d);res.on('end',()=>resolve(body));});req.on('error',reject);req.end();});
 assert.equal(await hostGet(),'canonical-http-ok');
 assert.equal(await run(['curl','--noproxy','*','--fail','--silent','--show-error',service.endpoint]),'canonical-http-ok');
 assert.match(service.readiness.guest,/HTTP reachable/);
 assert.match(await network.guestHosts.status(service.endpoint+'/unavailable'),/HTTP 502 · upstream unavailable/);
 const req=request(url,{lookup,headers:{Connection:'Upgrade',Upgrade:'websocket','Sec-WebSocket-Key':'dGhlIHNhbXBsZSBub25jZQ==','Sec-WebSocket-Version':'13'}});req.end();
 const [response,socket,head]=await once(req,'upgrade');assert.equal(response.statusCode,101);let data=head;while(data.length<4)data=Buffer.concat([data,(await once(socket,'data'))[0]]);assert.deepEqual(data,Buffer.from([129,2,111,107]));
 const closed=once(socket,'close');socket.resume();
 for(const host of ['127.0.0.1','::1']){const peer=connect(actualPort,host);peer.on('error',()=>{});await once(peer,'connect');peer.write('GET / HTTP/1.1\r\nHost: ');idle.push(peer);}
 await network.unpublish(`${listener.host}:${listener.port}`);await closed;
 await assert.rejects(hostGet({lookup:(_host,_options,done)=>done(null,[{address:'127.0.0.1',family:4}])}));
 assert.equal(await run(['sh','-c',`grep -c 'pibox-net:${network.portless.namespace}' /etc/hosts || true`]),'0');
 assert.match(await run(['cat','/etc/hosts']),/192.0.2.1 unmanaged.example # keep-this/);
 assert.equal(await run(['cat','/proc/sys/kernel/random/boot_id']),boot);
 console.log('PASS: same HTTP hostname from host (explicit test lookup only) and guest (normal resolution); WebSocket; HTTP 502 readiness; idle teardown; no VM restart. Host OS setup deliberately not installed.');
}finally{for(const peer of idle)peer.destroy();try{await network?.close();}finally{await sandbox?.remove();}}
