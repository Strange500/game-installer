const fs = require("fs/promises");
const fsNative = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");
const { spawn } = require("child_process");
const { pipeline } = require("stream/promises");

const DEFAULT_GE_RELEASE_API = "https://api.github.com/repos/GloriousEggroll/proton-ge-custom/releases/latest";

function toBool(value) {
  if (value === true || value === false) return value;
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}

function isFile(p) {
  try {
    return fsNative.existsSync(p) && fsNative.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDirectory(p) {
  try {
    return fsNative.existsSync(p) && fsNative.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isExecutable(p) {
  try {
    fsNative.accessSync(p, fsNative.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isNixOS() {
  return fsNative.existsSync("/etc/NIXOS");
}

function findProtonOnPath() {
  const envPath = process.env.PATH || "";
  const parts = envPath.split(path.delimiter).filter(Boolean);
  for (const part of parts) {
    const candidate = path.join(part, "proton");
    if (isExecutable(candidate)) return candidate;
  }
  return "";
}

function findSteamRunOnPath() {
  const envPath = process.env.PATH || "";
  const parts = envPath.split(path.delimiter).filter(Boolean);
  for (const part of parts) {
    const candidate = path.join(part, "steam-run");
    if (isExecutable(candidate)) return candidate;
  }
  return "";
}

function protonExecutableFromStore(dirPath) {
  const direct = path.join(dirPath, "proton");
  if (isExecutable(direct)) return direct;
  const candidate = path.join(dirPath, "bin", "proton");
  if (isExecutable(candidate)) return candidate;
  const alt = path.join(dirPath, "bin", "proton.sh");
  if (isExecutable(alt)) return alt;
  return "";
}

async function findProtonInNixStore() {
  const storeDir = "/nix/store";
  let entries = [];
  try {
    entries = await fs.readdir(storeDir, { withFileTypes: true });
  } catch {
    return "";
  }

  const candidates = entries
    .filter((entry) => entry.isDirectory() && /proton-ge-bin|proton-ge-custom|steamcompattool|proton/i.test(entry.name))
    .map((entry) => path.join(storeDir, entry.name))
    .sort((a, b) => b.localeCompare(a));

  for (const dirPath of candidates) {
    const execPath = protonExecutableFromStore(dirPath);
    if (execPath) return execPath;
  }

  return "";
}

function resolveProtonFromPath(inputPath) {
  if (!inputPath) return "";
  if (isExecutable(inputPath)) return inputPath;
  if (isFile(inputPath)) return "";
  if (isDirectory(inputPath)) {
    const candidate = path.join(inputPath, "proton");
    if (isExecutable(candidate)) return candidate;
    const alt = path.join(inputPath, "proton.sh");
    if (isExecutable(alt)) return alt;
  }
  return "";
}

function protonExecutableFromDir(dirPath) {
  const candidate = path.join(dirPath, "proton");
  if (isExecutable(candidate)) return candidate;
  const alt = path.join(dirPath, "proton.sh");
  if (isExecutable(alt)) return alt;
  return "";
}

function resolveProtonWrapper(config = {}) {
  const explicit = config.PROTON_WRAPPER_CMD || process.env.PROTON_WRAPPER_CMD || "";
  if (explicit && isExecutable(explicit)) return explicit;
  if (isNixOS()) {
    const steamRun = findSteamRunOnPath();
    if (steamRun) return steamRun;
  }
  return "";
}

function getSteamProtonRoots() {
  const home = os.homedir();
  return [
    path.join(home, ".local/share/Steam/steamapps/common"),
    path.join(home, ".steam/steam/steamapps/common"),
    path.join(home, ".steam/root/steamapps/common"),
    "/usr/share/steam/steamapps/common",
    "/usr/local/share/steam/steamapps/common"
  ];
}

async function findProtonInSteamPaths() {
  const roots = getSteamProtonRoots();
  for (const root of roots) {
    if (!isDirectory(root)) continue;
    let entries = [];
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch {
      entries = [];
    }

    const protonDirs = entries
      .filter((entry) => entry.isDirectory() && /proton/i.test(entry.name))
      .map((entry) => path.join(root, entry.name))
      .sort((a, b) => b.localeCompare(a));

    for (const dirPath of protonDirs) {
      const execPath = protonExecutableFromDir(dirPath);
      if (execPath) return execPath;
    }
  }

  return "";
}

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: {
        "User-Agent": "game-installer-proton/1.0",
        Accept: "application/vnd.github+json"
      }
    }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        httpGetJson(res.headers.location).then(resolve).catch(reject);
        return;
      }

      if (!res.statusCode || res.statusCode >= 400) {
        const code = res.statusCode || 0;
        res.resume();
        reject(new Error(`HTTP ${code} from ${url}`));
        return;
      }

      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        raw += chunk;
      });
      res.on("end", () => {
        try {
          resolve(JSON.parse(raw));
        } catch (err) {
          reject(err);
        }
      });
    });

    request.on("error", reject);
  });
}

