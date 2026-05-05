
const { spawn } = require("child_process");
const path = require("path");

const protonExec = "/nix/store/9rcmpchnqdivam5i2fpzjh27mlq8m4px-proton-ge-bin-GE-Proton10-34-steamcompattool/proton";
const exePath = "/home/strange/Documents/game-installer/games/installed-games/Title Pending FitGirl Repack/setup.exe";
const compatDataPath = "/run/user/1000/game-installer-sessions/debug-no-wrapper";

const env = {
    ...process.env,
    DISPLAY: ":100", // Assuming Xvfb is still running on :100 from previous launch
    SDL_VIDEODRIVER: "x11",
    STEAM_COMPAT_DATA_PATH: compatDataPath,
    STEAM_COMPAT_CLIENT_INSTALL_PATH: "/tmp/dummy-steam",
    WINEDEBUG: "-all",
    PROTON_NO_ESYNC: "1",
    PROTON_NO_FSYNC: "1"
};

console.log("Launching Proton WITHOUT wrapper...");
const child = spawn(protonExec, ["run", exePath], {
    env,
    stdio: "inherit"
});

child.on("exit", (code) => {
    console.log("Exit code:", code);
});
