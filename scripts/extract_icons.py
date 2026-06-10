#!/usr/bin/env python
"""
从 SE 游戏目录批量提取物品图标，DDS → WebP 转换，并生成中文名→图标文件名的映射。

用法: python scripts/extract_icons.py
输入: D:\SteamLibrary\steamapps\common\SpaceEngineers\Content\Textures\GUI\Icons\
输出: icons/*.webp + icons/mapping.json
"""

import os
import re
import json
from PIL import Image

GAME_ICONS = r"D:\SteamLibrary\steamapps\common\SpaceEngineers\Content\Textures\GUI\Icons"
OUT_DIR = r"d:\githubPage\icons"

# ---- 物品中文名 → SubtypeName 映射（从 Inventory_base.cs Mapper 提取）----
# MyObjectBuilder_Ore/Stone → Stone
# MyObjectBuilder_Component/SteelPlate → SteelPlate
# MyObjectBuilder_PhysicalGunObject/WelderItem → WelderItem

MAPPER_DATA = [
    # === 矿石 (Ore) ===
    ("石头", "Stone"), ("镍矿", "Nickel"), ("铁矿", "Iron"), ("钴矿", "Cobalt"),
    ("硅矿", "Silicon"), ("镁矿", "Magnesium"), ("银矿", "Silver"), ("金矿", "Gold"),
    ("铂金矿", "Platinum"), ("铀矿", "Uranium"), ("冰", "Ice"), ("钛铁矿", "TitaniumOre"),
    ("甲烷", "Methane"), ("铝矿石", "Aluminum"), ("水晶矿石", "Crystal"),
    ("紫晶矿石", "Amethyst"), ("有机物", "Organic"), ("页岩", "Shale"), ("汽油", "Gasoline"),

    # === 矿锭 (Ingot) ===
    ("沙石", "Stone"), ("镍锭", "Nickel"), ("铁锭", "Iron"), ("钴锭", "Cobalt"),
    ("硅片", "Silicon"), ("镁粉", "Magnesium"), ("银锭", "Silver"), ("金锭", "Gold"),
    ("铂金锭", "Platinum"), ("铀棒", "Uranium"), ("碳", "Carbons"),
    ("三钛合金", "Titanium"), ("浓缩甲烷", "MethaneIngot"), ("铝锭", "AluminumIngot"),
    ("能量水晶", "CrystalIngot"), ("紫晶结构体", "AmethystIngot"), ("柴油", "Diesel"),
    ("重油", "Heavyoil"),

    # === 零件 (Component) ===
    ("结构零件", "Construction"), ("金属网格", "MetalGrid"), ("内衬板", "InteriorPlate"),
    ("钢板", "SteelPlate"), ("梁", "Girder"), ("小钢管", "SmallTube"),
    ("大型钢管", "LargeTube"), ("马达", "Motor"), ("显示器", "Display"),
    ("防弹玻璃", "BulletproofGlass"), ("超导体", "Superconductor"),
    ("计算机", "Computer"), ("反应堆零件", "Reactor"), ("推进器零件", "Thrust"),
    ("重力发生器零件", "GravityGenerator"), ("医疗零件", "Medical"),
    ("无线电零件", "RadioCommunication"), ("探测器零件", "Detector"),
    ("爆炸物", "Explosives"), ("太阳能板", "SolarCell"), ("动力电池", "PowerCell"),
    ("帆布", "Canvas"), ("安全区芯片", "ZoneChip"),
    ("原型框架", "PrototechFrame"), ("原型面板", "PrototechPanel"),
    ("原型电容零件", "PrototechCapacitor"), ("原型推进零件", "PrototechPropulsionUnit"),
    ("原型机械零件", "PrototechMachinery"), ("原型电路零件", "PrototechCircuitry"),
    ("原型冷却零件", "PrototechCoolingUnit"),

    # === 弹药 (AmmoMagazine) ===
    ("S-10弹匣", "SemiAutoPistolMagazine"),
    ("S-20A弹匣", "FullAutoPistolMagazine"),
    ("S-10E弹匣", "ElitePistolMagazine"),
    ("MR-20弹匣", "AutomaticRifleGun_Mag_20rd"),
    ("MR-50A弹匣", "RapidFireAutomaticRifleGun_Mag_50rd"),
    ("MR-8P弹匣", "PreciseAutomaticRifleGun_Mag_5rd"),
    ("MR-30E弹匣", "UltimateAutomaticRifleGun_Mag_30rd"),
    ("5.56mm弹匣", "NATO_5p56x45mm"),
    ("加特林弹药箱", "NATO_25x184mm"),
    ("火箭弹", "Missile200mm"),
    ("重型火炮炮弹", "LargeCalibreAmmo"),
    ("突击火炮炮弹", "MediumCalibreAmmo"),
    ("大型轨道炮穿甲弹", "LargeRailgunAmmo"),
    ("小型轨道炮穿甲弹", "SmallRailgunAmmo"),
    ("机炮弹匣", "AutocannonClip"),

    # === 工具 (PhysicalGunObject) ===
    ("S-10", "SemiAutoPistolItem"), ("S-20A", "FullAutoPistolItem"),
    ("S-10E", "ElitePistolItem"), ("MR-20", "AutomaticRifleItem"),
    ("MR-8P", "PreciseAutomaticRifleItem"),
    ("MR-50A", "RapidFireAutomaticRifleItem"),
    ("MR-30E", "UltimateAutomaticRifleItem"),
    ("RO-1", "BasicHandHeldLauncherItem"),
    ("PRO-1", "AdvancedHandHeldLauncherItem"),
    ("焊接器", "WelderItem"), ("一级焊接器", "Welder2Item"),
    ("二级焊接器", "Welder3Item"), ("三级焊接器", "Welder4Item"),
    ("切割机", "AngleGrinderItem"), ("一级切割机", "AngleGrinder2Item"),
    ("二级切割机", "AngleGrinder3Item"), ("三级切割机", "AngleGrinder4Item"),
    ("手电钻", "HandDrillItem"), ("一级手电钻", "HandDrill2Item"),
    ("二级手电钻", "HandDrill3Item"), ("三级手电钻", "HandDrill4Item"),

    # === 消耗品 (ConsumableItem / Items) ===
    ("医疗包", "Medkit"), ("电力装置", "Powerkit"),
    ("抗辐射医疗箱", "RadiationKit"), ("氧气瓶", "OxygenBottle"),
    ("氢气瓶", "HydrogenBottle"), ("数据板", "Datapad"),

    # === 其他 (PhysicalObject / Other) ===
    ("太空货币", "SpaceCredit"), ("藻类", "Algae"), ("水果", "Fruit"),
    ("谷物", "Grain"), ("蘑菇", "Mushrooms"), ("蔬菜", "Vegetables"),
    ("生哺乳动物肉", "MammalMeatRaw"), ("熟哺乳动物肉", "MammalMeatCooked"),
    ("生昆虫肉", "InsectMeatRaw"), ("熟昆虫肉", "InsectMeatCooked"),
]

