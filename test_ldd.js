
const { spawn } = require("child_process");

const wrapper = "/nix/store/mk065grrk5hwvp872dx4qi2rws2yla6h-proton-fhs/bin/proton-fhs";
const protonPath = "/nix/store/9rcmpchnqdivam5i2fpzjh27mlq8m4px-proton-ge-bin-GE-Proton10-34-steamcompattool/proton";
const compatDataPath = "/run/user/1000/game-installer-sessions/debug-ldd";

const env = {
    ...process.env,
    DISPLAY: ":100",
    STEAM_COMPAT_DATA_PATH: compatDataPath,
    STEAM_COMPAT_CLIENT_INSTALL_PATH: "/tmp/dummy-steam",
    WINEDEBUG: "+loaddll",
    PROTON_NO_ESYNC: "1",
    PROTON_NO_FSYNC: "1"
};

console.log("Launching Wine with +loaddll via wrapper...");
const child = spawn(wrapper, [protonPath, "run", "cmd", "/c", "exit"], {
    env,
    stdio: "pipe"
});

child.stderr.on("data", (data) => {
    const line = data.toString();
    if (line.includes("failed") || line.includes("err:")) {
        console.error(line);
    }
});

child.stdout.on("data", (data) => {
    console.log(data.toString());
});

child.on("exit", (code) => {
    console.log("Exit code:", code);
});
