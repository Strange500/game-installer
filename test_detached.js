
const { spawn } = require("child_process");
const fsNative = require("fs");
const path = require("path");

function createLoggedDetachedProcess(command, args, options = {}) {
  const runtimeDir = options.runtimeDir || "/tmp/test-runtime";
  const logName = options.logName || "test";
  fsNative.mkdirSync(runtimeDir, { recursive: true });
  const outPath = path.join(runtimeDir, `${logName}.out.log`);
  const errPath = path.join(runtimeDir, `${logName}.err.log`);
  const outFd = fsNative.openSync(outPath, "a");
  const errFd = fsNative.openSync(errPath, "a");

  const child = spawn(command, args, {
    detached: true,
    stdio: ["ignore", outFd, errFd],
    ...options
  });

  fsNative.closeSync(outFd);
  fsNative.closeSync(errFd);
  child.unref();
  return { child, outPath, errPath };
}

const wrapper = "/nix/store/rfd3f2wq7z26mx0fyy733js2qjybhs48-proton-fhs/bin/proton-fhs";
const runtimeDir = "/tmp/test-runtime-detached";

console.log("Testing detached process via wrapper...");
const { child, outPath, errPath } = createLoggedDetachedProcess(wrapper, ["bash", "-c", "echo STARTED; sleep 5; echo DONE"], {
    runtimeDir,
    env: { ...process.env, TEST_VAL: "hello" }
});

console.log("Process PID:", child.pid);
setTimeout(() => {
    console.log("OUT LOG:", fsNative.readFileSync(outPath, "utf8"));
    console.log("ERR LOG:", fsNative.readFileSync(errPath, "utf8"));
}, 2000);
