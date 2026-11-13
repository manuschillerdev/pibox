import assert from 'node:assert/strict';
import test from 'node:test';
import { request } from 'node:http';
import { createServer as createHttpServer } from 'node:http';
import { connect, createServer as createTcpServer } from 'node:net';
import { networkInterfaces } from 'node:os';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { loadTypeScript } from './load-typescript.mjs';

const { EmbeddedPortless, PortlessRoutes } = await loadTypeScript('../src/network-portless.ts');
const proxyAt = (port=0) => new EmbeddedPortless(port);
function get(url, host) {
  const parsed=new URL(url);
  return new Promise((resolve,reject)=>{
    const req=request({hostname:'127.0.0.1',port:parsed.port,path:parsed.pathname,headers:{host:host || parsed.host},agent:false},res=>{
      let body='';res.on('data',data=>body+=data);res.on('end',()=>resolve({status:res.statusCode,body}));
    }); req.on('error',reject);req.end();
  });
}
async function backend() {
  const sockets=new Set();
  const server=createHttpServer((req,res)=>res.end(JSON.stringify({host:req.headers.host,path:req.url,proto:req.headers['x-forwarded-proto']})));
  server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
  server.on('upgrade',(req,socket)=>{
    const accept=createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.write(Buffer.from([0x81,5,...Buffer.from('hello')]));
    socket.on('error',()=>{});
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  return {port:server.address().port,async close(){for(const socket of sockets) socket.destroy();await new Promise(r=>server.close(r));}};
}

test('embedded Portless serves exact in-memory routes, preserves origin and isolates controllers', {timeout:10000}, async()=>{
  const target=await backend();
  const proxy=proxyAt();
  const a=new PortlessRoutes('pibox-a',proxy),b=new PortlessRoutes('pibox-b',proxy);
  const other=new PortlessRoutes('pibox-a',proxyAt());
  let routeA,routeB,routeOther;
  try {
    routeA=await a.add('web',target.port);routeB=await b.add('api',target.port);routeOther=await other.add('web',target.port);
    assert.equal(new URL(routeA.url).port,new URL(routeB.url).port);
    assert.notEqual(new URL(routeA.url).port,new URL(routeOther.url).port);
    const response=await get(routeA.url+'/api');
    assert.equal(response.status,200);
    assert.deepEqual(JSON.parse(response.body),{host:new URL(routeA.url).host,path:'/api',proto:'http'});
    assert.equal((await get(routeA.url,'unknown.pibox.test')).status,404);
    assert.equal((await get(routeA.url,'child.'+routeA.hostname)).status,404);
    await assert.rejects(a.add('web',target.port),/already published/);
    await assert.rejects(a.remove(routeA.hostname,target.port+1),/another publication/);
    await a.remove(routeA.hostname,target.port);
    assert.equal((await get(routeA.url)).status,404);
    assert.equal((await get(routeB.url)).status,200);
    assert.equal((await get(routeOther.url)).status,200);
    await b.remove(routeB.hostname,target.port);
    await assert.rejects(get(routeB.url),/ECONNREFUSED/);
  } finally {
    if(routeA) await a.remove(routeA.hostname,target.port);
    if(routeB) await b.remove(routeB.hostname,target.port);
    if(routeOther) await other.remove(routeOther.hostname,target.port);
    await target.close();
  }
});

test('embedded Portless forwards real WebSocket handshake/data and closes upgrades on final unpublish', {timeout:10000}, async()=>{
  const target=await backend(); const routes=new PortlessRoutes('pibox-ws',proxyAt());
  const route=await routes.add('web',target.port);
  const url=new URL(route.url);
  // Native client connects to numeric loopback to avoid platform DNS differences;
  // use a raw HTTP upgrade with the actual named Host to exercise routing.
  const req=request({hostname:'127.0.0.1',port:url.port,headers:{Host:url.host,Connection:'Upgrade',Upgrade:'websocket','Sec-WebSocket-Key':'dGhlIHNhbXBsZSBub25jZQ==','Sec-WebSocket-Version':'13'}});
  req.end();
  let socket;
  try {
    const [res,upgraded,head]=await once(req,'upgrade'); socket=upgraded; socket.on('error',()=>{});
    assert.equal(res.statusCode,101);
    assert.equal(res.headers['sec-websocket-accept'],'s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
    let data=head;
    while(data.length<7) data=Buffer.concat([data,(await once(socket,'data'))[0]]);
    assert.deepEqual(data,Buffer.from([0x81,5,...Buffer.from('hello')]));
    const closed=once(socket,'close');socket.resume();
    await routes.remove(route.hostname,target.port);await closed;
    await assert.rejects(get(route.url),/ECONNREFUSED/);
  } finally {socket?.destroy();req.destroy();await routes.remove(route.hostname,target.port);await target.close();}
});

test('embedded proxy refuses an occupied port without fallback or disturbing its owner', {timeout:5000}, async()=>{
  const occupied=createTcpServer();
  occupied.listen(0,'127.0.0.1');await once(occupied,'listening');
  const port=occupied.address().port;
  const target=await backend();const routes=new PortlessRoutes('pibox-conflict',proxyAt(port));
  try {
    await assert.rejects(routes.add('web',target.port),new RegExp(`port ${port} is already in use`));
    assert.ok(occupied.listening);
  } finally {await target.close();await new Promise(r=>occupied.close(r));}
});

test('IPv6-only conflict refuses publication and leaves IPv4 available', {timeout:5000}, async()=>{
  const occupied=createTcpServer();
  occupied.listen({port:0,host:'::',ipv6Only:true});await once(occupied,'listening');
  const port=occupied.address().port;
  const target=await backend();const routes=new PortlessRoutes('pibox-conflict',proxyAt(port));
  const probe=createTcpServer();
  try {
    await assert.rejects(routes.add('web',target.port),/already in use/);
    probe.listen(port,'0.0.0.0');await once(probe,'listening');
    assert.ok(occupied.listening);
  } finally {await target.close();await new Promise(r=>occupied.close(r));await new Promise(r=>probe.close(r));}
});

test('default proxy port is 80 and returned URLs omit the default port', async()=>{
  const proxy=new EmbeddedPortless();
  assert.equal(proxy.listenPort,80);
  // Exercise add's URL construction without binding a privileged CI port.
  proxy.start=async()=>{proxy.server={port:80,async close(){}};};
  const target=await backend();const routes=new PortlessRoutes('pibox-default',proxy);
  try {
    const route=await routes.add('web',target.port);
    assert.equal(route.url,'http://web.pibox-default.pibox.test');
    await routes.remove(route.hostname,target.port);
  } finally {await target.close();}
});

test('IPv6 upstream on native port cannot capture HTTP traffic; frontend serves both loopbacks', {timeout:10000}, async()=>{
  const target=await backend();let hits=0;
  const unrelated=createHttpServer((_req,res)=>{hits++;res.end('unrelated');});
  unrelated.listen(target.port,'::1');await once(unrelated,'listening');
  const routes=new PortlessRoutes('pibox-dual',proxyAt());let route;
  try {
    route=await routes.add('web',target.port);
    for(let i=0;i<4;i++) assert.equal(JSON.parse((await get(route.url)).body).proto,'http');
    const url=new URL(route.url);
    const response=await new Promise((resolve,reject)=>{
      const req=request({hostname:'::1',port:url.port,headers:{host:url.host},agent:false},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end();
    });
    assert.equal(response,200);assert.equal(hits,0);
  } finally {if(route)await routes.remove(route.hostname,target.port);await target.close();await new Promise(r=>unrelated.close(r));}
});

const nonLoopback=Object.values(networkInterfaces()).flat().find(address=>address?.family==='IPv4'&&!address.internal)?.address;
for (const kind of ['idle connection','HTTP request','WebSocket upgrade']) {
  test(`wildcard proxy rejects non-loopback ${kind} before serving traffic`, {timeout:5000,skip:!nonLoopback}, async()=>{
    const target=await backend();const routes=new PortlessRoutes('pibox-remote',proxyAt());
    let route;
    try {
      route=await routes.add('web',target.port);
      assert.equal((await get(route.url)).status,200);
      const url=new URL(route.url);
      await new Promise((resolve,reject)=>{
        const socket=connect({host:nonLoopback,localAddress:nonLoopback,port:Number(url.port)});
        const timer=setTimeout(()=>{socket.destroy();reject(new Error('Remote peer was not rejected at accept time'));},1500);
        let bytes=0;
        socket.on('data',data=>bytes+=data.length);
        socket.on('error',error=>{if(!['ECONNRESET','EPIPE'].includes(error.code))reject(error);});
        socket.once('close',()=>{clearTimeout(timer);try{assert.equal(bytes,0);resolve();}catch(error){reject(error);}});
        socket.once('connect',()=>{
          if(kind==='HTTP request')socket.write(`GET / HTTP/1.1\r\nHost: ${url.host}\r\nConnection: close\r\n\r\n`);
          if(kind==='WebSocket upgrade')socket.write(`GET / HTTP/1.1\r\nHost: ${url.host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
        });
      });
    } finally {if(route)await routes.remove(route.hostname,target.port);await target.close();}
  });
}

async function bounded(promise, label) {
  let timer;
  try { return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(label+' hung')),500);})]); }
  finally { clearTimeout(timer); }
}
async function pendingHttp(port) {
  const sockets=[];
  for(const host of ['127.0.0.1','::1']) {
    for(const partial of [false,true]) {
      const socket=connect(port,host);socket.on('error',()=>{});await once(socket,'connect');
      if(partial)socket.write('GET / HTTP/1.1\r\nHost: ');
      sockets.push(socket);
    }
  }
  await new Promise(r=>setTimeout(r,20));return sockets;
}
test('final removal destroys idle and incomplete HTTP frontend sockets on both families', {timeout:5000},async()=>{
 const target=await backend(),routes=new PortlessRoutes('pibox-idle',proxyAt());const route=await routes.add('web',target.port);
 const sockets=await pendingHttp(Number(new URL(route.url).port));let removing;
 try {
  removing=routes.remove(route.hostname,target.port);
  await bounded(removing,'route removal');
  await assert.rejects(get(route.url),/ECONNREFUSED/);
 }finally{for(const socket of sockets)socket.destroy();await removing;await target.close();}
});
test('WorkerNetwork shutdown cannot hang behind idle HTTP frontend connections', {timeout:5000},async()=>{
 const {WorkerNetwork}=await loadTypeScript('../src/network.ts');const target=await backend();let removed=0;
 const network=new WorkerNetwork({unpublishTcp:async()=>{removed++;}},'idle-worker','/test',proxyAt());
 const route=await network.portless.add('web',target.port);
 network.published.set('127.0.0.1:3000',{listener:{host:'127.0.0.1',port:3000,address:'0.0.0.0',process:'test'},name:'web',mode:'http',hostPort:target.port,hostname:route.hostname,endpoint:route.url});
 const sockets=await pendingHttp(Number(new URL(route.url).port));let closing;
 try {closing=network.close();await bounded(closing,'network shutdown');assert.equal(removed,1);assert.equal(network.published.size,0);}
 finally{for(const socket of sockets)socket.destroy();await closing;await target.close();}
});
test('partial dual-family bind failure destroys already accepted sockets', {timeout:5000},async()=>{
 const target=await backend(),proxy=proxyAt(),routes=new PortlessRoutes('pibox-partial-bind',proxy);const route=await routes.add('web',target.port);
 const BrowserProxy=proxy.server.constructor;await routes.remove(route.hostname,target.port);await target.close();
 let calls=0,first,client,pending;
 try {
  pending=BrowserProxy.listen(0,()=>{
   const server=createTcpServer();
   if(calls++===0){first=server;return server;}
   server.listen=()=>{
    client=connect(first.address().port,'127.0.0.1');client.on('error',()=>{});
    first.once('connection',()=>setImmediate(()=>server.emit('error',Object.assign(new Error('bind conflict'),{code:'EADDRINUSE'}))));
    return server;
   };
   return server;
  });
  await assert.rejects(bounded(pending,'bind rollback'),/bind conflict/);
 }finally{client?.destroy();await pending?.catch(()=>{});}
});
