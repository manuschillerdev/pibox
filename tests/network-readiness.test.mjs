import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { loadTypeScript } from './load-typescript.mjs';
const require=createRequire(import.meta.url);
const {GuestHosts}=await loadTypeScript('../src/network-guest-hosts.ts');
const {hostNetworkReadiness,httpReadiness}=await loadTypeScript('../src/network-readiness.ts');

test('host readiness distinguishes upstream 502 using real HTTP and normal lookup API',async(t)=>{
 let status=502;const server=createServer((_req,res)=>{res.writeHead(status);res.end();});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const dns=require('node:dns/promises'),http=require('node:http');const originalRequest=http.request;
 t.mock.method(dns,'lookup',async()=>[{address:'127.0.0.1',family:4}]);
 t.mock.method(http,'request',(url,options,callback)=>originalRequest(url,{...options,lookup:(_host,_options,done)=>done(null,[{address:'127.0.0.1',family:4}])},callback));
 syncBuiltinESMExports();
 try {
  const url=`http://web.pibox-12345678.pibox.test:${server.address().port}`;
  assert.equal(await hostNetworkReadiness(url),'HTTP reachable (OS resolution) · HTTP 502 · upstream unavailable');
  for(const response of [200,401,403]){status=response;assert.equal(await hostNetworkReadiness(url),`HTTP reachable (OS resolution) · HTTP ${response}`);}
  t.mock.method(dns,'lookup',async()=>[{address:'192.0.2.1',family:4}]);syncBuiltinESMExports();
  assert.match(await hostNetworkReadiness(url),/only to host loopback/);
 }finally{t.mock.restoreAll();syncBuiltinESMExports();await new Promise(r=>server.close(r));}
});
test('guest status reports unavailable upstream and invalid HTTP responses',async()=>{
 const guest=new GuestHosts({},'pibox-12345678');let response='502';guest.run=async()=>response;
 assert.match(await guest.status('http://web.pibox-12345678.pibox.test'),/HTTP 502 · upstream unavailable/);
 response='401';assert.match(await guest.status('http://web.pibox-12345678.pibox.test'),/HTTP 401$/);
 response='000';assert.match(await guest.status('http://web.pibox-12345678.pibox.test'),/No valid HTTP response/);
 assert.throws(()=>httpReadiness(0,'test'),/No valid/);
});
