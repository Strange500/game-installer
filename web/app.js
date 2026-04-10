const refreshBtn = document.getElementById("refreshBtn");
const statusPill = document.getElementById("statusPill");
const gamesGrid = document.getElementById("gamesGrid");
const gameCount = document.getElementById("gameCount");
const sessionBox = document.getElementById("sessionBox");
const gameCardTemplate = document.getElementById("gameCardTemplate");

let currentSessionId = null;
let pollTimer = null;

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

async function fetchGames() {
  setStatus("Loading library...");
  refreshBtn.disabled = true;
  gamesGrid.innerHTML = "";

  try {
    const res = await fetch("/api/games");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to load games");

    gameCount.textContent = `${data.count} game groups (local + remote)`;

    if (!data.games.length) {
      gamesGrid.innerHTML = "<p class='muted'>No installers found in remote directory.</p>";
      setStatus("No games found");
      return;
    }

    for (const game of data.games) {
      const node = gameCardTemplate.content.cloneNode(true);
      const title = node.querySelector(".game-title");
      const meta = node.querySelector(".game-meta");
      const select = node.querySelector(".installer-select");
      const installBtn = node.querySelector(".install-btn");

      title.textContent = game.name;
      meta.textContent = `${game.installers.length} installer option(s) • source: ${game.sourceType}`;

      for (const installer of game.installers) {
        const opt = document.createElement("option");
        opt.value = JSON.stringify({
          sourcePath: installer.sourcePath,
          sourceType: installer.sourceType,
          packageDir: installer.packageDir
        });
        opt.textContent = `${installer.fileName} (${formatBytes(installer.size)})`;
        select.appendChild(opt);
      }

      installBtn.addEventListener("click", async () => {
        installBtn.disabled = true;
        installBtn.textContent = "Starting...";
        try {
          const selected = JSON.parse(select.value);
          const response = await fetch("/api/install", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              gameName: game.name,
              sourcePath: selected.sourcePath,
              sourceType: selected.sourceType,
              packageDir: selected.packageDir
            })
          });
          const payload = await response.json();
          if (!response.ok) throw new Error(payload.error || "Install start failed");

          currentSessionId = payload.sessionId;
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

      gamesGrid.appendChild(node);
    }

    setStatus("Library loaded");
  } catch (err) {
    gameCount.textContent = "Failed to load";
    gamesGrid.innerHTML = `<p class='muted'>${err.message}</p>`;
    setStatus("Error loading games");
  } finally {
    refreshBtn.disabled = false;
  }
}

function renderSession(session) {
  const canLaunch = session.state === "awaiting_user";
  const hasRemoteUi = Boolean(session.remoteUiUrl);
  const canShowLogs = Boolean(session.runtime && session.runtime.runtimeDir);
  sessionBox.innerHTML = `
    <p class="session-state">State: ${session.state}</p>
    <p class="session-progress">${session.progress || "No details"}</p>
    <p class="muted">Install directory: ${session.installDir || "n/a"}</p>
    <p class="muted">Installer file: ${session.localInstallerPath || "n/a"}</p>
    ${
      hasRemoteUi
        ? `<p class="muted">Isolated installer UI: <a href="${session.remoteUiUrl}" target="_blank" rel="noopener noreferrer">Open remote installer desktop</a></p>`
        : ""
    }
    ${
      canShowLogs
        ? '<button id="showLogsBtn" class="btn btn-secondary" style="margin-top: 8px;">Show Session Logs</button><pre id="sessionLogs" class="muted" style="white-space: pre-wrap; margin-top: 8px; max-height: 280px; overflow: auto;"></pre>'
        : ""
    }
    ${
      canLaunch
        ? '<button id="launchInstallerBtn" class="btn btn-accent">Launch Installer UI</button>'
        : ""
    }
  `;

  if (canLaunch) {
    const launchBtn = document.getElementById("launchInstallerBtn");
    launchBtn.addEventListener("click", async () => {
      launchBtn.disabled = true;
      launchBtn.textContent = "Launching...";
      try {
        const response = await fetch(`/api/install/${session.id}/launch`, { method: "POST" });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Failed to launch installer");
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
      }
    });
  }

  if (canShowLogs) {
    const logsBtn = document.getElementById("showLogsBtn");
    const logsPre = document.getElementById("sessionLogs");
    logsBtn.addEventListener("click", async () => {
      logsBtn.disabled = true;
      logsBtn.textContent = "Loading logs...";
      try {
        const resp = await fetch(`/api/install/${session.id}/logs`);
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || "Failed to fetch logs");
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
        logsBtn.disabled = false;
        logsBtn.textContent = "Show Session Logs";
      }
    });
  }
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    if (!currentSessionId) return;
    try {
      const res = await fetch(`/api/install/${currentSessionId}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Session poll failed");
      renderSession(data);
      if (["failed", "installer_started"].includes(data.state)) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    } catch {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }, 2500);
}

refreshBtn.addEventListener("click", fetchGames);
fetchGames();
