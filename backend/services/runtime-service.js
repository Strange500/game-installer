const net = require("net");
const path = require("path");
const fs = require("fs/promises");
const fsNative = require("fs");
const { spawn } = require("child_process");

function createRuntimeService(config, autoNoVncPath, log) {
  const {
    SESSION_RUNTIME_BASE,
    ISOLATED_RESOLUTION,
    ISOLATED_BASE_DISPLAY,
    ISOLATED_BASE_VNC_PORT,
    ISOLATED_BASE_NOVNC_PORT,
    NOVNC_WEB_PATH,
    PUBLIC_HOST,
    PUBLIC_PROTOCOL
  } = config;

  const COMMANDS = {
    xvfb: process.env.XVFB_CMD || "Xvfb",
    x11vnc: process.env.X11VNC_CMD || "x11vnc",
    websockify: process.env.WEBSOCKIFY_CMD || "websockify",
    wine: process.env.WINE_CMD || "wine",
    proton: process.env.PROTON_CMD || "proton",
    msiexec: process.env.MSIEXEC_CMD || "msiexec",
    cmd: process.env.CMD_CMD || "cmd",
    powershell: process.env.POWERSHELL_CMD || "powershell"
  };

  const WINDOWS_RUNTIME_MODE = String(process.env.WINDOWS_RUNTIME || "auto").toLowerCase();
  const PROTON_ARGS = String(process.env.PROTON_ARGS || "run")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  function isExplicitCommandPath(command) {
    return command.includes("/");
  }

  async function commandExists(command) {
    if (isExplicitCommandPath(command)) {
      return fsNative.existsSync(command);
    }

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
      if (vncFree && novncFree) return { display, vncPort, novncPort };
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

  function expandNoVncCandidatePaths(inputPath) {
    if (!inputPath) return [];

    const base = String(inputPath).replace(/\/$/, "");
    return [
      base,
      path.join(base, "share", "novnc"),
      path.join(base, "share", "noVNC"),
      path.join(base, "share", "webapps", "novnc"),
      path.join(base, "www")
    ];
  }

  function resolveNoVncWeb(candidates) {
    const entryCandidates = ["vnc.html", "vnc_lite.html", "index.html"];
    const checked = [];

    for (const candidate of candidates) {
      if (!candidate || !fsNative.existsSync(candidate)) continue;

      for (const entryFile of entryCandidates) {
        const entryPath = path.join(candidate, entryFile);
        checked.push(entryPath);
        if (fsNative.existsSync(entryPath)) {
          return {
            webPath: candidate,
            entryFile,
            checked
          };
        }
      }
    }

    return {
      webPath: null,
      entryFile: null,
      checked
    };
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

  function buildRemoteUiUrl(req, novncPort, entryFile = "vnc.html") {
    if (PUBLIC_HOST) {
      const proto = PUBLIC_PROTOCOL || req.protocol || "http";
      return `${proto}://${PUBLIC_HOST}:${novncPort}/${entryFile}?autoconnect=1&resize=remote`;
    }

    const forwardedProto = req.headers["x-forwarded-proto"];
    const proto = typeof forwardedProto === "string" ? forwardedProto.split(",")[0] : req.protocol || "http";
    const forwardedHost = req.headers["x-forwarded-host"];
    const hostHeader = (typeof forwardedHost === "string" ? forwardedHost.split(",")[0] : req.get("host")) || "localhost";
    const hostname = hostHeader.includes(":") ? hostHeader.slice(0, hostHeader.lastIndexOf(":")) : hostHeader;
    return `${proto}://${hostname}:${novncPort}/${entryFile}?autoconnect=1&resize=remote`;
  }

  function buildHeadlessX11Env(displayName, extra = {}) {
    const env = { ...process.env, ...extra, DISPLAY: displayName };
    delete env.WAYLAND_DISPLAY;
    env.XDG_SESSION_TYPE = "x11";
    return env;
  }

  async function resolveLinuxWindowsRuntime() {
    const wineExists = await commandExists(COMMANDS.wine);
    const protonExists = await commandExists(COMMANDS.proton);

    if (WINDOWS_RUNTIME_MODE === "wine") {
      if (!wineExists) throw new Error("WINDOWS_RUNTIME=wine but WINE_CMD was not found.");
      return "wine";
    }

    if (WINDOWS_RUNTIME_MODE === "proton") {
      if (!protonExists) throw new Error("WINDOWS_RUNTIME=proton but PROTON_CMD was not found.");
      return "proton";
    }

    if (wineExists) return "wine";
    if (protonExists) return "proton";
    throw new Error("Missing runtime for Windows installers on Linux host. Install wine or proton, or set WINE_CMD/PROTON_CMD.");
  }

  async function readLogTail(filePath, maxBytes = 12000) {
    if (!filePath || !fsNative.existsSync(filePath)) return "";
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

  async function startIsolatedInstallerSession(session, req) {
    const needs = [
      { label: "Xvfb", command: COMMANDS.xvfb },
      { label: "x11vnc", command: COMMANDS.x11vnc },
      { label: "websockify", command: COMMANDS.websockify }
    ];

    for (const tool of needs) {
      const ok = await commandExists(tool.command);
      if (!ok) throw new Error(`Missing required command '${tool.label}'. Install it to use isolated installer sessions.`);
    }

    if (process.platform !== "win32") {
      const ext = path.extname(session.localInstallerPath).toLowerCase();
      if ([".exe", ".msi", ".bat", ".cmd"].includes(ext)) {
        await resolveLinuxWindowsRuntime();
      }
    }

    const { display, vncPort, novncPort } = await reserveSessionSlots();
    const displayName = `:${display}`;
    const runtimeDir = path.join(SESSION_RUNTIME_BASE, session.id);
    const winePrefix = path.join(runtimeDir, "wineprefix");
    await fs.mkdir(runtimeDir, { recursive: true });
    await fs.mkdir(winePrefix, { recursive: true });

    log("info", "Starting isolated session", { sessionId: session.id, displayName, vncPort, novncPort, runtimeDir });

    const xvfb = createLoggedDetachedProcess(COMMANDS.xvfb, [displayName, "-screen", "0", ISOLATED_RESOLUTION, "-nolisten", "tcp"], {
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

    const x11vnc = createLoggedDetachedProcess(COMMANDS.x11vnc, [
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

    const novncWebCandidatesRaw = [
      autoNoVncPath,
      NOVNC_WEB_PATH,
      "/run/current-system/sw/share/novnc",
      "/run/current-system/sw/share/noVNC",
      "/run/current-system/sw/share/webapps/novnc",
      "/usr/share/novnc",
      "/usr/share/novnc/www",
      "/usr/share/noVNC",
      "/usr/share/webapps/novnc"
    ].filter(Boolean);

    const novncWebCandidates = Array.from(new Set(novncWebCandidatesRaw.flatMap((candidate) => expandNoVncCandidatePaths(candidate))));

    const resolvedNoVnc = resolveNoVncWeb(novncWebCandidates);
    const novncWebPath = resolvedNoVnc.webPath;
    const novncEntryFile = resolvedNoVnc.entryFile || "vnc.html";

    if (!novncWebPath) {
      const checkedPreview = resolvedNoVnc.checked.slice(0, 8);
      throw new Error(
        `noVNC web files not found. Checked for vnc.html/vnc_lite.html under: ${checkedPreview.join(", ")}. Set NOVNC_WEB_PATH to a directory that contains noVNC web files.`
      );
    }

    const websockify = createLoggedDetachedProcess(COMMANDS.websockify, ["--web", novncWebPath, String(novncPort), `127.0.0.1:${vncPort}`], {
      env: buildHeadlessX11Env(displayName),
      runtimeDir,
      logName: "websockify"
    });

    const vncReady = await waitForPortOpen(vncPort, 12000);
    if (!vncReady) {
      const x11vncErrTail = await readLogTail(x11vnc.errPath, 3000);
      throw new Error(`x11vnc failed to start on port ${vncPort}. Check logs under ${runtimeDir}. x11vnc.err tail: ${x11vncErrTail.trim()}`);
    }

    const novncReady = await waitForPortOpen(novncPort, 12000);
    if (!novncReady) {
      const websockifyErrTail = await readLogTail(websockify.errPath, 3000);
      throw new Error(`websockify/noVNC failed to start on port ${novncPort}. Check logs under ${runtimeDir}. websockify.err tail: ${websockifyErrTail.trim()}`);
    }

    const ext = path.extname(session.localInstallerPath).toLowerCase();
    const linuxWindowsRuntime = process.platform !== "win32" && [".exe", ".msi", ".bat", ".cmd"].includes(ext)
      ? await resolveLinuxWindowsRuntime()
      : null;
    const installerEnv = buildHeadlessX11Env(displayName, {
      WINEPREFIX: winePrefix,
      STEAM_COMPAT_DATA_PATH: winePrefix
    });

    let installer;
    if (ext === ".msi" && process.platform === "win32") {
      installer = createLoggedDetachedProcess(COMMANDS.msiexec, ["/i", session.localInstallerPath], { runtimeDir, logName: "installer" });
    } else if (ext === ".msi") {
      if (linuxWindowsRuntime === "proton") {
        installer = createLoggedDetachedProcess(COMMANDS.proton, [...PROTON_ARGS, "msiexec", "/i", session.localInstallerPath], {
          env: installerEnv,
          runtimeDir,
          logName: "installer"
        });
      } else {
        installer = createLoggedDetachedProcess(COMMANDS.wine, ["msiexec", "/i", session.localInstallerPath], { env: installerEnv, runtimeDir, logName: "installer" });
      }
    } else if ((ext === ".bat" || ext === ".cmd") && process.platform === "win32") {
      installer = createLoggedDetachedProcess(COMMANDS.cmd, ["/c", session.localInstallerPath], { runtimeDir, logName: "installer" });
    } else if (ext === ".bat" || ext === ".cmd") {
      if (linuxWindowsRuntime === "proton") {
        installer = createLoggedDetachedProcess(COMMANDS.proton, [...PROTON_ARGS, "cmd", "/c", session.localInstallerPath], {
          env: installerEnv,
          runtimeDir,
          logName: "installer"
        });
      } else {
        installer = createLoggedDetachedProcess(COMMANDS.wine, ["cmd", "/c", session.localInstallerPath], { env: installerEnv, runtimeDir, logName: "installer" });
      }
    } else if (ext === ".ps1") {
      if (process.platform !== "win32") throw new Error("PowerShell installers are only supported on Windows hosts.");
      installer = createLoggedDetachedProcess(COMMANDS.powershell, ["-ExecutionPolicy", "Bypass", "-File", session.localInstallerPath], { runtimeDir, logName: "installer" });
    } else if (ext === ".exe" && process.platform !== "win32") {
      if (linuxWindowsRuntime === "proton") {
        installer = createLoggedDetachedProcess(COMMANDS.proton, [...PROTON_ARGS, session.localInstallerPath], {
          env: installerEnv,
          runtimeDir,
          logName: "installer"
        });
      } else {
        installer = createLoggedDetachedProcess(COMMANDS.wine, [session.localInstallerPath], { env: installerEnv, runtimeDir, logName: "installer" });
      }
    } else {
      installer = createLoggedDetachedProcess(session.localInstallerPath, [], { env: installerEnv, runtimeDir, logName: "installer" });
    }

    session.runtime = {
      display,
      vncPort,
      novncPort,
      runtimeDir,
      linuxWindowsRuntime,
      wmCommandUsed,
      novncWebPath,
      novncEntryFile,
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

    session.remoteUiUrl = buildRemoteUiUrl(req, novncPort, novncEntryFile);

    log("info", "Isolated session started", {
      sessionId: session.id,
      remoteUiUrl: session.remoteUiUrl,
      wmCommandUsed,
      novncWebPath
    });
  }

  return {
    startIsolatedInstallerSession,
    readLogTail
  };
}

module.exports = {
  createRuntimeService
};
