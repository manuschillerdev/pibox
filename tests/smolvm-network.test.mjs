import assert from 'node:assert/strict';
import test from 'node:test';
import { Machine } from 'smolmachines';
import { loadTypeScript } from './load-typescript.mjs';
const { SmolvmNetwork }=await loadTypeScript('../src/sandboxes/smolvm-network.ts');
const { WorkerNetwork }=await loadTypeScript('../src/network.ts');
const { PendingTcpPublicationError }=await loadTypeScript('../src/sandbox.ts');
function fixture() {
  const mappings=[{host:12345,guest:80,protocol:'tcp'}];
  let running=true;
  const native={async state(){return running?'running':'stopped';},async ports(){return [...mappings];},async publish(p){mappings.push(p);return p;},async unpublish(p){const i=mappings.findIndex(x=>x.host===p.host&&x.guest===p.guest&&x.protocol===p.protocol);if(i>=0)mappings.splice(i,1);}};
  return {network:new SmolvmNetwork(async()=>native),native,mappings,stop(){running=false;}};
}
test('native publication preserves configured ports and removes only exact owned mapping',async()=>{
  const {network,mappings}=fixture();
  const host=await network.publish(3000);assert.equal(mappings.length,2);
  await assert.rejects(network.unpublish(12345,80),/unowned/);
  await network.unpublish(host,3000);assert.deepEqual(mappings,[{host:12345,guest:80,protocol:'tcp'}]);
});
test('stopped machines never start and native errors explain virtio-net prerequisite',async()=>{
  const f=fixture();f.stop();await assert.rejects(f.network.publish(3000),/never restarts/);
  const g=fixture();g.native.publish=async()=>{throw new Error('backend unavailable');};
  await assert.rejects(g.network.publish(3000),/virtio-net/);
});
test('external retarget is not removed and cleanup failure retains ownership for retry',async()=>{
  const {network,native,mappings}=fixture();const host=await network.publish(3000);
  mappings[1].guest=4000;await assert.rejects(network.unpublish(host,3000),/changed outside/);
  mappings[1].guest=3000;const remove=native.unpublish;native.unpublish=async()=>{throw new Error('temporary');};
  await assert.rejects(network.unpublish(host,3000),/temporary/);native.unpublish=remove;
  await network.unpublish(host,3000);assert.equal(mappings.length,1);
});
test('concurrent operations use one native mutation at a time',async()=>{
  const {network,native}=fixture();let active=0,max=0;const publish=native.publish;
  native.publish=async p=>{max=Math.max(max,++active);await new Promise(r=>setTimeout(r,5));const result=await publish(p);active--;return result;};
  const ports=await Promise.all([network.publish(3000),network.publish(3001)]);
  assert.equal(max,1);await Promise.all(ports.map((host,i)=>network.unpublish(host,3000+i)));
});

// Execute the installed SDK's actual publish/unpublish implementation. Only its
// underlying transport is fault-injected: setPorts commits before ports rejects.
function committedThenRejected({cleanupFails=false,retarget=false}={}) {
  const initial=[{host:12345,guest:3000,protocol:'tcp'},{host:12346,guest:8080,protocol:'udp'}];
  let mappings=structuredClone(initial),rejectRead=false,opens=0,attempt;
  const transport={
    async state(){return 'running';},
    async ports(){if(rejectRead){rejectRead=false;throw new Error('post-commit read failed');}return structuredClone(mappings);},
    async setPorts(next){
      if(next.length>initial.length){
        mappings=structuredClone(next);attempt=next.at(-1);rejectRead=true;
        if(retarget)mappings.at(-1).guest=4000;
      } else {
        if(cleanupFails)throw new Error('cleanup unavailable');
        mappings=structuredClone(next);
      }
    },
  };
  const native=new SmolvmNetwork(async()=>{opens++;return new Machine(transport);});
  return {native,initial,get mappings(){return mappings;},get attempt(){return attempt;},get opens(){return opens;},allowCleanup(){cleanupFails=false;}};
}

test('actual SDK commit-then-reread failure rolls back only attempted mapping',async()=>{
  const f=committedThenRejected();
  await assert.rejects(f.native.publish(3000),/post-commit read failed/);
  assert.deepEqual(f.mappings,f.initial);
  assert.equal(f.opens,2,'cleanup reopens the machine');
  await assert.rejects(f.native.unpublish(f.attempt.host,3000),/unowned/);
});

test('actual SDK ambiguous publication and cleanup failure remains visible; shutdown retries',async()=>{
  const f=committedThenRejected({cleanupFails:true});
  const sandbox={publishTcp:port=>f.native.publish(port),unpublishTcp:(host,guest)=>f.native.unpublish(host,guest)};
  const worker=new WorkerNetwork(sandbox,'native-fault','/test');
  const listener={host:'127.0.0.1',address:'0.0.0.0',port:3000,process:'node'};
  worker.discover=async()=>[listener];
  let aliases=0;worker.portless.add=async()=>{aliases++;throw new Error('should not register');};
  await assert.rejects(worker.publish(listener,'web','http'),error=>{
    assert.ok(error instanceof PendingTcpPublicationError);
    assert.equal(error.hostPort,f.attempt.host);assert.equal(error.guestPort,3000);return true;
  });
  const pending=worker.published.get('127.0.0.1:3000');
  assert.equal(pending.hostPort,f.attempt.host);assert.match(pending.error,/may remain active/);
  assert.equal(aliases,0);assert.equal(f.mappings.length,3);
  await assert.rejects(worker.close(),/cleanup unavailable/);
  assert.equal(worker.published.size,1);
  f.allowCleanup();await worker.close();
  assert.equal(worker.published.size,0);assert.deepEqual(f.mappings,f.initial);
});

test('ambiguous publication never removes an externally retargeted endpoint',async()=>{
  const f=committedThenRejected({retarget:true});
  await assert.rejects(f.native.publish(3000),PendingTcpPublicationError);
  await assert.rejects(f.native.unpublish(f.attempt.host,3000),/changed outside/);
  assert.equal(f.mappings.at(-1).guest,4000);
  assert.deepEqual(f.mappings.slice(0,-1),f.initial);
});
