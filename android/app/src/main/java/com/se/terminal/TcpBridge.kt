package com.se.terminal

import java.io.DataInputStream
import java.io.DataOutputStream
import java.net.InetSocketAddress
import java.net.Socket

/**
 * TCP 帧协议 — server.js 中 buildFrame / readFrame / cleanPUA / tcpRequest 的 Kotlin 直译。
 */
object TcpBridge {
    private const val TIMEOUT_MS = 15000

    /** 4 字节 Big-Endian 长度 + UTF-8 JSON */
    fun buildFrame(json: String): ByteArray {
        val data = json.toByteArray(Charsets.UTF_8)
        val len = ByteArray(4)
        len[0] = ((data.size shr 24) and 0xFF).toByte()
        len[1] = ((data.size shr 16) and 0xFF).toByte()
        len[2] = ((data.size shr 8) and 0xFF).toByte()
        len[3] = (data.size and 0xFF).toByte()
        return len + data
    }

    /** 读取一帧：4 字节长度 + 载荷 */
    fun readFrame(input: DataInputStream): String {
        val length = input.readInt()  // Big-Endian
        val data = ByteArray(length)
        input.readFully(data)
        return String(data, Charsets.UTF_8)
    }

    /** 递归清除 U+E000 ~ U+F8FF（PUA 字符） */
    fun cleanPUA(obj: Any?): Any? = when (obj) {
        is String -> obj.replace(Regex("[\\uE000-\\uF8FF]"), "")
        is List<*> -> obj.map { cleanPUA(it) }
        is Map<*, *> -> obj.mapKeys { it.key.toString() }.mapValues { cleanPUA(it.value) }
        else -> obj
    }

    /** 响应统一格式 */
    data class Response(val code: Int, val msg: String, val data: Any?)

    /**
     * TCP 请求 → SE 服务器，永不抛异常，所有路径返回 Response。
     * @param customPath 自定义路径，默认 /command
     */
    suspend fun tcpRequest(
        host: String,
        port: Int,
        authKey: String,
        steamId: String,
        command: String,
        password: String,
        customPath: String? = null
    ): Response = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
        try {
            val innerBody = org.json.JSONObject().apply {
                put("steamId", steamId)
                put("command", command)
                put("gamePassword", password)
                put("forcePlayerOnline", false)
                put("dontSendToGameScreen", true)
            }.toString()

            val requestJson = org.json.JSONObject().apply {
                put("path", customPath ?: "/command")
                put("bodyJson", innerBody)
                put("authKey", authKey)
            }.toString()

            val socket = Socket()
            socket.soTimeout = TIMEOUT_MS
            socket.connect(InetSocketAddress(host, port), TIMEOUT_MS)

            // 注意：不能对 OutputStream 用 .use{}，它会连带关闭 Socket
            val out = DataOutputStream(socket.getOutputStream())
            out.write(buildFrame(requestJson))
            out.flush()

            val responseJson = DataInputStream(socket.getInputStream()).use { readFrame(it) }
            socket.close()

            parseResponse(responseJson)
        } catch (e: Exception) {
            Response(500, "TCP 失败: ${e.message}", null)
        }
    }

    /** JSON 值 → Kotlin 类型（递归，供 cleanPUA 遍历） */
    private fun jsonToAny(obj: Any?): Any? = when (obj) {
        is org.json.JSONObject -> {
            val map = mutableMapOf<String, Any?>()
            val keys = obj.keys()
            while (keys.hasNext()) {
                val key = keys.next()
                map[key] = jsonToAny(obj.get(key))
            }
            map
        }
        is org.json.JSONArray -> {
            (0 until obj.length()).map { jsonToAny(obj.get(it)) }
        }
        org.json.JSONObject.NULL -> null
        else -> obj
    }

    private fun parseResponse(json: String): Response {
        return try {
            val raw = org.json.JSONObject(json)
            val cleaned = cleanPUA(jsonToAny(raw)) as Map<*, *>

            // 已有 code 字段 → 直接返回
            if (cleaned.containsKey("code")) {
                return Response(
                    (cleaned["code"] as? Number)?.toInt() ?: 500,
                    cleaned["msg"]?.toString() ?: "",
                    cleaned["data"]
                )
            }

            val success = cleaned["success"]
            when {
                success == true -> {
                    var body = cleaned["bodyJson"]?.toString() ?: ""
                    // 与 server.js 一致：尝试 parse body，如果是字符串则保留原始内容
                    try {
                        val p = org.json.JSONObject(body)
                        body = p.toString()
                    } catch (_: Exception) {
                        try {
                            val a = org.json.JSONArray(body)
                            body = a.toString()
                        } catch (_: Exception) {
                            // body 就是纯文本，保持不变
                        }
                    }
                    Response(200, body, null)
                }
                success == false -> {
                    val msg = cleaned["errorMessage"]?.toString() ?: "未知错误"
                    Response(400, msg, null)
                }
                else -> Response(500, "无法解析响应", null)
            }
        } catch (_: Exception) {
            Response(500, "SE服务器响应异常", null)
        }
    }
}
