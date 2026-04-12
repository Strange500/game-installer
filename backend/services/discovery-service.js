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
  const GAMES_CACHE_TTL_MS = 30_000;
  const REMOTE_SCAN_DEPTH = Number(process.env.REMOTE_SCAN_DEPTH || 2);
  const REMOTE_LIST_CONCURRENCY = Number(process.env.REMOTE_LIST_CONCURRENCY || 8);
  let gamesCache = {
    ts: 0,
    value: null
  };

  async function mapWithConcurrency(items, concurrency, mapper) {
    if (!items.length) return [];
    const limit = Math.max(1, Math.floor(concurrency || 1));
    const results = new Array(items.length);
    let index = 0;

    async function worker() {
      while (index < items.length) {
        const current = index;
        index += 1;
        results[current] = await mapper(items[current], current);
      }
    }

    const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
    await Promise.all(workers);
    return results;
  }

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

  async function collectInstallers(sftp, remoteDir, depth = REMOTE_SCAN_DEPTH) {
    let output = [];
    let entries;
    try {
      entries = await sftp.list(remoteDir);
    } catch {
      return output;
    }

    const nestedDirs = [];

    for (const entry of entries) {
      const remotePath = path.posix.join(remoteDir, entry.name);
      if (entry.type === "d" && depth > 0) {
        nestedDirs.push(remotePath);
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

    if (nestedDirs.length > 0 && depth > 0) {
      const nestedResults = await mapWithConcurrency(nestedDirs, REMOTE_LIST_CONCURRENCY, async (dirPath) => {
        return collectInstallers(sftp, dirPath, depth - 1);
      });
      for (const nested of nestedResults) {
        output = output.concat(nested);
      }
    }

    return output;
  }

  async function listRemoteFilesRecursive(sftp, remoteDir, depth = 6) {
    let entries;
    try {
      entries = await sftp.list(remoteDir);
    } catch {
      return [];
    }

    const files = [];
    const nestedDirs = [];

    for (const entry of entries) {
      const remotePath = path.posix.join(remoteDir, entry.name);
      if (entry.type === "d") {
        if (depth > 0) nestedDirs.push(remotePath);
        continue;
      }

      files.push({
        path: remotePath,
        size: Number(entry.size || 0)
      });
    }

    if (nestedDirs.length > 0 && depth > 0) {
      const nestedResults = await mapWithConcurrency(nestedDirs, REMOTE_LIST_CONCURRENCY, async (dirPath) => {
        return listRemoteFilesRecursive(sftp, dirPath, depth - 1);
      });

      for (const nested of nestedResults) {
        files.push(...nested);
      }
    }

    return files;
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

  async function buildGamesListing(log) {
    const startedAt = Date.now();
    let sftp;
    const localStartedAt = Date.now();
    const localInstallers = await collectLocalInstallers(path.resolve(LOCAL_LIBRARY_DIR), 3);
    const localDurationMs = Date.now() - localStartedAt;
    let remoteInstallers = [];
    let remoteError = null;
    let remoteDurationMs = 0;

    try {
      const remoteStartedAt = Date.now();
      sftp = await createSftpClient();
      remoteInstallers = await collectInstallers(sftp, REMOTE_GAMES_DIR, REMOTE_SCAN_DEPTH);
      remoteDurationMs = Date.now() - remoteStartedAt;
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

    log("info", "Games discovery timing", {
      localInstallers: localInstallers.length,
      remoteInstallers: remoteInstallers.length,
      localDurationMs,
      remoteDurationMs,
      totalDurationMs: Date.now() - startedAt,
      remoteScanDepth: REMOTE_SCAN_DEPTH,
      remoteListConcurrency: REMOTE_LIST_CONCURRENCY
    });

    return {
      remoteDir: REMOTE_GAMES_DIR,
      localDir: path.resolve(LOCAL_LIBRARY_DIR),
      remoteStatus: remoteError ? "unavailable" : "ok",
      remoteError,
      count: games.length,
      games
    };
  }

  function paginateListing(listing, options = {}) {
    const rawOffset = Number(options.offset);
    const rawLimit = Number(options.limit);
    const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.floor(rawOffset)) : 0;
    const limit = Number.isFinite(rawLimit) ? Math.min(100, Math.max(1, Math.floor(rawLimit))) : 24;
    const total = listing.games.length;
    const pageGames = listing.games.slice(offset, offset + limit);
    const hasMore = offset + pageGames.length < total;

    return {
      ...listing,
      count: total,
      total,
      pageCount: pageGames.length,
      offset,
      limit,
      hasMore,
      games: pageGames
    };
  }

  async function listGames(log, options = {}) {
    const refresh = options.refresh === true;
    const isCacheValid = gamesCache.value && Date.now() - gamesCache.ts < GAMES_CACHE_TTL_MS;

    if (!isCacheValid || refresh) {
      gamesCache = {
        ts: Date.now(),
        value: await buildGamesListing(log)
      };
    }

    return paginateListing(gamesCache.value, options);
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
    listRemoteFilesRecursive,
    toSafeFolderName,
    copyDirectoryContents,
    resolveInstallerPathCandidates
  };
}

module.exports = {
  createDiscoveryService
};
