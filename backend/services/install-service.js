const path = require("path");
const fs = require("fs/promises");
const { existsSync } = require("fs");
const crypto = require("crypto");

function createInstallService(config, discoveryService, runtimeService, log) {
  const { LOCAL_INSTALL_BASE, LOCAL_LIBRARY_DIR, REMOTE_GAMES_DIR } = config;
  const sessions = new Map();

  async function listGames() {
    return discoveryService.listGames(log);
  }

  function getSession(sessionId) {
    return sessions.get(sessionId) || null;
  }

  function getActiveSession() {
    const allSessions = Array.from(sessions.values());
    allSessions.sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
    return allSessions.find((sess) => !["failed"].includes(sess.state)) || null;
  }

  async function getSessionLogs(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) {
      const err = new Error("Install session not found");
      err.status = 404;
      throw err;
    }

    const logs = session.runtime?.logs;
    if (!logs) {
      const err = new Error("No runtime logs available yet for this session");
      err.status = 400;
      throw err;
    }

    return {
      runtimeDir: session.runtime.runtimeDir,
      tails: {
        xvfbErr: await runtimeService.readLogTail(logs.xvfbErr),
        x11vncErr: await runtimeService.readLogTail(logs.x11vncErr),
        websockifyErr: await runtimeService.readLogTail(logs.websockifyErr),
        installerErr: await runtimeService.readLogTail(logs.installerErr),
        xvfbOut: await runtimeService.readLogTail(logs.xvfbOut),
        x11vncOut: await runtimeService.readLogTail(logs.x11vncOut),
        websockifyOut: await runtimeService.readLogTail(logs.websockifyOut),
        installerOut: await runtimeService.readLogTail(logs.installerOut)
      }
    };
  }

  async function startInstall(input) {
    const { sourcePath, sourceType, gameName, packageDir } = input || {};
    if (!sourcePath || !sourceType || !gameName) {
      const err = new Error("sourcePath, sourceType and gameName are required");
      err.status = 400;
      throw err;
    }

    log("info", "Install request received", { sourceType, sourcePath, gameName, packageDir });

    await fs.mkdir(LOCAL_INSTALL_BASE, { recursive: true });

    const gameFolder = discoveryService.toSafeFolderName(gameName);
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

    const runCopy = async () => {
      const packageDirName = normalizedPackageDir
        ? path.basename(sourceType === "remote" ? path.posix.basename(normalizedPackageDir) : normalizedPackageDir)
        : null;

      if (sourceType === "remote") {
        const sftp = await discoveryService.createSftpClient();
        try {
          const isNestedPackage = normalizedPackageDir && normalizedPackageDir !== REMOTE_GAMES_DIR;
          if (isNestedPackage) {
            const listing = await sftp.list(normalizedPackageDir).catch(() => []);
            const totalBytes = listing.filter((item) => item.type !== "d").reduce((sum, item) => sum + Number(item.size || 0), 0);
            let transferredBytes = 0;
            await sftp.downloadDir(normalizedPackageDir, installDir);

            const localEntries = await fs.readdir(installDir, { withFileTypes: true }).catch(() => []);
            for (const localEntry of localEntries) {
              if (!localEntry.isFile()) continue;
              const st = await fs.stat(path.join(installDir, localEntry.name)).catch(() => null);
              transferredBytes += Number(st?.size || 0);
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
                sessProgress.download = { totalBytes, transferredBytes: transferred, percent };
                sessProgress.progress = totalBytes > 0 ? `Downloading installer... ${percent}%` : "Downloading installer...";
              }
            });
          }
        } finally {
          await sftp.end().catch(() => {});
        }
      } else if (sourceType === "local") {
        const isNestedPackage = normalizedPackageDir && path.resolve(normalizedPackageDir) !== path.resolve(LOCAL_LIBRARY_DIR);
        if (isNestedPackage) {
          await discoveryService.copyDirectoryContents(path.resolve(normalizedPackageDir), installDir);
        } else {
          await fs.copyFile(path.resolve(sourcePath), localInstallerPath);
        }
      } else {
        throw new Error(`Unsupported sourceType: ${sourceType}`);
      }

      const sess = sessions.get(sessionId);
      if (!sess) return;

      sess.localInstallerPath = discoveryService.resolveInstallerPathCandidates(installDir, fileName, packageDirName);
      sess.state = "awaiting_user";
      sess.progress = "Installer downloaded. Waiting for user confirmation to launch installer.";
      sess.download = {
        totalBytes: sess.download?.totalBytes || null,
        transferredBytes: sess.download?.totalBytes || sess.download?.transferredBytes || null,
        percent: 100
      };

      log("info", "Installer payload ready", { sessionId, installDir, localInstallerPath: sess.localInstallerPath });
    };

    runCopy().catch((err) => {
      const sess = sessions.get(sessionId);
      if (!sess) return;
      sess.state = "failed";
      sess.progress = `Download failed: ${err.message}`;
      log("error", "Install download/copy failed", { sessionId, error: err.message });
    });

    return {
      sessionId,
      message: "Download started",
      installDir,
      localInstallerPath
    };
  }

  async function launchSession(sessionId, req) {
    const session = sessions.get(sessionId);
    if (!session) {
      const err = new Error("Install session not found");
      err.status = 404;
      throw err;
    }

    if (session.state !== "awaiting_user") {
      const err = new Error(`Cannot launch installer while state is ${session.state}`);
      err.status = 400;
      throw err;
    }

    if (!existsSync(session.localInstallerPath)) {
      session.state = "failed";
      session.progress = "Installer file is missing";
      const err = new Error("Installer file not found");
      err.status = 410;
      throw err;
    }

    try {
      session.state = "starting_isolated_session";
      session.progress = "Preparing isolated desktop session for installer...";
      await runtimeService.startIsolatedInstallerSession(session, req);
      session.state = "installer_started";
      session.progress = "Installer started in isolated session. Use remote UI link to complete installation.";
      return {
        ok: true,
        message: "Installer launched in isolated session",
        remoteUiUrl: session.remoteUiUrl,
        session
      };
    } catch (err) {
      session.state = "failed";
      session.progress = `Failed to start isolated session: ${err.message}`;
      log("error", "Isolated session failed to start", {
        sessionId,
        error: err.message,
        runtimeDir: session.runtime?.runtimeDir || null
      });
      err.status = 500;
      err.message = session.progress;
      throw err;
    }
  }

  return {
    listGames,
    startInstall,
    launchSession,
    getSession,
    getActiveSession,
    getSessionLogs
  };
}

module.exports = {
  createInstallService
};
