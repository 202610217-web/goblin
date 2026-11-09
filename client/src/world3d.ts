// Three.js 장면: 맵, 캐릭터, 3인칭 카메라
// 좌표 변환: 게임 (x=동, y=북, z=위) → Three.js (X=x, Y=z, Z=-y)
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { BOXES, BOXES_BY_MAP, type Box, HOUSES, MAPS, type MapId, PHYS, type TeamId, mapAt } from "../../shared/world";
import { CELL, NEON_GRID, NEON_ZONES, cellCenter } from "../../shared/neon";
import { AIM, type Vec3, aimConverge, aimRay, clampPitch, rayAabb } from "../../shared/aim";
import type { Body } from "../../shared/sim";
import type { ClassId } from "../../shared/classes";
import { firstSolid } from "../../shared/arrow";
import { CONFIG } from "./config";
import { Lighting, WINDOW, boxGeo, groundGeo, meterUV, model, photoMat, windowMat } from "./graphics";
import { Character, PROPS, type Pose } from "./characters";
import { StylizedFx } from "./ultfx";

const tmp = new THREE.Vector3();
/** 만화풍 명암 3단계 (MeshToonMaterial) */
const TOON3 = (() => { const t = new THREE.DataTexture(new Uint8Array([90, 170, 255]), 3, 1, THREE.RedFormat); t.minFilter = t.magFilter = THREE.NearestFilter; t.needsUpdate = true; return t; })();
const UP = new THREE.Vector3(0, 1, 0);
/** 매번 같은 배치를 만드는 난수 (장식 위치용) */
function seeded(seed: number) { return () => (seed = (seed * 16807) % 2147483647) / 2147483647; }

export class World3D {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  /** 카메라 방향 (게임 좌표계 기준 라디안). yaw = 카메라가 바라보는 수평 방향 */
  yaw = 0;
  pitch: number = CONFIG.CAMERA_PITCH_DEFAULT;

