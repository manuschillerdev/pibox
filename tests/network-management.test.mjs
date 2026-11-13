import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTypeScript } from './load-typescript.mjs';
const { WorkerNetwork } = await loadTypeScript('../src/network.ts');
const { networkNamespace, validateServiceName } = await loadTypeScript('../src/network-portless.ts');
const { NetworkOverlay } = await loadTypeScript('../src/network-ui.ts');
const { visibleWidth } = await import('@earendil-works/pi-tui');
const listener = {host:'127.0.0.1',address:'0.0.0.0',port:3000,process:'node'};
function manager() {
  const ports = new Map();
  const sandbox = {async publishTcp(guest){ ports.set(45678,guest); return 45678; },async unpublishTcp(host){ports.delete(host);}};
  const network = new WorkerNetwork(sandbox,'worker','/test');
  network.discover = async()=>[listener];
  return {network,sandbox,ports};
}
test('stable worktree namespace and safe labels',()=>{
  assert.notEqual(networkNamespace('worker','/one'),networkNamespace('worker','/two'));
  for(const bad of ['--force','a.b','/path','a;rm','UPPER','', 'x'.repeat(41)]) assert.throws(()=>validateServiceName(bad));
  validateServiceName('web-1');
});
test('native TCP mapping is returned and remains manageable after listener disappears',async()=>{
  const {network,ports}=manager();
  await network.publish(listener,'db','tcp');
  assert.equal(network.published.get('127.0.0.1:3000').endpoint,'127.0.0.1:45678');
  network.discover=async()=>[];
  await network.unpublish('127.0.0.1:3000');assert.equal(ports.size,0);await network.close();
});
test('Microsandbox and loopback listeners are refused without publishing',async()=>{
  const deferred=new WorkerNetwork({},'msb','/test');
  await assert.rejects(deferred.permission(),/Microsandbox publication is deferred/);
  const {network,ports}=manager();
  await assert.rejects(network.publish({...listener,address:'127.0.0.1'},'web','tcp'),/0.0.0.0/);
  assert.equal(ports.size,0);await network.close();await deferred.close();
});
test('HTTP failure rolls back native mapping; failed native cleanup remains retryable',async()=>{
  const {network,sandbox,ports}=manager();
  network.portless.add=async()=>{throw new Error('proxy unavailable');};
  await assert.rejects(network.publish(listener,'web','http'),/proxy unavailable/);
  assert.equal(ports.size,0);assert.equal(network.published.size,0);
  await network.publish(listener,'db','tcp');
  const remove=sandbox.unpublishTcp;sandbox.unpublishTcp=async()=>{throw new Error('unreachable');};
  await assert.rejects(network.unpublish('127.0.0.1:3000'),/may remain active/);
  assert.equal(network.published.size,1);sandbox.unpublishTcp=remove;
  await network.close();assert.equal(ports.size,0);
});
test('shutdown waits for native publication then rolls it back without leaking a mapping',async()=>{
  const {network,sandbox,ports}=manager();let release,entered;
  const started=new Promise(r=>entered=r);
  sandbox.publishTcp=async guest=>{entered();await new Promise(r=>release=r);ports.set(45678,guest);return 45678;};
  const pending=network.publish(listener,'db','tcp');const rejected=assert.rejects(pending,/closed/);
  await started;const closing=network.close();release();await rejected;await closing;
  assert.equal(ports.size,0);assert.equal(network.published.size,0);
});
test('overlay is read-only until save and sanitizes metadata in list and form',async()=>{
  const {network}=manager();let publishes=0,closed=0;
  network.publish=async()=>{publishes++;};
  network.discover=async()=>[{...listener,address:'0.0.0.0\x1b]52;c;address\x07',process:'node\x1b]52;c;evil\x07'}];
  const theme={fg:(_color,text)=>text,bold:text=>text,bg:(_color,text)=>text};
  const ui=new NetworkOverlay(network,'worker',theme,()=>{},()=>{closed++;},async()=>{});
  try {
    await new Promise(r=>setImmediate(r));
    for(const width of [12,40,100]) for(const line of ui.render(width)) assert.ok(visibleWidth(line)<=width);
    assert.ok(!ui.render(200).join('\n').includes('\x1b]52'));
    ui.handleInput('\r');assert.ok(!ui.render(200).join('\n').includes('\x1b]52'));
    ui.handleInput('\x1b');ui.handleInput('\x1b');assert.equal(publishes,0);assert.equal(closed,1);
  } finally {ui.dispose();await network.close();}
});

