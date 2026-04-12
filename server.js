const { loadEnv } = require("./backend/config");
const { createLogger } = require("./backend/logger");
const { createDiscoveryService } = require("./backend/services/discovery-service");
const { createRuntimeService } = require("./backend/services/runtime-service");
const { createInstallService } = require("./backend/services/install-service");
const { createApp } = require("./backend/create-app");

const { envCandidates, loadedEnvPath, config, AUTO_NOVNC_WEB_PATH } = loadEnv();
const log = createLogger(config.LOG_LEVEL);

if (loadedEnvPath) {
  log("info", "Loaded environment file", { envPath: loadedEnvPath });
} else {
  log("warn", "No .env file loaded", { lookedIn: envCandidates });
}

const discoveryService = createDiscoveryService(config);
const runtimeService = createRuntimeService(config, AUTO_NOVNC_WEB_PATH, log);
const installService = createInstallService(config, discoveryService, runtimeService, log);

const app = createApp({
  installService,
  log,
  healthInfo: {
    autoNoVncPath: AUTO_NOVNC_WEB_PATH,
    logLevel: config.LOG_LEVEL,
    serverHost: config.SERVER_HOST,
    publicHost: config.PUBLIC_HOST
  }
});

app.listen(config.PORT, config.SERVER_HOST, () => {
  console.log(`Game installer server listening on http://${config.SERVER_HOST}:${config.PORT}`);
});
