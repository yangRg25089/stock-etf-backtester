import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(frontendRoot, "..");
const backendPython = process.env.BACKEND_PYTHON
  ?? path.join(repositoryRoot, "backend", ".venv", "bin", "python");

async function findAvailablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to allocate a local port");
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

const port = await findAvailablePort();
const baseURL = `http://127.0.0.1:${port}`;
const child = spawn(backendPython, [
  "-m", "uvicorn", "app.main:app", "--app-dir", "backend",
  "--host", "127.0.0.1", "--port", String(port),
  "--no-proxy-headers", "--workers", "1", "--limit-concurrency", "64",
], {
  cwd: repositoryRoot,
  env: {
    ...process.env,
    STOCK_ETF_BACKTESTER_SERVE_FRONTEND: "1",
    STOCK_ETF_BACKTESTER_FRONTEND_DIR: "frontend/dist",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let childOutput = "";
child.stdout.setEncoding("utf8").on("data", chunk => { childOutput += chunk; });
child.stderr.setEncoding("utf8").on("data", chunk => { childOutput += chunk; });

async function waitForHealth() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Uvicorn exited before health check:\n${childOutput}`);
    try {
      const response = await fetch(`${baseURL}/health`);
      if (response.status === 200 && (await response.json()).status === "ok") return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 150));
    }
  }
  throw new Error(`Production app did not become healthy:\n${childOutput}`);
}

async function stopServer() {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    once(child, "exit"),
    new Promise(resolve => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

try {
  await waitForHealth();

  const health = await fetch(`${baseURL}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok" });

  const root = await fetch(`${baseURL}/`);
  assert.equal(root.status, 200);
  assert.equal(root.headers.get("www-authenticate"), null);
  assert.match(root.headers.get("x-robots-tag") ?? "", /noindex/);
  assert.equal(root.headers.get("x-content-type-options"), "nosniff");
  const html = await root.text();
  assert.match(html, /<div[^>]+id="root"/);
  assert.match(html, /<meta name="robots" content="noindex, nofollow"/);
  const javascriptPath = html.match(/src="([^"]+\.js)"/)?.[1];
  assert.ok(javascriptPath, "built frontend should reference a JavaScript asset");
  const javascript = await fetch(new URL(javascriptPath, baseURL));
  assert.equal(javascript.status, 200);
  assert.match(javascript.headers.get("content-type") ?? "", /javascript/);
  const stylesheetPaths = [...html.matchAll(/href="([^"]+\.css)"/g)].map(match => match[1]);
  assert.ok(stylesheetPaths.length > 0, "built frontend should reference a stylesheet");
  for (const stylesheetPath of stylesheetPaths) {
    const stylesheet = await fetch(new URL(stylesheetPath, baseURL));
    assert.equal(stylesheet.status, 200);
    assert.match(stylesheet.headers.get("content-type") ?? "", /text\/css/);
  }

  const catalogResponse = await fetch(`${baseURL}/api/v1/catalog`);
  assert.equal(catalogResponse.status, 200);
  const catalog = await catalogResponse.json();
  assert.equal(typeof catalog.version, "string");
  const crawlerHeaders = { "User-Agent": "SimpleCrawler/1.0" };
  const robots = await fetch(`${baseURL}/robots.txt`, { headers: crawlerHeaders });
  assert.equal(robots.status, 200);
  assert.equal(await robots.text(), "User-agent: *\nDisallow: /\n");
  assert.equal((await fetch(`${baseURL}/`, { headers: crawlerHeaders })).status, 403);
  for (let attempt = 0; attempt < 6; attempt++) {
    const rejected = await fetch(`${baseURL}/api/v1/runs`, {
      method: "POST", body: "{}", headers: {
        "Content-Type": "application/json", "X-Forwarded-For": `198.51.100.${attempt + 1}`,
        "CF-Connecting-IP": `198.51.100.${attempt + 1}`,
      },
    });
    assert.equal(rejected.status, attempt < 5 ? 422 : 429);
    if (attempt === 5) {
      const error = (await rejected.json()).error;
      assert.equal(error.code, "rate_limited");
      assert.equal(Number(rejected.headers.get("retry-after")), error.retryAfterSeconds);
    }
  }
  assert.equal((await fetch(`${baseURL}/health`)).status, 200);
  console.log("Production FastAPI smoke passed: public UI/API/assets, health, robots, crawler refusal, and spoof-resistant run throttling.");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await stopServer();
}
