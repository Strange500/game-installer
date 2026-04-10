const express = require("express");
const path = require("path");
const os = require("os");
const net = require("net");
const fs = require("fs/promises");
const fsNative = require("fs");
const { existsSync } = fsNative;
const { spawn } = require("child_process");
const crypto = require("crypto");
const dotenv = require("dotenv");
const SftpClient = require("ssh2-sftp-client");

const envCandidates = [path.join(__dirname, ".env"), path.join(process.cwd(), ".env")];
let loadedEnvPath = null;
for (const candidate of envCandidates) {
  const loaded = dotenv.config({ path: candidate });
  if (!loaded.error) {
    loadedEnvPath = candidate;
    break;
  }
}

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT || 3000);
const SERVER_HOST = process.env.SERVER_HOST || "0.0.0.0";
const SSH_HOST = process.env.SSH_HOST || "192.168.0.28";
const SSH_PORT = Number(process.env.SSH_PORT || 22);
const SSH_USERNAME = process.env.SSH_USERNAME || process.env.USER;
const SSH_PASSWORD = process.env.SSH_PASSWORD;
const SSH_PRIVATE_KEY_PATH = process.env.SSH_PRIVATE_KEY_PATH;
const SSH_AUTH_SOCK = process.env.SSH_AUTH_SOCK;
const REMOTE_GAMES_DIR = process.env.REMOTE_GAMES_DIR || "/mnt/data/media/torrents/game/windows";
const LOCAL_INSTALL_BASE = process.env.LOCAL_INSTALL_BASE || path.resolve(__dirname, "installed-games");
const LOCAL_LIBRARY_DIR = process.env.LOCAL_LIBRARY_DIR || __dirname;
const SESSION_RUNTIME_BASE = process.env.SESSION_RUNTIME_BASE || path.join(os.tmpdir(), "game-installer-sessions");
const ISOLATED_RESOLUTION = process.env.ISOLATED_RESOLUTION || "1600x900x24";
const ISOLATED_BASE_DISPLAY = Number(process.env.ISOLATED_BASE_DISPLAY || 90);
const ISOLATED_BASE_VNC_PORT = Number(process.env.ISOLATED_BASE_VNC_PORT || 5901);
const ISOLATED_BASE_NOVNC_PORT = Number(process.env.ISOLATED_BASE_NOVNC_PORT || 6081);
const NOVNC_WEB_PATH = process.env.NOVNC_WEB_PATH || "";
const PUBLIC_HOST = process.env.PUBLIC_HOST || "";
const PUBLIC_PROTOCOL = process.env.PUBLIC_PROTOCOL || "";
const LOG_LEVEL = process.env.LOG_LEVEL || "info";

const sessions = new Map();

function firstExistingPath(candidates) {
  for (const p of candidates) {
    if (p && existsSync(p)) return p;
  }
  return "";
}

function log(level, message, meta = {}) {
  const levels = { debug: 10, info: 20, warn: 30, error: 40 };
  if ((levels[level] || 20) < (levels[LOG_LEVEL] || 20)) return;
  const ts = new Date().toISOString();
  const hasMeta = Object.keys(meta).length > 0;
  const line = hasMeta ? `${ts} [${level}] ${message} ${JSON.stringify(meta)}` : `${ts} [${level}] ${message}`;
  console.log(line);
}

if (loadedEnvPath) {
  log("info", "Loaded environment file", { envPath: loadedEnvPath });
} else {
  log("warn", "No .env file loaded", { lookedIn: envCandidates });
}

