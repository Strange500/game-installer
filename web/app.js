const refreshBtn = document.getElementById("refreshBtn");
const statusPill = document.getElementById("statusPill");
const gamesGrid = document.getElementById("gamesGrid");
const gameCount = document.getElementById("gameCount");
const sessionBox = document.getElementById("sessionBox");
const gameCardTemplate = document.getElementById("gameCardTemplate");

const SESSION_DONE_STATES = new Set(["failed", "installer_started"]);

const state = {
  currentSessionId: null,
  pollTimer: null
};

function setStatus(text) {
  statusPill.textContent = text;
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return "Unknown size";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  return `${value.toFixed(value < 10 && idx > 0 ? 1 : 0)} ${units[idx]}`;
}

async function apiRequest(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `Request failed: ${response.status}`);
  }
  return payload;
}

function clearNode(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function renderMutedMessage(node, message) {
  clearNode(node);
  const p = document.createElement("p");
  p.className = "muted";
  p.textContent = message;
  node.appendChild(p);
}

function createLabeledParagraph(className, label, value) {
  const p = document.createElement("p");
  p.className = className;
  p.textContent = `${label}${value || "n/a"}`;
  return p;
}

function createLogsSection(sessionId) {
  const container = document.createElement("div");

  const button = document.createElement("button");
  button.id = "showLogsBtn";
  button.className = "btn btn-secondary";
  button.style.marginTop = "8px";
  button.textContent = "Show Session Logs";

  const logsPre = document.createElement("pre");
  logsPre.id = "sessionLogs";
  logsPre.className = "muted";
  logsPre.style.whiteSpace = "pre-wrap";
  logsPre.style.marginTop = "8px";
  logsPre.style.maxHeight = "280px";
  logsPre.style.overflow = "auto";

  button.addEventListener("click", async () => {
    button.disabled = true;
    button.textContent = "Loading logs...";
    try {
      const data = await apiRequest(`/api/install/${sessionId}/logs`);
      logsPre.textContent = [
        `runtimeDir: ${data.runtimeDir}`,
        "\n=== x11vnc.err ===\n",
        data.tails.x11vncErr || "(empty)",
        "\n=== websockify.err ===\n",
        data.tails.websockifyErr || "(empty)",
        "\n=== installer.err ===\n",
        data.tails.installerErr || "(empty)",
        "\n=== x11vnc.out ===\n",
        data.tails.x11vncOut || "(empty)",
        "\n=== websockify.out ===\n",
        data.tails.websockifyOut || "(empty)"
      ].join("");
    } catch (err) {
      logsPre.textContent = err.message;
    } finally {
      button.disabled = false;
      button.textContent = "Show Session Logs";
    }
  });

  container.appendChild(button);
  container.appendChild(logsPre);
  return container;
}

function createRemoteUiLink(url) {
  const p = document.createElement("p");
  p.className = "muted";
  p.textContent = "Isolated installer UI: ";

  const a = document.createElement("a");
  a.href = url;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.textContent = "Open remote installer desktop";

  p.appendChild(a);
  return p;
}

function renderSession(session) {
  clearNode(sessionBox);

  const canLaunch = session.state === "awaiting_user";
  const hasRemoteUi = Boolean(session.remoteUiUrl);
  const canShowLogs = Boolean(session.runtime && session.runtime.runtimeDir);

  sessionBox.appendChild(createLabeledParagraph("session-state", "State: ", session.state));
  sessionBox.appendChild(createLabeledParagraph("session-progress", "", session.progress || "No details"));
  sessionBox.appendChild(createLabeledParagraph("muted", "Install directory: ", session.installDir));
  sessionBox.appendChild(createLabeledParagraph("muted", "Installer file: ", session.localInstallerPath));

  if (hasRemoteUi) {
    sessionBox.appendChild(createRemoteUiLink(session.remoteUiUrl));
  }

  if (canLaunch) {
    const launchBtn = document.createElement("button");
    launchBtn.id = "launchInstallerBtn";
    launchBtn.className = "btn btn-accent";
    launchBtn.textContent = "Launch Installer UI";

    launchBtn.addEventListener("click", async () => {
      launchBtn.disabled = true;
      launchBtn.textContent = "Launching...";
      try {
        const payload = await apiRequest(`/api/install/${session.id}/launch`, { method: "POST" });
        renderSession(payload.session);
        if (payload.remoteUiUrl) {
          window.open(payload.remoteUiUrl, "_blank", "noopener,noreferrer");
        }
        setStatus("Installer launched");
      } catch (err) {
        alert(err.message);
        setStatus("Launch failed");
      } finally {
        launchBtn.disabled = false;
        launchBtn.textContent = "Launch Installer UI";
      }
    });

    sessionBox.appendChild(launchBtn);
  }

  if (canShowLogs) {
    sessionBox.appendChild(createLogsSection(session.id));
  }
}

function buildGameCard(game) {
  const node = gameCardTemplate.content.cloneNode(true);
  const title = node.querySelector(".game-title");
  const meta = node.querySelector(".game-meta");
  const select = node.querySelector(".installer-select");
  const installBtn = node.querySelector(".install-btn");

  title.textContent = game.name;
  meta.textContent = `${game.installers.length} installer option(s) • source: ${game.sourceType}`;

  game.installers.forEach((installer, index) => {
    const opt = document.createElement("option");
    opt.value = String(index);
    opt.textContent = `${installer.fileName} (${formatBytes(installer.size)})`;
    select.appendChild(opt);
  });

  installBtn.addEventListener("click", async () => {
    installBtn.disabled = true;
    installBtn.textContent = "Starting...";
    try {
      const selectedInstaller = game.installers[Number(select.value) || 0];
      const payload = await apiRequest("/api/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          gameName: game.name,
          sourcePath: selectedInstaller.sourcePath,
          sourceType: selectedInstaller.sourceType,
          packageDir: selectedInstaller.packageDir
        })
      });

      state.currentSessionId = payload.sessionId;
      renderSession({
        id: payload.sessionId,
        state: "downloading",
        progress: "Downloading installer from remote server...",
        installDir: payload.installDir,
        localInstallerPath: payload.localInstallerPath
      });
      startPolling();
      setStatus("Download started");
    } catch (err) {
      alert(err.message);
      setStatus("Install failed to start");
    } finally {
      installBtn.disabled = false;
      installBtn.textContent = "Download Installer";
    }
  });

  return node;
}

async function fetchGames() {
  setStatus("Loading library...");
  refreshBtn.disabled = true;
  clearNode(gamesGrid);

  try {
    const data = await apiRequest("/api/games");
    gameCount.textContent = `${data.count} game groups (local + remote)`;

    if (!data.games.length) {
      renderMutedMessage(gamesGrid, "No installers found in remote directory.");
      setStatus("No games found");
      return;
    }

    data.games.forEach((game) => {
      gamesGrid.appendChild(buildGameCard(game));
    });

    setStatus("Library loaded");
  } catch (err) {
    gameCount.textContent = "Failed to load";
    renderMutedMessage(gamesGrid, err.message);
    setStatus("Error loading games");
  } finally {
    refreshBtn.disabled = false;
  }
}

function stopPolling() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

function startPolling() {
  stopPolling();
  state.pollTimer = setInterval(async () => {
    if (!state.currentSessionId) return;
    try {
      const session = await apiRequest(`/api/install/${state.currentSessionId}`);
      renderSession(session);
      if (SESSION_DONE_STATES.has(session.state)) {
        stopPolling();
      }
    } catch {
      stopPolling();
    }
  }, 2500);
}

refreshBtn.addEventListener("click", fetchGames);
fetchGames();
