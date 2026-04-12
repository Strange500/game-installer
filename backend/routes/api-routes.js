const express = require("express");

function createApiRouter(deps) {
  const { installService, gameMetadataService, log, healthInfo } = deps;
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