  constructor(container: HTMLElement) {
    // 폰·패드: 계단 현상 보정(antialias)과 높은 해상도가 발열의 큰 원인이라 낮춘다
    const touch = matchMedia("(pointer: coarse)").matches;
    this.renderer = new THREE.WebGLRenderer({ antialias: !touch, powerPreference: touch ? "default" : "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, touch ? CONFIG.MAX_DPR_TOUCH : CONFIG.MAX_DPR));
    container.appendChild(this.renderer.domElement);
    this.camera = new THREE.PerspectiveCamera(CONFIG.CAMERA_FOV, 16 / 9, 0.1, 600);
    // 물리 하늘 + 하늘로 구운 환경광 + 해 그림자 + (고화질) 블룸
    this.light = new Lighting(this.renderer, this.scene, this.camera);

    PROPS.then((p) => { this.props = p; }).catch(() => {});
    this.buildMap();
    this.buildNeon();
    this.setMap("CLASSIC");
    // 처음 NEON으로 바꿀 때·화질을 바꿀 때 한참 멈추지 않게, 숨긴 맵까지 두 화질의 셰이더를 미리 만든다 (compile은 보이는 것만 훑음)
    this.neon.visible = true;
    this.light.warmUp();
    this.neon.visible = false;
    this.resize();
    window.addEventListener("resize", () => this.resize());
  }

  /** 지금 렌더링 해상도 배율 */
  get pixelRatio(): number { return this.renderer.getPixelRatio(); }
  /** 렌더링 해상도 배율 바꾸기 (화면이 버거우면 낮춘다) */
  setPixelRatio(pr: number) {
    this.renderer.setPixelRatio(pr);
    this.resize();
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.light?.resize();
  }

  readonly light: Lighting;

  /** 게임 좌표 → Three 좌표 */
  static toThree(x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    return out.set(x, z, -y);
  }

  /** 맵별 장면 묶음 (고른 맵만 보인다) */
  private classic = new THREE.Group();
  private neon = new THREE.Group();

  /** 보여 줄 맵 */
  setMap(map: MapId) {
    if (map === this.map) return;
    this.map = map;
    this.classic.visible = map === "CLASSIC";
    this.neon.visible = map === "NEON";
    this.light.setMap(map);
  }
  private map: MapId | null = null;

  /** 그림자를 드리우고 받는 상자 하나 (같은 재질끼리 flushPieces에서 한 메시로 합쳐 그리기 호출을 줄인다) */
  private addBox(b: Box, mat: THREE.Material) {
    const cx = (b.x0 + b.x1) / 2, cy = (b.z0 + b.z1) / 2, cz = -(b.y0 + b.y1) / 2;
    this.piece(mat, boxGeo(b.x1 - b.x0, b.z1 - b.z0, b.y1 - b.y0, cx, cy, cz), cx, cy, cz);
  }

  /** 나무 상자들: 사진 재질 상자를 먼저 그려 두고, 모델이 오면 한 번에(인스턴스) 그리고 사진 상자는 숨긴다 */
  private addCrates(g: THREE.Group, boxes: Box[]) {
    const fallback = photoMat("brown_planks_03");
    for (const b of boxes) this.addBox(b, fallback);
    this.instanced(g, "wooden_crate_02", (bb) => {
      const size = bb.getSize(new THREE.Vector3()), c = bb.getCenter(new THREE.Vector3());
      const fit = new THREE.Matrix4().makeTranslation(-c.x, -bb.min.y, -c.z);
      return boxes.map((b) => new THREE.Matrix4().compose(new THREE.Vector3((b.x0 + b.x1) / 2, b.z0, -(b.y0 + b.y1) / 2), new THREE.Quaternion(),
        new THREE.Vector3((b.x1 - b.x0) / size.x, (b.z1 - b.z0) / size.y, (b.y1 - b.y0) / size.z)).multiply(fit));
    }).then(() => { fallback.visible = false; }, () => { /* 모델을 못 받으면 사진 상자 그대로 */ });
  }

  /** 모델 하나를 여러 자리에 그리기 호출 몇 번으로 (부분마다 InstancedMesh). place = 모델 전체 경계 상자 → 자리별 변환 */
  private instanced(g: THREE.Group, name: string, place: (bb: THREE.Box3) => THREE.Matrix4[], tweak?: (o: THREE.Object3D) => void): Promise<void> {
    return model(name).then((o) => {
      tweak?.(o);
      o.updateMatrixWorld(true);
      const mats = place(new THREE.Box3().setFromObject(o));
      o.traverse((c) => {
        const mesh = c as THREE.Mesh;
        if (!mesh.isMesh || !mats.length) return;
        const im = new THREE.InstancedMesh(mesh.geometry.clone().applyMatrix4(mesh.matrixWorld), mesh.material, mats.length);
        mats.forEach((m, j) => im.setMatrixAt(j, m));
        im.castShadow = im.receiveShadow = true;
        g.add(im);
      });
    });
  }


  private buildMap() {
    this.scene.add(this.classic);
    const g = this.classic;
    // 하늘에 떠 있는 풀밭 섬 (울타리 밖 12m까지 땅, 그 아래는 바위 절벽) + 구름 바다 + 먼 섬들
    const grass = photoMat("leafy_grass", { tint: 0x9fb488 });
    this.island(g, PHYS.MAP_X / 2, PHYS.MAP_Y / 2, PHYS.MAP_X / 2 + 12, PHYS.MAP_Y / 2 + 12, 28, grass, 3);
    this.skyAround(g, PHYS.MAP_X / 2, PHYS.MAP_Y / 2, 28, grass, photoMat("forest_leaves_02", { scale: 0.35, tint: 0xa8c890 }), 17);

    // 맵 테두리 (낮은 나무 울타리, 보기용)
    const planks = photoMat("brown_planks_03");
    for (const [cx, cy, sx, sy] of [[PHYS.MAP_X / 2, -0.1, PHYS.MAP_X + 0.4, 0.2], [PHYS.MAP_X / 2, PHYS.MAP_Y + 0.1, PHYS.MAP_X + 0.4, 0.2],
      [-0.1, PHYS.MAP_Y / 2, 0.2, PHYS.MAP_Y], [PHYS.MAP_X + 0.1, PHYS.MAP_Y / 2, 0.2, PHYS.MAP_Y]] as const) {
      this.addBox({ x0: cx - sx / 2, x1: cx + sx / 2, y0: cy - sy / 2, y1: cy + sy / 2, z0: 0, z1: 0.6, kind: "wall" }, planks);
    }

    // 충돌 상자들 (서버와 같은 데이터)에 사진 재질
    const mats = {
      wall: photoMat("concrete_block_wall"),
      step: photoMat("Concrete034", { tint: 0xa8a49c }),
      platform: photoMat("PavingStones128", { tint: 0xa09c94 }),
      houseA: photoMat("Bricks085", { tint: 0xffe0d4 }),
      houseB: photoMat("Bricks085", { tint: 0xc4d0ff }),
    };
    const cap = photoMat("Concrete034", { tint: 0xa8a49c });
    for (const b of BOXES_BY_MAP.CLASSIC) {
      if (b.kind === "crate") continue;
      const key = (b.kind === "house" ? `house${b.team}` : b.kind) as keyof typeof mats;
      this.addBox(b, mats[key]);
      if (b.kind === "wall") this.addCap(b, cap);
    }
    this.addCrates(g, BOXES_BY_MAP.CLASSIC.filter((b) => b.kind === "crate"));
    this.flushPieces(g);
    // 울타리와 섬 끝 사이 수풀·바위·나무 (보기용, 맵 밖이라 충돌 없음)
    const rnd = seeded(11);
    const ring = (gap: number, near: number, far: number) => {
      const pts: [number, number, number, number][] = [];
      const X = PHYS.MAP_X, Y = PHYS.MAP_Y;
      for (let t = 0; t < 2 * (X + Y); t += gap * (0.6 + rnd() * 0.8)) {
        const out = near + rnd() * (far - near);
        const [x, y] = t < X ? [t, -out] : t < X + Y ? [X + out, t - X] : t < 2 * X + Y ? [2 * X + Y - t, Y + out] : [-out, 2 * (X + Y) - t];
        pts.push([x, y, 0, rnd() * Math.PI * 2]);
      }
      return pts;
    };
    this.scatter(g, "shrub_03", ring(2.2, 0.8, 4).map(([x, y, , r]) => [x, y, 6 + rnd() * 4, r]));
    this.scatter(g, "rock_07", ring(11, 3, 9).map(([x, y, , r]) => [x, y, 4 + rnd() * 4, r]));
    this.scatter(g, "rock_09", ring(9, 2, 8).map(([x, y, , r]) => [x, y, 6 + rnd() * 6, r]));
    // 섬 가장자리 나무 줄. 줄기 + 잎 덩어리 두 개 = 그리기 호출 2번
    const trees = ring(6, 5, 9);
    // UV를 실제 둘레·높이(m)로: 나무껍질이 세로로 길게 늘어나지 않게
    const trunk = new THREE.InstancedMesh(meterUV(new THREE.CylinderGeometry(0.18, 0.28, 3, 6), 1.45, 3).translate(0, 1.5, 0), photoMat("bark_brown_02"), trees.length);
    const crown = new THREE.InstancedMesh(meterUV(new THREE.IcosahedronGeometry(1, 1), 6.3, 3.1), photoMat("forest_leaves_02", { scale: 0.35, tint: 0xa8c890 }), trees.length * 2);
    const mt = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
    trees.forEach(([x, y, , r], k) => {
      const s = 1.4 + rnd() * 1.2;
      q.setFromAxisAngle(UP, r);
      trunk.setMatrixAt(k, mt.compose(tmp.set(x, 0, -y), q, sc.set(s, s, s)));
      crown.setMatrixAt(k * 2, mt.compose(tmp.set(x, 3.6 * s, -y), q, sc.set(2.2 * s, 2 * s, 2.2 * s)));
      crown.setMatrixAt(k * 2 + 1, mt.compose(tmp.set(x + 0.6 * s, 4.8 * s, -y), q, sc.set(1.5 * s, 1.4 * s, 1.5 * s)));
    });
    trunk.castShadow = crown.castShadow = true;
    g.add(trunk, crown);

    // 집 지붕 (기와) + 문
    for (const t of ["A", "B"] as TeamId[]) {
      const h = HOUSES[t];
      // 지붕 UV: u = 밑둘레(네 변), v = 비탈 길이 (m) → 기와 크기가 실제와 같고 줄이 수평
      const r = h.size * 0.78, slant = Math.hypot(2.4, r * Math.SQRT1_2);
      const roof = new THREE.Mesh(meterUV(new THREE.ConeGeometry(r, 2.4, 4), 4 * r * Math.SQRT2, slant), photoMat("RoofingTiles006", { tint: t === "A" ? 0xffc0b0 : 0xb8c8ff }));
      roof.rotation.y = Math.PI / 4;
      roof.position.set(h.x, h.height + 1.2, -h.y);
      roof.castShadow = true;
      g.add(roof);
      const doorX = t === "A" ? h.x + h.size / 2 + 0.01 : h.x - h.size / 2 - 0.01;
      // 문 판자는 세로로: 가로 2.4 × 세로 1.4 판을 90° 돌려 세움 (무늬 = 판의 가로 방향)
      const door = new THREE.Mesh(groundGeo(2.4, 1.4).rotateZ(Math.PI / 2), photoMat("Planks037A", { tint: 0xb89a80 }));
      door.rotation.y = t === "A" ? Math.PI / 2 : -Math.PI / 2;
      door.position.set(doorX, 1.2, -h.y);
      g.add(door);
    }
  }

  /** 담장 위 갓돌 (양옆으로 조금 넓게, 보기용) */
  private addCap(b: Box, mat: THREE.Material) {
    const cx = (b.x0 + b.x1) / 2, cz = -(b.y0 + b.y1) / 2;
    this.piece(mat, boxGeo(b.x1 - b.x0 + 0.16, 0.12, b.y1 - b.y0 + 0.16, cx, b.z1 + 0.06, cz), cx, b.z1 + 0.06, cz);
  }

  /** 건물 장식 조각을 모아 뒀다가 재질별로 한 메시로 합친다 (그리기 호출을 줄여 패드에서도 가볍게) */
  private pieces = new Map<THREE.Material, THREE.BufferGeometry[]>();
  private piece(mat: THREE.Material, geo: THREE.BufferGeometry, x: number, y: number, z: number, rotY = 0) {
    geo.rotateY(rotY).translate(x, y, z);
    const list = this.pieces.get(mat) ?? [];
    list.push(geo);
    this.pieces.set(mat, list);
  }
  private flushPieces(g: THREE.Group) {
    for (const [mat, list] of this.pieces) {
      const m = new THREE.Mesh(mergeGeometries(list), mat);
      m.castShadow = m.receiveShadow = !(mat as THREE.MeshStandardMaterial).emissiveMap; // 창문 판은 그림자 없음
      g.add(m);
    }
    this.pieces.clear();
  }

  /** 건물 면 하나에 2층부터 창문 (창문 칸이 잘리지 않게 칸 수로 맞춤). x, z, rot = 면 가운데 Three 좌표와 바깥 방향 */
  private addWindows(win: THREE.Material, x: number, z: number, len: number, rot: number, top: number, seed: number) {
    const rows = Math.floor((top - 3) / WINDOW.H), cols = Math.floor((len - 0.6) / WINDOW.W);
    if (rows <= 0 || cols <= 0) return;
    const geo = new THREE.PlaneGeometry(cols * WINDOW.W, rows * WINDOW.H);
    const uv = geo.attributes.uv!, ou = (seed % WINDOW.N) / WINDOW.N, ov = ((seed * 3) % WINDOW.N) / WINDOW.N;
    for (let k = 0; k < uv.count; k++) uv.setXY(k, ou + (uv.getX(k) * cols) / WINDOW.N, ov + (uv.getY(k) * rows) / WINDOW.N);
    this.piece(win, geo, x, 2.7 + (rows * WINDOW.H) / 2, z, rot);
  }

  /** 상자의 네 면: Three 좌표 (x, z), 면 길이, 바깥을 보게 돌리는 각도 (평면은 처음에 +Z를 봄). 0=남 1=북 2=동 3=서 */
  private static faces(b: Box, e = 0.02): [number, number, number, number][] {
    const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
    return [[cx, -b.y0 + e, b.x1 - b.x0, 0], [cx, -b.y1 - e, b.x1 - b.x0, Math.PI], [b.x1 + e, -cy, b.y1 - b.y0, Math.PI / 2], [b.x0 - e, -cy, b.y1 - b.y0, -Math.PI / 2]];
  }

  /**
   * 건물 꾸미기 (충돌 없음: 벽에 붙이거나 건물 속에 묻거나 사람이 못 가는 옥상에만).
   * 2층부터 창문, 옥상 난간, 1층 셔터 문, 옥상 실외기
   */
  private dressBuilding(b: Box, i: number, win: THREE.Material, trim: THREE.Material, shutters: THREE.Matrix4[], aircons: THREE.Matrix4[]) {
    const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2, sx = b.x1 - b.x0, sy = b.y1 - b.y0, top = b.z1;
    World3D.faces(b).forEach(([x, z, len, rot], f) => {
      this.addWindows(win, x, z, len, rot, top, i * 3 + f);
      // 1층 셔터 문: 면 두 개 중 하나꼴 (문틀 깊이만큼 건물 속에 묻는다)
      if (len >= 5 && (i + f) % 2 === 0) {
        shutters.push(new THREE.Matrix4().makeTranslation(x, 0, z).multiply(new THREE.Matrix4().makeRotationY(rot)).multiply(new THREE.Matrix4().makeTranslation(-1, 0, -0.28)));
      }
    });
    // 옥상 난간 (위로만 0.5m)
    for (const [px, pz, w, d] of [[cx, -b.y0, sx, 0.2], [cx, -b.y1, sx, 0.2], [b.x0, -cy, 0.2, sy], [b.x1, -cy, 0.2, sy]] as const) {
      this.piece(trim, boxGeo(w + 0.2, 0.5, d + 0.2, px, top + 0.25, pz), px, top + 0.25, pz);
    }
    aircons.push(new THREE.Matrix4().makeTranslation(cx + sx * 0.18, top + 0.32, -cy + sy * 0.15).multiply(new THREE.Matrix4().makeRotationY((i % 4) * Math.PI / 2)));
  }

  /**
   * 하늘에 떠 있는 섬: 위는 평평한 땅(top 재질), 아래는 거꾸로 선 바위 덩어리.
   * cx, cy = 가운데 지도 좌표, ax, ay = 반지름(m), depth = 바위 깊이, y0 = 땅 높이
   */
  private island(g: THREE.Group, cx: number, cy: number, ax: number, ay: number, depth: number, top: THREE.Material, seed: number, y0 = 0) {
    const rnd = seeded(seed), N = 72, K = 7, p1 = rnd() * 6, p2 = rnd() * 6;
    // 둥근 직사각형 외곽 (초타원 |x/ax|^6 + |y/ay|^6 = 1). 완만한 물결로 바깥으로만 들쭉날쭉 → 울타리 안쪽은 항상 땅
    const rim: THREE.Vector2[] = [];
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a), j = 1 + 0.025 * (2 + Math.sin(3 * a + p1) + Math.sin(7 * a + p2));
      rim.push(new THREE.Vector2(cx + ax * j * Math.sign(c) * Math.abs(c) ** (1 / 3), cy + ay * j * Math.sign(s) * Math.abs(s) ** (1 / 3)));
    }
    const ground = new THREE.Mesh(new THREE.ShapeGeometry(new THREE.Shape(rim)).rotateX(-Math.PI / 2).translate(0, y0, 0), top); // UV = 지도 좌표(m)
    ground.receiveShadow = true;
    // 바위: 테두리 고리를 아래로 내려가며 안쪽으로 좁힌다 (k=1은 살짝 바깥 = 튀어나온 턱). UV = 둘레 길이 × 깊이 (m)
    const pos: number[] = [], uv: number[] = [], idx: number[] = [];
    let perim = 0;
    const along = rim.map((p, i) => (perim += i ? p.distanceTo(rim[i - 1]!) : 0));
    const loop = perim + rim[N - 1]!.distanceTo(rim[0]!);
    for (let k = 0; k <= K; k++) {
      const t = k / K, shrink = k === 1 ? 1.03 : 1 - 0.88 * t ** 1.3, y = -depth * t ** 1.15 - (k === 1 ? 0.6 : 0);
      for (let i = 0; i <= N; i++) {
        const p = rim[i % N]!, wob = k ? 1 + (rnd() - 0.5) * 0.14 : 1;
        pos.push(cx + (p.x - cx) * shrink * wob, y0 + y, -(cy + (p.y - cy) * shrink * wob));
        uv.push(i < N ? along[i]! : loop, -y);
      }
    }
    for (let k = 0; k < K; k++) for (let i = 0; i < N; i++) { const a = k * (N + 1) + i, b = a + N + 1; idx.push(a, b, a + 1, a + 1, b, b + 1); }
    const tip = pos.length / 3; // 맨 아래 뾰족한 끝
    pos.push(cx, y0 - depth * 1.25, -cy);
    uv.push(0, depth * 1.25);
    for (let i = 0; i < N; i++) { const a = K * (N + 1) + i; idx.push(a, tip, a + 1); }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    this.cliffMat ??= photoMat("cliff_side", { tint: 0xa89a88 });
    g.add(ground, new THREE.Mesh(geo, this.cliffMat));
  }
  private cliffMat?: THREE.Material;

