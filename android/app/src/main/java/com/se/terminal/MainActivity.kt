package com.se.terminal

import android.annotation.SuppressLint
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        // 切换回 AppTheme（SplashTheme 仅用于启动瞬间）
        setTheme(R.style.AppTheme)
        super.onCreate(savedInstanceState)

        webView = WebView(this).apply {
            overScrollMode = View.OVER_SCROLL_NEVER  // 关掉橡皮筋效果
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = true
            settings.mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            settings.allowUniversalAccessFromFileURLs = true

            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(
                    view: WebView?, request: WebResourceRequest?
                ): WebResourceResponse? {
                    val url = request?.url?.toString() ?: ""
                    if (url.contains("cloudflareinsights.com")) {
                        return WebResourceResponse("text/javascript", "UTF-8", null)
                    }
                    return super.shouldInterceptRequest(view, request)
                }

                override fun onPageFinished(view: WebView?, url: String?) {
                    super.onPageFinished(view, url)
                    // 页面加载完成后重新注入安全区域（确保 CSS 变量生效）
                    if (view != null) {
                        view.post { view.requestApplyInsets() }
                    }
                }
            }

            // 处理前端 requestFullscreen() 调用
            webChromeClient = object : WebChromeClient() {
                private var customView: View? = null
                private var originalSystemUi: Int = 0

                override fun onShowCustomView(view: View?, callback: CustomViewCallback?) {
                    // 进入全屏（如 TradeSheet 图表）
                    customView?.let { onHideCustomView() }
                    customView = view
                    originalSystemUi = window.decorView.systemUiVisibility
                    window.decorView.systemUiVisibility = (
                        View.SYSTEM_UI_FLAG_FULLSCREEN
                        or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                        or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                    )
                    setContentView(view!!)
                }

                override fun onHideCustomView() {
                    window.decorView.systemUiVisibility = originalSystemUi
                    setContentView(webView)
                    customView = null
                }
            }
        }
        setContentView(webView)

        // 状态栏透明 + 暗色窗口背景 → 刘海区域与 app 主题融为一体
        @Suppress("DEPRECATION")
        window.addFlags(android.view.WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS)
        window.statusBarColor = android.graphics.Color.TRANSPARENT

        ViewCompat.setOnApplyWindowInsetsListener(webView) { _, insets ->
            val cutout = insets.getInsets(WindowInsetsCompat.Type.displayCutout())
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            injectSafeArea(webView, cutout.top, cutout.right, cutout.bottom, cutout.left,
                           bars.top, bars.right, bars.bottom, bars.left,
                           ime.bottom)
            insets
        }

        // 隐藏系统栏，内容占满全屏（下滑可临时唤出）
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.insetsController?.apply {
                hide(WindowInsets.Type.statusBars() or WindowInsets.Type.navigationBars())
                systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = (
                View.SYSTEM_UI_FLAG_FULLSCREEN
                or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
            )
        }

        // 启动前台服务
        val intent = Intent(this, ServerService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(intent)
        } else {
            startService(intent)
        }

        // 延迟加载，等服务器就绪
        webView.postDelayed({
            webView.loadUrl("http://localhost:${BuildConfig.HTTP_PORT}/terminal.html")
        }, 500)
    }

    // 将安全区域 insets 注入为 CSS 变量（Android WebView 不支持 env(safe-area-inset-*)）
    private fun injectSafeArea(webView: WebView,
                               cutoutTop: Int, cutoutRight: Int, cutoutBottom: Int, cutoutLeft: Int,
                               barsTop: Int, barsRight: Int, barsBottom: Int, barsLeft: Int,
                               imeBottom: Int) {
        val density = resources.displayMetrics.density
        // 安全区域取 cutout 和 systemBars 的最大值
        val top = Math.max(cutoutTop, barsTop).toDp(density)
        val right = Math.max(cutoutRight, barsRight).toDp(density)
        val bottom = Math.max(cutoutBottom, barsBottom).toDp(density)
        val left = Math.max(cutoutLeft, barsLeft).toDp(density)
        val kb = imeBottom.toDp(density)

        val js = """
            document.documentElement.style.setProperty('--safe-area-inset-top', '${top}px');
            document.documentElement.style.setProperty('--safe-area-inset-right', '${right}px');
            document.documentElement.style.setProperty('--safe-area-inset-bottom', '${bottom}px');
            document.documentElement.style.setProperty('--safe-area-inset-left', '${left}px');
            document.documentElement.style.setProperty('--keyboard-inset-bottom', '${kb}px');
        """.trimIndent()
        webView.evaluateJavascript(js, null)
    }

    private fun Int.toDp(density: Float): Int =
        (this / density).toInt()

    override fun onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack()
        } else {
            super.onBackPressed()
        }
    }
}