test('HTTP guest setup failure removes proxy/native state, failed cleanup remains retryable',async()=>{
 const {network,sandbox,ports}=manager();let removes=0,syncs=0;
 network.portless.add=async()=>({hostname:'web.pibox-test.pibox.test',url:'http://web.pibox-test.pibox.test'});
 network.portless.remove=async()=>{removes++;};
 network.guestHosts.sync=async(names)=>{syncs++;if(names.length)throw new Error('guest mapping setup failed');};
 await assert.rejects(network.publish(listener,'web','http'),/guest mapping setup failed/);
 assert.equal(syncs,2);assert.equal(removes,1);assert.equal(ports.size,0);assert.equal(network.published.size,0);
 network.guestHosts.sync=async()=>{throw new Error('cleanup temporarily unavailable');};
 await assert.rejects(network.publish(listener,'web','http'),/retry unpublish/);
 assert.equal(network.published.size,1);assert.equal(ports.size,0);
 assert.equal(network.published.get('127.0.0.1:3000').cleanup.nativeRemoved,true);
 sandbox.unpublishTcp=async()=>{assert.fail('retry must not unpublish a removed/unowned native mapping');};
 network.guestHosts.sync=async()=>{};await network.close();assert.equal(ports.size,0);assert.equal(network.published.size,0);
});

function httpManager() {
 const fixture=manager(),{network}=fixture;
 network.portless.add=async name=>({hostname:`${name}.${network.portless.namespace}.pibox.test`,url:`http://${name}.${network.portless.namespace}.pibox.test`});
 network.portless.remove=async()=>{};
 network.guestHosts.sync=async()=>{};
 network.check=async()=>{};
 return fixture;
}
test('guest cleanup failure still revokes route and native mapping; retry only cleans guest entries',async()=>{
 const {network,sandbox,ports}=httpManager();let routes=0,native=0;const removed=[];
 network.portless.remove=async()=>{routes++;};
 sandbox.unpublishTcp=async(host,guest)=>{native++;assert.equal(ports.get(host),guest,'mapping must still be owned');ports.delete(host);};
 await network.publish(listener,'web','http');
 network.guestHosts.sync=async names=>{removed.push(names);throw new Error('guest unavailable');};
 await assert.rejects(network.unpublish('127.0.0.1:3000'),/native forwarding removed.*guest unavailable/);
 assert.equal(routes,1);assert.equal(native,1);assert.equal(ports.size,0);
 assert.deepEqual(network.published.get('127.0.0.1:3000').cleanup,{routeRemoved:true,nativeRemoved:true,guestRemoved:false});
 // A new owner may reuse the port while guest cleanup is still pending.
 ports.set(45678,9999);
 network.guestHosts.sync=async names=>{removed.push(names);};
 await network.unpublish('127.0.0.1:3000');
 assert.deepEqual(removed,[[],[]]);assert.equal(routes,1);assert.equal(native,1);
 assert.equal(ports.get(45678),9999);assert.equal(network.published.size,0);await network.close();
});
test('route cleanup failure still attempts native and guest revocation; retry skips completed steps',async()=>{
 const {network,sandbox,ports}=httpManager();const calls=[];
 await network.publish(listener,'web','http');
 network.portless.remove=async()=>{calls.push('route');throw new Error('route unavailable');};
 sandbox.unpublishTcp=async host=>{calls.push('native');ports.delete(host);};
 network.guestHosts.sync=async names=>{calls.push('guest');assert.deepEqual(names,[]);};
 await assert.rejects(network.unpublish('127.0.0.1:3000'),/native forwarding removed.*route unavailable/);
 assert.deepEqual(calls,['route','native','guest']);assert.equal(ports.size,0);
 assert.deepEqual(network.published.get('127.0.0.1:3000').cleanup,{routeRemoved:false,nativeRemoved:true,guestRemoved:true});
 network.portless.remove=async()=>{calls.push('route retry');};
 await network.close();assert.deepEqual(calls,['route','native','guest','route retry']);assert.equal(network.published.size,0);
});
test('pending guest cleanup names are excluded when another service is published or removed',async()=>{
 const {network,sandbox,ports}=httpManager();
 await network.publish(listener,'web','http');
 network.guestHosts.sync=async()=>{throw new Error('guest unavailable');};
 await assert.rejects(network.unpublish('127.0.0.1:3000'),/guest unavailable/);
 const second={...listener,port:3001};network.discover=async()=>[listener,second];
 sandbox.publishTcp=async guest=>{ports.set(45679,guest);return 45679;};
 const syncs=[];network.guestHosts.sync=async names=>{syncs.push(names);};
 await network.publish(second,'api','http');
 await network.unpublish('127.0.0.1:3001');
 await network.unpublish('127.0.0.1:3000');
 assert.deepEqual(syncs,[[`api.${network.portless.namespace}.pibox.test`],[],[]]);
 assert.equal(ports.size,0);assert.equal(network.published.size,0);await network.close();
});
