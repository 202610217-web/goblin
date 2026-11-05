# Poly Haven(polyhaven.com, CC0) 재질·모델을 받아 client/public/ph/ 에 넣는다.
#   python3 tools/fetch_polyhaven.py
# 휴대폰 용량 때문에 줄여서 저장: 색 1024px, 노멀 512px, 거칠기 256px (jpg). 모델 glTF는 안의 사진도 512px로.
import json, os, urllib.request
from PIL import Image

OUT = os.path.join(os.path.dirname(__file__), "..", "client", "public", "ph")
TEXTURES = ["asphalt_02", "sparse_grass", "concrete_wall_008", "concrete_block_wall", "forest_leaves_02",
            "brown_planks_03", "rusty_metal_02", "concrete_floor_02", "red_brick_03", "clay_roof_tiles",
            "bark_brown_02", "patterned_concrete_pavers", "metal_plate"]
MODELS = ["wooden_crate_02", "street_lamp_01"]
MAPS = {"Diffuse": ("diff", 1024), "nor_gl": ("nor", 512), "Rough": ("rough", 256)}

def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "goblin-asset-fetch/1.0"})  # 기본 UA는 403
    with urllib.request.urlopen(req) as r:
        return r.read()

def save_jpg(data, path, size, quality=82):
    tmp = path + ".tmp"
    open(tmp, "wb").write(data)
    im = Image.open(tmp).convert("RGB")
    if im.width > size:
        im = im.resize((size, size), Image.LANCZOS)
    im.save(path, "JPEG", quality=quality, optimize=True)
    os.remove(tmp)

os.makedirs(OUT, exist_ok=True)
for t in TEXTURES:
    files = json.loads(get(f"https://api.polyhaven.com/files/{t}"))
    for key, (suffix, size) in MAPS.items():
        save_jpg(get(files[key]["1k"]["jpg"]["url"]), os.path.join(OUT, f"{t}_{suffix}.jpg"), size)
    print("texture", t)
for m in MODELS:
    g = json.loads(get(f"https://api.polyhaven.com/files/{m}"))["gltf"]["1k"]["gltf"]
    d = os.path.join(OUT, m)
    os.makedirs(d, exist_ok=True)
    open(os.path.join(d, f"{m}.gltf"), "wb").write(get(g["url"]))
    for rel, f in g["include"].items():
        p = os.path.join(d, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        data = get(f["url"])
        if rel.endswith(".jpg"):
            save_jpg(data, p, 512)
        else:
            open(p, "wb").write(data)
    print("model", m)
