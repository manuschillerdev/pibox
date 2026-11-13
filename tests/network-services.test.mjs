import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTypeScript } from './load-typescript.mjs';
const { defaultServiceNames, serviceLabel } = await loadTypeScript('../src/network-services.ts');
const { groupDockerListeners, listenerKey } = await loadTypeScript('../src/network-discovery.ts');
const { networkNamespace, validateServiceName } = await loadTypeScript('../src/network-portless.ts');
const docker = (name, port=8080, options={}) => ({host:'127.0.0.1',port,address:'0.0.0.0',process:`docker:${name}`,docker:{id:name,name,containerPort:80,project:'',service:'',replica:'',...options}});

test('Compose labels provide project-service defaults, otherwise container name or port',()=>{
  const compose=docker('shop-web-1',8080,{project:'shop',service:'web',replica:'1'});
  const plain=docker('hello-world',8081);
  const node={host:'127.0.0.1',port:3456,address:'0.0.0.0',process:'node'};
  const names=defaultServiceNames([compose,plain,node]);
  assert.equal(names.get(listenerKey(compose)),'shop-web');
  assert.equal(names.get(listenerKey(plain)),'hello-world');
  assert.equal(names.get(listenerKey(node)),'p3456');
  assert.equal(serviceLabel(compose),'shop / web');
  assert.equal(serviceLabel(plain),'hello-world');
  assert.match(networkNamespace('pibox-smolvm-very-long-worker','/worktree'),/^pibox-[a-f0-9]{8}$/);
});

test('defaults are bounded and deterministic for replicas, multiple ports and normalization collisions',()=>{
  const rows=[docker('shop-web-1',8080,{project:'shop',service:'web',replica:'1'}),docker('shop-web-2',8081,{project:'shop',service:'web',replica:'2'}),
    docker('metrics',9090),docker('metrics',9091,{containerPort:90}),docker('a_b',9001),docker('a-b',9002),docker('A-B',9003),docker('x'.repeat(100),9004),docker('\x1b]52;c;bad\x07\u202e',9005)];
  const names=defaultServiceNames(rows);
  assert.equal(new Set(names.values()).size,rows.length);
  for (const name of names.values()) validateServiceName(name);
  assert.deepEqual([...names].sort(),[...defaultServiceNames([...rows].reverse())].sort());
  assert.match(names.get('127.0.0.1:8080'),/^shop-web-8080-/);
  assert.match(names.get('127.0.0.1:9091'),/^metrics-9091-/);
  assert.doesNotMatch(serviceLabel(rows.at(-1)),/[\x1b\x07\u202e]/);
});

test('only identical Docker mapping wildcard pairs collapse; IPv6-only and unrelated sockets remain',()=>{
  const a=docker('web'); const v6={...a,host:'::1',address:'::'};
  assert.deepEqual(groupDockerListeners([v6,a]),[a]);
  assert.deepEqual(groupDockerListeners([v6]),[v6]);
  for (const other of [
    {...a,docker:undefined},
    {...a,docker:{...a.docker,id:'other'}},
    {...a,docker:{...a.docker,containerPort:81}},
    {...a,address:'127.0.0.1'},
    {...a,port:8081},
  ]) assert.equal(groupDockerListeners([v6,other]).length,2);
  assert.equal(groupDockerListeners([{...v6,docker:undefined},{...a,docker:undefined}]).length,2);
});
