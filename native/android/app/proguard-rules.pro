# R8 rules for the release build (app/build.gradle.kts). Libraries that ship consumer rules (OkHttp, Firebase,
# ML Kit, CameraX, Compose, androidx) need nothing here; these cover what reaches code only through JNI.

# WebRTC (stream-webrtc-android): the native library calls back into these classes by name.
-keep class org.webrtc.** { *; }
-dontwarn org.webrtc.**

# QuickJS (web/voice-core.js): the JNI bridge looks up its Kotlin classes and methods by name.
-keep class com.dokar.quickjs.** { *; }

# kotlinx.serialization (core/Models Machine): keep the generated serializers the runtime looks up.
-keepclassmembers @kotlinx.serialization.Serializable class ** {
    *** Companion;
    kotlinx.serialization.KSerializer serializer(...);
}
-keepclasseswithmembers class **$$serializer { *; }

# BouncyCastle (secretbox): only the engines the app uses are reached; the rest refers to JDK APIs Android lacks.
-dontwarn org.bouncycastle.**

# Readable stack traces in crash reports.
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile
