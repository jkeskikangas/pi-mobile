# pi-mobile for Android: placeholder

A minimal app (one screen: "pi-mobile — coming soon") whose only purpose for now is to **reserve the package name `dev.pi_mobile.app` on Google Play**. The real app is planned in [`plans/native-android.md`](../../plans/native-android.md).

| | |
|---|---|
| `applicationId` / `namespace` | `dev.pi_mobile.app` (permanent once uploaded) |
| `minSdk` | 26 (Android 8.0) |
| `targetSdk` / `compileSdk` | 36: from 31 Aug 2026, new apps and updates must target Android 16 (API 36) ([Android Developers](https://developer.android.com/google/play/requirements/target-sdk)) |
| `versionCode` | 1 (raise by one for every upload) |

This folder isn't part of the npm package (`package.json` `files` lists only `bin`, `src`, `web`, `README.md` and `LICENSE`).

## Toolchain (macOS)

```sh
brew install --cask temurin@21                 # JDK 21
brew install --cask android-commandlinetools   # sdkmanager, avdmanager
brew install gradle                            # only to generate the wrapper once

export JAVA_HOME="$(/usr/libexec/java_home -v 21)"
export ANDROID_HOME="$(brew --prefix)/share/android-commandlinetools"
export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"

yes | sdkmanager --licenses
sdkmanager "platform-tools" "platforms;android-36" "build-tools;36.0.0"
```

Put the `export` lines in `~/.zshrc`. Android Studio is optional; it brings its own SDK and JDK.

### Gradle wrapper

Only `gradle/wrapper/gradle-wrapper.properties` is committed: the wrapper jar and scripts couldn't be generated offline. Create them once, then commit them:

```sh
cd native/android
gradle wrapper --gradle-version 8.14.3
git add gradlew gradlew.bat gradle/wrapper/gradle-wrapper.jar
```

## Upload key

Google Play signs the app for users (Play App Signing). You sign each upload with your own **upload key**. If it's lost, Google can reset it; the app-signing key stays with Google.

```sh
cd native/android
keytool -genkeypair -v -keystore upload.jks -alias upload \
  -keyalg RSA -keysize 4096 -validity 10000 \
  -dname "CN=pi-mobile, O=pi-mobile, C=FI"
```

Then create `native/android/keystore.properties`:

```properties
storeFile=upload.jks
storePassword=…
keyAlias=upload
keyPassword=…
```

Both files are in `.gitignore` (`*.jks`, `keystore.properties`). Keep copies in your password manager. Check before every commit: `git status --ignored native/android`.

## Build the release bundle

```sh
cd native/android
./gradlew bundleRelease
# → app/build/outputs/bundle/release/app-release.aab (signed with the upload key)
```

If `keystore.properties` is missing, the bundle is built unsigned and Play Console rejects it.

## Google Play

1. **Create the app:** in [Play Console](https://play.google.com/console), go to Create app, name it "pi-mobile" and choose App, Free.
2. **Play App Signing:** use the default ("Let Google manage and protect your app signing key"). Enrolment happens with the first upload; the key you upload with becomes the upload key ([Play App Signing](https://support.google.com/googleplay/android-developer/answer/9842756)).
3. **Internal testing:** go to Test and release → Testing → Internal testing → Create new release, upload `app-release.aab`, add release notes, then Save → Review → Start rollout. Add testers by email list under Testers. The package name is reserved from this first upload.
4. **Closed test (new personal accounts):** personal developer accounts created after 13 Nov 2023 must run a closed test with **at least 12 testers who stayed opted in continuously for at least 14 days** before they can apply for production access ([Play Console Help](https://support.google.com/googleplay/android-developer/answer/14151465)). Recruit the testers early. A tester who leaves and rejoins restarts their 14 days.
5. **Production:** Dashboard → Apply for production. You answer questions about the closed test; review usually takes up to 7 days.

Every new upload needs a higher `versionCode` in `app/build.gradle.kts`.
