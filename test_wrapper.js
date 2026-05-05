
const { spawn } = require("child_process");

const wrapper = "/nix/store/rfd3f2wq7z26mx0fyy733js2qjybhs48-proton-fhs/bin/proton-fhs";
const env = {
    ...process.env,
    SDL_VIDEODRIVER: "x11_test_value",
    TEST_VAR: "test_value"
};

console.log("Testing NEW wrapper with env...");

const child = spawn(wrapper, ["bash", "-c", "echo SDL_VIDEODRIVER=$SDL_VIDEODRIVER; echo TEST_VAR=$TEST_VAR"], {
    env,
    stdio: "inherit"
});

child.on("exit", (code) => {
    console.log("Exit code:", code);
});
