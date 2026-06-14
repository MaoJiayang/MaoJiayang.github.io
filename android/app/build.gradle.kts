plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.se.terminal"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.se.terminal"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0"

        // 桥接配置（全部指令经服务端桥接，客户端不持密钥）
        buildConfigField("String", "BRIDGE_URL", "\"http://183.131.51.12:10085\"")
        buildConfigField("String", "CF_PAGES_DOMAIN", "\"atomickitty17th.pages.dev\"")
        buildConfigField("int", "HTTP_PORT", "24007")
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        buildConfig = true
    }
}

dependencies {
    implementation("org.nanohttpd:nanohttpd:2.3.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.7.3")
    implementation("androidx.core:core-ktx:1.12.0")
    implementation("androidx.appcompat:appcompat:1.6.1")
}
