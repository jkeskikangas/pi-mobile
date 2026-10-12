import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
}

// Upload key, never committed: native/android/keystore.properties (see README.md).
val keystoreProps = Properties().apply {
    val f = rootProject.file("keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

// Optional build inputs (gradle.properties, ~/.gradle/gradle.properties or -P): README → Push.
fun prop(name: String, default: String = "") = (project.findProperty(name) as String?) ?: default

// The shared voice logic (plans/native-android.md D3): only the copy bundled at build time runs.
val voiceCoreSource = rootProject.file("../../web/voice-core.js")
val bundleVoiceCore by tasks.registering(Copy::class) {
    // A Copy of a missing file copies nothing and succeeds: an app without its voice logic must not build.
    doFirst { check(voiceCoreSource.isFile) { "web/voice-core.js is missing: voice mode can't be built without it" } }
    from(voiceCoreSource)
    into(layout.buildDirectory.dir("generated/voicecore/assets"))
}

android {
    // Permanent once uploaded to Google Play (plans/native-android.md).
    namespace = "dev.pi_mobile.app"
    compileSdk = 36

    defaultConfig {
        applicationId = "dev.pi_mobile.app"
        minSdk = 26
        // Google Play: new apps and updates must target API 36 from 2026-08-31.
        targetSdk = 36
        versionCode = 2
        versionName = "1.0.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

        // Push through the relay (relay/, FCM). Empty Firebase values: push isn't available in this build.
        buildConfigField("String", "RELAY_URL", "\"${prop("piRelayUrl", "https://push.pi-mobile.dev")}\"")
        buildConfigField("String", "FIREBASE_PROJECT_ID", "\"${prop("piFirebaseProjectId")}\"")
        buildConfigField("String", "FIREBASE_APP_ID", "\"${prop("piFirebaseAppId")}\"")
        buildConfigField("String", "FIREBASE_API_KEY", "\"${prop("piFirebaseApiKey")}\"")
        buildConfigField("String", "FIREBASE_SENDER_ID", "\"${prop("piFirebaseSenderId")}\"")
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    sourceSets {
        getByName("main").assets.srcDir(layout.buildDirectory.dir("generated/voicecore/assets"))
        // JVM tests read web/voice-core.js and native/fixtures directly.
        getByName("test").resources.srcDirs(rootProject.file("../fixtures"))
    }

    signingConfigs {
        if (keystoreProps.isNotEmpty()) {
            create("upload") {
                storeFile = rootProject.file(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfigs.findByName("upload")?.let { signingConfig = it }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    testOptions {
        unitTests.isIncludeAndroidResources = true
        unitTests.all {
            it.systemProperty("pi.repo", rootProject.file("../..").absolutePath)
            // scripts/integration.sh: the fixture hub's pairing link for FixtureHubIntegrationTest.
            prop("piPairLink").takeIf { l -> l.isNotEmpty() }?.let { l -> it.systemProperty("PI_PAIR_LINK", l) }
            // Screenshot tests write to build/shots; `-Ppi.shots` refreshes the committed native/android/shots.
            val shots = if (project.hasProperty("pi.shots")) rootProject.file("shots") else layout.buildDirectory.dir("shots").get().asFile
            it.systemProperty("pi.shots", shots.absolutePath)
        }
    }

    packaging {
        resources.excludes += setOf("META-INF/versions/9/OSGI-INF/MANIFEST.MF", "META-INF/DEPENDENCIES")
    }
}

tasks.named("preBuild") { dependsOn(bundleVoiceCore) }

kotlin {
    jvmToolchain(21)
    compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2025.10.00")
    implementation(composeBom)
    implementation("androidx.core:core-ktx:1.17.0")
    implementation("androidx.activity:activity-compose:1.11.0")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.9.4")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.9.4")
    implementation("androidx.lifecycle:lifecycle-service:2.9.4")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.compose.ui:ui-tooling-preview")
    debugImplementation("androidx.compose.ui:ui-tooling")
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.9.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    // secretbox (XSalsa20-Poly1305), pure Java so the crypto vectors run as JVM tests.
    implementation("org.bouncycastle:bcprov-jdk18on:1.82")
    // Realtime voice: audio track + oai-events data channel, hardware AEC/NS.
    implementation("io.getstream:stream-webrtc-android:1.3.10")
    // web/voice-core.js runs in QuickJS (Android and, for the JVM tests, desktop).
    implementation("io.github.dokar3:quickjs-kt:1.0.15")
    // QR pairing.
    implementation("androidx.camera:camera-camera2:1.5.1")
    implementation("androidx.camera:camera-lifecycle:1.5.1")
    implementation("androidx.camera:camera-view:1.5.1")
    implementation("com.google.mlkit:barcode-scanning:17.3.0")
    // Push (FCM, through the relay); initialised from BuildConfig, no google-services plugin.
    implementation(platform("com.google.firebase:firebase-bom:34.4.0"))
    implementation("com.google.firebase:firebase-messaging")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.10.2")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
    testImplementation("org.robolectric:robolectric:4.16")
    testImplementation("androidx.test:core:1.7.0")
    testImplementation("io.github.dokar3:quickjs-kt-jvm:1.0.15")
    // Compose UI tests and screenshots under Robolectric (native graphics).
    testImplementation(composeBom)
    testImplementation("androidx.compose.ui:ui-test-junit4")
    // Captures composables under Robolectric (captureToImage needs a real frame); no Gradle plugin.
    testImplementation("io.github.takahirom.roborazzi:roborazzi:1.76.0")
    testImplementation("io.github.takahirom.roborazzi:roborazzi-compose:1.76.0")

    androidTestImplementation(composeBom)
    androidTestImplementation("androidx.test.ext:junit:1.3.0")
    androidTestImplementation("androidx.test:runner:1.7.0")
    androidTestImplementation("androidx.test:rules:1.7.0")
    androidTestImplementation("androidx.test.uiautomator:uiautomator:2.3.0")
    androidTestImplementation("androidx.test.espresso:espresso-web:3.7.0")
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
}
