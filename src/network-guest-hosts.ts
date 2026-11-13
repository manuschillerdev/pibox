import { execute, type SandboxInstance } from "./sandbox.js";
import { NETWORK_NODE } from "./network-discovery.js";
import { validateNetworkHostname } from "./network-hosts.js";
import { httpReadiness } from "./network-readiness.js";

export const GUEST_HOSTS_SCRIPT = String.raw`
const fs=require('node:fs'), dns=require('node:dns').promises;
const {namespace,names,url}=JSON.parse(process.argv[1]);
const timer=setTimeout(()=>{console.error('Guest network operation timed out');process.exit(1)},8000);
(async()=>{
 if(url){
  const http=require('node:http');
  await new Promise((resolve,reject)=>{const req=http.request(url,{method:'HEAD',agent:false},res=>{res.resume();console.log(res.statusCode);resolve()});req.on('error',reject);req.end()});return;
 }
 if(!/^pibox-[a-f0-9]{8}$/.test(namespace)||names.some(n=>!n.endsWith('.'+namespace+'.pibox.test')||!/^[a-z0-9.-]+$/.test(n)))throw Error('Invalid guest mapping');
 const {address}=names.length ? await dns.lookup('host.smolvm.internal',{family:4}) : {address:''};
 const lock='/tmp/pibox-net-hosts.lock', marker='# pibox-net:'+namespace;
 fs.mkdirSync(lock);
 try {
  const contents=fs.readFileSync('/etc/hosts','utf8');
  const lines=contents.split(/(?<=\n)/).filter(l=>!l.trimEnd().endsWith(' '+marker));
  const missing=[];
  for(const name of names){
   let found=false;
   for(const line of lines){const [ip,...aliases]=line.split('#')[0].trim().split(/\s+/);if(!aliases.some(n=>n.toLowerCase().replace(/\.$/,'')===name))continue;if(ip!==address)throw Error('Conflicting guest hostname: '+name);found=true;}
   if(!found)missing.push(name);
  }
  let output=lines.join('');
  if(missing.length){if(output&&!output.endsWith('\n'))output+='\n';output+=missing.map(n=>address+' '+n+' '+marker+'\n').join('');}
  if(output!==contents)fs.writeFileSync('/etc/hosts',output);
 } finally {fs.rmdirSync(lock)}
})().catch(e=>{console.error(e.message);process.exitCode=1}).finally(()=>clearTimeout(timer));
`;

/** Exact guest mappings only. Docker discovery does not opt containers in. */
export class GuestHosts {
  private configured = false;
  constructor(private readonly sandbox: SandboxInstance, private readonly namespace: string) {}
  private async run(input: Record<string, unknown>): Promise<string> {
    const result = await execute(this.sandbox, [NETWORK_NODE, "-e", GUEST_HOSTS_SCRIPT, JSON.stringify(input)]);
    if (!result.success) throw new Error(result.stderr.trim() || "Guest network operation failed");
    return result.stdout.trim();
  }
  async sync(names: string[]): Promise<void> {
    for (const name of names) validateNetworkHostname(name);
    if (!names.length && !this.configured) return;
    this.configured = true;
    await this.run({ namespace: this.namespace, names });
    if (!names.length) this.configured = false;
  }
  async status(url: string): Promise<string> {
    try { return httpReadiness(Number(await this.run({ url })), "guest resolution"); }
    catch (error) { return `Check needed: ${String(error)}. Check native gateway/egress policy; Pibox will not restart the VM.`; }
  }
}
