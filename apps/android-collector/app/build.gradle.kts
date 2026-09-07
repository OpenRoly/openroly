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
            // BouncyCastle jar が運ぶ複数 version の META-INF を重複 resource として落とさない
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
    // HPKE(RFC 9180)は BouncyCastle。byte 互換は apps/android-collector/interop/ の
    // check-interop.sh が機械検証する(図44・AC-1)
    implementation("org.bouncycastle:bcprov-jdk18on:1.78.1")
}