# ---- 扫描游戏图标目录 ----
def scan_icons():
    """扫描游戏图标目录，返回 {lowercase_filename_stem: relpath}"""
    icons = {}
    search_dirs = [
        "",              # 根目录 (ore_*, Weapon*, filter_* etc.)
        "component",
        "ingot",
        "ammo",
        "Items",
    ]
    for sub in search_dirs:
        full = os.path.join(GAME_ICONS, sub)
        if not os.path.isdir(full):
            continue
        for f in os.listdir(full):
            if f.lower().endswith('.dds'):
                stem = os.path.splitext(f)[0].lower()
                icons[stem] = os.path.join(full, f)
    return icons

# ---- 模糊匹配 SubtypeName → 图标文件名 ----
def camel_to_snake(name):
    """CamelCase → snake_case"""
    s = re.sub(r'([A-Z]+)([A-Z][a-z])', r'\1_\2', name)
    s = re.sub(r'([a-z\d])([A-Z])', r'\1_\2', s)
    return s.lower()

def match_icon(subtype_name, icons):
    """尝试找到 SubtypeName 对应的图标文件"""
    key = subtype_name.lower()
    snake = camel_to_snake(subtype_name)

    # 1. 直接匹配
    if key in icons:
        return icons[key]

    # 2. snake_case 直接匹配
    if snake in icons:
        return icons[snake]

    # 3. 搜索包含 subtype 或 snake_case 的文件名
    for icon_stem, icon_path in icons.items():
        # 跳过通用占位图标
        if icon_stem in ('na', 'fake', 'blank'):
            continue
        if key in icon_stem or snake in icon_stem:
            # 优先精确匹配（避免 Thrust 匹配到 PrototechThrusterComponent）
            if icon_stem.endswith('_' + snake) or icon_stem.startswith(snake + '_'):
                return icon_path

    # 4. 宽松匹配（去重前缀后的包含匹配）
    for icon_stem, icon_path in icons.items():
        if icon_stem in ('na', 'fake', 'blank'):
            continue
        if key in icon_stem or snake in icon_stem:
            return icon_path

    return None

# ---- 主流程 ----
def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    icons = scan_icons()
    print(f"扫描到 {len(icons)} 个游戏图标")

    mapping = {}    # ChineseName → webp_filename
    converted = 0
    failed = 0

    for chinese_name, subtype in MAPPER_DATA:
        # 检查是否已有映射
        if chinese_name in mapping:
            continue

        src = match_icon(subtype, icons)
        if src is None:
            failed += 1
            continue

        # 用 SubtypeName 作为输出文件名（干净的唯一标识）
        out_name = subtype.replace('/', '_')  # 安全处理
        out_path = os.path.join(OUT_DIR, out_name + '.webp')

        # 如果已转换过则跳过
        if os.path.exists(out_path):
            mapping[chinese_name] = out_name
            converted += 1
            continue

        try:
            img = Image.open(src)
            img.save(out_path, 'WEBP', quality=85)
            size_kb = os.path.getsize(out_path) / 1024
            print(f"  {chinese_name} ← {os.path.basename(src)} → {out_name}.webp ({size_kb:.1f}KB)")
            mapping[chinese_name] = out_name
            converted += 1
        except Exception as e:
            print(f"  FAIL {chinese_name} ({src}): {e}")
            failed += 1

    # 写入映射文件
    map_path = os.path.join(OUT_DIR, 'mapping.json')
    with open(map_path, 'w', encoding='utf-8') as f:
        json.dump(mapping, f, ensure_ascii=False, indent=2)

    print(f"\n完成: {converted} 个图标已转换, {failed} 个未找到")
    print(f"映射文件: {map_path}")
    print(f"图标目录: {OUT_DIR}")

if __name__ == '__main__':
    main()