  /** 섬 둘레 하늘: 아래 구름 바다, 섬 둘레 구름 덩어리, 먼 작은 섬들 (모두 그림자·충돌 없음) */
  private skyAround(g: THREE.Group, cx: number, cy: number, depth: number, top: THREE.Material, leaf: THREE.Material, seed: number) {
    const rnd = seeded(seed);
    // 부드러운 흰 구름 무늬 (가장자리를 넘친 덩어리는 반대편에도 그려서 이어 깔아도 이음매가 없다)
    const blobs = (size: number, n: number, bg: string | null, tile: boolean) => {
      const c = document.createElement("canvas");
      c.width = c.height = size;
      const x = c.getContext("2d")!;
      if (bg) { x.fillStyle = bg; x.fillRect(0, 0, size, size); }
      for (let i = 0; i < n; i++) {
        const r = size * (0.08 + rnd() * 0.16), px = tile ? rnd() * size : size / 2 + (rnd() - 0.5) * size * 0.45, py = tile ? rnd() * size : size / 2 + (rnd() - 0.5) * size * 0.2;
        for (const ox of tile ? [-size, 0, size] : [0]) for (const oy of tile ? [-size, 0, size] : [0]) {
          const gr = x.createRadialGradient(px + ox, py + oy, 0, px + ox, py + oy, r);
          gr.addColorStop(0, "rgba(255,255,255,0.7)");
          gr.addColorStop(1, "rgba(255,255,255,0)");
          x.fillStyle = gr;
          x.fillRect(px + ox - r, py + oy - r, r * 2, r * 2);
        }
      }
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      return t;
    };
    const seaTex = blobs(256, 70, "#dbe5f0", true);
    seaTex.wrapS = seaTex.wrapT = THREE.RepeatWrapping;
    seaTex.repeat.set(10, 10);
    const sea = new THREE.Mesh(new THREE.CircleGeometry(900, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: seaTex }));
    sea.position.set(cx, -depth - 30, -cy);
    g.add(sea);
    const puff = new THREE.SpriteMaterial({ map: blobs(128, 9, null, false), transparent: true, depthWrite: false, opacity: 0.95 });
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * Math.PI * 2 + rnd() * 0.3, d = 120 + rnd() * 170, s = 50 + rnd() * 70;
      const sp = new THREE.Sprite(puff);
      sp.position.set(cx + Math.cos(a) * d, -depth - 10 + rnd() * (depth + 25), -(cy + Math.sin(a) * d));
      sp.scale.set(s, s * 0.45, 1);
      g.add(sp);
    }
    // 먼 작은 섬: 눈높이보다 조금 아래라 풀밭 윗면과 나무가 보인다
    const crown = meterUV(new THREE.IcosahedronGeometry(1, 1), 6.3, 3.1);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + 0.5 + rnd() * 0.8, d = 170 + rnd() * 120, x = cx + Math.cos(a) * d, y = cy + Math.sin(a) * d;
      const rx = 9 + rnd() * 12, ry = 7 + rnd() * 9, y0 = -22 + rnd() * 14;
      this.island(g, x, y, rx, ry, 0.9 * Math.min(rx, ry) + 6, top, seed * 7 + i, y0);
      for (let k = 0; k < 4; k++) {
        const t = new THREE.Mesh(crown, leaf), s = 2.5 + rnd() * 2.5;
        t.position.set(x + (rnd() - 0.5) * rx, y0 + s * 0.8, -(y + (rnd() - 0.5) * ry));
        t.scale.set(s, s * 1.2, s);
        g.add(t);
      }
    }
  }

  /** 모델의 각 부분을 자리마다 하나씩 돌려 가며 한꺼번에 그린다 (InstancedMesh = 그리기 호출 몇 번). pts = [x, y, 크기, 회전] */
  private scatter(g: THREE.Group, name: string, pts: [number, number, number, number][]) {
    model(name).then((o) => {
      o.updateMatrixWorld(true);
      const parts: [THREE.BufferGeometry, THREE.Material][] = [];
      o.traverse((c) => {
        const mesh = c as THREE.Mesh;
        if (!mesh.isMesh) return;
        const geo = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
        geo.computeBoundingBox();
        const bb = geo.boundingBox!;
        geo.translate(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -(bb.min.z + bb.max.z) / 2); // 바닥 가운데 = 원점
        parts.push([geo, mesh.material as THREE.Material]);
      });
      const mat4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
      parts.forEach(([geo, mat], k) => {
        const mine = pts.filter((_, j) => j % parts.length === k);
        if (!mine.length) return;
        const im = new THREE.InstancedMesh(geo, mat, mine.length);
        mine.forEach(([x, y, s, r], j) => im.setMatrixAt(j, mat4.compose(tmp.set(x, 0, -y), q.setFromAxisAngle(UP, r), sc.setScalar(s))));
        im.castShadow = im.receiveShadow = true;
        g.add(im);
      });
    }).catch(() => { /* 못 받으면 장식 없이 */ });
  }

  /** NEON DISTRICT: 서버와 같은 충돌 상자(BOXES_BY_MAP.NEON)를 그대로 그리고, 네온 테두리·나무·사이트 글자만 장식으로 더한다 */
  private buildNeon() {
    const g = this.neon;
    this.scene.add(g);
    const m = MAPS.NEON, w = m.x1 - m.x0, h = m.y1 - m.y0;
    // 바닥: 아스팔트 사진, 사이트 구역은 보도블록, 스폰 구역은 색 반투명 판
    const floor = (r: { x0: number; y0: number; x1: number; y1: number }, mat: THREE.Material, y: number) => {
      const p = new THREE.Mesh(groundGeo(r.x1 - r.x0, r.y1 - r.y0, (r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2), mat);
      p.rotation.x = -Math.PI / 2;
      p.position.set((r.x0 + r.x1) / 2, y, -(r.y0 + r.y1) / 2);
      p.receiveShadow = true;
      g.add(p);
    };
    // 하늘에 떠 있는 도시 섬 (울타리 밖 10m까지 아스팔트, 그 아래는 바위 절벽)
    const asphalt = photoMat("asphalt_02");
    this.island(g, m.x0 + w / 2, m.y0 + h / 2, w / 2 + 10, h / 2 + 10, 40, asphalt, 7);
    this.skyAround(g, m.x0 + w / 2, m.y0 + h / 2, 40, photoMat("leafy_grass", { tint: 0x9fb488 }), photoMat("forest_leaves_02", { scale: 0.35, tint: 0xa8c890 }), 23);
    floor(NEON_ZONES.siteA, photoMat("patterned_concrete_pavers", { tint: 0xffd9a0 }), 0.01);
    floor(NEON_ZONES.siteB, photoMat("patterned_concrete_pavers", { tint: 0xb8f0ff }), 0.01);
    const zone = (color: number) => new THREE.MeshStandardMaterial({ color, transparent: true, opacity: 0.3, depthWrite: false, roughness: 1 });
    floor(NEON_ZONES.spawnA, zone(0xff5a5a), 0.02);
    floor(NEON_ZONES.spawnB, zone(0x4fa8ff), 0.02);
    const fenceMat = photoMat("concrete_block_wall", { tint: 0x9aa0b0 });
    for (const [cx, cy, sx, sy] of [[m.x0 + w / 2, -0.1, w + 0.4, 0.2], [m.x0 + w / 2, h + 0.1, w + 0.4, 0.2], [m.x0 - 0.1, h / 2, 0.2, h], [m.x1 + 0.1, h / 2, 0.2, h]] as const) {
      this.addBox({ x0: cx - sx / 2, x1: cx + sx / 2, y0: cy - sy / 2, y1: cy + sy / 2, z0: 0, z1: 1.2, kind: "wall" }, fenceMat);
    }
    // 서버와 같은 충돌 상자에 사진 재질. 건물은 세 가지 외벽(콘크리트·칠한 회벽·붉은 벽돌)을 번갈아
    const facades = [photoMat("concrete_wall_008", { tint: 0x8a8fa0 }), photoMat("PaintedPlaster017", { tint: 0xa89888 }), photoMat("red_brick_03", { tint: 0xa8989c })];
    const mats: Record<string, THREE.Material> = {
      wall: photoMat("concrete_block_wall"),
      shed: photoMat("CorrugatedSteel005", { tint: 0xb8bcc4, metal: 0.5 }), // 남쪽 창고 벽: 골함석
      hedge: photoMat("forest_leaves_02", { scale: 0.35, tint: 0x9fc29a }),
      tree: photoMat("bark_brown_02"),
      jersey: photoMat("Concrete034", { tint: 0xe6e2da }),
      step: photoMat("Concrete034", { tint: 0xa8a49c }),
      platform: photoMat("PavingStones128", { tint: 0xa09c94 }),
      ramp: photoMat("Concrete034", { tint: 0xa8a49c }),
      A: photoMat("metal_plate", { tint: 0xffb02e, metal: 0.6, emissive: 0x3a1e00 }),
      B: photoMat("metal_plate", { tint: 0x2ee6ff, metal: 0.6, emissive: 0x00303a }),
    };
    const crates: Box[] = [], shutters: THREE.Matrix4[] = [], aircons: THREE.Matrix4[] = [];
    const win = windowMat(0.8);
    const roofTrim = photoMat("metal_roof", { tint: 0x9a9ca4, metal: 0.4 });
    const wallCap = photoMat("Concrete034", { tint: 0x9c9890 });
    const planterBase = photoMat("concrete_block_wall", { tint: 0xc8c4bc });
    const bush = photoMat("forest_leaves_02", { scale: 0.35, tint: 0xa8cc98 });
    const basin = photoMat("stone_tiles", { tint: 0xe0e0e0 });
    const water = new THREE.MeshStandardMaterial({ color: 0x2c5a6e, roughness: 0.05, metalness: 0.2, transparent: true, opacity: 0.85 });
    BOXES_BY_MAP.NEON.forEach((b: Box, i) => {
      if (b.kind === "crate") { crates.push(b); return; }
      // 짐 더미: 나무 상자 2단 (가판대·하역장·창고)
      if (b.kind === "cargo") {
        const mid = (b.z0 + b.z1) / 2;
        crates.push({ ...b, z1: mid }, { ...b, z0: mid, x0: b.x0 + 0.15, x1: b.x1 - 0.15, y0: b.y0 + 0.15, y1: b.y1 - 0.15 });
        return;
      }
      // 화단: 콘크리트 화분 위에 수풀 (충돌 높이 안에 모두 들어감)
      if (b.kind === "planter") {
        this.addBox({ ...b, z1: 0.7 }, planterBase);
        this.addBox({ ...b, x0: b.x0 + 0.1, x1: b.x1 - 0.1, y0: b.y0 + 0.1, y1: b.y1 - 0.1, z0: 0.7 }, bush);
        return;
      }
      // 분수: 돌 테두리 + 물 + 가운데 기둥
      if (b.kind === "fountain") {
        const t = 0.35;
        for (const r of [{ y1: b.y0 + t }, { y0: b.y1 - t }, { x1: b.x0 + t }, { x0: b.x1 - t }]) this.addBox({ ...b, ...r }, basin);
        const pool = new THREE.Mesh(new THREE.PlaneGeometry(b.x1 - b.x0 - 2 * t, b.y1 - b.y0 - 2 * t), water);
        pool.rotation.x = -Math.PI / 2;
        pool.position.set((b.x0 + b.x1) / 2, b.z1 - 0.12, -(b.y0 + b.y1) / 2);
        g.add(pool);
        const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
        this.addBox({ ...b, x0: cx - 0.25, x1: cx + 0.25, y0: cy - 0.25, y1: cy + 0.25, z1: 1.6 }, basin);
        return;
      }
      const kind = b.kind === "wall" && b.y1 <= 12 ? "shed" : b.site ?? b.kind; // y 12m 아래 = 남쪽 시설(창고)
      this.addBox(b, b.kind === "building" ? facades[i % facades.length]! : mats[kind]!);
      if (b.kind === "wall") this.addCap(b, wallCap);
      if (b.kind === "building") this.dressBuilding(b, i, win, roofTrim, shutters, aircons);
    });
    this.addCrates(g, crates);
    this.flushPieces(g);
    this.instanced(g, "rollershutter_door", () => shutters).catch(() => {});
    this.instanced(g, "exterior_aircon_unit", () => aircons).catch(() => {});
    // 나무 잎 (장식, 충돌은 기둥만)
    const leaf = photoMat("forest_leaves_02", { scale: 0.35, tint: 0xb8d8a8 });
    const pit = photoMat("ground_mixed"); // 나무 밑 흙 (아스팔트 위 2m 칸)
    for (let s = 0; s < NEON_GRID.length; s++) for (let c = 0; c < NEON_GRID[s]!.length; c++) {
      if (NEON_GRID[s]![c] !== "o") continue;
      const p = cellCenter(c, s);
      const crown = new THREE.Mesh(meterUV(new THREE.IcosahedronGeometry(1.4, 1), 8.8, 4.4), leaf);
      crown.position.set(p.x, 3.5, -p.y);
      crown.scale.y = 0.85;
      crown.castShadow = true;
      const soil = new THREE.Mesh(groundGeo(CELL, CELL, p.x, p.y), pit);
      soil.rotation.x = -Math.PI / 2;
      soil.position.set(p.x, 0.015, -p.y);
      soil.receiveShadow = true;
      g.add(crown, soil);
    }
    // 가로등 (Poly Haven 모델, 장식): 건물 벽에 붙여 세워 길을 막지 않는다. 전구는 스스로 빛남
    // 위치: 시장 거리 양쪽 건물 벽, 광장 북쪽 건물 벽, 사이트 담장 안쪽 (모두 벽에서 0.4m)
    const X = (c: number) => cellCenter(c, 0).x;
    const lamps: [number, number][] = [
      [X(34), 29.6], [X(40), 31.6], [X(36), 24.4], [X(41), 22.4], // 시장 거리
      [X(16), 37.6], [X(19), 37.6], [92.4, cellCenter(0, 10).y], // 광장 둘레
      [X(33), 42.4], [X(25), 13.6], [X(33), 13.6], // A 담장, B 담장
    ];
    this.instanced(g, "street_lamp_01", () => lamps.map(([x, y]) => new THREE.Matrix4().makeTranslation(x, 0, -y)), (proto) => proto.traverse((o) => {
      const mat = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
      if (!mat?.name) return;
      if (mat.name.endsWith("bulb")) { mat.emissive = new THREE.Color(1, 0.8, 0.55); mat.emissiveIntensity = 30; mat.toneMapped = false; }
      if (mat.name.endsWith("glass")) { mat.emissive = new THREE.Color(1, 0.75, 0.5); mat.emissiveIntensity = 1.5; }
    })).catch(() => { /* 모델을 못 받으면 가로등 없이 */ });
    // 사이트 글자 (멀리서도 보이게 건물 위에 떠 있는 판)
    for (const b of BOXES_BY_MAP.NEON) {
      if (!b.site) continue;
      const cv = document.createElement("canvas");
      cv.width = cv.height = 128;
      const ctx = cv.getContext("2d")!;
      ctx.font = "bold 110px sans-serif";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillStyle = b.site === "A" ? "#ffb02e" : "#2ee6ff";
      ctx.fillText(b.site, 64, 70);
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv), fog: false }));
      sp.scale.set(3.5, 3.5, 1);
      sp.position.set((b.x0 + b.x1) / 2, b.z1 + 2.5, -(b.y0 + b.y1) / 2);
      g.add(sp);
    }
  }

  /** 지금 카메라 거리 비율 (1 = 기본 거리, 벽에 가리면 작아짐) */
  camK = 1;
  /** 보는 캐릭터가 궁수면 궁수용 어깨 시점 (서버 화살 판정과 같은 광선) */
  ranged = false;

  /**
   * 3인칭 카메라: 오른쪽 어깨 뒤 위에서 바라본다.
   * - 서버 타격 판정과 같은 광선(shared/aim.ts aimRay)을 기준으로, 화면 가운데 = 조준점이 되게 한다.
   * - 머리와 카메라 사이를 벽/집이 가리면 카메라를 머리 쪽으로 당긴다 (들어올 때는 즉시, 나갈 때는 부드럽게).
   *   당겨져도 "정면 AIM_CONVERGE 앞 조준 지점"을 계속 바라보므로 가까운 상대 조준은 그대로 맞는다.
   * 돌려주는 값: 카메라 거리 비율 (내 캐릭터를 반투명하게 할지 정할 때 사용)
   */
  updateCamera(x: number, y: number, z: number, dt = 0): number {
    this.pitch = clampPitch(this.pitch);
    const { origin } = aimRay({ x, y, z } as Body, this.yaw, this.pitch, this.ranged);
    const head = { x, y, z: z + AIM.CAMERA_TARGET_HEIGHT };
    const d = { x: origin.x - head.x, y: origin.y - head.y, z: origin.z - head.z };
    const len = Math.hypot(d.x, d.y, d.z);
    const want = Math.max(CONFIG.CAMERA_MIN_RATIO, this.hitRatio(head, d) - CONFIG.CAMERA_WALL_MARGIN / len);
    // 벽 쪽으로는 빠르게, 돌아갈 때는 천천히. 둘 다 부드럽게 (한 프레임에 확 당겨지면 화면이 튐)
    if (dt === 0) this.camK = want;
    else this.camK += (want - this.camK) * (1 - Math.exp(-dt / (want < this.camK ? CONFIG.CAMERA_EASE_IN_S : CONFIG.CAMERA_EASE_OUT_S)));
    World3D.toThree(head.x + d.x * this.camK, head.y + d.y * this.camK, head.z + d.z * this.camK, this.camera.position);
    this.light.follow(World3D.toThree(x, y, z, tmp)); // 그림자는 보는 사람 주변만 (해상도 아끼기)
    // 조준 지점 = 머리에서 정면(카메라 방향)으로 AIM_CONVERGE 앞
    const p = this.pitch, c = aimConverge(this.ranged);
    this.camera.lookAt(World3D.toThree(
      x + Math.cos(this.yaw) * Math.cos(p) * c,
      y + Math.sin(this.yaw) * Math.cos(p) * c,
      head.z - Math.sin(p) * c, tmp));
    return this.camK;
  }

  /** 카메라에서 이 점(게임 좌표)까지 벽·건물·상자에 가리지 않고 보이는지 (작은 물체도 엄폐로 친다) */
  canSee(x: number, y: number, z: number): boolean {
    const c = this.camera.position, from = { x: c.x, y: -c.z, z: c.y };
    const d = { x: x - from.x, y: y - from.y, z: z - from.z };
    for (const b of BOXES) {
      const t = rayAabb(from, d, { x: b.x0, y: b.y0, z: b.z0 }, { x: b.x1, y: b.y1, z: b.z1 });
      if (t !== null && t < 1) return false;
    }
    return true;
  }

  /** 머리에서 d 방향 선분(0~1)이 처음 벽/집(지붕 포함)에 닿는 비율. 안 닿으면 1 */
  private hitRatio(head: { x: number; y: number; z: number }, d: { x: number; y: number; z: number }): number {
    const pad = CONFIG.CAMERA_WALL_PAD;
    let k = 1;
    for (const b of BOXES) {
      // 나무 기둥·상자처럼 작은 것은 무시 (지나갈 때마다 카메라가 들락날락하지 않게)
      if (Math.max(b.x1 - b.x0, b.y1 - b.y0) < CONFIG.CAMERA_IGNORE_SIZE) continue;
      const top = b.kind === "house" && !b.site ? b.z1 + 2.6 : b.z1; // 기본 맵 집은 지붕까지
      const t = rayAabb(head, d, { x: b.x0 - pad, y: b.y0 - pad, z: b.z0 - pad }, { x: b.x1 + pad, y: b.y1 + pad, z: top + pad });
      if (t !== null && t < k) k = t;
    }
    // 올려다볼 때 땅속으로 들어가지 않게 (땅 위 0.3m에서 멈춤)
    if (d.z < 0 && head.z + d.z < 0.3) k = Math.min(k, (0.3 - head.z) / d.z);
    // 맵 밖 울타리 너머로도 나가지 않게
    const bx = head.x + d.x, by = head.y + d.y;
    const mb = MAPS[mapAt(head.x)];
    for (const [v, dv, lo, hi] of [[bx, d.x, mb.x0 + 0.3, mb.x1 - 0.3], [by, d.y, mb.y0 + 0.3, mb.y1 - 0.3]] as const) {
      if (v < lo && dv < 0) k = Math.min(k, (lo - (v - dv)) / dv);
      if (v > hi && dv > 0) k = Math.min(k, (hi - (v - dv)) / dv);
    }
    return Math.max(0, k);
  }

  render() {
    this.light.render();
  }

  // ---------- 화살 (서버 shot 메시지대로 서버 시각 기준으로 날린다) ----------
  private arrows: { by: string; mesh: THREE.Object3D; origin: Vec3; dir: Vec3; at: number; speed: number; maxDist: number; big: boolean; wall: boolean; half: number; stuck: boolean }[] = [];
  /** 궁극기 Stylized 이펙트 (폭발·충격파·불꽃·균열·속도선) */
  private fx = new StylizedFx(this.scene);
  private static arrowGeo = new THREE.CylinderGeometry(0.05, 0.05, 1, 5); // 모델을 받기 전 막대 (길이 방향 = +Y)
  private static arrowMat = new THREE.MeshBasicMaterial({ color: 0xfff1b8 });
  private props: { arrow: THREE.Object3D; spear: THREE.Object3D } | null = null;

  addArrow(by: string, origin: Vec3, dir: Vec3, at: number, speed: number, range: number, spear: boolean, big = false) {
    const model = this.props?.[spear ? "spear" : "arrow"];
    const mesh = model ? model.clone() : new THREE.Mesh(World3D.arrowGeo, World3D.arrowMat);
    if (big) { // 궁극기 거대 창: 2.5배 + 단색 금빛 테두리(뒷면 껍질) + 뒤로 길게 늘어진 잔상
      mesh.scale.multiplyScalar(2.5);
      const shell = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.02, 2.2, 6), new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffc94a).multiplyScalar(1.6), side: THREE.BackSide, toneMapped: false }));
      const smear = new THREE.Mesh(new THREE.ConeGeometry(0.14, 3.2, 6).translate(0, -1.6, 0), new THREE.MeshBasicMaterial({ color: 0xfff3c4, transparent: true, opacity: 0.55, depthWrite: false, toneMapped: false }));
      mesh.add(shell, smear);
    }
    World3D.toThree(dir.x, dir.y, dir.z, tmp);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), tmp.normalize());
    this.scene.add(mesh);
    // 벽·땅에 닿으면 촉이 박힌 채 잠시 남고, 허공에서 사거리 끝이면 사라진다
    const wall = firstSolid(origin, dir, 0);
    const half = (model ? new THREE.Box3().setFromObject(model).getSize(tmp).y / 2 : 0.5) * (big ? 2.5 : 1); // 모델 길이 방향 = +Y
    this.arrows.push({ by, mesh, origin, dir, at, speed, maxDist: Math.min(range, wall), big, wall: wall <= range, half, stuck: false });
  }

  /** 맞았다는 소식이 오면 그 사람이 쏜 가장 오래된 화살을 지운다 */
  removeArrow(by: string) {
    const i = this.arrows.findIndex((a) => a.by === by && !a.stuck); // 벽에 박혀 있는 건 빼고
    if (i < 0) return;
    const a = this.arrows[i]!;
    if (a.big) this.spearImpact(a.mesh.position, this.lastNow); // 맞은 자리에서 바로
    this.scene.remove(a.mesh);
    this.arrows.splice(i, 1);
  }

  // ---------- 궁극기 (기사 하늘 검): 반투명 금빛 큰 칼이 떨어져 꽂히고 충격파 고리가 퍼진다 ----------
  private ults: { g: THREE.Group; mats: THREE.MeshBasicMaterial[]; ring: THREE.Mesh; glow: THREE.Mesh; at: number }[] = [];

  /** 서버 시각 at에 (x, y, z) 위로 칼이 떨어지기 시작한다 */
  addUlt(x: number, y: number, z: number, at: number) {
    // Stylized: 단색 금(날) / 진한 금(가드·손잡이) / 빛기둥, 칼에는 검은 외곽선(뒷면 껍질)
    const mat = (c = 0xffd65a, boost = 1.3) => new THREE.MeshBasicMaterial({ color: new THREE.Color(c).multiplyScalar(boost), transparent: true, opacity: 1, depthWrite: true, toneMapped: false });
    const mats = [mat(0xffb820, 1), mat(0x9c5a12, 1), mat(0xfff3c4, 1.6)]; // 진한 금 / 구릿빛 / 빛기둥
    mats[2]!.depthWrite = false;
    const g = new THREE.Group();
    // 칼 (끝이 아래, 길이 약 4m, 넓은 면이 카메라 쪽): 날 + 끝 + 가드 + 손잡이
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.7, 2.6, 0.1), mats[0]); blade.position.y = 0.8 + 1.3;
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.5, 0.8, 4).rotateX(Math.PI).rotateY(Math.PI / 4), mats[0]); tip.scale.z = 0.2; tip.position.y = 0.4;
    const guard = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.24, 0.24), mats[1]); guard.position.y = 3.5;
    const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.7, 8), mats[1]); grip.position.y = 3.95;
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 1.1, 12, 16, 1, true), mats[2]); beam.position.y = 6; // 내려오는 빛기둥
    g.rotation.y = Math.atan2(Math.cos(this.yaw), -Math.sin(this.yaw)); // 칼 넓은 면이 지금 카메라를 보게
    const ink = new THREE.MeshBasicMaterial({ color: 0x1a1206, side: THREE.BackSide, transparent: true });
    for (const part of [blade, tip, guard, grip]) { // 외곽선: 조금 큰 뒷면 껍질
      const o = new THREE.Mesh(part.geometry, ink);
      o.position.copy(part.position); o.rotation.copy(part.rotation); o.scale.copy(part.scale).multiplyScalar(1.12);
      g.add(o);
    }
    mats.push(ink);
    g.add(blade, tip, guard, grip, beam);
    // 꽂히는 순간(at + 220ms) 터지는 것들
    const hit = new THREE.Vector3(); World3D.toThree(x, y, z, hit);
    const impact = at + 220;
    this.fx.speedLines(hit, 0xfff3c4, 1.2, 9, at, 240);
    this.fx.burst(hit.clone().setY(hit.y + 1.2), 0xffb21e, 3, impact);
    this.fx.shock(hit, 0xffffff, 4.5, impact, 360);
    this.fx.shock(hit, 0xffc94a, 7, impact + 60, 620);
    this.fx.sparks(hit.clone().setY(hit.y + 0.3), 0xffd65a, 18, 10, impact);
    this.fx.crack(hit, 2.4, impact);
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.85, 1, 48).rotateX(-Math.PI / 2), mat());
    ring.position.y = 0.05;
    // 빛 번쩍임: 조명을 새로 넣으면 모든 재질이 다시 컴파일돼 멈칫하므로, 더하기 혼합 원판으로 흉내
    const glow = new THREE.Mesh(new THREE.CircleGeometry(1.8, 32).rotateX(-Math.PI / 2), mat());
    glow.position.y = 0.04;
    const root = new THREE.Group();
    World3D.toThree(x, y, z, root.position);
    root.add(g, ring, glow);
    this.scene.add(root);
    ring.visible = glow.visible = false; // 충격파·번쩍임은 Stylized 이펙트가 맡는다
    this.ults.push({ g: root, mats: [...mats, ring.material as THREE.MeshBasicMaterial, glow.material as THREE.MeshBasicMaterial], ring, glow, at });
  }

  // ---------- 궁수 화살비: 떨어질 자리에 붉은 원이 깜빡이다가, 시간이 되면 화살이 한꺼번에 쏟아진다 ----------
  private rains: { g: THREE.Group; ring: THREE.Mesh; arrows: THREE.Mesh[]; mats: THREE.MeshBasicMaterial[]; at: number }[] = [];
  addRain(x: number, y: number, z: number, radius: number, at: number) {
    const ringMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff5a3c).multiplyScalar(1.3), transparent: true, opacity: 0.6, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
    // 예고 원: 끊어진 점선 고리 (Stylized), 시간이 다가오면 빨리 돈다
    const ring = new THREE.Group();
    for (let i = 0; i < 12; i++) ring.add(new THREE.Mesh(new THREE.RingGeometry(radius * 0.9, radius, 6, 1, (i / 12) * Math.PI * 2, (Math.PI * 2) / 12 * 0.6).rotateX(-Math.PI / 2), ringMat));
    const fill = new THREE.Mesh(new THREE.CircleGeometry(radius, 48).rotateX(-Math.PI / 2), ringMat);
    fill.scale.setScalar(1); fill.position.y = 0.03; ring.position.y = 0.04;
    const arrowMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xfff1b8).multiplyScalar(1.4), transparent: true, opacity: 1, toneMapped: false });
    const arrows: THREE.Mesh[] = [];
    const g = new THREE.Group();
    World3D.toThree(x, y, z, g.position);
    for (let i = 0; i < 26; i++) {
      const r = radius * Math.sqrt(Math.random()), a = Math.random() * Math.PI * 2;
      const m = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.9, 4), arrowMat);
      m.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
      m.userData.delay = Math.random() * 180; // 조금씩 다른 때 떨어짐
      m.visible = false;
      arrows.push(m);
      g.add(m);
    }
    g.add(fill, ring);
    g.userData.spin = ring;
    this.scene.add(g);
    this.rains.push({ g, ring: fill, arrows, mats: [ringMat, arrowMat], at });
    // 땅에 닿는 순간: 붉은 충격파 + 여기저기 작은 별 폭발
    this.fx.shock(g.position, 0xff6a3c, radius * 1.3, at, 420);
    for (let i = 0; i < 6; i++) {
      const a = arrows[i * 4]!;
      const p = g.position.clone().add(a.position).setY(g.position.y + 0.3);
      this.fx.burst(p, 0xffe0a0, 0.7, at + (a.userData.delay as number) - 180, 6);
    }
  }

  // ---------- 고블린 연막: 회색 연기 덩어리 (room_state의 목록대로 만들고 지운다) ----------
  private smokes = new Map<string, { g: THREE.Group; mat: THREE.MeshToonMaterial; until: number; born: number }>();
  setSmokes(list: { team: TeamId; x: number; y: number; z: number; radius: number; until: number }[], serverNow: number, myTeam?: TeamId) {
    const keep = new Set<string>();
    for (const s of list) {
      const key = `${s.x},${s.y},${s.until}`;
      keep.add(key);
      let e = this.smokes.get(key);
      if (!e) {
        // Stylized 연기: 명암 3단계(만화풍) + 덩어리가 통통 튀어나오며 생김
        const mat = new THREE.MeshToonMaterial({ color: 0x8a8f99, gradientMap: TOON3, transparent: true, opacity: 0, depthWrite: false });
        const g = new THREE.Group();
        World3D.toThree(s.x, s.y, s.z, g.position);
        for (let i = 0; i < 14; i++) { // 반구 모양으로 겹친 연기 덩어리
          const r = s.radius * Math.sqrt(Math.random()) * 0.85, a = Math.random() * Math.PI * 2;
          const puff = new THREE.Mesh(new THREE.IcosahedronGeometry(1.1 + Math.random() * 0.9, 1), mat);
          puff.position.set(Math.cos(a) * r, 0.6 + Math.random() * 1.6, Math.sin(a) * r);
          puff.userData.delay = i * 30;
          g.add(puff);
        }
        this.scene.add(g);
        e = { g, mat, until: s.until, born: serverNow };
        this.smokes.set(key, e);
      }
      const left = s.until - serverNow;
      // 쓴 팀에게는 옅게(안이 보임), 상대 팀에게는 거의 불투명하게
      e.mat.opacity = (s.team === myTeam ? 0.18 : 0.96) * Math.min(1, left / 800);
      e.g.rotation.y += 0.002;
      for (const puff of e.g.children) { // 생길 때 통 튀어나옴, 사라질 때 오그라듦
        const k = Math.min(1, Math.max(0, (serverNow - e.born - (puff.userData.delay as number)) / 380));
        const pop = k >= 1 ? 1 : 1 + 2.9 * (k - 1) ** 3 + 1.9 * (k - 1) ** 2;
        puff.scale.setScalar(Math.max(0.001, pop * Math.min(1, left / 600)));
      }
    }
    for (const [key, e] of this.smokes) {
      if (keep.has(key) && e.until > serverNow) continue;
      this.scene.remove(e.g);
      e.mat.dispose();
      e.g.traverse((o) => { if (o instanceof THREE.Mesh) o.geometry.dispose(); });
      this.smokes.delete(key);
    }
  }

  // ---------- 맵 가운데 파워업: 떠서 도는 보석 + 바닥 고리 (종류별 색) ----------
  private pickup: { g: THREE.Group; key: string } | null = null;
  static PICKUP_COLOR = { heal: 0x4dff88, power: 0xff5a3c, ult: 0x5ab8ff } as const;
  setPickup(p: { kind: keyof typeof World3D.PICKUP_COLOR; x: number; y: number; z: number } | null, serverNow: number) {
    const key = p ? `${p.kind},${p.x},${p.y}` : "";
    if (this.pickup && this.pickup.key !== key) {
      this.scene.remove(this.pickup.g);
      this.pickup.g.traverse((o) => { if (o instanceof THREE.Mesh) { o.geometry.dispose(); (o.material as THREE.Material).dispose(); } });
      this.pickup = null;
    }
    if (!p) return;
    if (!this.pickup) {
      const color = World3D.PICKUP_COLOR[p.kind];
      const g = new THREE.Group();
      World3D.toThree(p.x, p.y, p.z, g.position);
      const gem = new THREE.Mesh(new THREE.OctahedronGeometry(0.42, 0), new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(1.5), toneMapped: false }));
      const ring = new THREE.Mesh(new THREE.RingGeometry(1.1, 1.3, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.7, depthWrite: false, toneMapped: false }));
      ring.position.y = 0.05;
      g.add(gem, ring);
      this.scene.add(g);
      this.pickup = { g, key };
    }
    const [gem, ring] = this.pickup.g.children as [THREE.Mesh, THREE.Mesh];
    gem.position.y = 1.1 + Math.sin(serverNow / 300) * 0.15;
    gem.rotation.y = serverNow / 400;
    ring.scale.setScalar(1 + 0.08 * Math.sin(serverNow / 200));
  }

  /** 파워업을 먹은 자리: 그 색으로 별 폭발 + 고리 */
  pickupBurst(kind: keyof typeof World3D.PICKUP_COLOR, x: number, y: number, z: number, at: number) {
    const pos = World3D.toThree(x, y, z + 1.1, new THREE.Vector3());
    this.fx.burst(pos, World3D.PICKUP_COLOR[kind], 1.6, at);
    this.fx.shock(pos.clone().setY(pos.y - 1.1), World3D.PICKUP_COLOR[kind], 3, at);
  }

  updateUlts(serverNow: number) {
    this.fx.update(serverNow, this.camera);
    this.rains = this.rains.filter((r) => {
      const t = serverNow - r.at; // 0 = 화살이 땅에 닿는 시각
      if (t > 900) { this.scene.remove(r.g); r.mats.forEach((m) => m.dispose()); r.g.traverse((o) => { if (o instanceof THREE.Mesh) o.geometry.dispose(); }); return false; }
      r.mats[0]!.opacity = t < 0 ? 0.35 + 0.35 * (Math.floor(serverNow / 120) % 2) : 0.5 * (1 - t / 900); // 깜빡임도 딱딱 끊기게
      (r.g.userData.spin as THREE.Object3D).rotation.y += t < 0 ? 0.02 + 0.06 * (1 - Math.min(1, -t / 1000)) : 0;
      for (const a of r.arrows) {
        const tt = t + 250 - (a.userData.delay as number); // 땅에 닿기 250ms 전부터 떨어짐
        a.visible = tt > 0;
        a.position.y = Math.max(0.35, 7 * (1 - Math.min(1, tt / 250)));
        a.scale.y = a.position.y > 0.35 ? 2.4 : 1; // 떨어지는 동안 길게 늘어난 잔상
      }
      r.mats[1]!.opacity = t < 400 ? 1 : 1 - (t - 400) / 500;
      return true;
    });
    const FALL = 220, END = 1100;
    this.ults = this.ults.filter((u) => {
      const t = serverNow - u.at;
      if (t > END) { this.scene.remove(u.g); u.mats.forEach((m) => m.dispose()); u.g.traverse((o) => { if (o instanceof THREE.Mesh) o.geometry.dispose(); }); return false; }
      const sword = u.g.children[0]!;
      const f = Math.min(1, Math.max(0, t) / FALL);
      sword.position.y = 7 * (1 - f * f) - 0.4 * f; // 가속하며 떨어져 땅에 박힘
      const after = Math.max(0, t - FALL) / (END - FALL); // 꽂힌 뒤 0→1
      const fade = after < 0.55 ? 1 : 1 - Math.floor(((after - 0.55) / 0.45) * 4) / 4; // 한동안 꽂혀 있다가 계단식으로 사라짐
      u.mats[0]!.opacity = u.mats[1]!.opacity = u.mats[3]!.opacity = fade;
      u.mats[2]!.opacity = t < FALL ? 0.5 * f : 0.5 * (after < 0.15 ? 1 : 0); // 빛기둥: 꽂히자마자 툭 꺼짐
      sword.scale.set(1, t < FALL ? 1 + 0.6 * (1 - f) : 1, 1); // 떨어지는 동안 세로로 늘어나는 잔상(스미어)
      return true;
    });
  }

  private lastNow = 0;
  /** 거대 창이 맞거나 멈춘 자리: 금빛 별 폭발 + 충격파 + 불꽃 */
  private spearImpact(p: THREE.Vector3, at: number) {
    this.fx.burst(p, 0xffb21e, 2.2, at, 8);
    this.fx.shock(p.clone().setY(Math.max(0, p.y - 1)), 0xffd65a, 3.5, at, 420);
    this.fx.sparks(p, 0xffd65a, 12, 9, at);
  }

  updateArrows(serverNow: number) {
    this.lastNow = serverNow;
    this.arrows = this.arrows.filter((a) => {
      let d = (a.speed * Math.max(0, serverNow - a.at)) / 1000;
      if (d > a.maxDist) {
        if (!a.stuck && a.big) this.spearImpact(a.mesh.position, serverNow);
        const stuckFor = serverNow - a.at - (a.maxDist / a.speed) * 1000;
        if (!a.wall || a.big || stuckFor > 3000) { this.scene.remove(a.mesh); return false; }
        a.stuck = true;
        d = a.maxDist - a.half * 0.3; // 촉 쪽이 벽 속에 들어가게
      }
      World3D.toThree(a.origin.x + a.dir.x * d, a.origin.y + a.dir.y * d, a.origin.z + a.dir.z * d, a.mesh.position);
      return true;
    });
  }
}

