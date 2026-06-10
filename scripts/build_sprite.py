#!/usr/bin/env python
"""
将 icons/*.webp 合并为 CSS Sprite 大图 + 生成定位 CSS。

输出: icons/sprite.webp + icons/sprite.css
用法: python scripts/build_sprite.py
"""

import os, json, math
from PIL import Image

ICON_DIR = r'd:\githubPage\icons'
CELL = 32        # 每个图标格子（显示尺寸）
COLS = 16        # 每行列数
QUALITY = 85

def main():
    mapping_file = os.path.join(ICON_DIR, 'mapping.json')
    with open(mapping_file, 'r', encoding='utf-8') as f:
        name_map = json.load(f)

    # 收集唯一图标文件名（已排序，保证一致性）
    unique = sorted(set(name_map.values()))
    n = len(unique)
    rows = math.ceil(n / COLS)

    # 创建 sprite 画布
    canvas = Image.new('RGBA', (COLS * CELL, rows * CELL), (0, 0, 0, 0))

    # 图标 → 网格位置的映射
    positions = {}  # icon_name → (col, row)

    for i, icon_name in enumerate(unique):
        col = i % COLS
        row = i // COLS
        positions[icon_name] = (col, row)

        webp_path = os.path.join(ICON_DIR, icon_name + '.webp')
        if not os.path.exists(webp_path):
            print(f"  MISS: {icon_name}.webp")
            continue

        img = Image.open(webp_path).convert('RGBA')
        # 缩放到 CELLxCELL 以内，居中放置
        img.thumbnail((CELL, CELL), Image.LANCZOS)
        x = col * CELL + (CELL - img.width) // 2
        y = row * CELL + (CELL - img.height) // 2
        canvas.paste(img, (x, y), img)

    # 保存 sprite
    sprite_path = os.path.join(ICON_DIR, 'sprite.webp')
    canvas.save(sprite_path, 'WEBP', quality=QUALITY)
    size_kb = os.path.getsize(sprite_path) / 1024
    print(f"Sprite: {sprite_path} ({canvas.width}x{canvas.height}, {size_kb:.0f}KB)")

    # 生成 CSS
    css_lines = [
        '/* 虚空终端 — 物品图标 CSS Sprite */',
        '/* 自动生成，请勿手动编辑 */',
        '',
        '.si {',
        f'  width: {CELL}px; height: {CELL}px;',
        '  background-image: url(sprite.webp);',
        '  background-size: ' + str(canvas.width) + 'px ' + str(canvas.height) + 'px;',
        '  display: inline-block; flex-shrink: 0;',
        '  border-radius: 4px;',
        '  image-rendering: auto;',
        '}',
        '',
    ]

    for icon_name in sorted(positions.keys()):
        col, row = positions[icon_name]
        css_lines.append(f'.si-{icon_name} {{ background-position: -{col * CELL}px -{row * CELL}px; }}')

    # 生成映射对应的 CSS class（中文名 → 图标 class）
    css_lines.append('')
    css_lines.append('/* 中文名 → 图标定位映射 */')

    css_path = os.path.join(ICON_DIR, 'sprite.css')
    with open(css_path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(css_lines) + '\n')

    print(f"CSS: {css_path} ({len(unique)} 个图标类)")
    print(f"请求优化: {len(unique)} → 1")

if __name__ == '__main__':
    main()
