# 伊卡洛斯虚空终端 — 三端运行 & 构建指南

## 🌐 网页版

部署到 CF Pages 后自动生效，无需手动构建。

- 地址：`https://atomickitty17th.pages.dev/terminal`
- 部署：`git push` → CF Pages 自动构建

## 🖥️ Dev 本地开发

```bash
node server.js
# → http://localhost:24007/terminal.html 自动打开
```

前端 + TCP 桥接 + 认证代理，一个进程搞定所有。

## 📦 桌面版 EXE

```bash
npm install            # 安装依赖（仅首次）
npm run build          # → dist/se-terminal.exe（~85MB）
```

双击 `se-terminal.exe` 即可运行。控制台窗口不可关闭。

- 更换图标：替换 `icons/favicon.svg` → 重新 `npm run build`
- 清缓存测试：

```powershell
Remove-Item -Recurse -Force $env:LOCALAPPDATA\SE-Terminal\www -ErrorAction SilentlyContinue
```

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

### 桥接

| 文件 | 说明 |
|------|------|
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
| `start-local.bat` | 本地一键启动 |

## ☁️ CF Dashboard 配置

**Pages → Settings → Environment variables：**

| 变量 | 说明 |
|------|------|
| `SE_HOST` | SE 服务器地址 |
| `SE_PORT` | SE 服务器端口 |
| `SE_AUTH_KEY` | 认证密钥 |
| `SE_BLACKLIST` | 封禁 SteamID，逗号分隔 |
| `BRIDGE_URL` | ⚠️ 已退役，可删除 |

**Pages → Settings → Functions → AI bindings**（语义搜索）：

```text
Type: Workers AI    Name: AI    Value: Workers AI Catalog
```