async function downloadToFile(url, destPath) {
  await fs.mkdir(path.dirname(destPath), { recursive: true });
  const tmpHandle = await fs.open(destPath, "w");
  await tmpHandle.close();

  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: {
        "User-Agent": "game-installer-proton/1.0"
      }
    }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        downloadToFile(res.headers.location, destPath).then(resolve).catch(reject);
        return;
      }

      if (!res.statusCode || res.statusCode >= 400) {
        const code = res.statusCode || 0;
        res.resume();
        reject(new Error(`HTTP ${code} from ${url}`));
        return;
      }

      pipeline(res, fsNative.createWriteStream(destPath)).then(resolve).catch(reject);
    });

    request.on("error", reject);
  });
}

async function extractTar(tarPath, destinationDir) {
  await fs.mkdir(destinationDir, { recursive: true });
  return new Promise((resolve, reject) => {
    const child = spawn("tar", ["-xf", tarPath, "-C", destinationDir], { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar exited with code ${code}`));
    });
  });
}

async function installProtonGE(config, log) {
  const downloadUrl = config.PROTON_GEO_DOWNLOAD_URL || config.PROTON_GE_DOWNLOAD_URL || "";
  const releaseApi = downloadUrl && downloadUrl.endsWith(".tar.gz") ? "" : (downloadUrl || DEFAULT_GE_RELEASE_API);
  let assetUrl = downloadUrl && downloadUrl.endsWith(".tar.gz") ? downloadUrl : "";

  if (!assetUrl) {
    const release = await httpGetJson(releaseApi);
    const assets = Array.isArray(release?.assets) ? release.assets : [];
    const asset = assets.find((item) => String(item?.name || "").endsWith(".tar.gz"));
    if (!asset?.browser_download_url) {
      throw new Error("Unable to find Proton-GE tar.gz asset in release response.");
    }
    assetUrl = asset.browser_download_url;
  }

  const baseDir = path.join(os.homedir(), ".local/share/proton-ge");
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "proton-ge-"));
  const tarPath = path.join(tmpDir, "proton-ge.tar.gz");

  log("info", "Downloading Proton-GE", { url: assetUrl });
  await downloadToFile(assetUrl, tarPath);
  await extractTar(tarPath, baseDir);

  let candidates = [];
  try {
    candidates = await fs.readdir(baseDir, { withFileTypes: true });
  } catch {
    candidates = [];
  }

  const dirs = candidates
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(baseDir, entry.name))
    .sort((a, b) => b.localeCompare(a));

  for (const dirPath of dirs) {
    const execPath = protonExecutableFromDir(dirPath);
    if (execPath) {
      log("info", "Proton-GE installed", { path: execPath });
      return execPath;
    }
  }

  throw new Error("Proton-GE install completed but no proton executable was found.");
}

async function resolveProtonExecutable(config, log) {
  const fromEnv = resolveProtonFromPath(config.PROTON_PATH || "");
  if (fromEnv) {
    log("info", "Using Proton from PROTON_PATH", { path: fromEnv });
    return fromEnv;
  }

  const shouldAutoInstall = toBool(config.PROTON_AUTO_INSTALL);
  if (isNixOS()) {
    const pathCandidate = await findProtonOnPath();
    if (pathCandidate) {
      log("info", "Using Proton from PATH", { path: pathCandidate });
      return pathCandidate;
    }

    const storeCandidate = await findProtonInNixStore();
    if (storeCandidate) {
      log("info", "Using Proton from Nix store", { path: storeCandidate });
      return storeCandidate;
    }
  }
  if (shouldAutoInstall && isNixOS()) {
    try {
      const gePath = await installProtonGE(config, log);
      log("info", "Using Proton-GE on NixOS", { path: gePath });
      return gePath;
    } catch (err) {
      log("warn", "Proton-GE auto-install failed on NixOS, falling back", { error: err.message });
    }
  }

  const steamCandidate = await findProtonInSteamPaths();
  if (steamCandidate) {
    log("info", "Using Proton from Steam", { path: steamCandidate });
    return steamCandidate;
  }

  if (shouldAutoInstall) {
    const gePath = await installProtonGE(config, log);
    log("info", "Using Proton-GE", { path: gePath });
    return gePath;
  }

  return "";
}

async function ensureProtonAvailable(config, log) {
  const execPath = await resolveProtonExecutable(config, log);
  if (execPath) return execPath;

  const message = "Proton was not found. Install Steam Proton or enable PROTON_AUTO_INSTALL to download Proton-GE.";
  const err = new Error(message);
  err.code = "PROTON_NOT_FOUND";
  throw err;
}

function resolveSteamClientInstallPath(protonExec, config) {
  const envPath = process.env.STEAM_COMPAT_CLIENT_INSTALL_PATH || config?.STEAM_COMPAT_CLIENT_INSTALL_PATH;
  if (envPath) return envPath;

  if (protonExec) {
    const normalized = protonExec.replace(/\\/g, "/");
    const marker = "/steamapps/common/";
    const idx = normalized.indexOf(marker);
    if (idx > 0) {
      return normalized.slice(0, idx);
    }
  }

  const home = os.homedir();
  const candidates = [
    path.join(home, ".local/share/Steam"),
    path.join(home, ".steam/steam"),
    path.join(home, ".steam/root")
  ];

  for (const candidate of candidates) {
    if (isDirectory(candidate)) return candidate;
  }

  return "";
}

function buildProtonEnv(prefixDir, envOverride = {}, config = {}, protonExec = "") {
  const env = { ...process.env, ...envOverride };
  if (prefixDir) env.STEAM_COMPAT_DATA_PATH = prefixDir;

  if (!env.STEAM_COMPAT_CLIENT_INSTALL_PATH) {
    const steamClientPath = resolveSteamClientInstallPath(protonExec, config);
    if (steamClientPath) env.STEAM_COMPAT_CLIENT_INSTALL_PATH = steamClientPath;
  }

  return env;
}

function buildProtonCommand(protonExec, exePath, args = [], wrapperCmd = "") {
  const protonArgs = ["run", exePath, ...args];
  if (wrapperCmd) {
    return {
      command: wrapperCmd,
      args: [protonExec, ...protonArgs]
    };
  }

  return {
    command: protonExec,
    args: protonArgs
  };
}

async function runWithProton({
  exePath,
  prefixDir,
  args = [],
  envOverride = {},
  cwd,
  timeoutMs = 120000,
  log = () => {},
  config = {}
}) {
  if (!exePath) throw new Error("exePath is required for runWithProton");

  if (prefixDir) await fs.mkdir(prefixDir, { recursive: true });

  const protonExec = await ensureProtonAvailable(config, log);
  const wrapperCmd = resolveProtonWrapper(config);
  const command = buildProtonCommand(protonExec, exePath, args, wrapperCmd);
  const env = buildProtonEnv(prefixDir, envOverride, config, protonExec);

  log("info", "Running via Proton", {
    command: command.command,
    args: command.args,
    prefixDir
  });

  return new Promise((resolve, reject) => {
    const child = spawn(command.command, command.args, {
      env,
      cwd,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let timeout = null;

    if (timeoutMs && timeoutMs > 0) {
      timeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`Proton command timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      if (timeout) clearTimeout(timeout);
      reject(err);
    });

    child.on("exit", (code) => {
      if (timeout) clearTimeout(timeout);
      resolve({
        code: code ?? 0,
        stdout,
        stderr,
        command: command.command,
        args: command.args
      });
    });
  });
}

module.exports = {
  resolveProtonExecutable,
  ensureProtonAvailable,
  resolveProtonWrapper,
  buildProtonEnv,
  buildProtonCommand,
  runWithProton
};
