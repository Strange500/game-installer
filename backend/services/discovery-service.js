const path = require("path");
const fs = require("fs/promises");
const { existsSync } = require("fs");
const crypto = require("crypto");
const SftpClient = require("ssh2-sftp-client");

function createDiscoveryService(config) {
  const {
    SSH_HOST,
    SSH_PORT,
    SSH_USERNAME,
    SSH_PASSWORD,
    SSH_PRIVATE_KEY_PATH,
    SSH_AUTH_SOCK,
    REMOTE_GAMES_DIR,
    LOCAL_LIBRARY_DIR
  } = config;

  function requireConfig() {
    const missing = [];
    if (!SSH_HOST) missing.push("SSH_HOST");
    if (!SSH_USERNAME) missing.push("SSH_USERNAME");
    if (!SSH_PASSWORD && !SSH_PRIVATE_KEY_PATH && !SSH_AUTH_SOCK) {
      missing.push("SSH_PASSWORD or SSH_PRIVATE_KEY_PATH or SSH_AUTH_SOCK");
    }
    if (missing.length > 0) {
      const error = new Error(`Missing required env vars: ${missing.join(", ")}`);
      error.status = 500;
      throw error;
    }
  }

  async function createSftpClient() {
    requireConfig();
    const client = new SftpClient();
    const cfg = {
      host: SSH_HOST,
      port: SSH_PORT,
      username: SSH_USERNAME
    };

    if (SSH_PRIVATE_KEY_PATH) {
      const privateKey = await fs.readFile(path.resolve(SSH_PRIVATE_KEY_PATH), "utf8");
      cfg.privateKey = privateKey;
    } else {
      if (SSH_PASSWORD) cfg.password = SSH_PASSWORD;
      if (SSH_AUTH_SOCK) cfg.agent = SSH_AUTH_SOCK;
    }

    await client.connect(cfg);
    return client;
  }

  function normalizeName(value) {
    return value
      .replace(/\.[^/.]+$/, "")
      .replace(/[._-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function isInstaller(entryName) {
    return /\.(exe|msi|bat|cmd|ps1)$/i.test(entryName);
  }

  function shouldIgnoreLocalDir(dirName) {
    return ["node_modules", "web", "ui", "installed-games", ".git", "backend"].includes(dirName);
  }

  function shouldIgnoreLocalFile(fileName) {
    return fileName.toLowerCase() === "quicksfv.exe";
  }

  function guessGameName(fileName, packageDir) {
    const baseFileName = normalizeName(fileName).toLowerCase();
    if (["setup", "install", "installer"].includes(baseFileName)) {
      return normalizeName(path.basename(packageDir || fileName));
    }
    return normalizeName(fileName);
  }

  async function collectInstallers(sftp, remoteDir, depth = 2) {
    let output = [];
    let entries;
    try {
      entries = await sftp.list(remoteDir);
    } catch {
      return output;
    }

    for (const entry of entries) {
      const remotePath = path.posix.join(remoteDir, entry.name);
      if (entry.type === "d" && depth > 0) {
        const nested = await collectInstallers(sftp, remotePath, depth - 1);
        output = output.concat(nested);
        continue;
      }

      if (entry.type !== "d" && isInstaller(entry.name)) {
        output.push({
          name: guessGameName(entry.name, remoteDir),
          fileName: entry.name,
          sourceType: "remote",
          sourcePath: remotePath,
          packageDir: remoteDir,
          size: Number(entry.size || 0),
          modifiedAt: entry.modifyTime || null
        });
      }
    }

    return output;
  }

  async function collectLocalInstallers(localDir, depth = 3) {
    let output = [];
    let entries;
    try {
      entries = await fs.readdir(localDir, { withFileTypes: true });
    } catch {
      return output;
    }

    for (const entry of entries) {
      const fullPath = path.join(localDir, entry.name);

      if (entry.isDirectory()) {
        if (shouldIgnoreLocalDir(entry.name)) continue;
        if (depth > 0) {
          const nested = await collectLocalInstallers(fullPath, depth - 1);
          output = output.concat(nested);
        }
        continue;
      }

      if (entry.isFile() && isInstaller(entry.name)) {
        if (shouldIgnoreLocalFile(entry.name)) continue;
        const stat = await fs.stat(fullPath).catch(() => null);
        output.push({
          name: guessGameName(entry.name, localDir),
          fileName: entry.name,
          sourceType: "local",
          sourcePath: fullPath,
          packageDir: localDir,
          size: Number(stat?.size || 0),
          modifiedAt: stat?.mtime ? stat.mtime.toISOString() : null
        });
      }
    }

    return output;
  }

  async function listGames(log) {
    let sftp;
    const localInstallers = await collectLocalInstallers(path.resolve(LOCAL_LIBRARY_DIR), 3);
    let remoteInstallers = [];
    let remoteError = null;

    try {
      sftp = await createSftpClient();
      remoteInstallers = await collectInstallers(sftp, REMOTE_GAMES_DIR, 3);
    } catch (err) {
      remoteError = err.message;
      log("warn", "Remote games listing failed", {
        remoteDir: REMOTE_GAMES_DIR,
        error: err.message
      });
    } finally {
      if (sftp) await sftp.end().catch(() => {});
    }

    const installers = localInstallers.concat(remoteInstallers);
    const grouped = new Map();

    for (const item of installers) {
      const key = `${item.name}::${item.sourceType}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(item);
    }

    const games = Array.from(grouped.entries())
      .map(([groupKey, files]) => {
        files.sort((a, b) => b.size - a.size);
        const [name, sourceType] = groupKey.split("::");
        return {
          id: crypto.createHash("md5").update(`${sourceType}:${files[0].sourcePath}`).digest("hex"),
          name,
          sourceType,
          installers: files
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    return {
      remoteDir: REMOTE_GAMES_DIR,
      localDir: path.resolve(LOCAL_LIBRARY_DIR),
      remoteStatus: remoteError ? "unavailable" : "ok",
      remoteError,
      count: games.length,
      games
    };
  }

  function toSafeFolderName(name) {
    return name.replace(/[^a-zA-Z0-9._ -]/g, "").trim().slice(0, 120) || "game";
  }

  async function copyDirectoryContents(sourceDir, destinationDir) {
    const entries = await fs.readdir(sourceDir, { withFileTypes: true });
    for (const entry of entries) {
      const src = path.join(sourceDir, entry.name);
      const dest = path.join(destinationDir, entry.name);
      if (entry.isDirectory()) {
        await fs.cp(src, dest, { recursive: true });
      } else if (entry.isFile()) {
        await fs.copyFile(src, dest);
      }
    }
  }

  function resolveInstallerPathCandidates(installDir, installerFileName, packageDirName) {
    const direct = path.join(installDir, installerFileName);
    if (existsSync(direct)) return direct;

    if (packageDirName) {
      const nested = path.join(installDir, packageDirName, installerFileName);
      if (existsSync(nested)) return nested;
    }

    return direct;
  }

  return {
    listGames,
    createSftpClient,
    toSafeFolderName,
    copyDirectoryContents,
    resolveInstallerPathCandidates
  };
}

module.exports = {
  createDiscoveryService
};
