# 실사 재질(모두 CC0)을 세 사이트에서 받아 client/public/ph/ 에 넣고, 실제 크기 표를 client/src/texsizes.ts 로 만든다.
#   python3 tools/fetch_textures.py
# 사이트: Poly Haven(polyhaven.com) · ambientCG(ambientcg.com) · ShareTextures(sharetextures.com)
# 파일: <이름>_diff.jpg(색 1024) _nor.jpg(OpenGL 노멀 512) _rough.jpg(거칠기 256) _ao.jpg(AO 256, 없으면 흰색)
# 가로·세로 비율은 그대로 둔다 (정사각형으로 늘리면 벽돌이 찌그러짐). 크기 표 = 사진 한 장이 덮는 실제 가로·세로 m.
import io, json, os, re, sys, urllib.request, zipfile
from PIL import Image, ImageOps

ROOT = os.path.join(os.path.dirname(__file__), "..")
OUT = os.path.join(ROOT, "client", "public", "ph")
SIZES_TS = os.path.join(ROOT, "client", "src", "texsizes.ts")

POLYHAVEN = ["asphalt_02", "concrete_wall_008", "concrete_block_wall", "forest_leaves_02", "brown_planks_03",
             "red_brick_03", "bark_brown_02", "patterned_concrete_pavers", "leafy_grass", "metal_plate"]
AMBIENTCG = ["Bricks085", "PaintedPlaster017", "Concrete034", "PavingStones128", "RoofingTiles006", "Planks037A",
             "CorrugatedSteel005"]
# ambientCG가 크기를 안 알려 주는 재질: 무늬를 보고 정한 사진 한 장의 실제 가로 m (세로는 사진 비율대로)
ACG_GUESS = {"PaintedPlaster017": 2.0, "Planks037A": 1.6, "CorrugatedSteel005": 1.5}
# ShareTextures: (주소 경로, 사진 한 장 실제 크기 m — 사이트에 크기 정보가 없어 무늬를 보고 정함)
SHARETEXTURES = {"metal_roof": ("metal/metal-roof", 2.0), "stone_tiles": ("floor/stone-tiles", 1.5), "ground_mixed": ("ground/ground-mixed", 3.0)}
SIZE = {"diff": 1024, "nor": 512, "rough": 256, "ao": 256}


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (goblin-asset-fetch)"})  # 기본 UA는 403
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


def save(img, name, kind):
    im = img.convert("RGB" if kind in ("diff", "nor") else "L")
    s = SIZE[kind]
    if im.width > s:  # 긴 쪽 기준으로 줄이고 비율 유지
        k = s / max(im.width, im.height)
        im = im.resize((max(1, round(im.width * k)), max(1, round(im.height * k))), Image.LANCZOS)
    im.save(os.path.join(OUT, f"{name}_{kind}.jpg"), "JPEG", quality=82 if kind == "diff" else 88, optimize=True)


def white_ao(name, like):
    save(Image.new("L", like.size, 255), name, "ao")


def polyhaven(name):
    files = json.loads(get(f"https://api.polyhaven.com/files/{name}"))
    info = json.loads(get(f"https://api.polyhaven.com/info/{name}"))
    diff = Image.open(io.BytesIO(get(files["Diffuse"]["1k"]["jpg"]["url"])))
    save(diff, name, "diff")
    save(Image.open(io.BytesIO(get(files["nor_gl"]["1k"]["jpg"]["url"]))), name, "nor")
    save(Image.open(io.BytesIO(get(files["Rough"]["1k"]["jpg"]["url"]))), name, "rough")
    if "AO" in files: save(Image.open(io.BytesIO(get(files["AO"]["1k"]["jpg"]["url"]))), name, "ao")
    else: white_ao(name, diff)
    w, h = info.get("dimensions") or [2000, 2000]  # mm
    return [w / 1000, h / 1000]


def ambientcg(name):
    d = json.loads(get(f"https://ambientcg.com/api/v2/full_json?id={name}&include=downloadData,dimensionsData"))["foundAssets"][0]
    link = next(x["downloadLink"] for x in d["downloadFolders"]["default"]["downloadFiletypeCategories"]["zip"]["downloads"] if x["attribute"] == "1K-JPG")
    z = zipfile.ZipFile(io.BytesIO(get(link)))
    pick = lambda suffix: next((n for n in z.namelist() if n.endswith(f"_{suffix}.jpg")), None)
    diff = Image.open(z.open(pick("Color")))
    save(diff, name, "diff")
    save(Image.open(z.open(pick("NormalGL"))), name, "nor")
    save(Image.open(z.open(pick("Roughness"))), name, "rough")
    ao = pick("AmbientOcclusion")
    if ao: save(Image.open(z.open(ao)), name, "ao")
    else: white_ao(name, diff)
    w, h = d.get("dimensionX") or 0, d.get("dimensionY") or 0  # cm, 모르는 재질은 0
    return [w / 100, h / 100] if w and h else [ACG_GUESS[name], ACG_GUESS[name] * diff.height / diff.width]


def sharetextures(name, path, meters):
    page = get(f"https://www.sharetextures.com/textures/{path}").decode("utf8", "ignore")
    link = re.search(r"https://files\.sharetextures\.com/file/Share-Textures/[^\"\\]*-1K\.zip", page).group(0)
    z = zipfile.ZipFile(io.BytesIO(get(link)))
    pick = lambda key: next((n for n in z.namelist() if re.search(key, n, re.I)), None)
    diff = Image.open(z.open(pick(r"(basecolor|albedo|diffuse)\.jpg$")))
    save(diff, name, "diff")
    save(Image.open(z.open(pick(r"normal\.jpg$"))), name, "nor")
    rough = pick(r"roughness\.jpg$")
    # 옛 묶음은 거칠기 대신 반사(specular)만 있다: 반사가 셀수록 매끈하므로 뒤집어 쓴다
    save(Image.open(z.open(rough)) if rough else ImageOps.invert(Image.open(z.open(pick(r"specular\.jpg$"))).convert("L")), name, "rough")
    ao = pick(r"(ambientocclusion|[-_]ao)\.jpg$")
    if ao: save(Image.open(z.open(ao)), name, "ao")
    else: white_ao(name, diff)
    return [meters, meters * diff.height / diff.width]


os.makedirs(OUT, exist_ok=True)
only = set(sys.argv[1:])
sizes = {}
jobs = [(n, lambda n=n: polyhaven(n)) for n in POLYHAVEN] + [(n, lambda n=n: ambientcg(n)) for n in AMBIENTCG] \
    + [(n, lambda n=n, p=p, m=m: sharetextures(n, p, m)) for n, (p, m) in SHARETEXTURES.items()]
for name, job in jobs:
    if only and name not in only: continue
    sizes[name] = [round(v, 3) for v in job()]
    print("texture", name, sizes[name])
if not only:
    with open(SIZES_TS, "w") as f:
        f.write("// tools/fetch_textures.py 가 만든 파일: 재질 사진 한 장이 덮는 실제 가로·세로(m). 사이트가 알려 준 크기\n")
        f.write("export const TEX_SIZE: Record<string, [number, number]> = " + json.dumps(sizes) + ";\n")
