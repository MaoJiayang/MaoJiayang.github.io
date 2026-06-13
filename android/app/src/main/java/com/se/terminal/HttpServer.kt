package com.se.terminal

import fi.iki.elonen.NanoHTTPD
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * NanoHTTPD 本地服务器 — 路由表与 server.js 保持一致。
 * /api/ 通配符 -> 桥接逻辑, 其他 -> 静态文件 (assets/www/)
 */
class HttpServer(
    private val context: android.content.Context
) : NanoHTTPD(BuildConfig.HTTP_PORT) {

    private val assets = context.assets
    private val cfOrigin = "https://${BuildConfig.CF_PAGES_DOMAIN}"

    /** 优先缓存目录，其次 assets。缓存为空时自动回退。 */
    private fun wwwDir(): File? {
        val dir = File(context.filesDir, "www")
        return if (File(dir, "terminal.html").exists()) dir else null
    }

    override fun serve(session: IHTTPSession): Response {
        if (session.method == Method.OPTIONS) {
            val resp = newFixedLengthResponse(Response.Status.OK, "text/plain", "")
            resp.addHeader("Access-Control-Allow-Origin", "*")
            return resp
        }

        val path = session.uri.removeSuffix("/").ifEmpty { "/" }
        val method = session.method

        return try {
            when {
                path == "/api/health" -> handleHealth()
                path == "/api/command/verify" && method == Method.POST -> handleAuth(session, "/api/command/verify")
                path == "/api/user/sync" && method == Method.POST -> handleAuth(session, "/api/user/sync")
                path == "/api/command/execute" && method == Method.POST -> handleExecute(session)
                path == "/api/grid/world-grids" && method == Method.POST -> handleWorldGrids(session)
                method == Method.GET || method == Method.HEAD -> serveAsset(path)
                else -> jsonError(404, "未知接口")
            }
        } catch (e: Exception) {
            jsonError(500, e.message ?: "服务器错误")
        }
    }

    // ---- API ----

    private fun handleHealth() = jsonOk(mapOf("code" to 200, "msg" to "server ok"))

    private fun handleAuth(session: IHTTPSession, apiPath: String): Response {
        val body = parseBody(session) ?: return jsonError(400, "缺少必要参数")
        return proxyPost(apiPath, body)
    }

    private fun handleExecute(session: IHTTPSession): Response = runBlocking {
        val body = parseBody(session) ?: return@runBlocking jsonError(400, "缺少必要参数")
        val r = TcpBridge.tcpRequest(
            BuildConfig.SE_HOST, BuildConfig.SE_PORT, BuildConfig.SE_AUTH_KEY,
            body.optString("steamId"), body.optString("command"), body.optString("gamePassword")
        )
        jsonOk(mapOf("code" to r.code, "msg" to r.msg, "data" to (r.data ?: JSONObject.NULL)))
    }

    private fun handleWorldGrids(session: IHTTPSession): Response = runBlocking {
        val body = parseBody(session) ?: return@runBlocking jsonError(400, "缺少 steamId 或 gamePassword")
        val r = TcpBridge.tcpRequest(
            BuildConfig.SE_HOST, BuildConfig.SE_PORT, BuildConfig.SE_AUTH_KEY,
            body.optString("steamId"), "", body.optString("gamePassword"), "/getWorldGridsBySteamId"
        )
        if (r.code == 200 && r.data == null && r.msg.isNotEmpty()) {
            try {
                org.json.JSONArray(r.msg)
                return@runBlocking jsonOk(mapOf("code" to r.code, "msg" to r.msg, "data" to r.msg))
            } catch (_: Exception) {}
        }
        jsonOk(mapOf("code" to r.code, "msg" to r.msg, "data" to (r.data ?: JSONObject.NULL)))
    }

    /** POST 代理到 CF（认证请求） */
    private fun proxyPost(path: String, body: JSONObject): Response {
        return try {
            val url = URL(cfOrigin + path)
            val conn = url.openConnection() as HttpURLConnection
            conn.requestMethod = "POST"
            conn.setRequestProperty("Content-Type", "application/json")
            conn.doOutput = true
            conn.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            val respBody = conn.inputStream.use { it.readBytes().toString(Charsets.UTF_8) }
            json(Response.Status.lookup(conn.responseCode), respBody)
        } catch (_: Exception) {
            jsonError(502, "认证服务不可达")
        }
    }

    /** GET 代理到 CF（版本检查等） */
    private fun proxyGet(path: String): Response {
        return try {
            val url = URL(cfOrigin + path)
            val conn = url.openConnection() as HttpURLConnection
            conn.requestMethod = "GET"
            val respBody = conn.inputStream.use { it.readBytes().toString(Charsets.UTF_8) }
            val mime = if (path.endsWith(".json")) "application/json; charset=utf-8" else "text/plain"
            newFixedLengthResponse(Response.Status.lookup(conn.responseCode), mime, respBody).apply {
                addHeader("Access-Control-Allow-Origin", "*")
            }
        } catch (_: Exception) {
            jsonError(502, "服务不可达")
        }
    }

    // ---- 静态文件 ----

    private fun serveAsset(apiPath: String): Response {
        var filePath = apiPath.removePrefix("/")
        if (filePath.isEmpty()) filePath = "terminal.html"

        // version.json 从 CF 实时拉取，与 EXE 行为一致
        if (filePath == "version.json") {
            return proxyGet("/version.json")
        }

        // 尝试直接匹配
        try {
            return streamAsset("www/$filePath")
        } catch (_: Exception) {}

        // SPA fallback: 无扩展名 → 尝试加 .html
        if (!filePath.contains(".")) {
            try { return streamAsset("www/$filePath.html") } catch (_: Exception) {}
        }

        // 最终 fallback → terminal.html（SPA 路由）
        try {
            return streamAsset("www/terminal.html")
        } catch (_: Exception) {}

        return jsonError(404, "Not Found")
    }

    private fun streamAsset(assetPath: String): Response {
        // 优先读取缓存目录（同步后），其次 assets
        val bytes: ByteArray
        val cacheDir = wwwDir()
        if (cacheDir != null) {
            val f = File(cacheDir, assetPath.removePrefix("www/"))
            if (f.exists()) {
                bytes = f.readBytes()
            } else {
                val stream = assets.open(assetPath)
                bytes = stream.readBytes()
                stream.close()
            }
        } else {
            val stream = assets.open(assetPath)
            bytes = stream.readBytes()
            stream.close()
        }
        val mime = mimeType(assetPath)
        val resp = newFixedLengthResponse(Response.Status.OK, mime, ByteArrayInputStream(bytes), bytes.size.toLong())
        resp.addHeader("Access-Control-Allow-Origin", "*")
        return resp
    }

    // ---- 工具 ----

    private fun parseBody(session: IHTTPSession): JSONObject? {
        // 修复 NanoHTTPD 中文乱码：parseBody 前强制 content-type 声明 UTF-8
        // 社区标准方案: https://github.com/NanoHttpd/nanohttpd/issues/11
        val ct = session.headers["content-type"]
        if (ct != null && !ct.contains("charset", ignoreCase = true)) {
            session.headers["content-type"] = "$ct; charset=UTF-8"
        }
        val files = HashMap<String, String>()
        session.parseBody(files)
        val raw = files["postData"] ?: return null
        return try { JSONObject(raw) } catch (_: Exception) { null }
    }

    private fun jsonOk(data: Map<String, Any?>) =
        json(Response.Status.OK, JSONObject(data).toString())

    private fun jsonError(code: Int, msg: String) =
        json(Response.Status.lookup(code), JSONObject(mapOf("code" to code, "msg" to msg)).toString())

    private fun json(status: Response.Status, body: String): Response {
        val resp = newFixedLengthResponse(status, "application/json; charset=utf-8", body)
        resp.addHeader("Access-Control-Allow-Origin", "*")
        return resp
    }

    private fun mimeType(filePath: String): String = when {
        filePath.endsWith(".html") -> "text/html; charset=utf-8"
        filePath.endsWith(".css") -> "text/css; charset=utf-8"
        filePath.endsWith(".js") -> "application/javascript; charset=utf-8"
        filePath.endsWith(".json") -> "application/json; charset=utf-8"
        filePath.endsWith(".webp") -> "image/webp"
        filePath.endsWith(".jpg") || filePath.endsWith(".jpeg") -> "image/jpeg"
        filePath.endsWith(".png") -> "image/png"
        filePath.endsWith(".svg") -> "image/svg+xml"
        else -> "application/octet-stream"
    }
}
