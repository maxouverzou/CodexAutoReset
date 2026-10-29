{
  lib,
  stdenvNoCC,
  nodejs,
  pnpm_10,
  fetchPnpmDeps,
  pnpmConfigHook,
  pnpmBuildHook,
  makeWrapper,
}:
let
  pnpm = pnpm_10;
  # Deliberately allowlist build inputs: never copy local credential files, node_modules,
  # generated dist trees, or the development environment into the Nix store.
  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../package.json
      ../pnpm-lock.yaml
      ../pnpm-workspace.yaml
      ../tsconfig.base.json
      (lib.fileset.unions (
        map
          (
            name:
            let
              dir = ../packages + "/${name}";
            in
            lib.fileset.unions [
              (dir + "/src")
              (dir + "/test")
              (dir + "/package.json")
              (dir + "/tsconfig.json")
            ]
          )
          [
            "core"
            "daemon"
            "cli"
          ]
      ))
      ./tests/installed.mjs
    ];
  };
in
stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "codex-auto-reset";
  version = (lib.importJSON ../package.json).version;
  inherit src;

  nativeBuildInputs = [
    nodejs
    pnpm
    pnpmConfigHook
    pnpmBuildHook
    makeWrapper
  ];
  pnpmDeps = fetchPnpmDeps {
    inherit (finalAttrs) pname version src;
    inherit pnpm;
    fetcherVersion = 5;
    hash = "sha256-TRKS1Mov2El2NRLjWdogCqDoJ1rJJooD1qK/CFg+fwo=";
  };

  doCheck = true;
  checkPhase = ''
    runHook preCheck
    pnpm typecheck
    node --test packages/core/test/*.test.* packages/daemon/test/*.test.* packages/cli/test/*.test.*
    runHook postCheck
  '';

  installPhase = ''
    runHook preInstall
    root="$out/lib/codex-auto-reset"
    mkdir -p "$root/packages" "$root/node_modules/@codex-auto-reset" "$out/bin"
    for package in core daemon cli; do
      mkdir -p "$root/packages/$package"
      cp "packages/$package/package.json" "$root/packages/$package/"
      cp -r "packages/$package/dist" "$root/packages/$package/"
      ln -s "../../packages/$package" "$root/node_modules/@codex-auto-reset/$package"
    done
    makeWrapper ${nodejs}/bin/node "$out/bin/codex-auto-reset" \
      --add-flags "$root/packages/cli/dist/index.js"
    runHook postInstall
  '';

  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    node nix/tests/installed.mjs "$out/bin/codex-auto-reset"
    runHook postInstallCheck
  '';

  meta = {
    description = "Inspect Codex usage and redeem expiring earned reset credits using Pi credentials";
    homepage = "https://github.com/maxouverzou/CodexAutoReset";
    mainProgram = "codex-auto-reset";
    platforms = lib.platforms.linux ++ lib.platforms.darwin;
  };
})
