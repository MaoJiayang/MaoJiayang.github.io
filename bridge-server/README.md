# SE 指令桥接服务

将浏览器 HTTP 请求转为 TCP 帧协议，转发给 SE Torch 插件的 gRPC 端口。

## 快速启动

```powershell
# 编译（仅首次或代码更新后）
.\build.bat

# 或手动编译
C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /out:BridgeServer.exe /r:System.Web.Extensions.dll BridgeServer.cs

# 启动
.\BridgeServer.exe --http-port 10085 --grpc-port 10086
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

1. 如证书过期，本地运行.\caddy.exe run 
2. 将C:\Users\Lenovo\AppData\Roaming\Caddy\certificates\acme-v02.api.letsencrypt.org-directory\atomickitty17th.duckdns.org\下的.crt和.key文件拷贝到服务器上的桥接服务同一个目录
3. 拷贝Caddyfile
4. 运行桥接服务，然后.\caddy.exe run 