{
  pkgs,
  home-manager,
  self,
}:
let
  inherit (pkgs) lib;
  package = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
  evaluate =
    testPkgs: settings:
    home-manager.lib.homeManagerConfiguration {
      pkgs = testPkgs;
      modules = [
        (import ../home-manager.nix { inherit self; })
        {
          home = {
            username = "codex-test";
            homeDirectory =
              if testPkgs.stdenv.hostPlatform.isLinux then "/home/codex-test" else "/Users/codex-test";
            stateVersion = "24.11";
          };
          services.codex-auto-reset = settings;
        }
      ];
    };
  disabled = evaluate pkgs { };
  enabled = evaluate pkgs { enable = true; };
  # Deliberately nonexistent: evaluation must not read or copy this runtime file.
  authFile = "/home/codex-test/auth files/100%h $TOKEN \"quoted\" 'auth'.json";
  custom = evaluate pkgs {
    enable = true;
    inherit authFile;
    pollInterval = 60;
    redemptionLeadTime = 120;
  };
  replacement = pkgs.writeShellScriptBin "codex-auto-reset" "exit 0";
  overridden = evaluate pkgs {
    enable = true;
    package = replacement;
  };
  unit = evaluation: evaluation.config.systemd.user.services.codex-auto-reset;
  defaultCommand = ''"${package}/bin/codex-auto-reset" "daemon" "--json" "--poll-interval" "300s" "--redemption-lead-time" "900s"'';
  customCommand = ''"${package}/bin/codex-auto-reset" "daemon" "--json" "--poll-interval" "60s" "--redemption-lead-time" "120s" "--auth-file" "/home/codex-test/auth files/100%%h $$TOKEN \"quoted\" 'auth'.json"'';
  failures =
    evaluation: map (a: a.message) (builtins.filter (a: !a.assertion) evaluation.config.assertions);
  # Home Manager checks assertions before exposing config, so rejection is tested
  # through its public evaluator rather than bypassing its assertion machinery.
  rejects =
    settings:
    !(builtins.tryEval (
      builtins.deepSeq (evaluate pkgs ({ enable = true; } // settings)).config.services.codex-auto-reset
        true
    )).success;
  darwinPkgs = import pkgs.path { system = "aarch64-darwin"; };
  darwin = evaluate darwinPkgs {
    enable = true;
    # Avoid depending on a Darwin package output when testing the Linux assertion.
    inherit package;
  };
  invalidType =
    settings: option:
    !(builtins.tryEval (
      builtins.deepSeq (evaluate pkgs settings).config.services.codex-auto-reset.${option} true
    )).success;
  checks = [
    (!(disabled.config.systemd.user.services ? codex-auto-reset))
    (!(builtins.elem package disabled.config.home.packages))
    (failures disabled == [ ])
    (failures enabled == [ ])
    (builtins.elem package enabled.config.home.packages)
    (lib.toList (unit enabled).Service.ExecStart == [ defaultCommand ])
    ((unit enabled).Unit.After == [ "network-online.target" ])
    ((unit enabled).Install.WantedBy == [ "default.target" ])
    ((unit enabled).Service.Type == "simple")
    ((unit enabled).Service.Restart == "on-failure")
    ((unit enabled).Service.RestartSec == 30)
    ((unit enabled).Service.NoNewPrivileges)
    ((unit enabled).Service.UMask == "0077")
    ((unit enabled).Service.Environment or [ ] == [ ])
    (enabled.config.xdg.configFile ? "systemd/user/codex-auto-reset.service")
    (failures custom == [ ])
    (custom.config.services.codex-auto-reset.authFile == authFile)
    (lib.toList (unit custom).Service.ExecStart == [ customCommand ])
    (builtins.elem replacement overridden.config.home.packages)
    (lib.hasPrefix ''"${replacement}/bin/codex-auto-reset"'' (
      builtins.head (lib.toList (unit overridden).Service.ExecStart)
    ))
    (rejects { pollInterval = 451; })
    (rejects {
      pollInterval = 2147484;
      redemptionLeadTime = 4294968;
    })
    (rejects { redemptionLeadTime = 2147484; })
    (
      failures (
        evaluate pkgs {
          enable = true;
          pollInterval = 1073741;
          redemptionLeadTime = 2147483;
        }
      ) == [ ]
    )
    (invalidType {
      enable = true;
      pollInterval = 0;
    } "pollInterval")
    (invalidType {
      enable = true;
      redemptionLeadTime = -1;
    } "redemptionLeadTime")
    (invalidType {
      enable = true;
      pollInterval = 1.5;
    } "pollInterval")
    (!(builtins.tryEval darwin.config.services.codex-auto-reset.enable).success)
  ];
in
assert builtins.all (x: x) (
  lib.imap1 (
    index: passed: lib.assertMsg passed "codex-auto-reset Home Manager check ${toString index} failed"
  ) checks
);
pkgs.runCommand "codex-auto-reset-home-manager-check"
  {
    defaultUnit = enabled.config.xdg.configFile."systemd/user/codex-auto-reset.service".source;
    customUnit = custom.config.xdg.configFile."systemd/user/codex-auto-reset.service".source;
    inherit defaultCommand customCommand;
  }
  ''
    # Check the actual Home Manager-rendered user units, without activating them.
    grep -Fx -- "ExecStart=$defaultCommand" "$defaultUnit"
    grep -Fx -- "ExecStart=$customCommand" "$customUnit"
    grep -Fx -- 'WantedBy=default.target' "$defaultUnit"
    touch "$out"
  ''
