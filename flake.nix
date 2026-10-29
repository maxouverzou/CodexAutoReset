{
  description = "Codex usage inspection and automatic redemption of expiring reset credits";

  inputs = {
    nixpkgs.url = "https://flakehub.com/f/NixOS/nixpkgs/0.1"; # unstable Nixpkgs
    home-manager = {
      url = "github:nix-community/home-manager";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    { self, ... }@inputs:

    let
      supportedSystems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
      ];
      forEachSupportedSystem =
        f:
        inputs.nixpkgs.lib.genAttrs supportedSystems (
          system:
          f {
            inherit system;
            pkgs = import inputs.nixpkgs {
              inherit system;
              overlays = [ inputs.self.overlays.default ];
            };
          }
        );
    in
    {
      overlays.default = final: prev: rec {
        codex-auto-reset = final.callPackage ./nix/package.nix { };
        nodejs = prev.nodejs;
        yarn = (prev.yarn.override { inherit nodejs; });
      };

      packages = forEachSupportedSystem (
        { pkgs, ... }: {
          inherit (pkgs) codex-auto-reset;
          default = pkgs.codex-auto-reset;
        }
      );

      apps = forEachSupportedSystem (
        { system, ... }: {
          default = self.apps.${system}.codex-auto-reset;
          codex-auto-reset = {
            type = "app";
            program = "${self.packages.${system}.codex-auto-reset}/bin/codex-auto-reset";
            meta.description = "Inspect Codex usage and redeem earned reset credits";
          };
        }
      );

      homeManagerModules = {
        default = self.homeManagerModules.codex-auto-reset;
        codex-auto-reset = import ./nix/home-manager.nix { inherit self; };
      };

      checks = forEachSupportedSystem (
        { pkgs, system }:
        {
          package = self.packages.${system}.codex-auto-reset;
        }
        // pkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
          home-manager = import ./nix/tests/home-manager.nix {
            inherit pkgs self;
            inherit (inputs) home-manager;
          };
        }
      );

      devShells = forEachSupportedSystem (
        { pkgs, system }:
        {
          default = pkgs.mkShellNoCC {
            packages = with pkgs; [
              nodejs
              pnpm_10
              yarn
              self.formatter.${system}
            ];
          };
        }
      );

      formatter = forEachSupportedSystem ({ pkgs, ... }: pkgs.nixfmt);
    };
}
