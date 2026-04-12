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

  async function searchWikipediaTitle(query) {
    const searchUrl = `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(query + " video game")}&limit=1&namespace=0&format=json`;
    const payload = await fetchJson(searchUrl);
    const firstTitle = Array.isArray(payload?.[1]) ? payload[1][0] : null;
    return firstTitle || null;
  }

  async function fetchWikipediaSummary(title) {
    const summaryUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
    const summary = await fetchJson(summaryUrl);

    return {
      title: summary.title || title,
      description: summary.extract || null,
      imageUrl: summary.thumbnail?.source || null,
      sourceUrl: summary.content_urls?.desktop?.page || null,
      provider: "wikipedia"
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
      const title = await searchWikipediaTitle(normalizedName);
      if (!title) {
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

      const value = await fetchWikipediaSummary(title);
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
