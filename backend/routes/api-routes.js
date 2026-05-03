const crypto = require("crypto");
const express = require("express");
const fs = require("fs/promises");
const fsNative = require("fs");
const os = require("os");
const path = require("path");
const { runWithProton, resolveProtonExecutable, resolveProtonWrapper } = require("../lib/proton");

function createApiRouter(deps) {
  const { installService, gameMetadataService, log, healthInfo, config } = deps;
  const router = express.Router();

  router.get("/health", (req, res) => {
    log("debug", "Health check");
    res.json({
      ok: true,
      novncWebPath: healthInfo.autoNoVncPath || null,
      logLevel: healthInfo.logLevel,
      serverHost: healthInfo.serverHost,
      publicHost: healthInfo.publicHost || null
    });
  });

  router.get("/debug/proton", async (req, res, next) => {
    try {
      const allowAutoInstall = String(req.query.autoInstall || "").toLowerCase() === "true";
      const safeConfig = {
        ...config,
        PROTON_AUTO_INSTALL: allowAutoInstall ? config.PROTON_AUTO_INSTALL : "false"
      };
      const resolved = await resolveProtonExecutable(safeConfig, log);
      const wrapper = resolveProtonWrapper(safeConfig);
      const envProtonPath = process.env.PROTON_PATH || "";
      let envProtonExists = false;
      let envProtonIsFile = false;
      let envProtonExecutable = false;

      if (envProtonPath) {
        envProtonExists = fsNative.existsSync(envProtonPath);
        if (envProtonExists) {
          try {
            envProtonIsFile = fsNative.statSync(envProtonPath).isFile();
          } catch {
            envProtonIsFile = false;
          }
          try {
            fsNative.accessSync(envProtonPath, fsNative.constants.X_OK);
            envProtonExecutable = true;
          } catch {
            envProtonExecutable = false;
          }
        }
      }
      res.json({
        resolvedProtonPath: resolved || null,
        env: {
          PROTON_PATH: envProtonPath || null,
          STEAM_COMPAT_CLIENT_INSTALL_PATH: process.env.STEAM_COMPAT_CLIENT_INSTALL_PATH || null,
          PATH: process.env.PATH || null
        },
        envChecks: {
          protonExists: envProtonExists,
          protonIsFile: envProtonIsFile,
          protonIsExecutable: envProtonExecutable
        },
        wrapper: wrapper || null,
        config: {
          PROTON_PATH: config.PROTON_PATH || null,
          PROTON_AUTO_INSTALL: String(config.PROTON_AUTO_INSTALL || "false")
        }
      });
    } catch (err) {
      next(err);
    }
  });

  router.post("/debug/proton/test", async (req, res, next) => {
    try {
      const allowAutoInstall = String(req.query.autoInstall || "").toLowerCase() === "true";
      const runtimeBase = config.STEAM_COMPAT_DATA_BASE || config.SESSION_RUNTIME_BASE || os.tmpdir();
      const compatDataPath = path.join(runtimeBase, `proton-test-${crypto.randomUUID()}`);
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "proton-test-"));
      const batPath = path.join(tempDir, "run-test.bat");

      await fs.mkdir(compatDataPath, { recursive: true });
      await fs.writeFile(batPath, "@echo off\r\nexit /b 0\r\n", "utf8");

      const runConfig = {
        ...config,
        PROTON_AUTO_INSTALL: allowAutoInstall ? config.PROTON_AUTO_INSTALL : "false"
      };

      const result = await runWithProton({
        exePath: "cmd",
        prefixDir: compatDataPath,
        args: ["/c", batPath],
        envOverride: { PROTON_NO_ESYNC: "1" },
        timeoutMs: 120000,
        log,
        config: runConfig
      });

      const pfxPath = path.join(compatDataPath, "pfx");
      const pfxExists = fsNative.existsSync(pfxPath);

      res.json({
        ok: result.code === 0 && pfxExists,
        compatDataPath,
        pfxPath,
        pfxExists,
        result: {
          code: result.code,
          stdout: result.stdout,
          stderr: result.stderr
        }
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/games", async (req, res, next) => {
    try {
      const rawOffset = Number(req.query.offset);
      const rawLimit = Number(req.query.limit);
      const offset = Number.isFinite(rawOffset) ? rawOffset : 0;
      const limit = Number.isFinite(rawLimit) ? rawLimit : 24;
      const refresh = String(req.query.refresh || "").toLowerCase() === "true";
      const data = await installService.listGames({ offset, limit, refresh });
      res.json(data);
    } catch (err) {
      next(err);
    }
  });

  router.get("/game-meta", async (req, res, next) => {
    try {
      const name = String(req.query.name || "").trim();
      if (!name) return res.status(400).json({ error: "Query parameter 'name' is required" });
      const metadata = await gameMetadataService.getMetadata(name);
      res.json({ name, ...metadata });
    } catch (err) {
      next(err);
    }
  });

  router.post("/install", async (req, res, next) => {
    try {
      const payload = await installService.startInstall(req.body || {});
      res.status(202).json(payload);
    } catch (err) {
      next(err);
    }
  });

  router.post("/install/:sessionId/launch", async (req, res, next) => {
    try {
      const payload = await installService.launchSession(req.params.sessionId, req);
      res.json(payload);
    } catch (err) {
      next(err);
    }
  });

  router.get("/install/active", (req, res) => {
    res.json({ session: installService.getActiveSession() });
  });

  router.get("/installed-games", async (req, res, next) => {
    try {
      const games = await installService.listInstalledGames();
      res.json({ count: games.length, games });
    } catch (err) {
      next(err);
    }
  });

  router.get("/install/:sessionId", (req, res) => {
    const session = installService.getSession(req.params.sessionId);
    if (!session) return res.status(404).json({ error: "Install session not found" });
    res.json(session);
  });

  router.get("/install/:sessionId/logs", async (req, res, next) => {
    try {
      const payload = await installService.getSessionLogs(req.params.sessionId);
      res.json(payload);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = {
  createApiRouter
};
