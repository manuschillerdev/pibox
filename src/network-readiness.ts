import { lookup } from "node:dns/promises";
import { request } from "node:http";

export function httpReadiness(status: number, verification: string): string {
  if (!Number.isInteger(status) || status < 100 || status > 599) throw new Error("No valid HTTP response received");
  return `HTTP reachable (${verification}) · HTTP ${status}${status >= 500 ? " · upstream unavailable" : ""}`;
}

/** Uses normal OS hostname resolution. */
export async function hostNetworkReadiness(url: string): Promise<string> {
  try {
    const parsed = new URL(url);
    let dnsTimer: ReturnType<typeof setTimeout> | undefined;
    const addresses = await Promise.race([
      lookup(parsed.hostname, { all: true }),
      new Promise<never>((_resolve, reject) => { dnsTimer = setTimeout(() => reject(new Error("OS DNS lookup timed out")), 5000); }),
    ]).finally(() => clearTimeout(dnsTimer));
    if (!addresses.length || addresses.some(a => a.address !== "127.0.0.1" && a.address !== "::1")) throw new Error("DNS must resolve only to host loopback");
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(url, { method: "HEAD", agent: false }, res => { res.resume(); resolve(res.statusCode ?? 0); });
      const timer = setTimeout(() => req.destroy(new Error("HTTP check timed out")), 5000);
      req.once("close", () => clearTimeout(timer)); req.once("error", reject); req.end();
    });
    return httpReadiness(status, "OS resolution");
  } catch (error) { return `Setup/check needed: ${error instanceof Error ? error.message : String(error)}`; }
}
