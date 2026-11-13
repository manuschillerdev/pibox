// Executed through the provider's trusted exec channel, never through SSH.
export const VSCODE_GUEST = String.raw`
const fs = require('node:fs');
const cp = require('node:child_process');
const net = require('node:net');
const input = JSON.parse(process.argv[1]);
if (!/^[a-f0-9]{32}$/.test(input.id)) throw new Error('Invalid SSH instance');
const dir = '/run/pibox-vscode-' + input.id;
const config = dir + '/sshd_config';
function run(cmd, args, timeout = 10000) {
 // GNU timeout kills the whole subprocess group, including apt/dpkg children,
 // before the temporary service-start policy can be removed.
 const r = cp.spawnSync('/usr/bin/timeout', ['--signal=KILL', String(timeout / 1000) + 's', cmd, ...args], {
  encoding:'utf8', timeout:timeout + 10000, maxBuffer:1048576,
  env:{...process.env, DEBIAN_FRONTEND:'noninteractive'},
 });
 if (r.error || r.status !== 0) throw new Error(r.error?.message || r.stderr || cmd + ' failed');
 return r.stdout;
}
function ownedDirectory() {
 const s = fs.lstatSync(dir);
 if (!s.isDirectory() || s.uid !== 0 || (s.mode & 0o077)) throw new Error('Unsafe guest SSH directory');
}
function pid() {
 if (!fs.existsSync(dir + '/sshd.pid')) return;
 const text = fs.readFileSync(dir + '/sshd.pid','utf8').trim();
 if (!/^[1-9][0-9]*$/.test(text)) throw new Error('Invalid managed sshd pid');
 const p = Number(text);
 try {
  const exe = fs.readlinkSync('/proc/' + p + '/exe');
  const cmd = fs.readFileSync('/proc/' + p + '/cmdline','utf8');
  if (exe !== '/usr/sbin/sshd' || !cmd.includes(config)) throw new Error('Managed sshd PID belongs to another process; refusing to signal it');
  return p;
 } catch (e) { if (e.code !== 'ENOENT') throw e; }
}
function write(name, text) {
 fs.writeFileSync(dir + '/' + name + '.new', text, {mode:0o600, flag:'wx'});
 fs.renameSync(dir + '/' + name + '.new', dir + '/' + name);
}
async function freePort() {
 const server = net.createServer();
 return new Promise((resolve,reject) => {
  server.once('error', reject);
  server.listen(0,'0.0.0.0',() => { const port = server.address().port; server.close(e => e ? reject(e) : resolve(port)); });
 });
}
(async () => {
 if (process.getuid() !== 0) throw new Error('/pibox-vscode requires the standard root Pibox guest identity');
 if (input.action === 'stop') {
  if (!fs.existsSync(dir)) return;
  ownedDirectory();
  const p = pid();
  if (p) {
   process.kill(p, 'SIGTERM');
   for (let i=0; i<50 && pid(); i++) await new Promise(r=>setTimeout(r,100));
   if (pid()) throw new Error('Managed sshd did not stop; retry cleanup');
  }
  fs.rmSync(dir,{recursive:true});
  return;
 }
 if (input.action !== 'prepare' || !/^ssh-ed25519 [A-Za-z0-9+/]{68}=?$/.test(input.publicKey)) throw new Error('Invalid SSH public key');
 if (!fs.existsSync('/usr/sbin/sshd')) {
  // Debian maintainer scripts must not start a separate, default SSH service.
  // Never replace an existing administrator policy.
  const policy = '/usr/sbin/policy-rc.d';
  let fd, created = false;
  try { fd = fs.openSync(policy, 'wx', 0o755); created = true; }
  catch (e) {
   if (e.code !== 'EEXIST') throw e;
   const s = fs.lstatSync(policy);
   const body = s.isFile() && s.uid === 0 && !(s.mode & 0o022) ? fs.readFileSync(policy,'utf8') : '';
   // Debian container images commonly already have this deny-all policy.
   if (!body.startsWith('#!/bin/sh\n') || body.split('\n').map(l=>l.trim()).filter(l=>l && !l.startsWith('#')).join('\n') !== 'exit 101') {
    throw new Error('Install openssh-server in the guest first: existing policy-rc.d prevents safe automatic installation');
   }
  }
  try {
   if (created) { fs.writeFileSync(fd, '#!/bin/sh\nexit 101\n'); fs.closeSync(fd); fd = undefined; }
   run('apt-get',['update'],120000);
   run('apt-get',['install','-y','--no-install-recommends','openssh-server'],120000);
  } finally { if (fd !== undefined) fs.closeSync(fd); if (created) fs.unlinkSync(policy); }
 }
 if (!fs.existsSync(dir)) fs.mkdirSync(dir,{mode:0o700});
 ownedDirectory();
 if (!fs.existsSync(dir + '/host_key')) run('ssh-keygen',['-q','-t','ed25519','-N','','-f',dir + '/host_key']);
 const hostKey = run('ssh-keygen',['-y','-f',dir + '/host_key']).trim();
 // Existing listeners and /etc/ssh configuration are not modified.
 write('authorized_keys', 'no-agent-forwarding,no-X11-forwarding ' + input.publicKey + '\n');
 let port;
 if (pid()) {
  port = Number(fs.readFileSync(dir + '/port','utf8'));
 } else {
  port = await freePort();
  write('sshd_config', [
   'Port ' + port, 'ListenAddress 0.0.0.0', 'AddressFamily inet',
   'HostKey ' + dir + '/host_key', 'PidFile ' + dir + '/sshd.pid',
   'AuthorizedKeysFile ' + dir + '/authorized_keys', 'AuthorizedKeysCommand none',
   'TrustedUserCAKeys none', 'AllowUsers root', 'PermitRootLogin prohibit-password',
   'AuthenticationMethods publickey', 'PubkeyAuthentication yes',
   'PasswordAuthentication no', 'KbdInteractiveAuthentication no', 'PermitEmptyPasswords no',
   'UsePAM yes', 'StrictModes yes', 'AllowAgentForwarding no', 'X11Forwarding no',
   'PermitTunnel no', 'PermitUserEnvironment no', 'PermitUserRC no',
   'AllowTcpForwarding local', 'GatewayPorts no', 'UseDNS no',
   'Subsystem sftp internal-sftp', 'LogLevel ERROR', ''
  ].join('\n'));
  fs.mkdirSync('/run/sshd',{recursive:true,mode:0o755});
  run('/usr/sbin/sshd',['-t','-f',config]);
  run('/usr/sbin/sshd',['-f',config,'-E',dir + '/sshd.log']);
  write('port', String(port));
 }
 for (let i=0; i<50 && !pid(); i++) await new Promise(r=>setTimeout(r,100));
 if (!Number.isInteger(port) || port < 1 || port > 65535 || !pid()) {
  const log = fs.existsSync(dir + '/sshd.log') ? fs.readFileSync(dir + '/sshd.log','utf8').slice(-2048) : '';
  throw new Error('Managed sshd failed to start: ' + log);
 }
 console.log(JSON.stringify({port,hostKey}));
})().catch(e => { console.error(e.message); process.exitCode=1; });
`;
