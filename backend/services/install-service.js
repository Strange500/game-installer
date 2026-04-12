const path = require("path");
const fs = require("fs/promises");
const { existsSync } = require("fs");
const crypto = require("crypto");

function createInstallService(config, discoveryService, runtimeService, log) {
  const { LOCAL_INSTALL_BASE, LOCAL_LIBRARY_DIR, REMOTE_GAMES_DIR } = config;
  const sessions = new Map();
  const registryPath = path.join(LOCAL_INSTALL_BASE, ".installed-games.json");
  let installedRegistry = [];
  let registryLoaded = false;
  let registryWriteQueue = Promise.resolve();

  async function ensureRegistryLoaded() {
    if (registryLoaded) return;
    registryLoaded = true;
    try {
      const raw = await fs.readFile(registryPath, "utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) installedRegistry = parsed;
    } catch {
      installedRegistry = [];
    }
  }

  function enqueueRegistryWrite() {
    registryWriteQueue = registryWriteQueue
      .then(async () => {
        await fs.mkdir(LOCAL_INSTALL_BASE, { recursive: true });
        await fs.writeFile(registryPath, JSON.stringify(installedRegistry, null, 2), "utf8");
      })
      .catch(() => {});

    return registryWriteQueue;
  }

  async function updateInstalledRegistry(sessionOrRecord) {
    await ensureRegistryLoaded();

    const now = new Date().toISOString();
    const record = {
      id: sessionOrRecord.id || crypto.createHash("md5").update(`${sessionOrRecord.gameName}:${sessionOrRecord.installDir}`).digest("hex"),
      gameName: sessionOrRecord.gameName,
      sourceType: sessionOrRecord.sourceType || null,
      status: sessionOrRecord.state || sessionOrRecord.status || "unknown",
      installDir: sessionOrRecord.installDir || null,
      localInstallerPath: sessionOrRecord.localInstallerPath || null,
      sessionId: sessionOrRecord.id || sessionOrRecord.sessionId || null,
      progress: sessionOrRecord.progress || null,
      createdAt: sessionOrRecord.createdAt || now,
      updatedAt: now
    };

    const existingIndex = installedRegistry.findIndex((item) => item.id === record.id);
    if (existingIndex >= 0) {
      const existing = installedRegistry[existingIndex];
      installedRegistry[existingIndex] = {
        ...existing,
        ...record,
        createdAt: existing.createdAt || record.createdAt
      };
    } else {
      installedRegistry.push(record);
    }

    await enqueueRegistryWrite();
  }

  async function listInstalledGames() {
    await ensureRegistryLoaded();

    let diskEntries = [];
    try {
      const dirs = await fs.readdir(LOCAL_INSTALL_BASE, { withFileTypes: true });
      diskEntries = dirs
        .filter((entry) => entry.isDirectory())
        .map((entry) => ({
          id: crypto.createHash("md5").update(`disk:${entry.name}`).digest("hex"),
          gameName: entry.name,
          sourceType: null,
          status: "present_on_disk",
          installDir: path.join(LOCAL_INSTALL_BASE, entry.name),
          localInstallerPath: null,
          sessionId: null,
          progress: null,
          createdAt: null,
          updatedAt: null
        }));
    } catch {
      diskEntries = [];
    }

    const merged = new Map();
    for (const item of installedRegistry) merged.set(item.id, item);
    for (const item of diskEntries) {
      const existingByDir = Array.from(merged.values()).find((row) => row.installDir === item.installDir);
      if (!existingByDir) merged.set(item.id, item);
    }

    return Array.from(merged.values()).sort((a, b) => {
      const aTs = new Date(a.updatedAt || a.createdAt || 0).getTime();
      const bTs = new Date(b.updatedAt || b.createdAt || 0).getTime();
      return bTs - aTs;
    });
  }

  function formatMbps(bytesPerSecond) {
    if (!bytesPerSecond || bytesPerSecond <= 0) return null;
    return `${(bytesPerSecond / (1024 * 1024)).toFixed(2)} MB/s`;
  }

  function updateDownloadProgress(sessionId, totalBytes, transferredBytes, startedAt) {
    const sessProgress = sessions.get(sessionId);
    if (!sessProgress) return;

    const safeTotal = Number(totalBytes || 0);
    const safeTransferred = Number(transferredBytes || 0);
    const percent = safeTotal > 0 ? Math.min(100, Math.round((safeTransferred / safeTotal) * 100)) : null;
    const elapsedSeconds = Math.max(0.001, (Date.now() - startedAt) / 1000);
    const speedText = formatMbps(safeTransferred / elapsedSeconds);

    sessProgress.download = {
      totalBytes: safeTotal > 0 ? safeTotal : null,
      transferredBytes: safeTransferred,
      percent
    };

    if (percent !== null) {
      sessProgress.progress = speedText
        ? `Downloading installer... ${percent}% (${speedText})`
        : `Downloading installer... ${percent}%`;
    } else {
      sessProgress.progress = speedText
        ? `Downloading installer... (${speedText})`
        : "Downloading installer...";
    }
  }

  function isSubPath(rootPath, candidatePath) {
    const normalizedRoot = path.resolve(rootPath);
    const normalizedCandidate = path.resolve(candidatePath);
    const relative = path.relative(normalizedRoot, normalizedCandidate);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  }

  function assertLocalPathAllowed(inputPath, fieldName) {
    if (!inputPath) return;
    const allowedRoot = path.resolve(LOCAL_LIBRARY_DIR);
    const candidate = path.resolve(inputPath);
    if (!isSubPath(allowedRoot, candidate)) {
      const err = new Error(`${fieldName} must stay within LOCAL_LIBRARY_DIR`);
      err.status = 400;
      throw err;
    }
  }

  function assertRemotePathAllowed(inputPath, fieldName) {
    if (!inputPath) return;
    const normalizedRoot = path.posix.normalize(REMOTE_GAMES_DIR);
    const normalizedInput = path.posix.normalize(inputPath);
    if (!(normalizedInput === normalizedRoot || normalizedInput.startsWith(`${normalizedRoot}/`))) {
      const err = new Error(`${fieldName} must stay within REMOTE_GAMES_DIR`);
      err.status = 400;
      throw err;
    }
  }

  async function listGames(options = {}) {
    return discoveryService.listGames(log, options);
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

    if (sourceType === "local") {
      assertLocalPathAllowed(sourcePath, "sourcePath");
      assertLocalPathAllowed(packageDir, "packageDir");
    }
    if (sourceType === "remote") {
      assertRemotePathAllowed(sourcePath, "sourcePath");
      assertRemotePathAllowed(packageDir, "packageDir");
    }

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

    await updateInstalledRegistry(sessions.get(sessionId));

    const runCopy = async () => {
      const downloadStartedAt = Date.now();
      const packageDirName = normalizedPackageDir
        ? path.basename(sourceType === "remote" ? path.posix.basename(normalizedPackageDir) : normalizedPackageDir)
        : null;

      if (sourceType === "remote") {
        const sftp = await discoveryService.createSftpClient();
        try {
          const isNestedPackage = normalizedPackageDir && normalizedPackageDir !== REMOTE_GAMES_DIR;
          if (isNestedPackage) {
            const files = await discoveryService.listRemoteFilesRecursive(sftp, normalizedPackageDir, 8);
            const totalBytes = files.reduce((sum, item) => sum + Number(item.size || 0), 0);
            let transferredBytes = 0;

            updateDownloadProgress(sessionId, totalBytes, 0, downloadStartedAt);

            for (const remoteFile of files) {
              const relativePath = path.posix.relative(normalizedPackageDir, remoteFile.path);
              const localTarget = path.join(installDir, ...relativePath.split("/"));
              await fs.mkdir(path.dirname(localTarget), { recursive: true });

              await sftp.fastGet(remoteFile.path, localTarget, {
                concurrency: 64,
                step: (transferredForFile) => {
                  updateDownloadProgress(
                    sessionId,
                    totalBytes,
                    transferredBytes + Number(transferredForFile || 0),
                    downloadStartedAt
                  );
                }
              });

              transferredBytes += Number(remoteFile.size || 0);
              updateDownloadProgress(sessionId, totalBytes, transferredBytes, downloadStartedAt);
            }
          } else {
            const stat = await sftp.stat(sourcePath).catch(() => null);
            const totalBytes = Number(stat?.size || 0);
            updateDownloadProgress(sessionId, totalBytes, 0, downloadStartedAt);

            await sftp.fastGet(sourcePath, localInstallerPath, {
              concurrency: 64,
              step: (transferred) => {
                updateDownloadProgress(sessionId, totalBytes, Number(transferred || 0), downloadStartedAt);
              }
            });

            updateDownloadProgress(sessionId, totalBytes, totalBytes, downloadStartedAt);
          }
        } finally {
          await sftp.end().catch(() => {});
        }
      } else if (sourceType === "local") {
        const isNestedPackage = normalizedPackageDir && path.resolve(normalizedPackageDir) !== path.resolve(LOCAL_LIBRARY_DIR);
        if (isNestedPackage) {
          assertLocalPathAllowed(normalizedPackageDir, "packageDir");
          await discoveryService.copyDirectoryContents(path.resolve(normalizedPackageDir), installDir);
        } else {
          assertLocalPathAllowed(sourcePath, "sourcePath");
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

      await updateInstalledRegistry(sess);

      log("info", "Installer payload ready", { sessionId, installDir, localInstallerPath: sess.localInstallerPath });
    };

    runCopy().catch((err) => {
      const sess = sessions.get(sessionId);
      if (!sess) return;
      sess.state = "failed";
      sess.progress = `Download failed: ${err.message}`;
      updateInstalledRegistry(sess).catch(() => {});
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
      await updateInstalledRegistry(session);
      await runtimeService.startIsolatedInstallerSession(session, req);
      session.state = "installer_started";
      session.progress = "Installer started in isolated session. Use remote UI link to complete installation.";
      await updateInstalledRegistry(session);
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
      await updateInstalledRegistry(session);
      err.status = 500;
      err.message = session.progress;
      throw err;
    }
  }

  return {
    listGames,
    startInstall,
    launchSession,
    listInstalledGames,
    getSession,
    getActiveSession,
    getSessionLogs
  };
}

module.exports = {
  createInstallService
};