const AUTO_NOVNC_WEB_PATH = firstExistingPath([
  NOVNC_WEB_PATH,
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

function requireConfig() {
  const missing = [];
  if (!SSH_HOST) missing.push("SSH_HOST");
  if (!SSH_USERNAME) missing.push("SSH_USERNAME");
  if (!SSH_PASSWORD && !SSH_PRIVATE_KEY_PATH && !SSH_AUTH_SOCK) {
    missing.push("SSH_PASSWORD or SSH_PRIVATE_KEY_PATH or SSH_AUTH_SOCK");
  }
  if (missing.length > 0) {
    const error = new Error(`Missing required env vars: ${missing.join(", ")}`);
    error.status = 500;
    throw error;
  }
}

async function createSftpClient() {
  requireConfig();
  const client = new SftpClient();
  const cfg = {
    host: SSH_HOST,
    port: SSH_PORT,
    username: SSH_USERNAME
  };
  if (SSH_PRIVATE_KEY_PATH) {
    const privateKey = await fs.readFile(path.resolve(SSH_PRIVATE_KEY_PATH), "utf8");
    cfg.privateKey = privateKey;
  } else {
    if (SSH_PASSWORD) {
      cfg.password = SSH_PASSWORD;
    }
    if (SSH_AUTH_SOCK) {
      cfg.agent = SSH_AUTH_SOCK;
    }
  }
  await client.connect(cfg);
  return client;
}

function normalizeName(value) {
  return value
    .replace(/\.[^/.]+$/, "")
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isInstaller(entryName) {
  return /\.(exe|msi|bat|cmd|ps1)$/i.test(entryName);
}

function shouldIgnoreLocalDir(dirName) {
  return ["node_modules", "web", "installed-games", ".git"].includes(dirName);
}

function shouldIgnoreLocalFile(fileName) {
  return fileName.toLowerCase() === "quicksfv.exe";
}

function guessGameName(fileName, packageDir) {
  const baseFileName = normalizeName(fileName).toLowerCase();
  if (["setup", "install", "installer"].includes(baseFileName)) {
    return normalizeName(path.basename(packageDir || fileName));
  }
  return normalizeName(fileName);
}

async function collectInstallers(sftp, remoteDir, depth = 2) {
  let output = [];
  let entries;
  try {
    entries = await sftp.list(remoteDir);
  } catch {
    return output;
  }

  for (const entry of entries) {
    const remotePath = path.posix.join(remoteDir, entry.name);
    if (entry.type === "d" && depth > 0) {
      const nested = await collectInstallers(sftp, remotePath, depth - 1);
      output = output.concat(nested);
      continue;
    }

    if (entry.type !== "d" && isInstaller(entry.name)) {
      output.push({
        name: guessGameName(entry.name, remoteDir),
        fileName: entry.name,
        sourceType: "remote",
        sourcePath: remotePath,
        packageDir: remoteDir,
        size: Number(entry.size || 0),
        modifiedAt: entry.modifyTime || null
      });
    }
  }

  return output;
}

async function collectLocalInstallers(localDir, depth = 3) {
  let output = [];
  let entries;
  try {
    entries = await fs.readdir(localDir, { withFileTypes: true });
  } catch {
    return output;
  }

  for (const entry of entries) {
    const fullPath = path.join(localDir, entry.name);

    if (entry.isDirectory()) {
      if (shouldIgnoreLocalDir(entry.name)) continue;
      if (depth > 0) {
        const nested = await collectLocalInstallers(fullPath, depth - 1);
        output = output.concat(nested);
      }
      continue;
    }

    if (entry.isFile() && isInstaller(entry.name)) {
      if (shouldIgnoreLocalFile(entry.name)) continue;
      const stat = await fs.stat(fullPath).catch(() => null);
      output.push({
        name: guessGameName(entry.name, localDir),
        fileName: entry.name,
        sourceType: "local",
        sourcePath: fullPath,
        packageDir: localDir,
        size: Number(stat?.size || 0),
        modifiedAt: stat?.mtime ? stat.mtime.toISOString() : null
      });
    }
  }

  return output;
}

function toSafeFolderName(name) {
  return name.replace(/[^a-zA-Z0-9._ -]/g, "").trim().slice(0, 120) || "game";
}

async function copyDirectoryContents(sourceDir, destinationDir) {
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const src = path.join(sourceDir, entry.name);
    const dest = path.join(destinationDir, entry.name);
    if (entry.isDirectory()) {
      await fs.cp(src, dest, { recursive: true });
    } else if (entry.isFile()) {
      await fs.copyFile(src, dest);
    }
  }
}

function resolveInstallerPathCandidates(installDir, installerFileName, packageDirName) {
  const direct = path.join(installDir, installerFileName);
  if (existsSync(direct)) return direct;

  if (packageDirName) {
    const nested = path.join(installDir, packageDirName, installerFileName);
    if (existsSync(nested)) return nested;
  }

  return direct;
}

async function commandExists(command) {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-lc", `command -v ${command}`], { stdio: "ignore" });
    child.on("exit", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

async function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

async function reserveSessionSlots() {
  for (let i = 0; i < 30; i += 1) {
    const display = ISOLATED_BASE_DISPLAY + i;
    const vncPort = ISOLATED_BASE_VNC_PORT + i;
    const novncPort = ISOLATED_BASE_NOVNC_PORT + i;
    const [vncFree, novncFree] = await Promise.all([isPortFree(vncPort), isPortFree(novncPort)]);
    if (vncFree && novncFree) {
      return { display, vncPort, novncPort };
    }
  }
  throw new Error("No free isolated session slots available");
}

function createLoggedDetachedProcess(command, args, options = {}) {
  const runtimeDir = options.runtimeDir || SESSION_RUNTIME_BASE;
  const logName = options.logName || command;
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

async function waitForPortOpen(port, timeoutMs = 12000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const free = await isPortFree(port);
    if (!free) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

function buildRemoteUiUrl(req, novncPort) {
  if (PUBLIC_HOST) {
    const proto = PUBLIC_PROTOCOL || req.protocol || "http";
    return `${proto}://${PUBLIC_HOST}:${novncPort}/vnc.html?autoconnect=1&resize=remote`;
  }

  const forwardedProto = req.headers["x-forwarded-proto"];
  const proto = typeof forwardedProto === "string" ? forwardedProto.split(",")[0] : req.protocol || "http";
  const forwardedHost = req.headers["x-forwarded-host"];
  const hostHeader = (typeof forwardedHost === "string" ? forwardedHost.split(",")[0] : req.get("host")) || "localhost";
  const hostname = hostHeader.includes(":") ? hostHeader.slice(0, hostHeader.lastIndexOf(":")) : hostHeader;
  return `${proto}://${hostname}:${novncPort}/vnc.html?autoconnect=1&resize=remote`;
}

function buildHeadlessX11Env(displayName, extra = {}) {
  const env = { ...process.env, ...extra, DISPLAY: displayName };
  delete env.WAYLAND_DISPLAY;
  env.XDG_SESSION_TYPE = "x11";
  return env;
}

async function startIsolatedInstallerSession(session, req) {
  const needs = ["Xvfb", "x11vnc", "websockify"];
  for (const tool of needs) {
    const ok = await commandExists(tool);
    if (!ok) {
      throw new Error(`Missing required command '${tool}'. Install it to use isolated installer sessions.`);
    }
  }

  if (process.platform !== "win32") {
    const ext = path.extname(session.localInstallerPath).toLowerCase();
    if ([".exe", ".msi", ".bat", ".cmd"].includes(ext)) {
      const wineExists = await commandExists("wine");
      if (!wineExists) {
        throw new Error("Missing required command 'wine' for Windows installers on Linux host.");
      }
    }
  }

  const { display, vncPort, novncPort } = await reserveSessionSlots();
  const displayName = `:${display}`;
  const runtimeDir = path.join(SESSION_RUNTIME_BASE, session.id);
  const winePrefix = path.join(runtimeDir, "wineprefix");
  await fs.mkdir(runtimeDir, { recursive: true });
  await fs.mkdir(winePrefix, { recursive: true });

  log("info", "Starting isolated session", { sessionId: session.id, displayName, vncPort, novncPort, runtimeDir });

  const xvfb = createLoggedDetachedProcess("Xvfb", [displayName, "-screen", "0", ISOLATED_RESOLUTION, "-nolisten", "tcp"], {
    env: buildHeadlessX11Env(displayName),
    runtimeDir,
    logName: "xvfb"
  });
  await new Promise((resolve) => setTimeout(resolve, 700));

  const wmCandidates = ["openbox", "fluxbox", "xfwm4", "twm"];
  let wm = null;
  let wmCommandUsed = null;
  for (const wmCommand of wmCandidates) {
    if (await commandExists(wmCommand)) {
      wm = createLoggedDetachedProcess(wmCommand, [], {
        env: buildHeadlessX11Env(displayName),
        runtimeDir,
        logName: "window-manager"
      });
      wmCommandUsed = wmCommand;
      break;
    }
  }

  const x11vnc = createLoggedDetachedProcess("x11vnc", [
    "-display",
    displayName,
    "-rfbport",
    String(vncPort),
    "-localhost",
    "-forever",
    "-shared",
    "-nopw"
  ], {
    env: buildHeadlessX11Env(displayName),
    runtimeDir,
    logName: "x11vnc"
  });

  const novncWebCandidates = [
    AUTO_NOVNC_WEB_PATH,
    NOVNC_WEB_PATH,
    "/run/current-system/sw/share/novnc",
    "/run/current-system/sw/share/noVNC",
    "/run/current-system/sw/share/webapps/novnc",
    "/usr/share/novnc",
    "/usr/share/novnc/www",
    "/usr/share/noVNC",
    "/usr/share/webapps/novnc"
  ].filter(Boolean);
  let novncWebPath = null;
  for (const p of novncWebCandidates) {
    if (existsSync(p)) {
      novncWebPath = p;
      break;
    }
  }
  if (!novncWebPath) {
    throw new Error(
      "noVNC web files not found. Set NOVNC_WEB_PATH to the noVNC web dir (example: /run/current-system/sw/share/novnc)."
    );
  }

  const websockify = createLoggedDetachedProcess("websockify", [
    "--web",
    novncWebPath,
    String(novncPort),
    `127.0.0.1:${vncPort}`
  ], {
    env: buildHeadlessX11Env(displayName),
    runtimeDir,
    logName: "websockify"
  });

  const vncReady = await waitForPortOpen(vncPort, 12000);
  if (!vncReady) {
    const x11vncErrTail = await readLogTail(x11vnc.errPath, 3000);
    throw new Error(
      `x11vnc failed to start on port ${vncPort}. Check logs under ${runtimeDir}. x11vnc.err tail: ${x11vncErrTail.trim()}`
    );
  }

  const novncReady = await waitForPortOpen(novncPort, 12000);
  if (!novncReady) {
    const websockifyErrTail = await readLogTail(websockify.errPath, 3000);
    throw new Error(
      `websockify/noVNC failed to start on port ${novncPort}. Check logs under ${runtimeDir}. websockify.err tail: ${websockifyErrTail.trim()}`
    );
  }

  const ext = path.extname(session.localInstallerPath).toLowerCase();
  const installerEnv = buildHeadlessX11Env(displayName, {
    WINEPREFIX: winePrefix
  });

  let installer;
  if (ext === ".msi" && process.platform === "win32") {
    installer = createLoggedDetachedProcess("msiexec", ["/i", session.localInstallerPath], {
      runtimeDir,
      logName: "installer"
    });
  } else if (ext === ".msi") {
    installer = createLoggedDetachedProcess("wine", ["msiexec", "/i", session.localInstallerPath], {
      env: installerEnv,
      runtimeDir,
      logName: "installer"
    });
  } else if ((ext === ".bat" || ext === ".cmd") && process.platform === "win32") {
    installer = createLoggedDetachedProcess("cmd", ["/c", session.localInstallerPath], {
      runtimeDir,
      logName: "installer"
    });
  } else if (ext === ".bat" || ext === ".cmd") {
    installer = createLoggedDetachedProcess("wine", ["cmd", "/c", session.localInstallerPath], {
      env: installerEnv,
      runtimeDir,
      logName: "installer"
    });
  } else if (ext === ".ps1") {
    if (process.platform !== "win32") {
      throw new Error("PowerShell installers are only supported on Windows hosts.");
    }
    installer = createLoggedDetachedProcess("powershell", ["-ExecutionPolicy", "Bypass", "-File", session.localInstallerPath], {
      runtimeDir,
      logName: "installer"
    });
  } else if (ext === ".exe" && process.platform !== "win32") {
    installer = createLoggedDetachedProcess("wine", [session.localInstallerPath], {
      env: installerEnv,
      runtimeDir,
      logName: "installer"
    });
  } else {
    installer = createLoggedDetachedProcess(session.localInstallerPath, [], {
      env: installerEnv,
      runtimeDir,
      logName: "installer"
    });
  }

  session.runtime = {
    display,
    vncPort,
    novncPort,
    runtimeDir,
    wmCommandUsed,
    novncWebPath,
    pids: {
      xvfb: xvfb.child.pid,
      wm: wm ? wm.child.pid : null,
      x11vnc: x11vnc.child.pid,
      websockify: websockify.child.pid,
      installer: installer.child.pid
    },
    logs: {
      xvfbOut: xvfb.outPath,
      xvfbErr: xvfb.errPath,
      wmOut: wm ? wm.outPath : null,
      wmErr: wm ? wm.errPath : null,
      x11vncOut: x11vnc.outPath,
      x11vncErr: x11vnc.errPath,
      websockifyOut: websockify.outPath,
      websockifyErr: websockify.errPath,
      installerOut: installer.outPath,
      installerErr: installer.errPath
    }
  };
  session.remoteUiUrl = buildRemoteUiUrl(req, novncPort);
  log("info", "Isolated session started", {
    sessionId: session.id,
    remoteUiUrl: session.remoteUiUrl,
    wmCommandUsed,
    novncWebPath
  });
}

async function readLogTail(filePath, maxBytes = 12000) {
  if (!filePath || !existsSync(filePath)) return "";
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat) return "";
  const start = Math.max(0, stat.size - maxBytes);
  const handle = await fs.open(filePath, "r");
  try {
    const length = stat.size - start;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}

app.use(express.static(path.join(__dirname, "ui", "dist", "ui", "browser")));
app.use(express.static(path.join(__dirname, "web")));

app.get("/api/health", (req, res) => {
  log("debug", "Health check");
  res.json({
    ok: true,
    novncWebPath: AUTO_NOVNC_WEB_PATH || null,
    logLevel: LOG_LEVEL,
    serverHost: SERVER_HOST,
    publicHost: PUBLIC_HOST || null
  });
});

app.get("/api/games", async (req, res, next) => {
  let sftp;
  try {
    const localInstallers = await collectLocalInstallers(path.resolve(LOCAL_LIBRARY_DIR), 3);
    let remoteInstallers = [];
    let remoteError = null;

    try {
      sftp = await createSftpClient();
      remoteInstallers = await collectInstallers(sftp, REMOTE_GAMES_DIR, 3);
    } catch (err) {
      remoteInstallers = [];
      remoteError = err.message;
      log("warn", "Remote games listing failed", {
        remoteDir: REMOTE_GAMES_DIR,
        error: err.message
      });
    }

    const installers = localInstallers.concat(remoteInstallers);

    const grouped = new Map();
    for (const item of installers) {
      const key = `${item.name}::${item.sourceType}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(item);
    }

    const games = Array.from(grouped.entries())
      .map(([groupKey, files]) => {
        files.sort((a, b) => b.size - a.size);
        const [name, sourceType] = groupKey.split("::");
        return {
          id: crypto.createHash("md5").update(`${sourceType}:${files[0].sourcePath}`).digest("hex"),
          name,
          sourceType,
          installers: files
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    res.json({
      remoteDir: REMOTE_GAMES_DIR,
      localDir: path.resolve(LOCAL_LIBRARY_DIR),
      remoteStatus: remoteError ? "unavailable" : "ok",
      remoteError,
      count: games.length,
      games
    });
  } catch (err) {
    next(err);
  } finally {
    if (sftp) {
      try {
        await sftp.end();
      } catch {
        // ignore close errors
      }
    }
  }
});

app.post("/api/install", async (req, res, next) => {
  const { sourcePath, sourceType, gameName, packageDir } = req.body || {};
  log("info", "Install request received", {
    sourceType,
    sourcePath,
    gameName,
    packageDir
  });
  if (!sourcePath || !sourceType || !gameName) {
    return res.status(400).json({ error: "sourcePath, sourceType and gameName are required" });
  }

  try {
    await fs.mkdir(LOCAL_INSTALL_BASE, { recursive: true });

    const gameFolder = toSafeFolderName(gameName);
    const installDir = path.join(LOCAL_INSTALL_BASE, gameFolder);
    await fs.mkdir(installDir, { recursive: true });

    const sourcePathBasename = sourceType === "remote" ? path.posix.basename(sourcePath) : path.basename(sourcePath);
    const fileName = sourcePathBasename;
    const localInstallerPath = path.join(installDir, fileName);
    const normalizedPackageDir = packageDir || (sourceType === "remote" ? path.posix.dirname(sourcePath) : path.dirname(sourcePath));

    const sessionId = crypto.randomUUID();
    sessions.set(sessionId, {
      id: sessionId,
      gameName,
      state: "downloading",
      installDir,
      localInstallerPath,
      sourceType,
      sourcePath,
      packageDir: normalizedPackageDir,
      progress: "Preparing download...",
      download: {
        totalBytes: null,
        transferredBytes: 0,
        percent: null
      },
      createdAt: new Date().toISOString()
    });

    (async () => {
      const packageDirName = normalizedPackageDir
        ? path.basename(sourceType === "remote" ? path.posix.basename(normalizedPackageDir) : normalizedPackageDir)
        : null;

      if (sourceType === "remote") {
        const sftp = await createSftpClient();
        try {
          const isNestedPackage = normalizedPackageDir && normalizedPackageDir !== REMOTE_GAMES_DIR;
          if (isNestedPackage) {
            const listing = await sftp.list(normalizedPackageDir).catch(() => []);
            const totalBytes = listing
              .filter((item) => item.type !== "d")
              .reduce((sum, item) => sum + Number(item.size || 0), 0);
            let transferredBytes = 0;
            await sftp.downloadDir(normalizedPackageDir, installDir);
            try {
              const localEntries = await fs.readdir(installDir, { withFileTypes: true });
              for (const localEntry of localEntries) {
                if (!localEntry.isFile()) continue;
                const st = await fs.stat(path.join(installDir, localEntry.name)).catch(() => null);
                transferredBytes += Number(st?.size || 0);
              }
            } catch {
              // ignore local size fallback errors
            }
            const sessAfterDir = sessions.get(sessionId);
            if (sessAfterDir) {
              sessAfterDir.download = {
                totalBytes,
                transferredBytes: totalBytes > 0 ? totalBytes : transferredBytes,
                percent: totalBytes > 0 ? 100 : null
              };
            }
          } else {
            const stat = await sftp.stat(sourcePath).catch(() => null);
            const totalBytes = Number(stat?.size || 0);
            await sftp.fastGet(sourcePath, localInstallerPath, {
              step: (transferred) => {
                const sessProgress = sessions.get(sessionId);
                if (!sessProgress) return;
                const percent = totalBytes > 0 ? Math.min(100, Math.round((transferred / totalBytes) * 100)) : null;
                sessProgress.download = {
                  totalBytes,
                  transferredBytes: transferred,
                  percent
                };
                sessProgress.progress = totalBytes > 0
                  ? `Downloading installer... ${percent}%`
                  : "Downloading installer...";
              }
            });
          }
        } finally {
          await sftp.end().catch(() => {});
        }
      } else if (sourceType === "local") {
        const isNestedPackage = normalizedPackageDir && path.resolve(normalizedPackageDir) !== path.resolve(LOCAL_LIBRARY_DIR);
        if (isNestedPackage) {
          await copyDirectoryContents(path.resolve(normalizedPackageDir), installDir);
        } else {
          await fs.copyFile(path.resolve(sourcePath), localInstallerPath);
        }
      } else {
        throw new Error(`Unsupported sourceType: ${sourceType}`);
      }

      const sess = sessions.get(sessionId);
      if (!sess) return;

      sess.localInstallerPath = resolveInstallerPathCandidates(installDir, fileName, packageDirName);

      sess.state = "awaiting_user";
      sess.progress = "Installer downloaded. Waiting for user confirmation to launch installer.";
      sess.download = {
        totalBytes: sess.download?.totalBytes || null,
        transferredBytes: sess.download?.totalBytes || sess.download?.transferredBytes || null,
        percent: 100
      };
      log("info", "Installer payload ready", {
        sessionId,
        installDir,
        localInstallerPath: sess.localInstallerPath
      });
    })()
      .then(() => {
        const sess = sessions.get(sessionId);
        if (!sess) return;
      })
      .catch((err) => {
        const sess = sessions.get(sessionId);
        if (!sess) return;
        sess.state = "failed";
        sess.progress = `Download failed: ${err.message}`;
        log("error", "Install download/copy failed", {
          sessionId,
          error: err.message
        });
      });

    res.status(202).json({
      sessionId,
      message: "Download started",
      installDir,
      localInstallerPath
    });
  } catch (err) {
    next(err);
  }
});

app.post("/api/install/:sessionId/launch", async (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: "Install session not found" });
  if (session.state !== "awaiting_user") {
    return res.status(400).json({ error: `Cannot launch installer while state is ${session.state}` });
  }
  if (!existsSync(session.localInstallerPath)) {
    session.state = "failed";
    session.progress = "Installer file is missing";
    return res.status(410).json({ error: "Installer file not found" });
  }

  try {
    session.state = "starting_isolated_session";
    session.progress = "Preparing isolated desktop session for installer...";
    await startIsolatedInstallerSession(session, req);
    session.state = "installer_started";
    session.progress = "Installer started in isolated session. Use remote UI link to complete installation.";
    return res.json({
      ok: true,
      message: "Installer launched in isolated session",
      remoteUiUrl: session.remoteUiUrl,
      session
    });
  } catch (err) {
    session.state = "failed";
    session.progress = `Failed to start isolated session: ${err.message}`;
    log("error", "Isolated session failed to start", {
      sessionId,
      error: err.message,
      runtimeDir: session.runtime?.runtimeDir || null
    });
    return res.status(500).json({ error: session.progress });
  }
});

app.get("/api/install/active", (req, res) => {
  const allSessions = Array.from(sessions.values());
  allSessions.sort((a, b) => {
    const aTs = new Date(a.createdAt || 0).getTime();
    const bTs = new Date(b.createdAt || 0).getTime();
    return bTs - aTs;
  });

  const active = allSessions.find((sess) => !["failed"].includes(sess.state));
  res.json({ session: active || null });
});

app.get("/api/install/:sessionId", (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: "Install session not found" });
  res.json(session);
});

app.get("/api/install/:sessionId/logs", async (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: "Install session not found" });

  const logs = session.runtime?.logs;
  if (!logs) {
    return res.status(400).json({ error: "No runtime logs available yet for this session" });
  }

  const payload = {
    runtimeDir: session.runtime.runtimeDir,
    tails: {
      xvfbErr: await readLogTail(logs.xvfbErr),
      x11vncErr: await readLogTail(logs.x11vncErr),
      websockifyErr: await readLogTail(logs.websockifyErr),
      installerErr: await readLogTail(logs.installerErr),
      xvfbOut: await readLogTail(logs.xvfbOut),
      x11vncOut: await readLogTail(logs.x11vncOut),
      websockifyOut: await readLogTail(logs.websockifyOut),
      installerOut: await readLogTail(logs.installerOut)
    }
  };
  res.json(payload);
});

app.use((err, req, res, next) => {
  const status = err.status || 500;
  res.status(status).json({
    error: err.message || "Unexpected server error"
  });
});

app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  const angularIndexPath = path.join(__dirname, "ui", "dist", "ui", "browser", "index.html");
  if (existsSync(angularIndexPath)) {
    return res.sendFile(angularIndexPath);
  }
  return res.sendFile(path.join(__dirname, "web", "index.html"));
});

app.listen(PORT, SERVER_HOST, () => {
  console.log(`Game installer server listening on http://${SERVER_HOST}:${PORT}`);
});
