{ self }:
{ config, lib, pkgs, ... }:
let
  cfg = config.services.game-installer;

  packageDefault = self.packages.${pkgs.system}.default;

  runtimeTools = [
    pkgs.bash
    pkgs.python3Packages.websockify
    pkgs.x11vnc
    pkgs.xorg.xorgserver
    pkgs.openbox
    pkgs.wineWowPackages.stable
  ];
in
{
  options.services.game-installer = {
    enable = lib.mkEnableOption "Game Installer web service";

    package = lib.mkOption {
      type = lib.types.package;
      default = packageDefault;
      defaultText = lib.literalExpression "self.packages.${pkgs.system}.default";
      description = "Packaged game-installer application.";
    };

    nodejsPackage = lib.mkOption {
      type = lib.types.package;
      default = pkgs.nodejs_22;
      defaultText = lib.literalExpression "pkgs.nodejs_22";
      description = "Node.js runtime used to start server.js.";
    };

    user = lib.mkOption {
      type = lib.types.str;
      default = "game-installer";
      description = "User account that runs the service.";
    };

    group = lib.mkOption {
      type = lib.types.str;
      default = "game-installer";
      description = "Group account that runs the service.";
    };

    host = lib.mkOption {
      type = lib.types.str;
      default = "0.0.0.0";
      description = "Bind address (SERVER_HOST).";
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 3000;
      description = "Web server port (PORT).";
    };

    openFirewall = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Open the configured port in NixOS firewall.";
    };

    dataDir = lib.mkOption {
      type = lib.types.str;
      default = "/var/lib/game-installer";
      description = "Persistent application data directory.";
    };

    runtimeDir = lib.mkOption {
      type = lib.types.str;
      default = "/var/lib/game-installer/runtime";
      description = "Directory for isolated desktop runtime sessions.";
    };

    envFile = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "/run/secrets/game-installer.env";
      description = "Optional environment file loaded by systemd.";
    };

    environment = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      description = "Additional environment variables passed to the service.";
    };
  };

  config = lib.mkIf cfg.enable {
    users.groups = lib.mkIf (cfg.group == "game-installer") {
      game-installer = { };
    };

    users.users = lib.mkIf (cfg.user == "game-installer") {
      game-installer = {
        isSystemUser = true;
        group = cfg.group;
        home = cfg.dataDir;
        createHome = true;
      };
    };

    systemd.tmpfiles.rules = [
      "d ${cfg.dataDir} 0750 ${cfg.user} ${cfg.group} -"
      "d ${cfg.dataDir}/installed-games 0750 ${cfg.user} ${cfg.group} -"
      "d ${cfg.runtimeDir} 0750 ${cfg.user} ${cfg.group} -"
    ];

    networking.firewall.allowedTCPPorts = lib.mkIf cfg.openFirewall [ cfg.port ];

    systemd.services.game-installer = {
      description = "Game Installer web service";
      wantedBy = [ "multi-user.target" ];
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];

      environment = {
        NODE_ENV = "production";
        PORT = toString cfg.port;
        SERVER_HOST = cfg.host;
        LOCAL_LIBRARY_DIR = cfg.dataDir;
        LOCAL_INSTALL_BASE = "${cfg.dataDir}/installed-games";
        SESSION_RUNTIME_BASE = cfg.runtimeDir;
        NOVNC_WEB_PATH = "${pkgs.novnc}/share/novnc";
      } // cfg.environment;

      path = runtimeTools;

      serviceConfig = {
        Type = "simple";
        User = cfg.user;
        Group = cfg.group;
        UMask = "0027";
        WorkingDirectory = cfg.package;
        ExecStart = "${cfg.nodejsPackage}/bin/node ${cfg.package}/server.js";
        Restart = "on-failure";
        RestartSec = 2;

        NoNewPrivileges = true;
        PrivateTmp = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        ReadWritePaths = [ cfg.dataDir cfg.runtimeDir ];
      } // lib.optionalAttrs (cfg.envFile != null) {
        EnvironmentFile = cfg.envFile;
      };
    };
  };
}
