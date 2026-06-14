package com.se.terminal

import fi.iki.elonen.NanoHTTPD
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * NanoHTTPD 本地服务器 — 所有 API 请求转发到服务端桥接。
 * 桥接服务处理 TCP、限流、封禁——客户端不持有任何敏感信息。
 */
class HttpServer(
    private val context: android.content.Context
) : NanoHTTPD(BuildConfig.HTTP_PORT) {

    private val assets = context.assets
    private val bridgeUrl = BuildConfig.BRIDGE_URL
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
                path == "/api/health" -> {
                    // 携带 steamId 查询参数透传到桥接（配额查询）
                    val steamId = session.parameters["steamId"]?.firstOrNull()
                    val healthPath = if (steamId != null) "/api/health?steamId=$steamId" else "/api/health"
                    proxyToBridge("GET", healthPath, null)
                }
                path == "/api/command/verify" && method == Method.POST -> {
                    val body = parseBody(session) ?: return jsonError(400, "缺少必要参数")
                    proxyToBridge("POST", "/api/command/verify", body)
                }
                path == "/api/user/sync" && method == Method.POST -> {
                    val body = parseBody(session) ?: return jsonError(400, "缺少 steamId 或 gamePassword")
                    proxyToBridge("POST", "/api/user/sync", body)
                }
                path == "/api/command/execute" && method == Method.POST -> {
                    val body = parseBody(session) ?: return jsonError(400, "缺少必要参数")
                    proxyToBridge("POST", "/api/command/execute", body)
                }
                path == "/api/grid/world-grids" && method == Method.POST -> {
                    val body = parseBody(session) ?: return jsonError(400, "缺少 steamId 或 gamePassword")
                    proxyToBridge("POST", "/api/grid/world-grids", body)
                }
                method == Method.GET || method == Method.HEAD -> serveAsset(path)
                else -> jsonError(404, "未知接口")
            }
        } catch (e: Exception) {
            jsonError(500, e.message ?: "服务器错误")
        }
    }

    /** POST 转发到服务端桥接 */
    private fun proxyToBridge(method: String, path: String, body: JSONObject?): Response {
        return try {
            val url = URL(bridgeUrl + path)
            val conn = url.openConnection() as HttpURLConnection
            conn.requestMethod = method
            conn.connectTimeout = 8000
            conn.readTimeout = 15000
            if (body != null) {
                conn.setRequestProperty("Content-Type", "application/json")
                conn.doOutput = true
                val bodyBytes = body.toString().toByteArray(Charsets.UTF_8)
                conn.outputStream.use { it.write(bodyBytes) }
            }
            val respBody = conn.inputStream.use { it.readBytes().toString(Charsets.UTF_8) }
            json(Response.Status.lookup(conn.responseCode), respBody)
        } catch (_: Exception) {
            jsonError(502, "桥接服务不可达")
        }
    }

    /** GET 代理到 CF（仅用于 version.json 实时拉取） */
    private fun proxyGetCF(path: String): Response {
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
            return proxyGetCF("/version.json")
        }

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
        val ct = session.headers["content-type"]
        if (ct != null && !ct.contains("charset", ignoreCase = true)) {
            session.headers["content-type"] = "$ct; charset=UTF-8"
        }
        val files = HashMap<String, String>()
        session.parseBody(files)
        val raw = files["postData"] ?: return null
        return try { JSONObject(raw) } catch (_: Exception) { null }
    }

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
