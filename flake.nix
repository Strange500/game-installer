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
          uiPackage = pkgs.buildNpmPackage {
            pname = "game-installer-ui";
            version = "1.0.0";
            src = self + "/ui";
            npmDepsHash = "sha256-VeT68X0NCg4xKg86f+dMtS8LrNvypJsGDP4Qi6+FzXs=";
            CI = "1";
            NG_CLI_ANALYTICS = "false";

            npmBuildScript = "build";

            installPhase = ''
              runHook preInstall
              mkdir -p "$out/dist"
              cp -r dist/ui "$out/dist/"
              runHook postInstall
            '';
          };

          gameInstallerPackage = pkgs.buildNpmPackage {
            pname = "game-installer-web";
            version = "1.0.0";
            src = self;
            npmDepsHash = "sha256-kJWUZ2XNxGIOo6X/kzDcT8+r5gNOO1N+ak+SAknXudE=";
            dontNpmBuild = true;

            installPhase = ''
              runHook preInstall
              mkdir -p "$out"
              cp -r server.js package.json package-lock.json backend web ui "$out"/
              rm -rf "$out/ui/dist"
              mkdir -p "$out/ui/dist"
              cp -r ${uiPackage}/dist/ui "$out/ui/dist/"
              cp -r node_modules "$out"/
              runHook postInstall
            '';
          };

          protonFhs = pkgs.buildFHSEnv {
            name = "proton-fhs";
            targetPkgs = pkgs: with pkgs; [
              bash
              coreutils
              freetype
              fontconfig
              SDL2
              alsa-lib
              libpulseaudio
              libxkbcommon
              libdrm
              mesa
              libglvnd
              vulkan-loader
              zlib
              openssl
              libX11
              libXext
              libXrender
              libXrandr
              libXcursor
              libXi
              libXfixes
              libXdamage
              libXcomposite
              libXinerama
              libxcb
              libXScrnSaver
            ];
            runScript = pkgs.writeShellScript "proton-fhs-run" ''
              exec "$@"
            '';
          };

          nixLdLibs = with pkgs; [
            glibc
            stdenv.cc.cc
            freetype
            fontconfig
            SDL2
            alsa-lib
            libpulseaudio
            libxkbcommon
            libdrm
            mesa
            libglvnd
            vulkan-loader
            zlib
            openssl
            libX11
            libXext
            libXrender
            libXrandr
            libXcursor
            libXi
            libXfixes
            libXdamage
            libXcomposite
            libXinerama
            libxcb
            libXScrnSaver
          ];

          nixLdLibs32 = with pkgs.pkgsi686Linux; [
            glibc
            stdenv.cc.cc
            freetype
            fontconfig
            SDL2
            alsa-lib
            libpulseaudio
            libxkbcommon
            libdrm
            mesa
            libglvnd
            vulkan-loader
            zlib
            openssl
            libX11
            libXext
            libXrender
            libXrandr
            libXcursor
            libXi
            libXfixes
            libXdamage
            libXcomposite
            libXinerama
            libxcb
            libXScrnSaver
          ];
        in {
          packages.default = gameInstallerPackage;
          packages.game-installer = gameInstallerPackage;
          packages.proton-fhs = protonFhs;

          devShells.default = pkgs.mkShell {
            packages = with pkgs; [
              nodejs_22
              python3Packages.websockify
              x11vnc
              xorg-server
              openbox
              novnc
              proton-ge-bin
              protonFhs
            ];

            shellHook = ''
              export LOCAL_LIBRARY_DIR="$PWD"
              export NOVNC_WEB_PATH="${pkgs.novnc}/share/novnc"
              if [ ! -d "$NOVNC_WEB_PATH" ]; then
                export NOVNC_WEB_PATH="${pkgs.novnc}/share/webapps/novnc"
              fi
              export PROTON_PATH="${pkgs.proton-ge-bin.steamcompattool}/proton"
              export PROTON_WRAPPER_CMD="${protonFhs}/bin/proton-fhs"
              export NIX_LD="${pkgs.stdenv.cc.bintools.dynamicLinker}"
              export NIX_LD_32="${pkgs.pkgsi686Linux.stdenv.cc.bintools.dynamicLinker}"
              export NIX_LD_LIBRARY_PATH="${pkgs.lib.makeLibraryPath nixLdLibs}"
              export NIX_LD_LIBRARY_PATH_32="${pkgs.lib.makeLibraryPath nixLdLibs32}"
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
              export SESSION_RUNTIME_BASE="''${XDG_RUNTIME_DIR:-/tmp}/game-installer-sessions"
              export NOVNC_WEB_PATH="${pkgs.novnc}/share/novnc"
              if [ ! -d "$NOVNC_WEB_PATH" ]; then
                export NOVNC_WEB_PATH="${pkgs.novnc}/share/webapps/novnc"
              fi
              export PROTON_PATH="${pkgs.proton-ge-bin.steamcompattool}/proton"
              export PROTON_WRAPPER_CMD="${protonFhs}/bin/proton-fhs"
              export NIX_LD="${pkgs.stdenv.cc.bintools.dynamicLinker}"
              export NIX_LD_32="${pkgs.pkgsi686Linux.stdenv.cc.bintools.dynamicLinker}"
              export NIX_LD_LIBRARY_PATH="${pkgs.lib.makeLibraryPath nixLdLibs}"
              export NIX_LD_LIBRARY_PATH_32="${pkgs.lib.makeLibraryPath nixLdLibs32}"
              export PATH="${pkgs.python3Packages.websockify}/bin:${pkgs.x11vnc}/bin:${pkgs.xorg-server}/bin:${pkgs.openbox}/bin:${pkgs.proton-ge-bin.steamcompattool}:$PATH"
              mkdir -p "$LOCAL_INSTALL_BASE" "$SESSION_RUNTIME_BASE"

              if [ -f "$PWD/server.js" ]; then
                if [ ! -f "$PWD/ui/dist/ui/browser/index.html" ]; then
                  echo "Angular build not found. Bootstrapping UI (npm install + npm run ui:build)..."
                  ${pkgs.nodejs_22}/bin/npm install
                  ${pkgs.nodejs_22}/bin/npm run ui:build
                fi
                exec ${pkgs.nodejs_22}/bin/node "$PWD/server.js"
              fi

              exec ${pkgs.nodejs_22}/bin/node ${gameInstallerPackage}/server.js
            '');
          };
        }))
      // {
        nixosModules.default = nixosModule;
        nixosModules.game-installer = nixosModule;
      };
}
