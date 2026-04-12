const path = require("path");
const os = require("os");
const dotenv = require("dotenv");
const { existsSync } = require("fs");

function firstExistingPath(candidates) {
  for (const p of candidates) {
    if (p && existsSync(p)) return p;
  }
  return "";
}

function loadEnv() {
  const envCandidates = [path.join(__dirname, "..", ".env"), path.join(process.cwd(), ".env")];
  let loadedEnvPath = null;

  for (const candidate of envCandidates) {
    const loaded = dotenv.config({ path: candidate });
    if (!loaded.error) {
      loadedEnvPath = candidate;
      break;
    }
  }

  const config = {
    PORT: Number(process.env.PORT || 3000),
    SERVER_HOST: process.env.SERVER_HOST || "0.0.0.0",
    SSH_HOST: process.env.SSH_HOST || "192.168.0.28",
    SSH_PORT: Number(process.env.SSH_PORT || 22),
    SSH_USERNAME: process.env.SSH_USERNAME || process.env.USER,
    SSH_PASSWORD: process.env.SSH_PASSWORD,
    SSH_PRIVATE_KEY_PATH: process.env.SSH_PRIVATE_KEY_PATH,
    SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK,
    REMOTE_GAMES_DIR: process.env.REMOTE_GAMES_DIR || "/mnt/data/media/torrents/game/windows",
    LOCAL_INSTALL_BASE: process.env.LOCAL_INSTALL_BASE || path.resolve(__dirname, "..", "installed-games"),
    LOCAL_LIBRARY_DIR: process.env.LOCAL_LIBRARY_DIR || path.resolve(__dirname, ".."),
    SESSION_RUNTIME_BASE: process.env.SESSION_RUNTIME_BASE || path.join(os.tmpdir(), "game-installer-sessions"),
    ISOLATED_RESOLUTION: process.env.ISOLATED_RESOLUTION || "1600x900x24",
    ISOLATED_BASE_DISPLAY: Number(process.env.ISOLATED_BASE_DISPLAY || 90),
    ISOLATED_BASE_VNC_PORT: Number(process.env.ISOLATED_BASE_VNC_PORT || 5901),
    ISOLATED_BASE_NOVNC_PORT: Number(process.env.ISOLATED_BASE_NOVNC_PORT || 6081),
    NOVNC_WEB_PATH: process.env.NOVNC_WEB_PATH || "",
    PUBLIC_HOST: process.env.PUBLIC_HOST || "",
    PUBLIC_PROTOCOL: process.env.PUBLIC_PROTOCOL || "",
    LOG_LEVEL: process.env.LOG_LEVEL || "info"
  };

  const AUTO_NOVNC_WEB_PATH = firstExistingPath([
    config.NOVNC_WEB_PATH,
    "/run/current-system/sw/share/novnc",
    "/run/current-system/sw/share/noVNC",
    "/run/current-system/sw/share/webapps/novnc",
    process.env.HOME ? path.join(process.env.HOME, ".nix-profile/share/novnc") : "",
    process.env.HOME ? path.join(process.env.HOME, ".nix-profile/share/noVNC") : "",
    process.env.HOME ? path.join(process.env.HOME, ".nix-profile/share/webapps/novnc") : "",
    process.env.USER ? path.join("/etc/profiles/per-user", process.env.USER, "share/novnc") : "",
    process.env.USER ? path.join("/etc/profiles/per-user", process.env.USER, "share/noVNC") : "",
    process.env.USER ? path.join("/etc/profiles/per-user", process.env.USER, "share/webapps/novnc") : "",
    "/usr/share/novnc",
    "/usr/share/novnc/www",
    "/usr/share/noVNC",
    "/usr/share/webapps/novnc"
  ]);

  return {
    envCandidates,
    loadedEnvPath,
    config,
    AUTO_NOVNC_WEB_PATH
  };
}

module.exports = {
  loadEnv,
  firstExistingPath
};
