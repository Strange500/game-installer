function createLogger(levelName = "info") {
  const levels = { debug: 10, info: 20, warn: 30, error: 40 };

  return function log(level, message, meta = {}) {
    if ((levels[level] || 20) < (levels[levelName] || 20)) return;
    const ts = new Date().toISOString();
    const hasMeta = Object.keys(meta).length > 0;
    const line = hasMeta ? `${ts} [${level}] ${message} ${JSON.stringify(meta)}` : `${ts} [${level}] ${message}`;
    console.log(line);
  };
}

module.exports = {
  createLogger
};
