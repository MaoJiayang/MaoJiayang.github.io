#!/usr/bin/env python
"""
一步生成 CSS Sprite：从 SE 游戏 DDS 图标 → sprite.webp + sprite.css

依赖: Pillow (pip install Pillow)
配置: icon_sources.json（中文名→游戏文件相对路径）
输入: SE 游戏图标目录 (Content/Textures/GUI/Icons/)
输出: icons/sprite.webp + icons/sprite.css + icons/mapping.json

用法: python scripts/build_sprite.py
"""

import os, json, math
from PIL import Image

# ---- 配置 ----
GAME_ICONS = r"D:\SteamLibrary\steamapps\common\SpaceEngineers\Content\Textures\GUI\Icons"
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJ_DIR = os.path.dirname(SCRIPT_DIR)
ICON_DIR = os.path.join(PROJ_DIR, 'icons')
MAP_FILE = os.path.join(SCRIPT_DIR, 'icon_sources.json')

CELL = 64        # 每个图标格子像素（2x Retina）
DISPLAY = 32     # CSS 显示尺寸
COLS = 16        # 每行列数
QUALITY = 85     # WebP 质量

def main():
    # 1. 加载映射
    with open(MAP_FILE, 'r', encoding='utf-8') as f:
        sources = json.load(f)

    # 2. 收集图标列表（跳过注释行）
    items = []  # [(中文名, DDS路径), ...]
    for name, rel_path in sources.items():
        if name.startswith('===') or name.startswith('_') or not rel_path:
            continue
        # 绝对路径（模组）直接使用，相对路径拼接 GAME_ICONS
        if os.path.isabs(rel_path):
            src = rel_path
        else:
            src = os.path.join(GAME_ICONS, rel_path)
        if os.path.exists(src):
            items.append((name, src))
        else:
            print(f"  MISS: {name} → {rel_path}")

    unique_srcs = sorted(set(src for _, src in items))
    n = len(unique_srcs)
    rows = math.ceil(n / COLS)

    # 3. 构建 DDS路径 → (col, row) 索引
    src_to_pos = {}
    for i, src in enumerate(unique_srcs):
        src_to_pos[src] = (i % COLS, i // COLS)

    # 4. 拼合 sprite
    canvas = Image.new('RGBA', (COLS * CELL, rows * CELL), (0, 0, 0, 0))

    for src, (col, row) in src_to_pos.items():
        img = Image.open(src).convert('RGBA')
        img.thumbnail((CELL, CELL), Image.LANCZOS)
        x = col * CELL + (CELL - img.width) // 2
        y = row * CELL + (CELL - img.height) // 2
        canvas.paste(img, (x, y), img)

    os.makedirs(ICON_DIR, exist_ok=True)

    # 保存 sprite
    sprite_path = os.path.join(ICON_DIR, 'sprite.webp')
    canvas.save(sprite_path, 'WEBP', quality=QUALITY)
    size_kb = os.path.getsize(sprite_path) / 1024
    print(f"Sprite: {canvas.width}x{canvas.height}, {size_kb:.0f}KB")

    # 5. 生成 CSS
    # CSS 坐标：background-size 缩放到 DISPLAY*COLS x DISPLAY*ROWS
    css_bg_w = DISPLAY * COLS
    css_bg_h = DISPLAY * rows
    css = [
        '/* 虚空终端 — 物品图标 CSS Sprite（自动生成，2x Retina） */',
        '',
        '.si {',
        f'  width: {DISPLAY}px; height: {DISPLAY}px;',
        '  background-image: url(sprite.webp);',
        f'  background-size: {css_bg_w}px {css_bg_h}px;',
        '  display: inline-block; flex-shrink: 0;',
        '  border-radius: 4px;',
        '  image-rendering: auto;',
        '}',
        '',
    ]
    for src, (col, row) in src_to_pos.items():
        class_name = os.path.splitext(os.path.basename(src))[0]
        css.append(f'.si-{class_name} {{ background-position: -{col * DISPLAY}px -{row * DISPLAY}px; }}')

    css_path = os.path.join(ICON_DIR, 'sprite.css')
    with open(css_path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(css) + '\n')

    # 6. 生成中文名→CSS类名 映射
    mapping = {}
    for name, src in items:
        icon_name = os.path.splitext(os.path.basename(src))[0]
        mapping[name] = icon_name

    map_path = os.path.join(ICON_DIR, 'mapping.json')
    with open(map_path, 'w', encoding='utf-8') as f:
        json.dump(mapping, f, ensure_ascii=False, indent=2)

    print(f"CSS: {css_path} ({n} 个图标类)")
    print(f"映射: {len(mapping)} 条")
    print(f"请求: {n} 个文件 → 1 个 sprite")

if __name__ == '__main__':
    main()