/** 캐릭터 1명의 화면 표시 (메시와 이름표를 재사용, 매 프레임 새 객체를 만들지 않는다) */
export class PlayerView {
  readonly group = new THREE.Group();
  private pivot = new THREE.Group(); // 기절/사망 시 눕히는 축
  private shadow: THREE.Mesh;
  private bodyMat: THREE.MeshStandardMaterial;
  private baseColor: THREE.Color;
  readonly label: HTMLDivElement;
  private nameEl: HTMLDivElement;
  private hpWrap: HTMLDivElement;
  private hpFill: HTMLDivElement;
  private tagEl: HTMLDivElement;
  private lastHpPct = -1;
  private lastTag = "";
  private flashUntil = 0;
  private swingUntil = 0;
  private static geo = {
    body: new THREE.CapsuleGeometry(PHYS.PLAYER_HALF, PHYS.PLAYER_HEIGHT - PHYS.PLAYER_HALF * 2, 4, 12),
    visor: new THREE.BoxGeometry(0.2, 0.25, 0.55),
    fist: new THREE.SphereGeometry(0.16, 8, 6),
    // 검: 주먹에서 앞으로 뻗은 납작한 막대 / 활: 앞으로 휜 세로 호
    sword: new THREE.BoxGeometry(0.9, 0.1, 0.03).translate(0.5, 0, 0),
    bow: new THREE.TorusGeometry(0.5, 0.03, 4, 12, Math.PI).rotateZ(-Math.PI / 2),
    // 창: 손에서 앞뒤로 긴 막대 + 끝의 날
    spear: new THREE.CylinderGeometry(0.03, 0.03, 2, 6).rotateZ(-Math.PI / 2).translate(0.4, 0, 0),
    spearTip: new THREE.ConeGeometry(0.07, 0.3, 6).rotateZ(-Math.PI / 2).translate(1.55, 0, 0),
    ring: new THREE.RingGeometry(0.42, 0.5, 40),
  };
  private static flashColor = new THREE.Color(0xffffff);
  private static deadColor = new THREE.Color(0x444444);
  private fist: THREE.Mesh;
  private sword: THREE.Mesh;
  private bow: THREE.Mesh;
  private spear = new THREE.Group();

