package com.se.terminal

import android.content.Context
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * 前端自动更新 — 与 server.js syncFrontend() 逻辑一致。
 * 启动时对比 CF 上的 version.json，版本不同则全量下载。
 */
object SyncManager {
    private const val TAG = "SyncManager"
    private val CF_ORIGIN = "https://${BuildConfig.CF_PAGES_DOMAIN}"

    private val FILES = arrayOf(
        "terminal.html", "terminal.css", "commands.html", "version.json",
        "version-check.js", "command-autocomplete.js", "command-executor.js",
        "items_catalog.json", "commands.json", "config.json",
        "js/se-bridge.js", "js/ui.js", "js/warehouse.js",
        "js/trade.js", "js/hangar.js", "js/shipyard.js", "js/settings.js",
        "icons/sprite.css", "icons/sprite.webp", "icons/mapping.json", "icons/tea.jpg"
    )

    suspend fun sync(context: Context) = withContext(Dispatchers.IO) {
        val wwwDir = File(context.filesDir, "www")
        wwwDir.mkdirs()

        // 1. 对比版本号
        val remoteV = fetchVersion()
        if (remoteV == null) {
            Log.d(TAG, "无法获取远端版本，跳过同步")
            return@withContext
        }

        val localV = readLocalVersion(wwwDir, context)
        if (localV != null && remoteV == localV) {
            Log.d(TAG, "已是最新 (v=${remoteV.take(7)})，跳过同步")
            return@withContext
        }

        Log.d(TAG, if (localV != null) "版本更新: ${localV.take(7)} -> ${remoteV.take(7)}" else "首次同步")

        // 2. 全量下载
        var updated = 0
        for (file in FILES) {
            if (downloadFile(wwwDir, file)) updated++
        }
        Log.d(TAG, "同步完成: $updated/${FILES.size} 文件")
    }

    private fun fetchVersion(): String? {
        return try {
            val url = URL("$CF_ORIGIN/version.json")
            val conn = url.openConnection() as HttpURLConnection
            conn.connectTimeout = 5000
            conn.readTimeout = 5000
            val body = conn.inputStream.use { it.readBytes().toString(Charsets.UTF_8) }
            org.json.JSONObject(body).optString("v", null)
        } catch (_: Exception) { null }
    }

    private fun readLocalVersion(wwwDir: File, context: Context): String? {
        // 优先读本地缓存
        val cachedFile = File(wwwDir, "version.json")
        if (cachedFile.exists()) {
            return try {
                org.json.JSONObject(cachedFile.readText()).optString("v", null)
            } catch (_: Exception) { null }
        }
        // 回退读 assets
        return try {
            val body = context.assets.open("www/version.json").bufferedReader().readText()
            org.json.JSONObject(body).optString("v", null)
        } catch (_: Exception) { null }
    }

    private fun downloadFile(wwwDir: File, filePath: String): Boolean {
        return try {
            val url = URL("$CF_ORIGIN/$filePath")
            val conn = url.openConnection() as HttpURLConnection
            conn.connectTimeout = 10000
            conn.readTimeout = 10000
            if (conn.responseCode != 200) return false
            val bytes = conn.inputStream.use { it.readBytes() }
            val dest = File(wwwDir, filePath)
            dest.parentFile?.mkdirs()
            dest.writeBytes(bytes)
            true
        } catch (_: Exception) { false }
    }

    /** 获取 www 根目录（优先缓存，回退 assets） */
    fun wwwDir(context: Context): File {
        val dir = File(context.filesDir, "www")
        // 缓存中存在 terminal.html 才认为有效
        return if (File(dir, "terminal.html").exists()) dir
        else File(context.filesDir, "www")  // 返回缓存目录（可能为空）
    }

    /** 是否已有缓存（即已经同步过） */
    fun hasCache(context: Context): Boolean {
        return File(context.filesDir, "www/terminal.html").exists()
    }
}
