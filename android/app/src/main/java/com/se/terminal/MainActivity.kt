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

    override fun onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack()
        } else {
            super.onBackPressed()
        }
    }
}
