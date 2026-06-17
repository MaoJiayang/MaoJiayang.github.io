/**
 * 虚空终端 WebView2 内嵌浏览器
 *
 * 功能:
 *   - WebView2 窗口加载 localhost:24007/terminal.html
 *   - Alt+1 全局热键: 切换置顶 + 半透明 + 手机尺寸
 *   - 置顶时失焦则鼠标穿透（不误触游戏）
 *   - 启动时等待 HTTP server 就绪
 */

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include "webview/webview.h"
#include <windows.h>
#include <winhttp.h>
#include <shellapi.h>
#include <commctrl.h>
#include <string>
#include <algorithm>

#pragma comment(lib, "winhttp.lib")
#pragma comment(lib, "comctl32.lib")

// ---- 全局状态 ----
static HWND g_hwnd = NULL;
static bool g_onTop = false;
static RECT g_bigRect, g_smallRect;
static bool g_bigValid = false, g_smallValid = false;
static webview_t g_wv = NULL;

// ---- HTTP 就绪检测 ----
static bool waitForServer(const char *url, int timeoutSec) {
  for (int i = 0; i < timeoutSec * 10; ++i) {
    HINTERNET hSession = WinHttpOpen(L"WebView/1.0",
      WINHTTP_ACCESS_TYPE_DEFAULT_PROXY, WINHTTP_NO_PROXY_NAME,
      WINHTTP_NO_PROXY_BYPASS, 0);
    if (!hSession) { Sleep(100); continue; }
    URL_COMPONENTS uc = { sizeof(uc) };
    wchar_t host[256], path[1024];
    uc.lpszHostName = host; uc.dwHostNameLength = 256;
    uc.lpszUrlPath = path; uc.dwUrlPathLength = 1024;
    std::wstring wurl(url, url + strlen(url));
    if (!WinHttpCrackUrl(wurl.c_str(), 0, 0, &uc)) {
      WinHttpCloseHandle(hSession); Sleep(100); continue;
    }
    HINTERNET hConnect = WinHttpConnect(hSession, host, uc.nPort, 0);
    if (!hConnect) { WinHttpCloseHandle(hSession); Sleep(100); continue; }
    HINTERNET hReq = WinHttpOpenRequest(hConnect, L"GET", path, NULL,
      WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, 0);
    if (hReq && WinHttpSendRequest(hReq, NULL, 0, NULL, 0, 0, 0) &&
        WinHttpReceiveResponse(hReq, NULL)) {
      DWORD status = 0, size = sizeof(status);
      WinHttpQueryHeaders(hReq, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
        NULL, &status, &size, NULL);
      WinHttpCloseHandle(hReq);
      WinHttpCloseHandle(hConnect);
      WinHttpCloseHandle(hSession);
      if (status == 200) return true;
    }
    if (hReq) WinHttpCloseHandle(hReq);
    if (hConnect) WinHttpCloseHandle(hConnect);
    WinHttpCloseHandle(hSession);
    Sleep(100);
  }
  return false;
}

