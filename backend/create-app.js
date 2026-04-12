const express = require("express");
const path = require("path");
const { existsSync } = require("fs");
const { createApiRouter } = require("./routes/api-routes");

function createApp({ installService, gameMetadataService, log, healthInfo }) {
  const app = express();
  app.use(express.json());

  app.use(express.static(path.join(__dirname, "..", "ui", "dist", "ui", "browser")));

  app.use("/api", createApiRouter({ installService, gameMetadataService, log, healthInfo }));

  app.use((err, req, res, next) => {
    const status = err.status || 500;
    res.status(status).json({ error: err.message || "Unexpected server error" });
  });

  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api/")) return next();

    const angularIndexPath = path.join(__dirname, "..", "ui", "dist", "ui", "browser", "index.html");
    if (existsSync(angularIndexPath)) return res.sendFile(angularIndexPath);

    return res.status(503).json({
      error: "Angular frontend build not found. Run 'npm run ui:build' before starting the server."
    });
  });

  return app;
}

module.exports = {
  createApp
};
