{ self }:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.codex-auto-reset;
  # The CLI accepts durations up to Node's maximum timer delay, in milliseconds.
  maxSeconds = 2147483;
  args = [
    "${cfg.package}/bin/codex-auto-reset"
    "daemon"
    "--json"
    "--poll-interval"
    "${toString cfg.pollInterval}s"
    "--redemption-lead-time"
    "${toString cfg.redemptionLeadTime}s"
  ]
  ++ lib.optionals (cfg.authFile != null) [
    "--auth-file"
    cfg.authFile
  ];
in
{
  options.services.codex-auto-reset = {
    enable = lib.mkEnableOption "the Codex automatic reset foreground daemon";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      defaultText = lib.literalExpression "self.packages.\${pkgs.stdenv.hostPlatform.system}.default";
      description = "Package providing the codex-auto-reset executable.";
    };

    authFile = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "/home/alice/.pi/agent/auth.json";
      description = ''
        Runtime path to Pi's existing auth.json file containing openai-codex OAuth credentials. This must be a
        string, not a Nix path: credentials must never be copied into the store.
        Null uses the CLI's normal authentication discovery. The file is only
        read by the daemon, with the permissions of the user running the service.
        Percent signs are literal; systemd specifiers such as %h are not expanded.
      '';
    };

    pollInterval = lib.mkOption {
      type = lib.types.ints.positive;
      default = 300;
      description = "Polling interval in seconds; at most half the redemption lead time.";
    };

    redemptionLeadTime = lib.mkOption {
      type = lib.types.ints.positive;
      default = 900;
      description = "Redemption lead time in seconds (at most 2147483 seconds).";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = pkgs.stdenv.hostPlatform.isLinux;
        message = "services.codex-auto-reset requires Linux (a systemd user service).";
      }
      {
        assertion = cfg.pollInterval <= cfg.redemptionLeadTime / 2;
        message = "services.codex-auto-reset.pollInterval must be at most half redemptionLeadTime.";
      }
      {
        assertion = cfg.pollInterval <= maxSeconds;
        message = "services.codex-auto-reset.pollInterval exceeds Node's maximum timer delay (2147483647 ms).";
      }
      {
        assertion = cfg.redemptionLeadTime <= maxSeconds;
        message = "services.codex-auto-reset.redemptionLeadTime exceeds the CLI duration limit (2147483647 ms).";
      }
    ];

    home.packages = [ cfg.package ];

    systemd.user.services.codex-auto-reset = {
      Unit = {
        Description = "Codex automatic reset daemon";
        # A user target provides ordering only, not a guarantee of connectivity.
        After = [ "network-online.target" ];
      };
      Service = {
        Type = "simple";
        # Shell quoting is not systemd quoting. Also prevent %/$ expansion in paths.
        ExecStart = lib.hm.strings.escapeSystemdExecArgs args;
        Restart = "on-failure";
        RestartSec = 30;
        NoNewPrivileges = true;
        UMask = "0077";
      };
      Install.WantedBy = [ "default.target" ];
    };
  };
}
