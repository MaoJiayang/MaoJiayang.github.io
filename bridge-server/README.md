# SE 指令桥接服务

将浏览器 HTTP 请求转为 TCP 帧协议，转发给 SE Torch 插件的 gRPC 端口。

## 快速启动

```powershell
# 编译（仅首次或代码更新后）
.\build.bat

# 或手动编译
C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /out:BridgeServer.exe /r:System.Web.Extensions.dll BridgeServer.cs

# 启动
BridgeServer.exe --http-port 10085 --grpc-port 10086
```

## 配置

三种方式，优先级从高到低：

```
命令行参数              BridgeServer.exe --http-port 10085 --grpc-port 10086 --auth-key 12345
环境变量                BRIDGE_HTTP_PORT=10085  BRIDGE_GRPC_PORT=10086  BRIDGE_AUTH_KEY=12345
config.json             { "bridgeHttpPort": 10085, "bridgeGrpcPort": 10086, "bridgeAuthKey": "12345" }
```

默认值：HTTP 端口 8080，gRPC 端口 10086，密钥 12345。

## 开机自启

用 Windows 计划任务：

```powershell
$action = New-ScheduledTaskAction -Execute "C:\Users\Administrator\Desktop\bridge-server\BridgeServer.exe" -Argument "--http-port 10085 --grpc-port 10086"
$trigger = New-ScheduledTaskTrigger -AtStartup
Register-ScheduledTask -TaskName "SE-BridgeServer" -Action $action -Trigger $trigger -RunLevel Highest
```

## HTTPS（可选）

桥接服务本身仅 HTTP。如需 HTTPS 有两条路：

1. **Cloudflare Tunnel**（零配置，走 CF 边缘）：
   ```powershell
   cloudflared.exe tunnel --url http://localhost:10085
   ```
   获得 `https://xxx.trycloudflare.com`，CF Dashboard 的 BRIDGE_URL 填这个。

2. **反代 + Let's Encrypt**（需域名，延迟最低）：在桥接前面挂 Caddy/Nginx。

## 健康检查

```
GET http://你的IP:10085/api/health
→ { "code": 200, "msg": "ok", "data": { "bridge": "local" } }
```

## 故障排查

| 现象 | 检查 |
|------|------|
| 编译报错 | 确认 .NET Framework 4.0+ 已安装 |
| 启动后无响应 | Windows 防火墙是否放行 HTTP 端口 |
| 指令返回 401 | gRPC 端口的 authKey 是否匹配（Constants.cs AuthKey） |
| 指令返回 503 | 游戏是否已完成加载（gamingStartedDone） |
| 指令返回"密码校验失败" | 用户密码是否正确 |
