function createGameMetadataService(log) {
  const cache = new Map();
  const TTL_MS = 1000 * 60 * 60 * 24;

  function normalizeSearchName(rawName) {
    return String(rawName || "")
      .replace(/\[[^\]]+\]/g, "")
      .replace(/\([^\)]*\)/g, "")
      .replace(/\b(fitgirl|repack|portable|setup|installer|multi\d+|v\d+(?:\.\d+)*)\b/gi, "")
      .replace(/[_.-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function normalizeForMatch(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "")
      .trim();
  }

  function stripHtml(value) {
    return String(value || "")
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  async function fetchJson(url) {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "game-installer-web/1.0 (+local metadata fetch)",
        Accept: "application/json"
      }
    });
    if (!res.ok) throw new Error(`Metadata request failed: ${res.status}`);
    return res.json();
  }

  function selectBestSteamMatch(query, apps) {
    const normalizedQuery = normalizeForMatch(query);
    let best = null;
    let bestScore = -1;

    for (const app of apps || []) {
      const appName = String(app?.name || "");
      const normalizedAppName = normalizeForMatch(appName);
      if (!normalizedAppName) continue;

      let score = 0;
      if (normalizedAppName === normalizedQuery) score = 100;
      else if (normalizedAppName.startsWith(normalizedQuery)) score = 80;
      else if (normalizedQuery.startsWith(normalizedAppName)) score = 70;
      else if (normalizedAppName.includes(normalizedQuery)) score = 60;
      else if (normalizedQuery.includes(normalizedAppName)) score = 50;

      if (score > bestScore) {
        best = app;
        bestScore = score;
      }
    }

    return bestScore >= 50 ? best : (apps?.[0] || null);
  }

  async function searchSteamApp(query) {
    const searchUrl = `https://steamcommunity.com/actions/SearchApps/${encodeURIComponent(query)}?format=json`;
    const apps = await fetchJson(searchUrl);
    if (!Array.isArray(apps) || apps.length === 0) return null;
    return selectBestSteamMatch(query, apps);
  }

  async function fetchSteamDetails(appId) {
    const detailsUrl = `https://store.steampowered.com/api/appdetails?appids=${encodeURIComponent(String(appId))}&l=english&cc=us`;
    const payload = await fetchJson(detailsUrl);
    const entry = payload?.[String(appId)];
    if (!entry?.success || !entry?.data) return null;
    const data = entry.data;
    const description = (data.short_description || stripHtml(data.detailed_description || "")).slice(0, 600) || null;
    const sourceUrl = `https://store.steampowered.com/app/${encodeURIComponent(String(appId))}`;

    return {
      title: data.name || null,
      description,
      imageUrl: data.header_image || null,
      sourceUrl,
      provider: "steam"
    };
  }

  async function getMetadata(gameName) {
    const normalizedName = normalizeSearchName(gameName);
    if (!normalizedName) {
      return {
        title: gameName,
        description: null,
        imageUrl: null,
        sourceUrl: null,
        provider: "none"
      };
    }

    const cacheKey = normalizedName.toLowerCase();
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.ts < TTL_MS) {
      return cached.value;
    }

    try {
      const app = await searchSteamApp(normalizedName);
      if (!app?.appid) {
        const fallback = {
          title: normalizedName,
          description: null,
          imageUrl: null,
          sourceUrl: null,
          provider: "none"
        };
        cache.set(cacheKey, { ts: Date.now(), value: fallback });
        return fallback;
      }

      const steamDetails = await fetchSteamDetails(app.appid);
      const value = steamDetails || {
        title: app.name || normalizedName,
        description: null,
        imageUrl: app.logo || app.icon || null,
        sourceUrl: `https://store.steampowered.com/app/${encodeURIComponent(String(app.appid))}`,
        provider: "steam"
      };

      cache.set(cacheKey, { ts: Date.now(), value });
      return value;
    } catch (err) {
      log("warn", "Game metadata lookup failed", { gameName, error: err.message });
      return {
        title: normalizedName,
        description: null,
        imageUrl: null,
        sourceUrl: null,
        provider: "none"
      };
    }
  }

  return {
    getMetadata
  };
}

module.exports = {
  createGameMetadataService
};
