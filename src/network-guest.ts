export const DISCOVER_SCRIPT = String.raw`
const fs = require('node:fs');
const cp = require('node:child_process');
const rows = new Map();
function add(address, port, processName, docker) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return;
  const host = address === '0.0.0.0' || address === '*' ? '127.0.0.1' : address === '::' ? '::1' : address;
  rows.set(host + ':' + port, {host, port, address, process: processName || '', ...(docker ? {docker} : {})});
}
try {
  const text = cp.execFileSync('ss', ['-H', '-ltnp'], {encoding:'utf8', timeout:3000, maxBuffer:1048576});
  for (const line of text.trim().split('\n')) {
    const fields = line.trim().split(/\s+/), endpoint = fields[3] || '';
    const at = endpoint.lastIndexOf(':');
    add(endpoint.slice(0,at).replace(/^\[|\]$/g,''), Number(endpoint.slice(at+1)), line.match(/users:\(\("([^"]+)"/)?.[1]);
  }
} catch {
  for (const path of ['/proc/net/tcp','/proc/net/tcp6']) {
    let text; try { text = fs.readFileSync(path,'utf8'); } catch { continue; }
    for (const line of text.trim().split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields[3] !== '0A') continue;
      const [hex, p] = fields[1].split(':');
      const bytes = Buffer.from(hex, 'hex');
      for (let i=0;i<bytes.length;i+=4) bytes.subarray(i,i+4).reverse();
      const address = bytes.length === 4 ? [...bytes].join('.') : Array.from({length:8},(_,i)=>bytes.readUInt16BE(i*2).toString(16)).join(':');
      add(address === '0:0:0:0:0:0:0:0' ? '::' : address === '0:0:0:0:0:0:0:1' ? '::1' : address, parseInt(p,16), '');
    }
  }
}
// Docker NAT can publish a port without a listening socket in the VM namespace.
try {
  const ids = cp.execFileSync('docker',['ps','-q'],{encoding:'utf8',timeout:3000}).trim().split(/\s+/).filter(Boolean);
  if (ids.length) {
    const containers = JSON.parse(cp.execFileSync('docker',['inspect',...ids],{encoding:'utf8',timeout:3000,maxBuffer:1048576}));
    for (const c of containers) for (const [port, bindings] of Object.entries(c.NetworkSettings.Ports || {})) {
      if (!port.endsWith('/tcp')) continue;
      const name = String(c.Name || '').replace(/^\//,'');
      const labels = c.Config?.Labels || {};
      const docker = {
        id: String(c.Id || ''), name, containerPort: Number(port.split('/')[0]),
        project: String(labels['com.docker.compose.project'] || ''),
        service: String(labels['com.docker.compose.service'] || ''),
        replica: String(labels['com.docker.compose.container-number'] || ''),
      };
      for (const b of bindings || []) add(b.HostIp || '0.0.0.0', Number(b.HostPort), 'docker:' + name, docker);
    }
  }
} catch {}
console.log(JSON.stringify([...rows.values()].sort((a,b)=>a.port-b.port)));
`;
