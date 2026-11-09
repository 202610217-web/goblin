# Poly Haven(polyhaven.com, CC0) 모델을 받아 (재질은 tools/fetch_textures.py) client/public/ph/ 에 넣는다.
#   python3 tools/fetch_polyhaven.py
# 휴대폰 용량 때문에 모델 glTF 안의 사진은 512px로 줄여 저장.
import json, os, urllib.request
from PIL import Image

OUT = os.path.join(os.path.dirname(__file__), "..", "client", "public", "ph")
MODELS = ["wooden_crate_02", "street_lamp_01", "rollershutter_door", "exterior_aircon_unit", "shrub_03", "rock_07", "rock_09"]

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
