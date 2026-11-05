// 실사 그래픽: Poly Haven(CC0) 사진 재질, 물리 기반 하늘(대기 산란) + 그 하늘로 구운 환경광, 해 그림자, 블룸.
// 자원은 tools/fetch_polyhaven.py 가 client/public/ph/ 에 받아 둔 것. 늦게 와도 게임은 바로 시작하고 사진이 나중에 입혀진다.
import * as THREE from "three";
import { Sky } from "three/examples/jsm/objects/Sky.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import type { MapId } from "../../shared/world";

const PH = `${import.meta.env.BASE_URL}ph/`;
const loader = new THREE.TextureLoader();

// ---------- 화질 ----------
/** 고화질 = 블룸 + 2048 그림자. 기본: 컴퓨터는 켬, 폰·패드는 끔 (설정은 기기에 저장) */
export function highQuality(): boolean {
  try {
    const v = localStorage.getItem("gfxHigh");
    if (v !== null) return v === "1";
  } catch { /* 저장 못 하는 환경 */ }
  return !matchMedia("(pointer: coarse)").matches;
}
export function setHighQuality(on: boolean) {
  try { localStorage.setItem("gfxHigh", on ? "1" : "0"); } catch { /* 무시 */ }
}

// ---------- 사진 재질 ----------
const texCache = new Map<string, THREE.Texture>();
function tex(file: string, color: boolean): THREE.Texture {
  let t = texCache.get(file);
  if (!t) {
    t = loader.load(PH + file);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 8;
    if (color) t.colorSpace = THREE.SRGBColorSpace;
    texCache.set(file, t);
  }
  return t;
}

/** Poly Haven 재질 (색·노멀·거칠기). tint = 사진 위에 곱하는 색 */
export function photoMat(id: string, opts: { tint?: number; metal?: number; emissive?: number; normal?: number } = {}): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    map: tex(`${id}_diff.jpg`, true),
    normalMap: tex(`${id}_nor.jpg`, false),
    normalScale: new THREE.Vector2(opts.normal ?? 1, opts.normal ?? 1),
    roughnessMap: tex(`${id}_rough.jpg`, false),
    color: opts.tint ?? 0xffffff,
    metalness: opts.metal ?? 0,
    emissive: opts.emissive ?? 0x000000,
  });
}

/**
 * 상자 모양 + 실제 크기(m)에 맞춘 UV: 사진 한 장이 tile 미터를 덮도록 면마다 늘린다 (큰 건물도 무늬가 늘어나지 않음).
 * 크기는 Three 좌표 (sx = 동서, sy = 높이, sz = 남북)
 */
export function boxGeo(sx: number, sy: number, sz: number, tile: number): THREE.BoxGeometry {
  const g = new THREE.BoxGeometry(sx, sy, sz);
  const uv = g.attributes.uv!;
  // BoxGeometry 면 순서: +x, -x, +y, -y, +z, -z (면마다 정점 4개). 각 면의 (가로, 세로) 실제 길이
  const faces: [number, number][] = [[sz, sy], [sz, sy], [sx, sz], [sx, sz], [sx, sy], [sx, sy]];
  for (let f = 0; f < 6; f++) {
    const [w, h] = faces[f]!;
    for (let i = f * 4; i < f * 4 + 4; i++) uv.setXY(i, (uv.getX(i) * w) / tile, (uv.getY(i) * h) / tile);
  }
  return g;
}

/** 바닥 판: 사진 한 장이 tile 미터 */
export function groundGeo(w: number, h: number, tile: number): THREE.PlaneGeometry {
  const g = new THREE.PlaneGeometry(w, h);
  const uv = g.attributes.uv!;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) * w) / tile, (uv.getY(i) * h) / tile);
  return g;
}

