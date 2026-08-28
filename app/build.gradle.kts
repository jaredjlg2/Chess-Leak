plugins {
    id("com.android.application")
}

android {
    namespace = "com.sonyjared.chessleak"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.sonyjared.chessleak"
        minSdk = 26
        targetSdk = 36
        versionCode = 5
        versionName = "0.5.0"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    androidResources {
        noCompress += "wasm"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }
}

dependencies {
    implementation("androidx.webkit:webkit:1.16.0")
}
