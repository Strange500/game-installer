{
  description = "Game installer web app (Nix dev shell + runner)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
      in {
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
            export NOVNC_WEB_PATH="${pkgs.novnc}/share/novnc"
            if [ ! -d "$NOVNC_WEB_PATH" ]; then
              export NOVNC_WEB_PATH="${pkgs.novnc}/share/webapps/novnc"
            fi
            export PATH="${pkgs.nodejs_22}/bin:${pkgs.python3Packages.websockify}/bin:${pkgs.x11vnc}/bin:${pkgs.xorg.xorgserver}/bin:${pkgs.openbox}/bin:${pkgs.wineWowPackages.stable}/bin:$PATH"
            cd "$PWD"
            if [ ! -d node_modules ]; then
              npm install
            fi
            npm run dev
          '');
        };
      });
}
