/**
 * electron/preload.js — 预加载脚本
 *
 * 在渲染进程注入 Electron 专属 UI（关闭按钮等），不修改 terminal.html。
 */

const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
});

// DOM 就绪后注入关闭按钮（仅 Electron 环境，不影响浏览器版）
window.addEventListener('DOMContentLoaded', function () {
  // 样式
  var style = document.createElement('style');
  style.textContent = [
    '#electron-close {',
    '  position: fixed; top: 0; right: 12px; z-index: 10001;',
    '  width: 28px; height: 24px;',
    '  border: 1px solid rgba(255,255,255,0.08); border-top: none;',
    '  background: rgba(0,0,0,0.5);',
    '  color: rgba(255,255,255,0.45);',
    '  font-size: 13px; line-height: 22px; text-align: center;',
    '  border-radius: 0 0 5px 5px;',
    '  cursor: pointer;',
    '  -webkit-app-region: no-drag;',
    '  transition: background .15s, color .15s;',
    '}',
    '#electron-close:hover {',
    '  background: #e81123; color: #fff; border-color: #e81123;',
    '}',
  ].join('\n');
  document.head.appendChild(style);

  // 按钮
  var btn = document.createElement('button');
  btn.id = 'electron-close';
  btn.textContent = '✕';  // ✕
  btn.title = '关闭';
  btn.onclick = function () { window.close(); };
  document.body.appendChild(btn);
});
