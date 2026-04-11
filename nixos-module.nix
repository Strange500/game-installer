{ self }:
{ config, lib, pkgs, ... }:
let
  cfg = config.services.game-installer;
  appDir = "${cfg.dataDir}/app";
  envFileArg =
    if cfg.envFile == null then
      ""
    else
      "--env-file ${lib.escapeShellArg cfg.envFile}";
in
{
  options.services.game-installer = {
    enable = lib.mkEnableOption "Game Installer web service";

    sourceDir = lib.mkOption {
      type = lib.types.path;
      default = self;
      defaultText = lib.literalExpression "self";
      description = "Source directory copied into the service data directory.";
    };

    nodejsPackage = lib.mkOption {
      type = lib.types.package;
      default = pkgs.nodejs_22;
      defaultText = lib.literalExpression "pkgs.nodejs_22";
      description = "Node.js package used to run the backend server.";
    };

    user = lib.mkOption {
      type = lib.types.str;
      default = "game-installer";
      description = "System user account running the service.";
    };

    group = lib.mkOption {
      type = lib.types.str;
      default = "game-installer";
      description = "System group running the service.";
    };

    dataDir = lib.mkOption {
      type = lib.types.path;
      default = "/var/lib/game-installer";
      description = "Directory used for persistent app data.";
    };

    runtimeDir = lib.mkOption {
      type = lib.types.path;
      default = "/var/lib/game-installer/runtime";
      description = "Directory used for isolated session runtime artifacts and logs.";
    };

    host = lib.mkOption {
      type = lib.types.str;
      default = "0.0.0.0";
      description = "Bind address for the web server (SERVER_HOST).";
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 3000;
      description = "TCP port for the web server (PORT).";
    };

    openFirewall = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Whether to open the configured service port in the firewall.";
    };

    envFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      example = "/run/secrets/game-installer.env";
      description = "Optional env file passed to Node using --env-file.";
    };

    environment = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      example = {
        SSH_HOST = "192.168.0.28";
        SSH_PORT = "22";
        SSH_USERNAME = "games";
        PUBLIC_HOST = "192.168.0.138";
        PUBLIC_PROTOCOL = "http";
      };
      description = "Extra environment variables for the service.";
    };
  };

  config = lib.mkIf cfg.enable {
    users.users = lib.mkIf (cfg.user == "game-installer") {
      game-installer = {
        isSystemUser = true;
        group = cfg.group;
        home = cfg.dataDir;
        createHome = true;
      };
    };

    users.groups = lib.mkIf (cfg.group == "game-installer") {
      game-installer = { };
    };

    systemd.tmpfiles.rules = [
      "d ${cfg.dataDir} 0750 ${cfg.user} ${cfg.group} -"
      "d ${cfg.runtimeDir} 0750 ${cfg.user} ${cfg.group} -"
      "d ${appDir} 0750 ${cfg.user} ${cfg.group} -"
    ];

    networking.firewall.allowedTCPPorts = lib.mkIf cfg.openFirewall [ cfg.port ];

    systemd.services.game-installer = {
      description = "Game Installer web service";
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];
      wantedBy = [ "multi-user.target" ];

      environment = {
        NODE_ENV = "production";
        PORT = toString cfg.port;
        SERVER_HOST = cfg.host;
        LOCAL_INSTALL_BASE = "${cfg.dataDir}/installed-games";
        SESSION_RUNTIME_BASE = cfg.runtimeDir;
        NOVNC_WEB_PATH = "${pkgs.novnc}/share/novnc";
        LOCAL_LIBRARY_DIR = cfg.dataDir;
      } // cfg.environment;

      serviceConfig = {
        Type = "simple";
        User = cfg.user;
        Group = cfg.group;
        WorkingDirectory = appDir;
        ExecStartPre = "${pkgs.bash}/bin/bash -eu -c '${pkgs.rsync}/bin/rsync -a --delete --exclude .git --exclude node_modules --exclude ui/node_modules --exclude .env ${lib.escapeShellArg (toString cfg.sourceDir)}/ ${lib.escapeShellArg appDir}/ && cd ${lib.escapeShellArg appDir} && ${cfg.nodejsPackage}/bin/npm ci --omit=dev'";
        ExecStart = "${cfg.nodejsPackage}/bin/node ${envFileArg} ${appDir}/server.js";
        Restart = "on-failure";
        RestartSec = 2;

        NoNewPrivileges = true;
        PrivateTmp = true;
        ProtectSystem = "strict";
        ProtectHome = false;
        ReadWritePaths = [ cfg.dataDir cfg.runtimeDir appDir ];
      };

      path = [
        pkgs.bash
        pkgs.python3Packages.websockify
        pkgs.x11vnc
        pkgs.xorg.xorgserver
        pkgs.openbox
        pkgs.wineWowPackages.stable
      ];
    };
  };
}
