package com.se.terminal

import android.annotation.SuppressLint
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = true
            settings.mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            // 允许 localhost 访问
            settings.allowUniversalAccessFromFileURLs = true

            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(
                    view: WebView?, request: WebResourceRequest?
                ): WebResourceResponse? {
                    // 拦截 CF Analytics 脚本，避免 CORS 报错
                    val url = request?.url?.toString() ?: ""
                    if (url.contains("cloudflareinsights.com")) {
                        return WebResourceResponse("text/javascript", "UTF-8", null)
                    }
                    return super.shouldInterceptRequest(view, request)
                }
            }
        }
        setContentView(webView)

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
