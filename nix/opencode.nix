{
  lib,
  stdenvNoCC,
  callPackage,
  autoPatchelfHook,
  bun,
  fetchurl,
  nodejs,
  sysctl,
  unzip,
  makeBinaryWrapper,
  models-dev,
  ripgrep,
  installShellFiles,
  versionCheckHook,
  writableTmpDirAsHomeHook,
  node_modules ? callPackage ./node-modules.nix { },
}:
let
  isLinuxX64 = stdenvNoCC.hostPlatform.isLinux && stdenvNoCC.hostPlatform.isx86_64;
  bunBaseline = fetchurl {
    url = "https://github.com/oven-sh/bun/releases/download/bun-v${bun.version}/bun-linux-x64-baseline.zip";
    hash = "sha256-nYokKSpwaAkCBdqsCloiP19pc29Sh+N7+I07QDHtx1A=";
  };
in
stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "opencode";
  inherit (node_modules) version src;
  inherit node_modules;
  dontStrip = isLinuxX64;
  dontAutoPatchelf = isLinuxX64;

  nativeBuildInputs = [
    bun
    nodejs # for patchShebangs node_modules
    installShellFiles
    makeBinaryWrapper
    models-dev
    writableTmpDirAsHomeHook
  ]
  ++ lib.optionals isLinuxX64 [
    autoPatchelfHook
    unzip
  ];

  postPatch = ''
    # NOTE: Relax Bun version check to be a warning instead of an error
    substituteInPlace packages/script/src/index.ts \
      --replace-fail 'throw new Error(`This script requires bun@''${expectedBunVersionRange}' \
                     'console.warn(`Warning: This script requires bun@''${expectedBunVersionRange}'
  '';

  configurePhase = ''
    runHook preConfigure

    cp -R ${finalAttrs.node_modules}/. .
    patchShebangs node_modules
    patchShebangs packages/*/node_modules

    runHook postConfigure
  '';

  env.MODELS_DEV_API_JSON = "${models-dev}/dist/_api.json";
  env.OPENCODE_DISABLE_MODELS_FETCH = true;
  env.OPENCODE_VERSION = finalAttrs.version;
  env.OPENCODE_CHANNEL = "prod";

  buildPhase = ''
    runHook preBuild

    cd ./packages/opencode
    ${lib.optionalString isLinuxX64 ''
      unzip -p ${bunBaseline} bun-linux-x64-baseline/bun > bun-linux-x64-baseline
      chmod +x bun-linux-x64-baseline
      export OPENCODE_BUN_EXECUTABLE_PATH="$PWD/bun-linux-x64-baseline"
    ''}
    bun --bun ./script/build.ts --single${lib.optionalString isLinuxX64 " --baseline"} --skip-install
    bun --bun ./script/schema.ts schema.json

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    install -Dm755 dist/opencode-*/bin/opencode $out/bin/opencode
    install -Dm644 schema.json $out/share/opencode/schema.json
    ${lib.optionalString isLinuxX64 ''
      autoPatchelf $out/bin/opencode
    ''}

    wrapProgram $out/bin/opencode \
      --prefix PATH : ${
        lib.makeBinPath (
          [
            ripgrep
          ]
          # bun runs sysctl to detect if running on rosetta2
          ++ lib.optional stdenvNoCC.hostPlatform.isDarwin sysctl
        )
      }

    runHook postInstall
  '';

  postInstall = lib.optionalString (stdenvNoCC.buildPlatform.canExecute stdenvNoCC.hostPlatform) ''
    # trick yargs into also generating zsh completions
    installShellCompletion --cmd opencode \
      --bash <($out/bin/opencode completion) \
      --zsh <(SHELL=/bin/zsh $out/bin/opencode completion)
  '';

  nativeInstallCheckInputs = [
    versionCheckHook
    writableTmpDirAsHomeHook
  ];
  doInstallCheck = true;
  versionCheckKeepEnvironment = [ "HOME" "OPENCODE_DISABLE_MODELS_FETCH" ];
  versionCheckProgramArg = "--version";

  passthru = {
    jsonschema = "${placeholder "out"}/share/opencode/schema.json";
    env = finalAttrs.env;
  };

  meta = {
    description = "The open source coding agent";
    homepage = "https://opencode.ai";
    license = lib.licenses.mit;
    mainProgram = "opencode";
    inherit (node_modules.meta) platforms;
  };
})
