# Game Installer Web App

This project provides a local web interface to:

- connect to `192.168.0.28` over SSH,
- discover installer files inside `/mnt/data/media/torrents/game/windows`,
- display available games in a clean UI,
- download a selected installer locally,
- and let the user launch and complete installer UI interaction on the host machine.
- and launch installers in an isolated virtual desktop session accessible from browser.

## 1) Setup

```bash
npm install
cp .env.example .env
```

Update `.env` with real SSH credentials.

To scan multiple remote folders, set `REMOTE_GAMES_DIRS` (comma-separated or JSON array). When set,
it overrides `REMOTE_GAMES_DIR`.

Important: place `.env` in this project root (`games/.env`) because the backend reads from current directory.

## 2) Run

```bash
npm run dev
```

Open `http://localhost:3000`.

For LAN access, set in `.env`:

```bash
SERVER_HOST=0.0.0.0
PUBLIC_HOST=<your-server-lan-ip>
PUBLIC_PROTOCOL=http
```

This makes the web app and generated noVNC links reachable from other devices on your network.

To use the Angular frontend, build it first:

```bash
npm run ui:install
npm run ui:build
```

Then run backend (`npm run dev`) and it will serve `ui/dist/ui/browser`.

Legacy `web/` fallback UI is no longer served by the backend.

## NixOS quick start (recommended)

From this project directory:

```bash
nix develop
npm install
cp .env.example .env
npm run dev
```

Or one-command run (auto-installs npm deps if needed):

```bash
nix run
```

The flake provides all runtime tools for isolated installer sessions and sets `NOVNC_WEB_PATH` automatically.

## NixOS module (system service)

This flake now exports a NixOS module at:

- `nixosModules.default`
- `nixosModules.game-installer`

Example `flake.nix` (host config):

```nix
{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    game-installer.url = "github:<you>/<repo>";
  };

  outputs = { self, nixpkgs, game-installer, ... }: {
    nixosConfigurations.myhost = nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      modules = [
        game-installer.nixosModules.default
        ({ ... }: {
          services.game-installer = {
            enable = true;
            openFirewall = true;
            host = "0.0.0.0";
            port = 3000;

            # Keep secrets in an external file with chmod 600
            envFile = "/run/secrets/game-installer.env";

            environment = {
              SSH_HOST = "192.168.0.28";
              SSH_PORT = "22";
              SSH_USERNAME = "games";
              PUBLIC_HOST = "192.168.0.138";
              PUBLIC_PROTOCOL = "http";
              REMOTE_GAMES_DIR = "/mnt/data/media/torrents/game/windows";
              LOCAL_INSTALL_BASE = "/var/lib/game-installer/installed-games";
              LOG_LEVEL = "info";
            };
          };
        })
      ];
    };
  };
}
```

You can also set `services.game-installer.sshHost`, `services.game-installer.remoteGamesDir`,
`services.game-installer.remoteGamesDirs`, and `services.game-installer.localInstallBase` to have
the module inject `SSH_HOST`, `REMOTE_GAMES_DIR(S)`, and `LOCAL_INSTALL_BASE` for you.

The module now runs an immutable packaged app (built with `buildNpmPackage`) and starts `server.js` directly from the Nix store, so startup does not run `npm ci` and avoids runtime permission issues.

Useful commands:

```bash
sudo systemctl status game-installer
sudo journalctl -u game-installer -f
curl -s http://127.0.0.1:3000/api/health
```

If you run outside `nix develop`, set in `.env`:

```bash
NOVNC_WEB_PATH=/run/current-system/sw/share/novnc
```

On some Nix setups, use:

```bash
NOVNC_WEB_PATH=/run/current-system/sw/share/webapps/novnc
```

Quick check:

```bash
ls /run/current-system/sw/share/novnc
```

## 3) How install flow works

1. UI calls `GET /api/games` to list installer files found remotely via SFTP.
2. User clicks **Download Installer** for a selected game installer.
3. Backend downloads installer to `LOCAL_INSTALL_BASE/<game-name>/`.
4. When ready, UI shows **Launch Installer UI**.
5. User clicks launch; backend starts isolated Xvfb + VNC + noVNC session.
6. User opens the provided noVNC URL and completes installer prompts in browser.

Download progress is exposed in session state and shown in the UI progress bar.

## API endpoints

- `GET /api/health`
- `GET /api/games`
- `POST /api/install` body: `{ "remotePath": "...", "gameName": "..." }`
- `GET /api/install/:sessionId`
- `GET /api/install/active`
- `GET /api/installed-games`
- `POST /api/install/:sessionId/launch`
- `GET /api/install/:sessionId/logs` (tails of xvfb/x11vnc/websockify/installer logs)

Tracked installs/downloads are persisted in `LOCAL_INSTALL_BASE/.installed-games.json`.

With `services.game-installer.openFirewall = true;`, the NixOS module opens:

- app port (`services.game-installer.port`, default `3000`)
- noVNC session range (`services.game-installer.isolatedBaseNoVncPort` through `+ isolatedSessionSlots - 1`, default `6081-6110`)

## Notes

- Installer runs on the same machine where Node.js server runs, but in an isolated desktop session.
- The browser connects to this isolated desktop through noVNC.

## Isolated session dependencies (Linux host)

Install these packages on the server host:

```bash
sudo apt-get update
sudo apt-get install -y xvfb x11vnc websockify novnc openbox
```

`openbox` may be replaced based on your environment.

### Proton requirements (Linux)

Windows installers now run via Proton (Steam Proton or Proton-GE). Recommended options:

- Install Steam and Proton (default path under `~/.local/share/Steam/steamapps/common/Proton*`).
- Or enable automatic Proton-GE download by setting `PROTON_AUTO_INSTALL=true`.

Optional env overrides (in `.env`):

```bash
PROTON_PATH=/home/user/.local/share/Steam/steamapps/common/Proton 8.0
PROTON_AUTO_INSTALL=false
PROTON_GEO_DOWNLOAD_URL=
STEAM_COMPAT_DATA_BASE=/tmp/game-installer-sessions
STEAM_COMPAT_CLIENT_INSTALL_PATH=/home/user/.local/share/Steam
```

On NixOS, you can skip manual package install by using `flake.nix` in this repo.

This repo now configures `nix-ld` automatically in the NixOS module and exports
`NIX_LD`, `NIX_LD_32`, and library paths in `nix run` so Proton can load its 32-bit
and 64-bit dependencies out of the box.

## Debugging noVNC connection issues

1. Set `LOG_LEVEL=debug` in `.env`.
2. Restart server.
3. Start installer session and click **Show Session Logs** in UI.
4. Or use API directly:

```bash
curl -s http://localhost:3000/api/install/<sessionId>/logs
```

This helps identify whether x11vnc, websockify, or proton/installer failed.

## Integration test (Proton)

Run the minimal integration test that exercises Proton with a stub Windows batch file:

```bash
npm run test:integration
```

The test creates a temporary compatdata prefix, runs a `cmd /c` script via Proton, and verifies that `pfx/` exists under the prefix.
