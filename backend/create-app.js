const express = require("express");
const path = require("path");
const { existsSync } = require("fs");
const { createApiRouter } = require("./routes/api-routes");

function createApp({ installService, log, healthInfo }) {
  const app = express();
  app.use(express.json());

  app.use(express.static(path.join(__dirname, "..", "ui", "dist", "ui", "browser")));
  app.use(express.static(path.join(__dirname, "..", "web")));

  app.use("/api", createApiRouter({ installService, log, healthInfo }));

  app.use((err, req, res, next) => {
    const status = err.status || 500;
    res.status(status).json({ error: err.message || "Unexpected server error" });
  });

  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api/")) return next();

    const angularIndexPath = path.join(__dirname, "..", "ui", "dist", "ui", "browser", "index.html");
    if (existsSync(angularIndexPath)) return res.sendFile(angularIndexPath);

    return res.sendFile(path.join(__dirname, "..", "web", "index.html"));
  });

  return app;
}

module.exports = {
  createApp
};
