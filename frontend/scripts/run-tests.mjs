import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = path.join(frontendRoot, ".test-output");
const tscPath = path.join(frontendRoot, "node_modules", "typescript", "bin", "tsc");
const repositoryRoot = path.dirname(frontendRoot);
const backendRoot = path.join(repositoryRoot, "backend");
const backendPython =
  process.env.BACKEND_PYTHON ??
  path.join(
    backendRoot,
    ".venv",
    process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
  );

rmSync(outputPath, { recursive: true, force: true });
mkdirSync(outputPath, { recursive: true });
writeFileSync(path.join(outputPath, "package.json"), '{"type":"commonjs"}\n');

try {
  execFileSync(process.execPath, [tscPath, "-p", "tsconfig.test.json"], {
    cwd: frontendRoot,
    stdio: "inherit",
  });
  if (!existsSync(backendPython)) {
    throw new Error(
      `Backend Python was not found at ${backendPython}. Set BACKEND_PYTHON to the backend virtual environment interpreter.`,
    );
  }
  const catalogJson = execFileSync(
    backendPython,
    [
      "-c",
      "import json; from app.catalog.service import get_catalog; " +
        "print(json.dumps(get_catalog().model_dump(mode='json', by_alias=True)))",
    ],
    {
      cwd: backendRoot,
      env: { ...process.env, PYTHONPATH: backendRoot },
      encoding: "utf8",
    },
  );
  writeFileSync(path.join(outputPath, "catalog.json"), catalogJson);
  execFileSync(
    process.execPath,
    [
      "--test",
      "tests/catalog-contract.test.mjs",
      "tests/shared-settings.test.mjs",
      "tests/strategy-model.test.mjs",
      "tests/strategy-ui.test.mjs",
      "tests/runs-api.test.mjs",
      "tests/results-model.test.mjs",
      "tests/results-components.test.mjs",
      "tests/results-visuals.test.mjs",
      "tests/results-search-export.test.mjs",
      "tests/results-viewer.test.mjs",
      "tests/ui-accessibility.test.mjs",
    ],
    { cwd: frontendRoot, stdio: "inherit" },
  );
} finally {
  rmSync(outputPath, { recursive: true, force: true });
}