// ---------- 건물 창문 (그려서 만드는 무늬, 받을 파일 없음) ----------
/** 창문 8×8칸 무늬 한 장: 창틀·유리(map, 창문 밖은 투명) + 불 켜진 창(emissiveMap). 창문 1칸 = WINDOW m */
export const WINDOW = { W: 3, H: 3, N: 8 } as const;
let windowTex: { map: THREE.CanvasTexture; lit: THREE.CanvasTexture } | null = null;
export function windowMat(glow: number): THREE.MeshStandardMaterial {
  if (!windowTex) {
    const px = 64, n = WINDOW.N;
    const mk = () => { const c = document.createElement("canvas"); c.width = c.height = px * n; return [c, c.getContext("2d")!] as const; };
    const [mc, m] = mk(), [lc, l] = mk();
    l.fillStyle = "#000"; l.fillRect(0, 0, px * n, px * n);
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647; // 매번 같은 배치
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const x = i * px, y = j * px;
      m.fillStyle = "#3b3f46"; m.fillRect(x + 12, y + 10, 40, 46); // 창틀
      m.fillStyle = "#5d7488"; m.fillRect(x + 15, y + 13, 34, 40); // 유리
      m.fillStyle = "#3b3f46"; m.fillRect(x + 31, y + 13, 2, 40); // 가운데 살
      const r = rnd();
      if (r < 0.4) { l.fillStyle = r < 0.15 ? "#9fd0ff" : "#ffcf8a"; l.fillRect(x + 15, y + 13, 34, 40); }
    }
    const tex = (c: HTMLCanvasElement, color: boolean) => {
      const t = new THREE.CanvasTexture(c);
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = 4;
      if (color) t.colorSpace = THREE.SRGBColorSpace;
      return t;
    };
    windowTex = { map: tex(mc, true), lit: tex(lc, true) };
  }
  return new THREE.MeshStandardMaterial({
    map: windowTex.map, alphaTest: 0.5, emissiveMap: windowTex.lit, emissive: 0xffffff, emissiveIntensity: glow,
    roughness: 0.15, metalness: 0.5,
  });
}

// ---------- 모델 (Poly Haven glTF) ----------
const models = new Map<string, Promise<THREE.Object3D>>();
/** 모델을 한 번만 받아 두고, 부를 때마다 복제본을 준다 (그림자 켬) */
export function model(name: string): Promise<THREE.Object3D> {
  let p = models.get(name);
  if (!p) {
    p = new GLTFLoader().loadAsync(`${PH}${name}/${name}.gltf`).then((g) => {
      g.scene.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      return g.scene;
    });
    models.set(name, p);
  }
  return p.then((m) => m.clone());
}

/** 모델을 상자(가로 sx, 높이 sy, 깊이 sz, 바닥 가운데 = 0) 크기에 맞게 늘린다 */
export function fitTo(o: THREE.Object3D, sx: number, sy: number, sz: number) {
  const b = new THREE.Box3().setFromObject(o);
  const s = b.getSize(new THREE.Vector3());
  o.scale.set(sx / s.x, sy / s.y, sz / s.z);
  const c = b.getCenter(new THREE.Vector3());
  o.position.set(-c.x * o.scale.x, -b.min.y * o.scale.y, -c.z * o.scale.z);
  const wrap = new THREE.Group();
  wrap.add(o);
  return wrap;
}

// ---------- 하늘·해·그림자·블룸 ----------
/** 맵별 시간대: 기본 맵 = 맑은 오후, NEON = 늦은 오후. 해는 북쪽(옆)에 둬서 동서로 싸우는 두 팀 누구도 해를 정면으로 보지 않게 */
const LIGHTING: Record<MapId, { elevation: number; azimuth: number; turbidity: number; rayleigh: number; exposure: number; sun: number; sunColor: number; fog: number; fogDensity: number; env: number; hemi: number }> = {
  CLASSIC: { elevation: 38, azimuth: 210, turbidity: 4, rayleigh: 1.2, exposure: 0.55, sun: 3.2, sunColor: 0xfff1de, fog: 0xc3d3e3, fogDensity: 0.006, env: 0.45, hemi: 0.7 },
  NEON: { elevation: 30, azimuth: 180, turbidity: 8, rayleigh: 2.2, exposure: 0.5, sun: 3, sunColor: 0xffc08a, fog: 0x9a8088, fogDensity: 0.009, env: 0.8, hemi: 1.3 },
};

export class Lighting {
  readonly sun = new THREE.DirectionalLight(0xffffff, 3);
  private sky = new Sky();
  private envSky = new Sky();
  private envScene = new THREE.Scene();
  private pmrem: THREE.PMREMGenerator;
  private envRT: THREE.WebGLRenderTarget | null = null;
  private sunDir = new THREE.Vector3();
  private composer: EffectComposer | null = null;
  private hemi = new THREE.HemisphereLight(0xbfd4ff, 0x4a4036, 0.25);
  high: boolean;