// ---- 置顶+半透明+缩放 切换 ----
static void toggleTopmost(webview_t w, void *) {
  g_onTop = !g_onTop;
  if (g_onTop) {
    GetWindowRect(g_hwnd, &g_bigRect);
    g_bigValid = true;

    int x, y, ww, wh;
    if (g_smallValid) {
      x  = g_smallRect.left; y  = g_smallRect.top;
      ww = g_smallRect.right - g_smallRect.left;
      wh = g_smallRect.bottom - g_smallRect.top;
    } else {
      ww = 420; wh = 750;
      RECT work; SystemParametersInfo(SPI_GETWORKAREA, 0, &work, 0);
      x = work.left + ((work.right - work.left) - ww) / 2;
      y = work.top  + ((work.bottom - work.top) - wh) / 2;
    }
    SetWindowPos(g_hwnd, NULL, x, y, ww, wh, SWP_NOZORDER | SWP_SHOWWINDOW);

    BringWindowToTop(g_hwnd);
    SetForegroundWindow(g_hwnd);
    SetWindowPos(g_hwnd, HWND_TOPMOST, 0, 0, 0, 0,
                 SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);

    LONG ex = GetWindowLong(g_hwnd, GWL_EXSTYLE);
    SetWindowLong(g_hwnd, GWL_EXSTYLE, ex | WS_EX_LAYERED);
    SetLayeredWindowAttributes(g_hwnd, 0, 180, LWA_ALPHA);
  } else {
    GetWindowRect(g_hwnd, &g_smallRect);
    g_smallValid = true;

    if (g_bigValid) {
      SetWindowPos(g_hwnd, HWND_BOTTOM,
        g_bigRect.left, g_bigRect.top,
        g_bigRect.right - g_bigRect.left,
        g_bigRect.bottom - g_bigRect.top,
        SWP_NOACTIVATE | SWP_SHOWWINDOW);
    }

    SetLayeredWindowAttributes(g_hwnd, 0, 255, LWA_ALPHA);
    LONG ex = GetWindowLong(g_hwnd, GWL_EXSTYLE);
    SetWindowLong(g_hwnd, GWL_EXSTYLE, ex & ~WS_EX_LAYERED);
  }
}

// ---- 窗口子类化 ----
static LRESULT CALLBACK WndProc(HWND h, UINT m, WPARAM w, LPARAM l,
                                UINT_PTR, DWORD_PTR) {
  if (m == WM_HOTKEY && w == 1 && g_wv) {
    webview_dispatch(g_wv, toggleTopmost, NULL);
    return 0;
  }
  if (m == WM_ACTIVATE && g_onTop) {
    LONG ex = GetWindowLong(h, GWL_EXSTYLE);
    if (LOWORD(w) == WA_INACTIVE) {
      SetWindowLong(h, GWL_EXSTYLE, ex | WS_EX_TRANSPARENT);
    } else {
      SetWindowLong(h, GWL_EXSTYLE, ex & ~WS_EX_TRANSPARENT);
    }
  }
  return DefSubclassProc(h, m, w, l);
}

// ---- 主程序 ----
int WINAPI WinMain(HINSTANCE, HINSTANCE, LPSTR, int) {
  const char *defaultUrl = "http://localhost:24007/terminal.html";
  int argc; LPWSTR *argvW = CommandLineToArgvW(GetCommandLineW(), &argc);
  static std::string urlStr;
  if (argc >= 2) {
    int len = WideCharToMultiByte(CP_UTF8, 0, argvW[1], -1, NULL, 0, NULL, NULL);
    urlStr.resize(len);
    WideCharToMultiByte(CP_UTF8, 0, argvW[1], -1, &urlStr[0], len, NULL, NULL);
    if (urlStr.back() == '\0') urlStr.pop_back();
    defaultUrl = urlStr.c_str();
  }
  if (argvW) LocalFree(argvW);

  if (!waitForServer(defaultUrl, 30)) return 1;

  g_wv = webview_create(0, NULL);
  if (!g_wv) return 1;
  g_hwnd = (HWND)webview_get_window(g_wv);
  if (!g_hwnd) { webview_destroy(g_wv); return 1; }

  RegisterHotKey(g_hwnd, 1, MOD_ALT | MOD_NOREPEAT, '1');
  SetWindowSubclass(g_hwnd, WndProc, 1, 0);

  webview_set_title(g_wv, "虚空终端");
  RECT rc;
  SystemParametersInfo(SPI_GETWORKAREA, 0, &rc, 0);
  int w = std::min(1200L, (long)(rc.right - rc.left - 100));
  int h = std::min(800L, (long)(rc.bottom - rc.top - 100));
  webview_set_size(g_wv, w, h, WEBVIEW_HINT_NONE);

  webview_init(g_wv, "window.__webview=1");
  webview_navigate(g_wv, defaultUrl);
  webview_run(g_wv);

  UnregisterHotKey(g_hwnd, 1);
  RemoveWindowSubclass(g_hwnd, WndProc, 1);
  webview_destroy(g_wv);
  return 0;
}
