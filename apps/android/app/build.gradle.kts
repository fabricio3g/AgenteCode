plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("com.google.devtools.ksp")
}

android {
    namespace = "dev.agente.android"
    compileSdk = 35
    ndkVersion = "28.2.13676358"
    defaultConfig {
        applicationId = "dev.agente.android"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0-dev"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        ndk { abiFilters += providers.gradleProperty("agenteAbi").orElse("arm64-v8a").get() }
    }
    buildFeatures { compose = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    lint {
        warningsAsErrors = true
        abortOnError = true
        // Dependencies are pinned for a reproducible build (Gradle 8.11.1, JDK 17,
        // NDK 28), so "newer version available" is not a build failure. The native
        // library is built per ABI (-PagenteAbi=x86_64 covers x86_64 devices and
        // emulators), which the ChromeOS ARM-translation check cannot see.
        disable += setOf("GradleDependency", "ChromeOsAbiSupport")
    }
    sourceSets["main"].jniLibs.srcDir(layout.buildDirectory.dir("rustJniLibs"))
    packaging { jniLibs.useLegacyPackaging = false }
}
kotlin { compilerOptions {
    jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    allWarningsAsErrors.set(true)
} }
ksp { arg("room.schemaLocation", "$projectDir/schemas") }

val buildRust by tasks.registering(Exec::class) {
    val sdk = providers.environmentVariable("ANDROID_SDK_ROOT")
        .orElse(providers.environmentVariable("ANDROID_HOME"))
    val abi = providers.gradleProperty("agenteAbi").orElse("arm64-v8a")
    inputs.dir("../../../crates/agente-mobile/src")
    inputs.dir("../../../crates/agente-core/src")
    inputs.dir("../../../crates/agente-core/providers")
    inputs.dir("../../../crates/agente-sync/src")
    inputs.dir("../../../crates/agente-protocol/src")
    inputs.file("../../../Cargo.lock")
    inputs.property("abi", abi)
    outputs.dir(layout.buildDirectory.dir("rustJniLibs"))
    commandLine("bash", "../scripts/build-rust.sh", abi.get(), layout.buildDirectory.dir("rustJniLibs").get().asFile.absolutePath)
    environment("ANDROID_SDK_ROOT", sdk.getOrElse(""))
}
tasks.configureEach {
    if (name.contains("merge", ignoreCase = true) && name.endsWith("JniLibFolders")) dependsOn(buildRust)
}

dependencies {
    implementation(platform("androidx.compose:compose-bom:2025.04.01"))
    implementation("androidx.activity:activity-compose:1.10.1")
    // No Material: the phone draws the desktop's own planes and ladder through
    // `ui/design`, and DesignBoundaryTest fails the build if a screen reaches
    // for a component library instead.
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.animation:animation")
    implementation("androidx.compose.ui:ui-tooling-preview")
    debugImplementation("androidx.compose.ui:ui-tooling")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.9.0")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.9.0")
    implementation("androidx.room:room-runtime:2.7.1")
    implementation("androidx.room:room-ktx:2.7.1")
    ksp("androidx.room:room-compiler:2.7.1")
    implementation("androidx.datastore:datastore-preferences:1.1.4")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.room:room-testing:2.7.1")
}