  constructor(scene: THREE.Scene, team: TeamId, nickname: string, isMe: boolean) {
    this.baseColor = new THREE.Color(CONFIG.TEAM_COLOR[team]);
    this.bodyMat = new THREE.MeshStandardMaterial({ color: this.baseColor.clone(), transparent: true, roughness: 0.55 });
    const body = new THREE.Mesh(PlayerView.geo.body, this.bodyMat);
    body.castShadow = true;
    body.position.y = PHYS.PLAYER_HEIGHT / 2;
    // 바라보는 방향 표시 (앞쪽 = +X)
    const visor = new THREE.Mesh(PlayerView.geo.visor, new THREE.MeshStandardMaterial({ color: isMe ? 0xffffff : 0x222222, roughness: 0.15, metalness: 0.4 }));
    visor.position.set(PHYS.PLAYER_HALF * 0.85, PHYS.PLAYER_HEIGHT * 0.78, 0);
    // 타격할 때 앞으로 뻗는 주먹
    this.fist = new THREE.Mesh(PlayerView.geo.fist, new THREE.MeshStandardMaterial({ color: 0xffe0b0, roughness: 0.7 }));
    this.fist.position.set(PHYS.PLAYER_HALF, PHYS.PLAYER_HEIGHT * 0.55, -0.25);
    const wood = new THREE.MeshStandardMaterial({ color: 0x8a5a2b, roughness: 0.8 });
    const steel = new THREE.MeshStandardMaterial({ color: 0xdfe3ea, metalness: 1, roughness: 0.28 });
    this.sword = new THREE.Mesh(PlayerView.geo.sword, steel);
    this.bow = new THREE.Mesh(PlayerView.geo.bow, wood);
    this.bow.visible = false;
    this.spear.add(new THREE.Mesh(PlayerView.geo.spear, wood), new THREE.Mesh(PlayerView.geo.spearTip, steel));
    this.spear.visible = false;
    this.fist.add(this.sword, this.bow, this.spear);
    this.pivot.add(body, visor, this.fist);
    this.group.add(this.pivot);
    scene.add(this.group);

    // 발밑 팀 색 고리 (그림자는 해가 만든다)
    this.shadow = new THREE.Mesh(PlayerView.geo.ring, new THREE.MeshBasicMaterial({ color: CONFIG.TEAM_COLOR[team], transparent: true, opacity: isMe ? 0.95 : 0.7, depthWrite: false }));
    this.shadow.rotation.x = -Math.PI / 2;
    scene.add(this.shadow);

    // 이름표: 닉네임 + 체력 바 + 상태(기절 카운트다운 등)
    this.label = document.createElement("div");
    this.label.className = "label";
    this.nameEl = document.createElement("div");
    this.nameEl.style.color = team === "A" ? "#ffb3b3" : "#b8ccff";
    this.hpWrap = document.createElement("div");
    this.hpWrap.className = "hpbar";
    this.hpFill = document.createElement("div");
    this.hpWrap.appendChild(this.hpFill);
    this.tagEl = document.createElement("div");
    this.tagEl.className = "tag";
    this.label.append(this.tagEl, this.nameEl, this.hpWrap);
    document.body.appendChild(this.label);
    this.setNickname(isMe ? `${nickname} (나)` : nickname);
  }

