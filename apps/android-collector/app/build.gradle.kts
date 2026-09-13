plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "ai.openroly.collector"
    compileSdk = 34

    defaultConfig {
        applicationId = "ai.openroly.collector"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    packaging {
        resources {
            // Don't fail on the duplicate META-INF resources the BouncyCastle jar ships for multiple versions
            excludes += setOf(
                "META-INF/versions/**",
                "META-INF/*.SF",
                "META-INF/*.DSA",
                "META-INF/*.RSA",
            )
        }
    }
}

dependencies {
    // HPKE (RFC 9180) comes from BouncyCastle. Byte compatibility is checked by
    // apps/android-collector/interop/check-interop.sh
    implementation("org.bouncycastle:bcprov-jdk18on:1.78.1")
}
