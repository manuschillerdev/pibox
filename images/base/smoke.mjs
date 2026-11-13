import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const temporary = await mkdtemp(join(tmpdir(), "pibox-image-smoke-"));
const session = `pibox-smoke-${process.pid}`;
const browser = (...args) => exec("agent-browser", ["--session", session, ...args], {
  timeout: 30_000,
  maxBuffer: 2 * 1024 * 1024,
});
const server = createServer((_request, response) => {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end('<!doctype html><title>Pibox smoke</title><h1>Pibox browser smoke</h1><button onclick="this.textContent=\'Clicked\'">Run check</button>');
});

try {
  const guide = await exec("agent-browser", ["skills", "get", "core"], { timeout: 10_000 });
  assert.ok(guide.stdout.includes("snapshot"), "CLI must serve its bundled workflow");
  assert.match(await readFile("/root/.agents/skills/agent-browser/SKILL.md", "utf8"), /name: agent-browser/);
  await checkPiSkill();

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  await browser("open", `http://127.0.0.1:${server.address().port}`);
  assert.match((await browser("snapshot")).stdout, /Pibox browser smoke/);
  await browser("find", "role", "button", "click", "--name", "Run check");
  assert.match((await browser("snapshot", "-i")).stdout, /Clicked/);
  const screenshot = join(temporary, "page.png");
  await browser("screenshot", screenshot);
  assert.deepEqual((await readFile(screenshot)).subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  console.log("Pi discovers agent-browser; Chromium navigation, snapshots, clicks and screenshots pass.");
} finally {
  await browser("close").catch(() => undefined);
  server.closeAllConnections();
  server.close();
  await rm(temporary, { recursive: true, force: true });
}

async function checkPiSkill() {
  const child = spawn("pi", ["--mode", "rpc", "--no-session", "--no-extensions"], {
    cwd: "/workspace",
    env: { ...process.env, PI_CODING_AGENT_DIR: join(temporary, "worker-profile") },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = new Promise(resolve => child.once("close", resolve));
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Pi skill discovery timed out: ${stderr}`)), 30_000);
      const fail = error => { clearTimeout(timer); reject(error); };
      child.once("error", fail);
      child.once("exit", code => fail(new Error(`Pi exited before skill discovery (${code}): ${stderr}`)));
      child.stdin.on("error", fail);
      let pending = "";
      child.stdout.on("data", chunk => {
        pending += chunk;
        let newline;
        while ((newline = pending.indexOf("\n")) !== -1) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          let response;
          try { response = JSON.parse(line); } catch { continue; }
          if (response.id !== "image-skill-check") continue;
          try {
            assert.equal(response.success, true, JSON.stringify(response));
            assert.ok(response.data.commands.some(command => command.name === "skill:agent-browser"), "Pi must discover the skill with an isolated worker profile");
            clearTimeout(timer);
            resolve();
          } catch (error) { fail(error); }
        }
      });
      child.stdin.write(`${JSON.stringify({ id: "image-skill-check", type: "get_commands" })}\n`);
    });
  } finally {
    child.kill("SIGKILL");
    await exited;
  }
}