  setNickname(text: string) {
    if (this.nameEl.textContent !== text) this.nameEl.textContent = text;
  }

  /** 체력 바 비율(0~1)과 머리 위 상태 문구 */
  setStatus(hpRatio: number, tag: string) {
    const pct = Math.round(hpRatio * 100);
    if (pct !== this.lastHpPct) {
      this.lastHpPct = pct;
      this.hpFill.style.width = `${pct}%`;
      this.hpWrap.classList.toggle("low", pct <= 30);
    }
    if (tag !== this.lastTag) {
      this.lastTag = tag;
      this.tagEl.textContent = tag;
    }
  }

  /** 직업: 3D 캐릭터(기사 / 후드 쓴 석궁수 / 창 든 바바리안). 받기 전에는 도형 캐릭터 + 손 무기 */
  setWeapon(cls: ClassId) {
    this.sword.visible = cls === "KNIGHT" || cls === "GOBLIN";
    this.bow.visible = cls === "ARCHER";
    this.spear.visible = cls === "JAVELIN";
    if (this.char?.cls === cls) return;
    if (this.char) this.group.remove(this.char.root);
    this.char = new Character(cls);
    this.group.add(this.char.root);
  }
  private char: Character | null = null;
  private lastMs = 0;
  private lastX = 0;
  private lastY = 0;
  private speed = 0;

