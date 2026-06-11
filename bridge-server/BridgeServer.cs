/**
 * SE 指令桥接服务 — HTTP → TCP 帧协议
 *
 * 用途: 部署在 SE 服务器上，将浏览器 HTTP 请求转为 TCP 帧协议，
 *       转发给 SE Torch 插件的 gRPC 端口。解决 CF Pages Function
 *       跨境延迟问题（海外 CF 边缘 → 国内服务器）。
 *
 * 编译 (零依赖，仅需 .NET Framework 4.0 自带的 csc.exe):
 *   C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe ^
 *     /out:BridgeServer.exe ^
 *     /r:System.Web.Extensions.dll ^
 *     BridgeServer.cs
 *
 * 运行:
 *   BridgeServer.exe --http-port 8080 --grpc-port 10086
 *
 * 配置优先级: 命令行参数 > 环境变量 > 同目录 config.json > 默认值
 *
 * 协议:
 *   入站 HTTP JSON → 封装 RequestMessage → [4字节BE长度][UTF-8 JSON] → gRPC 端口
 *   响应 ← 归一化 {code, msg, data} ← [4字节BE长度][UTF-8 JSON] ← gRPC 端口
 */

using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

namespace BridgeServer
{
    // ========== 配置 ==========

    class Config
    {
        public int HttpPort = 8080;
        public string GrpcHost = "127.0.0.1";
        public int GrpcPort = 10086;
        public string AuthKey = "12345";
        public string BindAddress = "0.0.0.0";  // 0.0.0.0 接受来自外部的连接

        public static Config Load(string[] args)
        {
            var cfg = new Config();

            // 1. 尝试读取同目录 config.json
            try
            {
                var jsonPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "config.json");
                if (File.Exists(jsonPath))
                {
                    var json = File.ReadAllText(jsonPath, Encoding.UTF8);
                    var serializer = new JavaScriptSerializer();
                    var dict = serializer.Deserialize<Dictionary<string, object>>(json);
                    if (dict.ContainsKey("bridgeHttpPort")) cfg.HttpPort = Convert.ToInt32(dict["bridgeHttpPort"]);
                    if (dict.ContainsKey("bridgeGrpcHost")) cfg.GrpcHost = (string)dict["bridgeGrpcHost"];
                    if (dict.ContainsKey("bridgeGrpcPort")) cfg.GrpcPort = Convert.ToInt32(dict["bridgeGrpcPort"]);
                    if (dict.ContainsKey("bridgeAuthKey")) cfg.AuthKey = (string)dict["bridgeAuthKey"];
                }
            }
            catch { /* 配置文件不存在或格式错误，使用默认值 */ }

            // 2. 环境变量覆盖
            var env = Environment.GetEnvironmentVariable("BRIDGE_HTTP_PORT");
            if (!string.IsNullOrEmpty(env)) cfg.HttpPort = int.Parse(env);
            env = Environment.GetEnvironmentVariable("BRIDGE_GRPC_HOST");
            if (!string.IsNullOrEmpty(env)) cfg.GrpcHost = env;
            env = Environment.GetEnvironmentVariable("BRIDGE_GRPC_PORT");
            if (!string.IsNullOrEmpty(env)) cfg.GrpcPort = int.Parse(env);
            env = Environment.GetEnvironmentVariable("BRIDGE_AUTH_KEY");
            if (!string.IsNullOrEmpty(env)) cfg.AuthKey = env;
            env = Environment.GetEnvironmentVariable("BRIDGE_BIND_ADDR");
            if (!string.IsNullOrEmpty(env)) cfg.BindAddress = env;

            // 3. 命令行参数覆盖
            for (int i = 0; i < args.Length; i++)
            {
                switch (args[i])
                {
                    case "--http-port":
                    case "-p": if (i + 1 < args.Length) cfg.HttpPort = int.Parse(args[++i]); break;
                    case "--grpc-host": if (i + 1 < args.Length) cfg.GrpcHost = args[++i]; break;
                    case "--grpc-port":
                    case "-g": if (i + 1 < args.Length) cfg.GrpcPort = int.Parse(args[++i]); break;
                    case "--auth-key": if (i + 1 < args.Length) cfg.AuthKey = args[++i]; break;
                    case "--bind":
                    case "-b": if (i + 1 < args.Length) cfg.BindAddress = args[++i]; break;
                    case "--help":
                    case "-h": PrintHelp(); Environment.Exit(0); break;
                }
            }

