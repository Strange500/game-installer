const assert = require("assert");
const fs = require("fs/promises");
const fsNative = require("fs");
const os = require("os");
const path = require("path");
const { loadEnv } = require("../../config");
const { runWithProton } = require("../../lib/proton");

function log(level, message, meta) {
  const payload = meta ? ` ${JSON.stringify(meta)}` : "";
  process.stdout.write(`[${level}] ${message}${payload}\n`);
}

async function main() {
  const { config } = loadEnv();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "proton-test-"));
  const compatDir = path.join(tempDir, "compatdata");
  const batPath = path.join(tempDir, "run-test.bat");

  await fs.writeFile(batPath, "@echo off\r\nexit /b 0\r\n", "utf8");

  const result = await runWithProton({
    exePath: "cmd",
    prefixDir: compatDir,
    args: ["/c", batPath],
    envOverride: { PROTON_NO_ESYNC: "1" },
    timeoutMs: 120000,
    log,
    config
  });

  const pfxPath = path.join(compatDir, "pfx");
  const hasPfx = fsNative.existsSync(pfxPath);

  assert.strictEqual(result.code, 0, `Expected Proton exit code 0, got ${result.code}. stderr: ${result.stderr}`);
  assert.ok(hasPfx, `Expected compatdata prefix at ${pfxPath}`);

  log("info", "Proton integration test passed", { compatDir, command: result.command });
}

main().catch((err) => {
  process.stderr.write(`Proton integration test failed: ${err.message}\n`);
  process.exit(1);
});