  /** 맞았을 때 번쩍 */
  flash(nowMs: number) { this.flashUntil = nowMs + CONFIG.HIT_FLASH_MS; this.char?.hit(); }
  /** 타격 동작 */
  swing(nowMs: number) { this.swingUntil = nowMs + CONFIG.SWING_MS; this.char?.attack(); }

  /**
   * 위치/방향/상태 반영. state: 0=정상, 1=기절(눕고 반투명), 2=사망(눕고 회색)
   * invuln = 무적 중(깜빡임), dim = 재접속 대기 중(반투명)
   */
  /** 카메라가 아주 가까우면 내 캐릭터를 숨긴다 (화면을 가리지 않게) */
  nearCamera = false;
  /** 은신한 상대: 아예 그리지 않는다 (그림자 고리·이름표까지) */
  hidden = false;
  /** 이름표·체력만 숨김 (엄폐물 뒤의 상대) */
  labelHidden = false;

  update(x: number, y: number, z: number, faceRad: number, groundZ: number, state: 0 | 1 | 2, invuln: boolean, dim: boolean, nowMs: number, crouch = false) {
    this.pivot.scale.y = state === 0 && crouch ? PHYS.CROUCH_HEIGHT / PHYS.PLAYER_HEIGHT : 1; // 앉으면 낮게
    World3D.toThree(x, y, z, this.group.position);
    this.group.visible = this.shadow.visible = !this.hidden;
    this.group.rotation.y = faceRad;
    this.pivot.rotation.x = state === 0 ? 0 : Math.PI / 2; // 옆으로 눕힘
    this.pivot.position.y = state === 0 ? 0 : PHYS.PLAYER_HALF;
    this.pivot.position.z = state === 0 ? 0 : PHYS.PLAYER_HEIGHT / 2 - PHYS.PLAYER_HALF;
    World3D.toThree(x, y, groundZ + 0.02, this.shadow.position);
    this.shadow.scale.setScalar(Math.max(0.4, 1 - (z - groundZ) * 0.25)); // 높이 뜰수록 그림자 작게

    const c = this.bodyMat.color;
    if (nowMs < this.flashUntil) c.copy(PlayerView.flashColor);
    else if (state === 2) c.copy(PlayerView.deadColor);
    else c.copy(this.baseColor);
    let opacity = 1;
    if (dim || state === 1) opacity = 0.55;
    if (invuln && Math.floor(nowMs / 120) % 2 === 0) opacity = 0.3;
    this.bodyMat.opacity = opacity;
    // 카메라가 캐릭터 바로 뒤까지 당겨지면 캐릭터를 숨겨서 화면을 가리지 않게 한다 (그림자는 남김)
    this.pivot.visible = !this.nearCamera;

    const sw = Math.max(0, this.swingUntil - nowMs) / CONFIG.SWING_MS; // 1 → 0
    this.fist.position.x = PHYS.PLAYER_HALF + Math.sin(sw * Math.PI) * 0.7;
    this.fist.visible = state === 0;
    this.hpWrap.style.display = state === 2 ? "none" : "";

    // 3D 캐릭터: 실제 이동 속도로 가만히/걷기/달리기를 고르고 부드럽게 섞는다
    const real = this.lastMs ? (nowMs - this.lastMs) / 1000 : 0;
    const dt = Math.min(0.1, real); // 애니메이션은 한 번에 0.1초까지만 (탭 전환 뒤 튀지 않게)
    if (real > 0) {
      const v = Math.hypot(x - this.lastX, y - this.lastY) / real;
      this.speed += (v - this.speed) * Math.min(1, real * 10); // 튀는 값 누그러뜨리기
    }
    this.lastMs = nowMs; this.lastX = x; this.lastY = y;
    const ch = this.char;
    if (ch?.ready) {
      this.pivot.visible = false;
      ch.root.visible = !this.nearCamera;
      const pose: Pose = state === 2 ? "dead" : state === 1 ? "down" : z - groundZ > 0.25 ? "air"
        : this.speed > 4 ? "run" : this.speed > 0.4 ? "walk" : "idle";
      ch.setPose(pose, this.speed);
      ch.setLook(nowMs < this.flashUntil, opacity, state === 2);
      ch.crouch = state === 0 && crouch; // 무릎 굽혀 앉기 (걸으면 앉은 채 걷기)
      ch.update(dt);
    }
  }

  /** 이름표를 화면 좌표로 옮긴다 */
  placeLabel(camera: THREE.Camera, w: number, h: number) {
    if (this.nearCamera || this.hidden || this.labelHidden) { this.label.style.display = "none"; return; }
    tmp.copy(this.group.position);
    tmp.y += PHYS.PLAYER_HEIGHT + 0.35;
    tmp.project(camera);
    if (tmp.z > 1 || tmp.z < -1) {
      this.label.style.display = "none";
      return;
    }
    this.label.style.display = "block";
    this.label.style.transform = `translate(${((tmp.x + 1) / 2) * w}px, ${((1 - tmp.y) / 2) * h}px) translate(-50%, -100%)`;
  }

  dispose(scene: THREE.Scene) {
    scene.remove(this.group, this.shadow);
    this.label.remove();
  }
}
