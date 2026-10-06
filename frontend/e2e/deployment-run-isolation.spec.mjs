import { expect, test } from "@playwright/test";

const activeRunSessionKey = "stock-etf-backtester.active-run-id.v1";

test("independent browser contexts reconnect only to their own active run ID", async ({ browser }) => {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  const runRequestsA = [];
  const runRequestsB = [];

  await contextA.addInitScript(({ key }) => sessionStorage.setItem(key, "run-browser-a"), { key: activeRunSessionKey });
  await contextB.addInitScript(({ key }) => sessionStorage.setItem(key, "run-browser-b"), { key: activeRunSessionKey });
  pageA.on("request", request => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/v1/runs/")) runRequestsA.push(path);
  });
  pageB.on("request", request => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/v1/runs/")) runRequestsB.push(path);
  });

  const gone = route => route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({
    error: { code: "run_not_found", messageKey: "api.errors.run_not_found" },
  }) });
  await pageA.route("**/api/v1/runs/**", gone);
  await pageB.route("**/api/v1/runs/**", gone);
  try {
    await Promise.all([pageA.goto("/"), pageB.goto("/")]);
    await expect.poll(() => runRequestsA.filter(path => path.includes("run-browser")).length).toBe(1);
    await expect.poll(() => runRequestsB.filter(path => path.includes("run-browser")).length).toBe(1);

    expect(runRequestsA).toEqual(["/api/v1/runs/run-browser-a"]);
    expect(runRequestsB).toEqual(["/api/v1/runs/run-browser-b"]);
    expect(await pageA.evaluate(key => sessionStorage.getItem(key), activeRunSessionKey)).toBeNull();
    expect(await pageB.evaluate(key => sessionStorage.getItem(key), activeRunSessionKey)).toBeNull();
    expect(await pageA.evaluate(() => Object.values(localStorage))).not.toContain("run-browser-a");
    expect(await pageB.evaluate(() => Object.values(localStorage))).not.toContain("run-browser-b");
  } finally {
    await contextA.close();
    await contextB.close();
  }
});
