# 伊卡洛斯虚空终端 — 三端运行 & 构建指南

## 🌐 网页版

部署到 CF Pages 后自动生效，无需手动构建。

- 地址：`https://atomickitty17th.pages.dev/terminal`
- 部署：`git push` → CF Pages 自动构建
- **CF 构建命令**（在 Dashboard → Settings → Build configuration 中配置）：
  ```bash
  FILES=$(cat frontend-files.json) && echo "{\"v\":\"$CF_PAGES_COMMIT_SHA\",\"files\":$FILES}" > version.json
  ```
  构建产物 `version.json` 格式：`{"v":"abc123","files":["terminal.html",...]}`，所有端运行时同步时先拉此文件获取版本号和文件列表。

## 🖥️ Dev 本地开发

```bash
node server.js
# → http://localhost:24007/terminal.html 自动打开
```

前端 + TCP 桥接 + 认证代理，一个进程搞定所有。

## 📦 桌面版 EXE

### 前置依赖

- **Node.js 22+**（SEA 打包）
- **Visual Studio 2022 Build Tools**（C++ 桌面开发 workload，编译内嵌浏览器）
- **WebView2 Runtime** — Win10 1809+ / Win11 自带，无需分发

### 构建

```bash
# 首次：安装 Node 依赖 + WebView2 SDK
npm install
nuget install Microsoft.Web.WebView2 -OutputDirectory libs

# 每次构建（需在 VS 2022 Developer Command Prompt 中执行）
scripts\build-webview.bat && npm run build
# → dist/se-terminal.exe（~85MB，单文件）
```

### 特性

- **内嵌 WebView2 窗口**：无标题栏，边缘可拖拽调整大小，顶部可拖动位置
- **Alt+K**：全局热键，切换窗口置顶 + 半透明
- **关闭按钮**：窗口右上角 ✕，对应的命令行控制台会跟随退出
- **单文件分发**：`webview.exe` 以 base64 内嵌在 `server.js` 中，SEA 打包后仅一个 `se-terminal.exe`
- `WebView2Loader.dll` 系统自带，不分发

### 维护

- 更换图标：替换 `icons/favicon.svg` → 重新 `npm run build`
- 修改内嵌浏览器：编辑 `webview/app.cc` → `scripts\build-webview.bat && npm run build`
- 清缓存测试：

```powershell
Remove-Item -Recurse -Force $env:LOCALAPPDATA\SE-Terminal\www -ErrorAction SilentlyContinue
```

## 🔗 服务端桥接 EXE

部署在游戏服务器上，作为所有客户端的**唯一安全边界**（限流 / 封禁 / TCP 通信）：

```bash
npm run build:bridge             # → dist/se-bridge-server.exe
```

**部署到游戏服务器**：

1. 复制 `dist/se-bridge-server.exe` 到服务器
2. 复制 `bridge-server/config.example.json` 为同目录 `config.json`，填写实际密钥
3. 双击 EXE 运行（控制台窗口不可关闭）
4. 浏览器打开 `http://localhost:10085/admin` 可看管理界面

**config.json 字段**：

| 字段 | 说明 |
|------|------|
| `port` | 桥接监听端口，默认 10085 |
| `seHost` | SE 服务器地址（同机=127.0.0.1） |
| `sePort` | SE 服务器端口 |
| `seAuthKey` | SE TCP 认证密钥 |
| `cfAdminUrl` | CF Pages 地址 |
| `cfAdminKey` | 调用 CF admin 端点的密钥，与 CF Dashboard `SE_ADMIN_KEY` 一致 |
| `cacheTtlSec` | 用户状态缓存刷新间隔，默认 60 |
| `cacheMaxIdleSec` | 缓存淘汰：超此时长无请求即删除，默认 86400（1天） |

## 📱 Android APK

```bash
.\scripts\sync-assets.ps1              # 同步前端到 assets（每次改前端后执行）
# → Android Studio 打开 android/ 目录 → Build → Build APK
# → app/build/outputs/apk/debug/app-debug.apk
```

