const express = require("express");

function createApiRouter(deps) {
  const { installService, log, healthInfo } = deps;
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
      const data = await installService.listGames();
      res.json(data);
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