            return cfg;
        }

        static void PrintHelp()
        {
            Console.WriteLine("SE 指令桥接服务");
            Console.WriteLine();
            Console.WriteLine("用法: BridgeServer.exe [选项]");
            Console.WriteLine();
            Console.WriteLine("选项:");
            Console.WriteLine("  --http-port, -p <port>    HTTP 监听端口 (默认: 8080)");
            Console.WriteLine("  --grpc-host <host>        gRPC 服务地址 (默认: 127.0.0.1)");
            Console.WriteLine("  --grpc-port, -g <port>    gRPC 服务端口 (默认: 10086)");
            Console.WriteLine("  --auth-key <key>          认证密钥 (默认: 12345)");
            Console.WriteLine("  --bind, -b <addr>         绑定地址 (默认: 0.0.0.0)");
            Console.WriteLine("  --help, -h                显示此帮助");
            Console.WriteLine();
            Console.WriteLine("环境变量: BRIDGE_HTTP_PORT, BRIDGE_GRPC_HOST, BRIDGE_GRPC_PORT, BRIDGE_AUTH_KEY");
            Console.WriteLine("配置文件: 同目录下的 config.json (字段: bridgeHttpPort, bridgeGrpcHost, bridgeGrpcPort, bridgeAuthKey)");
        }
    }

    // ========== TCP 帧协议客户端 ==========

    class TcpFrameClient
    {
        const int TIMEOUT_MS = 10000;

        /// <summary>
        /// 发送 JSON 请求到 gRPC 服务，返回归一化后的响应 JSON 字符串
        /// </summary>
        public static string SendRequest(string host, int port, string requestJson)
        {
            using (var client = new TcpClient())
            {
                // 连接超时
                var result = client.BeginConnect(host, port, null, null);
                if (!result.AsyncWaitHandle.WaitOne(TimeSpan.FromMilliseconds(TIMEOUT_MS)))
                {
                    client.Close();
                    return "{\"code\":500,\"msg\":\"连接 gRPC 服务超时\",\"data\":null}";
                }
                client.EndConnect(result);
                client.ReceiveTimeout = TIMEOUT_MS;
                client.SendTimeout = TIMEOUT_MS;

                using (var stream = client.GetStream())
                {
                    // 发送帧: [4字节BE长度] + [UTF-8 JSON]
                    WriteFrame(stream, requestJson);

                    // 读取帧: [4字节BE长度] + [UTF-8 JSON]
                    var responseJson = ReadFrame(stream);

                    // 归一化响应格式（兼容新旧两种 SE 插件格式）
                    return NormalizeResponse(responseJson);
                }
            }
        }

        static void WriteFrame(NetworkStream stream, string json)
        {
            var data = Encoding.UTF8.GetBytes(json);
            var lenBytes = new byte[4];
            // Big-Endian 长度
            lenBytes[0] = (byte)((data.Length >> 24) & 0xFF);
            lenBytes[1] = (byte)((data.Length >> 16) & 0xFF);
            lenBytes[2] = (byte)((data.Length >> 8) & 0xFF);
            lenBytes[3] = (byte)(data.Length & 0xFF);
            stream.Write(lenBytes, 0, 4);
            stream.Write(data, 0, data.Length);
            stream.Flush();
        }

        static string ReadFrame(NetworkStream stream)
        {
            // 读取 4 字节长度
            var lenBytes = ReadExact(stream, 4);
            int length = (lenBytes[0] << 24) | (lenBytes[1] << 16) | (lenBytes[2] << 8) | lenBytes[3];

            if (length <= 0 || length > 10 * 1024 * 1024)
            {
                throw new Exception("无效的响应长度: " + length);
            }

            // 读取 JSON 数据
            var data = ReadExact(stream, length);
            return Encoding.UTF8.GetString(data);
        }

        static byte[] ReadExact(NetworkStream stream, int count)
        {
            var buf = new byte[count];
            int offset = 0;
            while (offset < count)
            {
                int read = stream.Read(buf, offset, count - offset);
                if (read == 0) throw new Exception("连接在读取过程中关闭");
                offset += read;
            }
            return buf;
        }

        /// <summary>
        /// 归一化响应格式
        /// 新版: {code: 200, msg: "...", data: null}  → 直接透传
        /// 旧版: {success: true, bodyJson: "...", errorMessage: "..."}  → 转换
        /// </summary>
        static string NormalizeResponse(string rawJson)
        {
            try
            {
                var serializer = new JavaScriptSerializer();
                var raw = serializer.Deserialize<Dictionary<string, object>>(rawJson);

                // 新版格式：有 code 字段 → 直接透传
                if (raw.ContainsKey("code"))
                {
                    return rawJson;
                }

                // 旧版格式：有 success 字段 → 转换
                if (raw.ContainsKey("success"))
                {
                    bool success = Convert.ToBoolean(raw["success"]);
                    if (success)
                    {
                        var body = raw.ContainsKey("bodyJson") ? (raw["bodyJson"] ?? "").ToString() : "";
                        // bodyJson 可能还是 JSON 字符串，保留原样
                        return "{\"code\":200,\"msg\":" + serializer.Serialize(body) + ",\"data\":null}";
                    }
                    else
                    {
                        var errMsg = raw.ContainsKey("errorMessage") ? (raw["errorMessage"] ?? "未知错误").ToString() : "未知错误";
                        return "{\"code\":400,\"msg\":" + serializer.Serialize(errMsg) + ",\"data\":null}";
                    }
                }

                return "{\"code\":500,\"msg\":\"无法解析响应格式\",\"data\":null}";
            }
            catch
            {
                return "{\"code\":500,\"msg\":\"SE 服务器响应异常\",\"data\":null}";
            }
        }
    }

    // ========== HTTP 服务（基于 TcpListener，无需管理员权限）==========

    class HttpBridge
    {
        readonly Config _cfg;
        readonly JavaScriptSerializer _json = new JavaScriptSerializer();
        TcpListener _listener;
        volatile bool _running;

        public HttpBridge(Config cfg)
        {
            _cfg = cfg;
        }

        public void Start()
        {
            var addr = IPAddress.Parse(_cfg.BindAddress);
            _listener = new TcpListener(addr, _cfg.HttpPort);
            _listener.Start();
            _running = true;

            Console.WriteLine("========================================");
            Console.WriteLine("  SE 指令桥接服务已启动");
            Console.WriteLine("  HTTP 监听: {0}:{1}", _cfg.BindAddress, _cfg.HttpPort);
            Console.WriteLine("  gRPC 后端: {0}:{1}", _cfg.GrpcHost, _cfg.GrpcPort);
            Console.WriteLine("  认证密钥: {0}", MaskKey(_cfg.AuthKey));
            Console.WriteLine("========================================");
            Console.WriteLine();

            // 处理线程
            var thread = new Thread(AcceptLoop);
            thread.IsBackground = true;
            thread.Start();
        }

        void AcceptLoop()
        {
            while (_running)
            {
                try
                {
                    var client = _listener.AcceptTcpClient();
                    // 每个客户端一个线程池线程处理
                    ThreadPool.QueueUserWorkItem(HandleClient, client);
                }
                catch (SocketException)
                {
                    if (_running) Console.WriteLine("接受连接时出错（服务可能正在关闭）");
                }
            }
        }

        void HandleClient(object state)
        {
            using (var client = (TcpClient)state)
            {
                try
                {
                    client.ReceiveTimeout = 5000;
                    client.SendTimeout = 5000;
                    using (var stream = client.GetStream())
                    {
                        // 简单 HTTP 请求解析（只处理首个请求，不处理 keep-alive）
                        var request = ReadHttpRequest(stream);
                        if (request == null) return;

                        var response = Route(request);
                        SendHttpResponse(stream, response);
                    }
                }
                catch (Exception ex)
                {
                    Console.WriteLine("处理请求出错: " + ex.Message);
                }
            }
        }

        // ---- 简易 HTTP 解析 ----

        class HttpRequest
        {
            public string Method;
            public string Path;
            public Dictionary<string, string> Headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            public string Body;
        }

        HttpRequest ReadHttpRequest(NetworkStream stream)
        {
            var reader = new StreamReader(stream, Encoding.UTF8, false, 4096, true);

            // 读取请求行
            var requestLine = reader.ReadLine();
            if (string.IsNullOrEmpty(requestLine)) return null;

            var parts = requestLine.Split(' ');
            if (parts.Length < 2) return null;

            var request = new HttpRequest
            {
                Method = parts[0].ToUpperInvariant(),
                Path = parts[1]
            };

            // 读取 Headers
            string line;
            while (!string.IsNullOrEmpty(line = reader.ReadLine()))
            {
                var colonIdx = line.IndexOf(':');
                if (colonIdx > 0)
                {
                    var key = line.Substring(0, colonIdx).Trim();
                    var value = line.Substring(colonIdx + 1).Trim();
                    request.Headers[key] = value;
                }
            }

            // 读取 Body
            if (request.Headers.ContainsKey("Content-Length"))
            {
                int length = int.Parse(request.Headers["Content-Length"]);
                var bodyChars = new char[length];
                int offset = 0;
                while (offset < length)
                {
                    int read = reader.Read(bodyChars, offset, length - offset);
                    if (read == 0) break;
                    offset += read;
                }
                request.Body = new string(bodyChars, 0, offset);
            }

            return request;
        }

        void SendHttpResponse(NetworkStream stream, string body)
        {
            var bytes = Encoding.UTF8.GetBytes(body);

            var headers = new StringBuilder();
            headers.Append("HTTP/1.1 200 OK\r\n");
            headers.Append("Content-Type: application/json; charset=utf-8\r\n");
            headers.Append("Content-Length: ").Append(bytes.Length).Append("\r\n");
            headers.Append("Access-Control-Allow-Origin: *\r\n");
            headers.Append("Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n");
            headers.Append("Access-Control-Allow-Headers: Content-Type, Authorization\r\n");
            headers.Append("Connection: close\r\n");
            headers.Append("\r\n");

            var headerBytes = Encoding.ASCII.GetBytes(headers.ToString());
            stream.Write(headerBytes, 0, headerBytes.Length);
            stream.Write(bytes, 0, bytes.Length);
            stream.Flush();
        }

        void SendHttpResponse(NetworkStream stream, int statusCode, string body)
        {
            if (statusCode == 204)
            {
                var resp = Encoding.ASCII.GetBytes(
                    "HTTP/1.1 204 No Content\r\n" +
                    "Access-Control-Allow-Origin: *\r\n" +
                    "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n" +
                    "Access-Control-Allow-Headers: Content-Type, Authorization\r\n" +
                    "Connection: close\r\n\r\n");
                stream.Write(resp, 0, resp.Length);
                return;
            }

            var bytes = Encoding.UTF8.GetBytes(body);
            var statusText = statusCode == 400 ? "Bad Request" :
                             statusCode == 401 ? "Unauthorized" :
                             statusCode == 403 ? "Forbidden" :
                             statusCode == 404 ? "Not Found" :
                             statusCode == 503 ? "Service Unavailable" : "OK";

            var headers = new StringBuilder();
            headers.Append("HTTP/1.1 ").Append(statusCode).Append(" ").Append(statusText).Append("\r\n");
            headers.Append("Content-Type: application/json; charset=utf-8\r\n");
            headers.Append("Content-Length: ").Append(bytes.Length).Append("\r\n");
            headers.Append("Access-Control-Allow-Origin: *\r\n");
            headers.Append("Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n");
            headers.Append("Access-Control-Allow-Headers: Content-Type, Authorization\r\n");
            headers.Append("Connection: close\r\n");
            headers.Append("\r\n");

            var headerBytes = Encoding.ASCII.GetBytes(headers.ToString());
            stream.Write(headerBytes, 0, headerBytes.Length);
            stream.Write(bytes, 0, bytes.Length);
            stream.Flush();
        }

        // ---- 路由 ----

        string Route(HttpRequest req)
        {
            // CORS 预检
            if (req.Method == "OPTIONS")
            {
                SendHttpResponse((NetworkStream)null, 204, "");
                return "";
            }

            var path = req.Path;
            // 去掉查询参数
            var qIdx = path.IndexOf('?');
            if (qIdx >= 0) path = path.Substring(0, qIdx);

            Console.WriteLine("[{0:HH:mm:ss}] {1} {2}", DateTime.Now, req.Method, path);

            if (req.Method == "GET" && (path == "/api/health" || path == "/health"))
            {
                return JsonOk("ok", new Dictionary<string, object> { { "bridge", "local" } });
            }

            if (req.Method != "POST")
            {
                return JsonError(404, "未知接口");
            }

            if (path == "/api/command/verify" || path == "/command/verify")
            {
                return HandleVerify(req.Body);
            }

            if (path == "/api/command/execute" || path == "/command/execute")
            {
                return HandleExecute(req.Body);
            }

            return JsonError(404, "未知接口: " + path);
        }

        // ---- 指令处理 ----

        string HandleVerify(string bodyJson)
        {
            try
            {
                var dict = _json.Deserialize<Dictionary<string, object>>(bodyJson);
                var steamId = dict["steamId"].ToString();
                var password = dict["gamePassword"].ToString();

                // 构造 RpcCommand
                var innerJson = _json.Serialize(new Dictionary<string, object>
                {
                    { "steamId", steamId },
                    { "command", "!info myinfo" },
                    { "gamePassword", password },
                    { "forcePlayerOnline", false },
                    { "dontSendToGameScreen", true },
                });

                // 构造 RequestMessage
                var requestJson = _json.Serialize(new Dictionary<string, object>
                {
                    { "path", "/command" },
                    { "bodyJson", innerJson },
                    { "authKey", _cfg.AuthKey },
                });

                // 发送 TCP 帧 → gRPC
                var response = TcpFrameClient.SendRequest(_cfg.GrpcHost, _cfg.GrpcPort, requestJson);
                return response;
            }
            catch (Exception ex)
            {
                return JsonError(400, "请求格式错误: " + ex.Message);
            }
        }

        string HandleExecute(string bodyJson)
        {
            try
            {
                var dict = _json.Deserialize<Dictionary<string, object>>(bodyJson);
                if (!dict.ContainsKey("steamId") || !dict.ContainsKey("command") || !dict.ContainsKey("gamePassword"))
                {
                    return JsonError(400, "缺少必要参数: steamId, command, gamePassword");
                }

                var steamId = dict["steamId"].ToString();
                var command = dict["command"].ToString();
                var password = dict["gamePassword"].ToString();

                // 构造 RpcCommand
                var innerJson = _json.Serialize(new Dictionary<string, object>
                {
                    { "steamId", steamId },
                    { "command", command },
                    { "gamePassword", password },
                    { "forcePlayerOnline", false },
                    { "dontSendToGameScreen", true },
                });

                // 构造 RequestMessage
                var requestJson = _json.Serialize(new Dictionary<string, object>
                {
                    { "path", "/command" },
                    { "bodyJson", innerJson },
                    { "authKey", _cfg.AuthKey },
                });

                // 发送 TCP 帧 → gRPC
                var response = TcpFrameClient.SendRequest(_cfg.GrpcHost, _cfg.GrpcPort, requestJson);
                return response;
            }
            catch (Exception ex)
            {
                return JsonError(400, "请求格式错误: " + ex.Message);
            }
        }

        // ---- JSON 响应构造 ----

        string JsonOk(string msg, object data)
        {
            return _json.Serialize(new Dictionary<string, object>
            {
                { "code", 200 },
                { "msg", msg },
                { "data", data },
            });
        }

        string JsonError(int code, string msg)
        {
            return _json.Serialize(new Dictionary<string, object>
            {
                { "code", code },
                { "msg", msg },
                { "data", null },
            });
        }

        static string MaskKey(string key)
        {
            if (string.IsNullOrEmpty(key) || key.Length <= 4) return "****";
            return key.Substring(0, 2) + "****" + key.Substring(key.Length - 2);
        }

        public void Stop()
        {
            _running = false;
            try { if (_listener != null) _listener.Stop(); } catch { }
        }
    }

    // ========== 入口 ==========

    class Program
    {
        static void Main(string[] args)
        {
            var cfg = Config.Load(args);

            Console.OutputEncoding = Encoding.UTF8;
            Console.WriteLine("SE 指令桥接服务 v1.0");
            Console.WriteLine();

            var bridge = new HttpBridge(cfg);
            bridge.Start();

            Console.WriteLine("按 Ctrl+C 停止服务...");
            Console.WriteLine();

            // 等待退出
            var exitEvent = new ManualResetEvent(false);
            Console.CancelKeyPress += (sender, e) =>
            {
                e.Cancel = true;
                Console.WriteLine("正在停止...");
                bridge.Stop();
                exitEvent.Set();
            };

            exitEvent.WaitOne();
            Console.WriteLine("服务已停止。");
        }
    }
}