配置文件：`android/app/build.gradle.kts` → `buildConfigField`

| 字段 | 说明 |
|------|------|
| `SE_HOST` | SE 服务器地址 |
| `SE_PORT` | SE 服务器端口 |
| `SE_AUTH_KEY` | 认证密钥 |
| `CF_PAGES_DOMAIN` | CF Pages 域名 |
| `HTTP_PORT` | 本地 HTTP 端口 |

## ➕ 新增前端文件

只需改一处——`frontend-files.json`：

1. 在数组末尾加一行文件路径
2. `git push` → CF Pages 构建时自动注入 `version.json` 的 `files` 字段
3. EXE/APK 下次启动自动拉取新文件

各端消费者自动跟随 `version.json` 的文件列表，无需手动同步清单。

## 🤖 重新生成 Embedding

更新 `commands.json` 后执行：

```powershell
$env:CF_ACCOUNT_ID="你的账号ID"
$env:CF_API_TOKEN="你的Token"
node build.js                     # 生成 embeddings.json
node test-search.js "保存飞船"    # 本地测试
```

## 📁 核心文件

### 前端

| 文件 | 说明 |
|------|------|
| `terminal.html` | 主页面入口 |
| `terminal.css` | 全局样式 |
| `commands.html` | 指令速查表 |
| `js/se-bridge.js` | 凭据 + 桥接 + 限流 |
| `js/ui.js` | Toast / Tab / 登录 / 弹窗 |
| `js/warehouse.js` | 仓库面板 |
| `js/trade.js` | 交易面板 |
| `js/hangar.js` | 船坞面板 |
| `js/shipyard.js` | 船厂面板 |
| `js/settings.js` | 设置面板 |
| `js/tools.js` | 工具面板 |
| `frontend-files.json` | **唯一真相源**，前端文件列表，加新文件只需改此处 |

### 桥接

| 文件 | 说明 |
|------|------|
| `bridge-server/bridge-server.js` | Node.js 服务端桥接（安全边界，部署在游戏服务器） |
| `server.js` | Node.js 客户端桥接（Dev + EXE） |
| `android/` | Kotlin 客户端桥接（APK） |
| `functions/api/[[route]].js` | CF 云端桥接（认证 + 指令 fallback） |

### 数据

| 文件 | 说明 |
|------|------|
| `commands.json` | 指令数据，日常维护入口 |
| `embeddings.json` | 由 build.js 生成，勿手动编辑 |
| `items_catalog.json` | 物品图标映射 |
| `config.json` | 模型名称、端口 |

### 构建 & 脚本

| 文件 | 说明 |
|------|------|
| `build.js` | 生成 embeddings.json |
| `scripts/sync-assets.ps1` | 前端 → Android assets |
| `scripts/build-webview.bat` | 编译内嵌 WebView2 浏览器 |
| `scripts/embed-webview.js` | 将 webview.exe base64 注入 server.js |
| `start-local.bat` | 本地一键启动 |
| `webview/app.cc` | WebView2 内嵌浏览器 C++ 源码 |
| `webview/include/` | webview 库头文件 |

## ☁️ CF Dashboard 配置

**Pages → Settings → Environment variables：**

| 变量 | 说明 |
|------|------|
| `SE_HOST` | SE 服务器地址 |
| `SE_PORT` | SE 服务器端口 |
| `SE_AUTH_KEY` | 认证密钥 |
| `SE_BLACKLIST` | 封禁 SteamID，逗号分隔 |
| `SE_ADMIN_KEY` | 管理密钥，供 bridge-server 校验身份 |
| `BRIDGE_URL` | 服务端桥接地址（Phase 3 启用，如 `http://183.131.51.12:10085`） |

**Pages → Settings → Functions → AI bindings**（语义搜索）：

```text
Type: Workers AI    Name: AI    Value: Workers AI Catalog
```
