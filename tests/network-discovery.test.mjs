import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { loadTypeScript } from './load-typescript.mjs';
const { DISCOVER_SCRIPT } = await loadTypeScript('../src/network-guest.ts');
function discover({ss, files={}, containers=[]}) {
  let output;
  runInNewContext(DISCOVER_SCRIPT, {
    Buffer,
    console:{log:value=>output=JSON.parse(value)},
    require(name) {
      if(name==='node:fs') return {readFileSync(path) { if(path in files) return files[path]; throw new Error('missing'); }};
      if(name==='node:child_process') return {execFileSync(command,args) {
        if(command==='ss') { if(ss===undefined) throw new Error('missing'); return ss; }
        if(args[0]==='ps') return containers.length ? 'abc' : '';
        return JSON.stringify(containers);
      }};
      throw new Error(name);
    },
  });
  return output;
}
test('ss discovery keeps bind addresses and process labels; Docker supplements NAT-only ports', () => {
  const rows=discover({ss:'LISTEN 0 128 0.0.0.0:3000 0.0.0.0:* users:(("node",pid=42,fd=5))\nLISTEN 0 128 [::1]:8080 [::]:*\n',containers:[{Name:'/db',NetworkSettings:{Ports:{'5432/tcp':[{HostIp:'0.0.0.0',HostPort:'15432'}],'5353/udp':[{HostIp:'0.0.0.0',HostPort:'5353'}]}}}]});
  assert.deepEqual(rows,[{host:'127.0.0.1',port:3000,address:'0.0.0.0',process:'node'},{host:'::1',port:8080,address:'::1',process:''},{host:'127.0.0.1',port:15432,address:'0.0.0.0',process:'docker:db',docker:{id:'',name:'db',containerPort:5432,project:'',service:'',replica:''}}]);
});
test('proc fallback decodes TCP listen sockets and IPv6 loopback, excludes established sockets', () => {
  const rows=discover({files:{'/proc/net/tcp':'header\n0: 0100007F:0BB8 00000000:0000 0A\n1: 0100007F:0016 00000000:0000 01\n','/proc/net/tcp6':'header\n0: 00000000000000000000000001000000:1F90 00000000:0000 0A\n'}});
  assert.deepEqual(rows,[{host:'127.0.0.1',port:3000,address:'127.0.0.1',process:''},{host:'::1',port:8080,address:'::1',process:''}]);
});
test('Docker inspect extracts structured Compose labels without interpolating them into commands',()=>{
  const rows=discover({ss:'',containers:[{Id:'container-id',Name:'/shop-web-1',Config:{Labels:{'com.docker.compose.project':'shop','com.docker.compose.service':'web','com.docker.compose.container-number':'1'}},NetworkSettings:{Ports:{'80/tcp':[{HostIp:'0.0.0.0',HostPort:'8080'},{HostIp:'::',HostPort:'8080'}]}}}]});
  assert.equal(rows.length,2);
  assert.deepEqual(rows[0].docker,{id:'container-id',name:'shop-web-1',containerPort:80,project:'shop',service:'web',replica:'1'});
  assert.deepEqual(rows[1].docker,rows[0].docker);
});
test('controller validates Docker metadata and groups proven wildcard pairs end-to-end',async()=>{
  const { discoverListeners }=await loadTypeScript('../src/network-discovery.ts');
  const rows=discover({ss:'',containers:[{Id:'id',Name:'/web',Config:{Labels:{}},NetworkSettings:{Ports:{'80/tcp':[{HostIp:'0.0.0.0',HostPort:'8080'},{HostIp:'::',HostPort:'8080'}]}}}]});
  const events=[{type:'stdout',data:Buffer.from(JSON.stringify(rows))},{type:'exit',code:0}];
  const result=await discoverListeners({async startProcess(){return {async receive(){return events.shift();},async close(){}};}});
  assert.equal(result.length,1);assert.equal(result[0].address,'0.0.0.0');assert.equal(result[0].docker.name,'web');
});
