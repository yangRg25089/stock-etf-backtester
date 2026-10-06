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
const username = "production-smoke";
const password = "temporary-smoke-credential";
const child = spawn(backendPython, [
  "-m", "uvicorn", "app.main:app", "--app-dir", "backend",
  "--host", "127.0.0.1", "--port", String(port),
], {
  cwd: repositoryRoot,
  env: {
    ...process.env,
    APP_BASIC_AUTH_USERNAME: username,
    APP_BASIC_AUTH_PASSWORD: password,
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

  const unauthorizedRoot = await fetch(`${baseURL}/`);
  assert.equal(unauthorizedRoot.status, 401);
  assert.match(unauthorizedRoot.headers.get("www-authenticate") ?? "", /^Basic /);
  const unauthorizedCatalog = await fetch(`${baseURL}/api/v1/catalog`);
  assert.equal(unauthorizedCatalog.status, 401);

  const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  const headers = { Authorization: authorization };
  const root = await fetch(`${baseURL}/`, { headers });
  assert.equal(root.status, 200);
  const html = await root.text();
  assert.match(html, /<div[^>]+id="root"/);
  assert.match(html, /<meta name="robots" content="noindex, nofollow"/);
  const javascriptPath = html.match(/src="([^"]+\.js)"/)?.[1];
  assert.ok(javascriptPath, "built frontend should reference a JavaScript asset");
  const javascript = await fetch(new URL(javascriptPath, baseURL), { headers });
  assert.equal(javascript.status, 200);
  assert.match(javascript.headers.get("content-type") ?? "", /javascript/);
  const stylesheetPaths = [...html.matchAll(/href="([^"]+\.css)"/g)].map(match => match[1]);
  assert.ok(stylesheetPaths.length > 0, "built frontend should reference a stylesheet");
  for (const stylesheetPath of stylesheetPaths) {
    const stylesheet = await fetch(new URL(stylesheetPath, baseURL), { headers });
    assert.equal(stylesheet.status, 200);
    assert.match(stylesheet.headers.get("content-type") ?? "", /text\/css/);
  }

  const catalogResponse = await fetch(`${baseURL}/api/v1/catalog`, { headers });
  assert.equal(catalogResponse.status, 200);
  const catalog = await catalogResponse.json();
  assert.equal(typeof catalog.version, "string");
  console.log("Production FastAPI smoke passed: auth, health, frontend assets, and catalog.");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await stopServer();
}
