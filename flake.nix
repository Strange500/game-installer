{
  description = "Game installer web app (Nix dev shell + runner)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    let
      nixosModule = import ./nixos-module.nix { inherit self; };
    in
      (flake-utils.lib.eachDefaultSystem (system:
        let
          pkgs = import nixpkgs { inherit system; };
          gameInstallerPackage = pkgs.buildNpmPackage {
            pname = "game-installer-web";
            version = "1.0.0";
            src = self;
            npmDepsHash = "sha256-kJWUZ2XNxGIOo6X/kzDcT8+r5gNOO1N+ak+SAknXudE=";
            dontNpmBuild = true;

            installPhase = ''
              runHook preInstall
              mkdir -p "$out"
              cp -r server.js package.json package-lock.json web ui "$out"/
              cp -r node_modules "$out"/
              runHook postInstall
            '';
          };
        in {
          packages.default = gameInstallerPackage;
          packages.game-installer = gameInstallerPackage;

          devShells.default = pkgs.mkShell {
            packages = with pkgs; [
              nodejs_22
              python3Packages.websockify
              x11vnc
              xorg.xorgserver
              openbox
              novnc
              wineWowPackages.stable
            ];

            shellHook = ''
              export LOCAL_LIBRARY_DIR="$PWD"
              export NOVNC_WEB_PATH="${pkgs.novnc}/share/novnc"
              if [ ! -d "$NOVNC_WEB_PATH" ]; then
                export NOVNC_WEB_PATH="${pkgs.novnc}/share/webapps/novnc"
              fi
              export PATH="$PWD/node_modules/.bin:$PATH"
              echo "Dev shell ready. Run: npm install && npm run dev"
            '';
          };

          apps.default = {
            type = "app";
            program = toString (pkgs.writeShellScript "run-game-installer" ''
              set -euo pipefail
              export LOCAL_LIBRARY_DIR="$PWD"
              export LOCAL_INSTALL_BASE="$PWD/installed-games"
              export SESSION_RUNTIME_BASE="${XDG_RUNTIME_DIR:-/tmp}/game-installer-sessions"
              export NOVNC_WEB_PATH="${pkgs.novnc}/share/novnc"
              if [ ! -d "$NOVNC_WEB_PATH" ]; then
                export NOVNC_WEB_PATH="${pkgs.novnc}/share/webapps/novnc"
              fi
              export PATH="${pkgs.python3Packages.websockify}/bin:${pkgs.x11vnc}/bin:${pkgs.xorg.xorgserver}/bin:${pkgs.openbox}/bin:${pkgs.wineWowPackages.stable}/bin:$PATH"
              mkdir -p "$LOCAL_INSTALL_BASE" "$SESSION_RUNTIME_BASE"
              exec ${pkgs.nodejs_22}/bin/node ${gameInstallerPackage}/server.js
            '');
          };
        }))
      // {
        nixosModules.default = nixosModule;
        nixosModules.game-installer = nixosModule;
      };
}
