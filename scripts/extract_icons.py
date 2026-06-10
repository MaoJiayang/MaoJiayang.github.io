#!/usr/bin/env python
"""
从 SE 游戏目录提取物品图标 DDS → WebP，使用精确手动映射。

映射文件: scripts/icon_sources.json
输出: icons/*.webp + icons/mapping.json

用法: python scripts/extract_icons.py
"""

import os
import json
from PIL import Image

GAME_ICONS = r"D:\SteamLibrary\steamapps\common\SpaceEngineers\Content\Textures\GUI\Icons"
OUT_DIR = r"d:\githubPage\icons"
MAP_FILE = r"d:\githubPage\scripts\icon_sources.json"

def main():
    os.makedirs(OUT_DIR, exist_ok=True)

    with open(MAP_FILE, 'r', encoding='utf-8') as f:
        sources = json.load(f)

    mapping = {}
    converted = 0
    missing = 0
    failed = 0

    for chinese_name, rel_path in sources.items():
        # 跳过注释行
        if chinese_name.startswith('===') or chinese_name.startswith('_'):
            continue
        if not rel_path:
            continue

        src = os.path.join(GAME_ICONS, rel_path)

        # 用路径中的实际文件名（不含扩展名）作为输出名
        out_name = os.path.splitext(os.path.basename(rel_path))[0]
        out_path = os.path.join(OUT_DIR, out_name + '.webp')

        if not os.path.exists(src):
            print(f"  MISS: {chinese_name} → {rel_path}")
            missing += 1
            continue

        # 已转换则跳过
        if os.path.exists(out_path):
            mapping[chinese_name] = out_name
            converted += 1
            continue

        try:
            img = Image.open(src)
            img.save(out_path, 'WEBP', quality=85)
            size_kb = os.path.getsize(out_path) / 1024
            print(f"  OK: {chinese_name} ← {rel_path} → {out_name}.webp ({size_kb:.1f}KB)")
            mapping[chinese_name] = out_name
            converted += 1
        except Exception as e:
            print(f"  FAIL: {chinese_name} ({rel_path}): {e}")
            failed += 1

    # 写入映射文件（中文名 → webp 文件名，不含扩展名）
    map_path = os.path.join(OUT_DIR, 'mapping.json')
    with open(map_path, 'w', encoding='utf-8') as f:
        json.dump(mapping, f, ensure_ascii=False, indent=2)

    # 统计
    icon_files = len([f for f in os.listdir(OUT_DIR) if f.endswith('.webp')])
    print(f"\n=== 结果 ===")
    print(f"  转换成功: {converted} 个")
    print(f"  源文件缺失: {missing} 个")
    print(f"  转换失败: {failed} 个")
    print(f"  图标文件总数: {icon_files} 个 WebP")
    print(f"  映射条目: {len(mapping)} 条")

if __name__ == '__main__':
    main()