  constructor(private renderer: THREE.WebGLRenderer, private scene: THREE.Scene, private camera: THREE.PerspectiveCamera) {
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = highQuality() ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap; // 폰은 가벼운 그림자 (바꾸면 새로고침 후 적용)
    this.sky.scale.setScalar(450);
    scene.add(this.sky);
    this.envSky.material = this.sky.material; // 같은 하늘을 환경광용 장면에 한 번 더
    this.envSky.scale.setScalar(450);
    this.envScene.add(this.envSky);
    this.pmrem = new THREE.PMREMGenerator(renderer);
    const s = this.sun.shadow;
    s.camera.left = s.camera.bottom = -32;
    s.camera.right = s.camera.top = 32;
    s.camera.near = 1;
    s.camera.far = 160;
    s.bias = -0.0004;
    s.normalBias = 0.04;
    scene.add(this.sun, this.sun.target);
    // 아주 약한 하늘빛 (환경광이 대부분을 맡는다)
    scene.add(this.hemi);
    scene.fog = new THREE.FogExp2(0xc3d3e3, 0.006);
    this.high = highQuality();
    this.setQuality(this.high);
  }

  /**
   * 고화질 켬/끔: 그림자 해상도, 블룸.
   * 블룸은 장면을 화면 밖 버퍼에 그려서 재질 셰이더가 따로 필요하다. 바꾸는 순간 한꺼번에 만들면 패드가 몇 초 멈추므로,
   * 지금 화질로 계속 그리면서 새 셰이더를 뒤에서 만들고(compileAsync) 다 되면 바꾼다
   */
  setQuality(high: boolean) {
    this.high = high;
    const token = ++this.qualityToken;
    if (high && !this.composer) {
      const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
      this.composer = new EffectComposer(this.renderer, rt);
      this.composer.addPass(new RenderPass(this.scene, this.camera));
      // 아주 밝은 것(네온·전구)만 번짐
      this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(256, 256), 0.3, 0.2, 12));
      this.composer.addPass(new OutputPass());
      this.resize();
    }
    const prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(high ? this.composer!.readBuffer : null);
    const ready = this.renderer.compileAsync(this.scene, this.camera);
    this.renderer.setRenderTarget(prev);
    const apply = () => {
      if (token !== this.qualityToken) return; // 그 사이에 또 바꿨으면 무시
      const size = high ? 2048 : 1024;
      this.sun.shadow.mapSize.set(size, size);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
      this.sun.castShadow = true;
      this.useComposer = high;
      if (!high) { this.composer?.dispose(); this.composer = null; }
    };
    ready.then(apply, apply);
  }
  private qualityToken = 0;

  /** 화면에 바로 그리는 셰이더(보통 화질)와 버퍼에 그리는 셰이더(고화질 블룸)를 둘 다 미리 만든다. 시작할 때 한 번 */
  warmUp() {
    const prev = this.renderer.getRenderTarget();
    const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
    for (const target of [null, rt]) {
      this.renderer.setRenderTarget(target);
      this.renderer.compileAsync(this.scene, this.camera).catch(() => {});
    }
    this.renderer.setRenderTarget(prev);
    rt.dispose();
  }
  /** 지금 블룸 경로로 그리는지 (셰이더가 준비된 뒤에 바뀐다) */
  private useComposer = false;

  /** 맵에 맞는 시간대로 하늘·해·안개·환경광을 바꾼다 */
  setMap(map: MapId) {
    const L = LIGHTING[map];
    const u = (this.sky.material as THREE.ShaderMaterial).uniforms;
    u.turbidity!.value = L.turbidity;
    u.rayleigh!.value = L.rayleigh;
    u.mieCoefficient!.value = 0.003;
    u.mieDirectionalG!.value = 0.7;
    this.sunDir.setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - L.elevation), THREE.MathUtils.degToRad(L.azimuth));
    u.sunPosition!.value.copy(this.sunDir);
    this.sun.color.setHex(L.sunColor);
    this.sun.intensity = L.sun;
    this.renderer.toneMappingExposure = L.exposure;
    const fog = this.scene.fog as THREE.FogExp2;
    fog.color.setHex(L.fog);
    fog.density = L.fogDensity;
    this.envRT?.dispose();
    this.envRT = this.pmrem.fromScene(this.envScene);
    this.scene.environment = this.envRT.texture;
    // 물리 하늘은 실제 밝기 단위라 매우 밝다 → 환경광은 조금만 (그래도 그늘진 벽이 새까맣지 않을 만큼)
    this.scene.environmentIntensity = L.env;
    this.hemi.intensity = L.hemi;
  }

  /** 그림자가 보이는 곳(내 주변 ±32m)을 따라간다. 게임 좌표가 아니라 Three 좌표 */
  follow(p: THREE.Vector3) {
    this.sun.target.position.copy(p);
    this.sun.position.copy(p).addScaledVector(this.sunDir, 80);
  }

  resize() {
    const s = this.renderer.getSize(new THREE.Vector2());
    this.composer?.setPixelRatio(this.renderer.getPixelRatio());
    this.composer?.setSize(s.x, s.y);
  }

  render() {
    if (this.useComposer && this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }
}
