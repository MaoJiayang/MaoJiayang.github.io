/**
 * electron/main.js — 伊卡洛斯虚空终端 Electron 主进程
 *
 * 替代 webview/app.cc 的全部功能:
 *   - 启动 HTTP 服务器（复用 server.js）
 *   - 创建 frameless 窗口
 *   - Alt+1 全局热键：切换置顶 + 半透明 + 小窗
 *   - 叠加模式下失焦 → 鼠标穿透
 *   - 窗口尺寸记忆
 */

// Windows 控制台设为 UTF-8，解决中文乱码
if (process.platform === 'win32') {
  try { require('child_process').execSync('chcp 65001', { stdio: 'ignore' }); } catch (_) {}
}

const { app, BrowserWindow, globalShortcut, screen } = require('electron');
const path = require('path');
const { start, IS_DEV } = require('../server.js');

// ---- 配置 ----
const SERVER_URL = 'http://localhost:24007/terminal.html';

// ---- 状态 ----
let mainWindow = null;
let isOverlay = false;

// 窗口尺寸记忆（对应 C++ g_bigRect / g_smallRect）
const winState = {
  big: { width: 1200, height: 800 },
  small: { width: 420, height: 750 },
  bigValid: false,
  smallValid: false,
};

// ---- Alt+1 切换叠加模式 ----
function toggleOverlay() {
  if (!mainWindow) return;

  const bounds = mainWindow.getBounds();

  if (isOverlay) {
    // 恢复正常模式：保存小窗，恢复大窗
    winState.small = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
    winState.smallValid = true;

    if (winState.bigValid) {
      mainWindow.setBounds(winState.big);
    }
    mainWindow.setAlwaysOnTop(false);
    mainWindow.setOpacity(1);
    mainWindow.setIgnoreMouseEvents(false);
    // 显示关闭按钮
    mainWindow.webContents.executeJavaScript(
      "var b=document.getElementById('electron-close');if(b)b.style.display=''");
  } else {
    // 进入叠加模式：保存大窗，切到小窗置顶半透明
    winState.big = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
    winState.bigValid = true;

    let target;
    if (winState.smallValid) {
      target = winState.small;
    } else {
      const wa = screen.getPrimaryDisplay().workArea;
      target = {
        x: Math.round(wa.x + (wa.width - 420) / 2),
        y: Math.round(wa.y + (wa.height - 750) / 2),
        width: 420,
        height: 750,
      };
    }

    mainWindow.setBounds(target);
    mainWindow.setAlwaysOnTop(true, 'screen-saver');
    mainWindow.setOpacity(0.7);
    // 隐藏关闭按钮
    mainWindow.webContents.executeJavaScript(
      "var b=document.getElementById('electron-close');if(b)b.style.display='none'");
  }

  isOverlay = !isOverlay;
}

// ---- 创建无框窗口 ----
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    frame: false,
    resizable: true,
    title: '虚空终端',
    backgroundColor: '#0B0F14',  // 暗色背景，消除缩放白闪
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.loadURL(SERVER_URL);

  // 叠加模式下失焦 → 鼠标穿透（模拟 C++ WS_EX_TRANSPARENT）
  mainWindow.on('blur', () => {
    if (isOverlay && mainWindow) {
      mainWindow.setIgnoreMouseEvents(true, { forward: true });
    }
  });
  mainWindow.on('focus', () => {
    if (isOverlay && mainWindow) {
      mainWindow.setIgnoreMouseEvents(false);
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ---- 应用生命周期 ----
app.whenReady().then(async () => {
  try {
    // 启动 HTTP 服务器（复用 server.js 的 start()）
    await start();
    console.log('[electron] HTTP 服务器就绪');
  } catch (err) {
    console.error('[electron] 服务器启动失败:', err.message);
    app.quit();
    return;
  }

  createWindow();

  // 注册 Alt+1 全局热键（对应 C++ RegisterHotKey MOD_ALT '1'）
  const ok = globalShortcut.register('Alt+1', toggleOverlay);
  if (!ok) {
    console.warn('[electron] Alt+1 热键注册失败（可能被其他程序占用）');
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  app.quit();
});
