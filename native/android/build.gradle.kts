// Versions pinned 2026-10 (known to work together with Gradle 8.14.3 and JDK 21). README → Toolchain.

// AGP 8.13's bundled R8 can't read Kotlin 2.4 metadata (it warns and may shrink Kotlin classes wrongly);
// a newer R8 that knows Kotlin 2.4 runs the release minification instead.
buildscript {
    repositories { google() }
    dependencies { classpath("com.android.tools:r8:9.4.28") }
}

plugins {
    id("com.android.application") version "8.13.0" apply false
    id("org.jetbrains.kotlin.android") version "2.4.10" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.4.10" apply false
    id("org.jetbrains.kotlin.plugin.serialization") version "2.4.10" apply false
}
