# pi-mobile — Nix flake for the Android app.
#
# Provides, without touching the global system package set (no brew, no
# ~/Library, nothing outside the Nix store):
#
#   nix develop            a dev shell with JDK 21 and the Android SDK; then
#                          `./gradlew assembleDebug` works as in native/android/README.md
#                          (Gradle caches in ~/.gradle, which persists between runs)
#   nix run .#build-apk    one-shot `./gradlew assembleDebug` in the current checkout
#   nix build .#apk        a pure(ish) build: the debug APK ends up in
#                          result/app-debug.apk  (Gradle re-fetches Maven deps each run)
#   nix build .#sdk        just the Android SDK
#   nix fmt                format this file / nix flake check to verify
#
# The nixpkgs config below (allowUnfree, android licenses) is scoped to this
# flake's own nixpkgs instance — nothing global is changed.
#
# Notes
# - `nix develop` and `nix run` run outside the Nix sandbox, so Gradle can reach
#   Maven Central / Google Maven on its first run (it then caches in ~/.gradle,
#   which the dev shell reuses on later runs).
# - Android SDK via Nix: platforms;android-36, build-tools 36.1.0, platform-tools
#   and cmdline-tools, licenses pre-accepted (androidenv writes the license hash
#   files into the SDK itself). API 36 is not in older nixpkgs; use a recent
#   nixpkgs-unstable (25.11+).
# - `nix build .#apk`: on macOS the derivation runs outside the sandbox
#   (__noChroot) because Gradle must reach the network; the source copy is
#   filtered to native/android + web/voice-core.js.

{
  description = "pi-mobile Android app: Nix-provided JDK 21 and Android SDK";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      systems = [ "aarch64-darwin" "x86_64-darwin" "aarch64-linux" "x86_64-linux" ];
      forAllSystems = f: builtins.listToAttrs (map (system: { name = system; value = f system; }) systems);

      # A nixpkgs instance whose config stays inside this flake.
      pkgsFor = system: import nixpkgs {
        inherit system;
        config = {
          allowUnfree = true; # Android SDK packages are marked unfree
          android_sdk.accept_license = true;
        };
      };

      # Android SDK: platform 36 + build-tools + platform-tools + cmdline-tools.
      androidSdk = pkgs: (pkgs.androidenv.composeAndroidPackages {
        platformVersions = [ "36" ];
        # AGP 8.13 defaults to build-tools 35.0.0; 36.1.0 is the current 36 patch.
        buildToolsVersions = [ "35.0.0" "36.1.0" ];
        includeEmulator = false; # enable for emulator e2e only (system-images are large)
        # Android licenses: accepted via the nixpkgs config android_sdk.accept_license
        # set above; the composed SDK writes the license hash files itself.
      }).androidsdk;

      # Gradle wants the SDK root (platforms/build-tools/licenses) itself, which the
      # composed package keeps under libexec/android-sdk; the adb/sdkmanager wrappers
      # live in the package's bin/.
      sdkRoot = pkgs: "${androidSdk pkgs}/libexec/android-sdk";

      # Environment every Gradle invocation needs (JAVA_HOME + the nix SDK).
      gradleEnv = pkgs: ''
        export JAVA_HOME="${pkgs.jdk21}"
        export ANDROID_HOME="${sdkRoot pkgs}"
        export ANDROID_SDK_ROOT="$ANDROID_HOME"
        export PATH="$JAVA_HOME/bin:${androidSdk pkgs}/bin:$PATH"
      '';

      # Keep only what the Gradle build reads: the android project and voice-core.js.
      # Ancestor dirs (the root, native, web) must pass the filter too, or the
      # tree gets pruned away entirely.
      apkSrc = pkgs: pkgs.lib.cleanSourceWith {
        src = ./.;
        filter = path: type:
          let p = toString path; in
          p == toString ./.
          || p == toString ./native
          || p == toString ./native/android
          || pkgs.lib.hasPrefix (toString ./native/android + "/") p
          || p == toString ./web
          || p == toString ./web/voice-core.js;
      };
    in
    {
      packages = forAllSystems (system:
        let pkgs = pkgsFor system; in
        rec {
          inherit (pkgs) jdk21;
          sdk = androidSdk pkgs;
          # The debug APK. Gradle touches the network, so on macOS the derivation
          # opts out of the sandbox (__noChroot); on Linux run
          # `nix build .#apk --option sandbox false` instead.
          apk = pkgs.stdenv.mkDerivation {
            pname = "pi-mobile-android";
            version = "1.0.0"; # app versionName, see native/android/app/build.gradle.kts
            src = apkSrc pkgs;
            __noChroot = pkgs.stdenv.hostPlatform.isDarwin;
            nativeBuildInputs = [ pkgs.jdk21 ];
            GRADLE_USER_HOME = "$TMPDIR/gradle-home"; # don't touch ~/.gradle in a pure build
            buildPhase = ''
              runHook preBuild
              ${gradleEnv pkgs}
              export ANDROID_USER_HOME="$TMPDIR/android-user-home"
              cd native/android
              ./gradlew assembleDebug --no-daemon --stacktrace
            '';
            installPhase = ''
              mkdir -p $out
              cp -f app/build/outputs/apk/debug/app-debug.apk $out/app-debug.apk
            '';
          };
          default = sdk;
        });

      apps = forAllSystems (system:
        let pkgs = pkgsFor system; in
        {
          # Incremental one-shot build in the repo checkout (reuses ~/.gradle).
          build-apk = {
            type = "app";
            program = "${pkgs.writeShellScriptBin "build-apk" ''
              set -euo pipefail
              ${gradleEnv pkgs}
              cd native/android
              exec ./gradlew assembleDebug --no-daemon "$@"
            ''}/bin/build-apk";
          };
        });

      devShells = forAllSystems (system:
        let pkgs = pkgsFor system; in
        {
          default = pkgs.mkShell {
            name = "pi-mobile-android";
            packages = [ pkgs.jdk21 (androidSdk pkgs) ];
            ANDROID_HOME = "${sdkRoot pkgs}";
            ANDROID_SDK_ROOT = "${sdkRoot pkgs}";
            JAVA_HOME = "${pkgs.jdk21}";
            shellHook = ''
              export PATH="$JAVA_HOME/bin:${androidSdk pkgs}/bin:$PATH"
              echo "pi-mobile Android shell: JDK ${pkgs.jdk21.version}, SDK at $ANDROID_HOME"
              echo "Build with: cd native/android && ./gradlew assembleDebug"
            '';
          };
        });

      formatter = forAllSystems (system: nixpkgs.legacyPackages.${system}.nixfmt);

      checks = forAllSystems (system:
        { apk = self.packages.${system}.apk; });
    };
}
