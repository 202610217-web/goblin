// Three.js 장면: 맵, 캐릭터, 3인칭 카메라
// 좌표 변환: 게임 (x=동, y=북, z=위) → Three.js (X=x, Y=z, Z=-y)
import * as THREE from "three";
import { BARRIERS, BARRIER_HEIGHT, BOXES, BOXES_BY_MAP, type Box, HOUSES, MAPS, type MapId, PHYS, type TeamId, mapAt } from "../../shared/world";
import { NEON_GRID, NEON_ZONES, cellCenter } from "../../shared/neon";
import { AIM, type Vec3, aimConverge, aimRay, clampPitch, rayAabb } from "../../shared/aim";
import type { Body } from "../../shared/sim";
import type { ClassId } from "../../shared/classes";
import { firstSolid } from "../../shared/arrow";
import { CONFIG } from "./config";
import { Lighting, boxGeo, fitTo, groundGeo, model, photoMat } from "./graphics";

const tmp = new THREE.Vector3();

export class World3D {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  /** 카메라 방향 (게임 좌표계 기준 라디안). yaw = 카메라가 바라보는 수평 방향 */
  yaw = 0;
  pitch: number = CONFIG.CAMERA_PITCH_DEFAULT;

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, CONFIG.MAX_DPR));
    container.appendChild(this.renderer.domElement);
    this.camera = new THREE.PerspectiveCamera(CONFIG.CAMERA_FOV, 16 / 9, 0.1, 600);
    // 물리 하늘 + 하늘로 구운 환경광 + 해 그림자 + (고화질) 블룸
    this.light = new Lighting(this.renderer, this.scene, this.camera);

    this.buildMap();
    this.buildNeon();
    this.setMap("CLASSIC");
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
  private barrierGroup = new THREE.Group();

  /** 보여 줄 맵 */
  setMap(map: MapId) {
    if (map === this.map) return;
    this.map = map;
    this.classic.visible = map === "CLASSIC";
    this.neon.visible = map === "NEON";
    this.light.setMap(map);
  }
  private map: MapId | null = null;

  /** 그림자를 드리우고 받는 상자 하나 */
  private addBox(g: THREE.Group, b: Box, mat: THREE.Material, tile: number): THREE.Mesh {
    const m = new THREE.Mesh(boxGeo(b.x1 - b.x0, b.z1 - b.z0, b.y1 - b.y0, tile), mat);
    m.position.set((b.x0 + b.x1) / 2, (b.z0 + b.z1) / 2, -(b.y0 + b.y1) / 2);
    m.castShadow = m.receiveShadow = true;
    g.add(m);
    return m;
  }

  /** 나무 상자: 사진 재질 상자를 먼저 그려 두고, 모델이 오면 바꾼다 */
  private addCrate(g: THREE.Group, b: Box, fallback: THREE.Material) {
    const box = this.addBox(g, b, fallback, 1.5);
    model("wooden_crate_02").then((o) => {
      const w = fitTo(o, b.x1 - b.x0, b.z1 - b.z0, b.y1 - b.y0);
      w.position.set((b.x0 + b.x1) / 2, b.z0, -(b.y0 + b.y1) / 2);
      g.add(w);
      box.visible = false;
    }).catch(() => { /* 모델을 못 받으면 사진 상자 그대로 */ });
  }

  /** 준비 시간 결계 보이기/숨기기 */
  setBarriers(on: boolean) { this.barrierGroup.visible = on; }

  private buildMap() {
    this.scene.add(this.classic);
    const g = this.classic;
    // 바닥: 풀밭 사진 (사진 한 장 = 4m)
    const ground = new THREE.Mesh(groundGeo(PHYS.MAP_X + 40, PHYS.MAP_Y + 40, 4), photoMat("sparse_grass"));
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(PHYS.MAP_X / 2, 0, -PHYS.MAP_Y / 2);
    ground.receiveShadow = true;
    g.add(ground);

    // 맵 테두리 (낮은 나무 울타리, 보기용)
    const planks = photoMat("brown_planks_03");
    for (const [cx, cy, sx, sy] of [[PHYS.MAP_X / 2, -0.1, PHYS.MAP_X + 0.4, 0.2], [PHYS.MAP_X / 2, PHYS.MAP_Y + 0.1, PHYS.MAP_X + 0.4, 0.2],
      [-0.1, PHYS.MAP_Y / 2, 0.2, PHYS.MAP_Y], [PHYS.MAP_X + 0.1, PHYS.MAP_Y / 2, 0.2, PHYS.MAP_Y]] as const) {
      this.addBox(g, { x0: cx - sx / 2, x1: cx + sx / 2, y0: cy - sy / 2, y1: cy + sy / 2, z0: 0, z1: 0.6, kind: "wall" }, planks, 1.5);
    }

    // 충돌 상자들 (서버와 같은 데이터)에 사진 재질
    const mats = {
      wall: photoMat("concrete_block_wall"),
      step: photoMat("concrete_floor_02"),
      platform: photoMat("concrete_floor_02"),
      houseA: photoMat("red_brick_03", { tint: 0xffd6c8 }),
      houseB: photoMat("red_brick_03", { tint: 0xb9c8ff }),
    };
    for (const b of BOXES_BY_MAP.CLASSIC) {
      if (b.kind === "crate") { this.addCrate(g, b, planks); continue; }
      const key = (b.kind === "house" ? `house${b.team}` : b.kind) as keyof typeof mats;
      this.addBox(g, b, mats[key], 2);
    }

    // 집 지붕 (기와) + 문
    for (const t of ["A", "B"] as TeamId[]) {
      const h = HOUSES[t];
      const roof = new THREE.Mesh(new THREE.ConeGeometry(h.size * 0.78, 2.4, 4), photoMat("clay_roof_tiles", { tint: t === "A" ? 0xffb0a0 : 0xa8bcff }));
      roof.rotation.y = Math.PI / 4;
      roof.position.set(h.x, h.height + 1.2, -h.y);
      roof.castShadow = true;
      g.add(roof);
      const doorX = t === "A" ? h.x + h.size / 2 + 0.01 : h.x - h.size / 2 - 0.01;
      const door = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 2.4), photoMat("brown_planks_03", { tint: 0x8a6a50 }));
      door.rotation.y = t === "A" ? Math.PI / 2 : -Math.PI / 2;
      door.position.set(doorX, 1.2, -h.y);
      g.add(door);
    }
  }

  /** NEON DISTRICT: 서버와 같은 충돌 상자(BOXES_BY_MAP.NEON)를 그대로 그리고, 네온 테두리·나무·사이트 글자만 장식으로 더한다 */
  private buildNeon() {
    const g = this.neon;
    this.scene.add(g);
    const m = MAPS.NEON, w = m.x1 - m.x0, h = m.y1 - m.y0;
    // 바닥: 아스팔트 사진, 사이트 구역은 보도블록, 스폰 구역은 색 반투명 판
    const floor = (r: { x0: number; y0: number; x1: number; y1: number }, mat: THREE.Material, y: number, tile = 4) => {
      const p = new THREE.Mesh(groundGeo(r.x1 - r.x0, r.y1 - r.y0, tile), mat);
      p.rotation.x = -Math.PI / 2;
      p.position.set((r.x0 + r.x1) / 2, y, -(r.y0 + r.y1) / 2);
      p.receiveShadow = true;
      g.add(p);
    };
    floor({ x0: m.x0 - 20, y0: m.y0 - 20, x1: m.x1 + 20, y1: m.y1 + 20 }, photoMat("asphalt_02"), 0);
    floor(NEON_ZONES.siteA, photoMat("patterned_concrete_pavers", { tint: 0xffd9a0 }), 0.01, 3);
    floor(NEON_ZONES.siteB, photoMat("patterned_concrete_pavers", { tint: 0xb8f0ff }), 0.01, 3);
    const zone = (color: number) => new THREE.MeshStandardMaterial({ color, transparent: true, opacity: 0.3, depthWrite: false, roughness: 1 });
    floor(NEON_ZONES.spawnAtk, zone(0xff5a5a), 0.02);
    floor(NEON_ZONES.spawnDef, zone(0x4fa8ff), 0.02);
    const fenceMat = photoMat("concrete_block_wall", { tint: 0x9aa0b0 });
    for (const [cx, cy, sx, sy] of [[m.x0 + w / 2, -0.1, w + 0.4, 0.2], [m.x0 + w / 2, h + 0.1, w + 0.4, 0.2], [m.x0 - 0.1, h / 2, 0.2, h], [m.x1 + 0.1, h / 2, 0.2, h]] as const) {
      this.addBox(g, { x0: cx - sx / 2, x1: cx + sx / 2, y0: cy - sy / 2, y1: cy + sy / 2, z0: 0, z1: 1.2, kind: "wall" }, fenceMat, 2);
    }
    // 서버와 같은 충돌 상자에 사진 재질 (사진 한 장이 덮는 m)
    const mats: Record<string, [THREE.Material, number]> = {
      building: [photoMat("concrete_wall_008", { tint: 0x9aa0b8 }), 3],
      wall: [photoMat("concrete_block_wall"), 2],
      hedge: [photoMat("forest_leaves_02", { tint: 0x9fc29a }), 1.5],
      tree: [photoMat("bark_brown_02"), 1],
      jersey: [photoMat("concrete_floor_02", { tint: 0xe6e2da }), 1.5],
      step: [photoMat("concrete_floor_02"), 2],
      platform: [photoMat("concrete_floor_02"), 2],
      ramp: [photoMat("concrete_floor_02"), 2],
      A: [photoMat("metal_plate", { tint: 0xffb02e, metal: 0.6, emissive: 0x3a1e00 }), 2],
      B: [photoMat("metal_plate", { tint: 0x2ee6ff, metal: 0.6, emissive: 0x00303a }), 2],
    };
    const planks = photoMat("brown_planks_03");
    // 건물 모서리 네온 (톤 매핑 없이 밝게 → 블룸으로 번짐. 약한 색 성분은 1 아래로 둬야 흰색으로 안 잘림)
    const neonA = new THREE.LineBasicMaterial({ color: new THREE.Color(14, 0.6, 11), toneMapped: false });
    const neonB = new THREE.LineBasicMaterial({ color: new THREE.Color(0.3, 10, 14), toneMapped: false });
    const planterBase = photoMat("concrete_block_wall", { tint: 0xc8c4bc });
    const bush = photoMat("forest_leaves_02", { tint: 0xa8cc98 });
    const basin = photoMat("patterned_concrete_pavers", { tint: 0xd8d8d8 });
    const water = new THREE.MeshStandardMaterial({ color: 0x2c5a6e, roughness: 0.05, metalness: 0.2, transparent: true, opacity: 0.85 });
    BOXES_BY_MAP.NEON.forEach((b: Box, i) => {
      if (b.kind === "crate") { this.addCrate(g, b, planks); return; }
      // 짐 더미: 나무 상자 2단 (가판대·하역장·창고)
      if (b.kind === "cargo") {
        const mid = (b.z0 + b.z1) / 2;
        this.addCrate(g, { ...b, z1: mid }, planks);
        this.addCrate(g, { ...b, z0: mid, x0: b.x0 + 0.15, x1: b.x1 - 0.15, y0: b.y0 + 0.15, y1: b.y1 - 0.15 }, planks);
        return;
      }
      // 화단: 콘크리트 화분 위에 수풀 (충돌 높이 안에 모두 들어감)
      if (b.kind === "planter") {
        this.addBox(g, { ...b, z1: 0.7 }, planterBase, 1.5);
        this.addBox(g, { ...b, x0: b.x0 + 0.1, x1: b.x1 - 0.1, y0: b.y0 + 0.1, y1: b.y1 - 0.1, z0: 0.7 }, bush, 1);
        return;
      }
      // 분수: 돌 테두리 + 물 + 가운데 기둥
      if (b.kind === "fountain") {
        const t = 0.35;
        for (const r of [{ y1: b.y0 + t }, { y0: b.y1 - t }, { x1: b.x0 + t }, { x0: b.x1 - t }]) this.addBox(g, { ...b, ...r }, basin, 1);
        const pool = new THREE.Mesh(new THREE.PlaneGeometry(b.x1 - b.x0 - 2 * t, b.y1 - b.y0 - 2 * t), water);
        pool.rotation.x = -Math.PI / 2;
        pool.position.set((b.x0 + b.x1) / 2, b.z1 - 0.12, -(b.y0 + b.y1) / 2);
        g.add(pool);
        const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
        this.addBox(g, { ...b, x0: cx - 0.25, x1: cx + 0.25, y0: cy - 0.25, y1: cy + 0.25, z1: 1.6 }, basin, 1);
        return;
      }
      const [mat, tile] = mats[b.site ?? b.kind]!;
      const mesh = this.addBox(g, b, mat, tile);
      if (b.kind === "building") {
        const line = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry), i % 2 ? neonA : neonB);
        line.position.copy(mesh.position);
        g.add(line);
      }
    });
    // 나무 잎 (장식, 충돌은 기둥만)
    const leaf = photoMat("forest_leaves_02", { tint: 0xb8d8a8 });
    for (let s = 0; s < NEON_GRID.length; s++) for (let c = 0; c < NEON_GRID[s]!.length; c++) {
      if (NEON_GRID[s]![c] !== "o") continue;
      const p = cellCenter(c, s);
      const crown = new THREE.Mesh(new THREE.IcosahedronGeometry(1.4, 1), leaf);
      crown.position.set(p.x, 3.5, -p.y);
      crown.scale.y = 0.85;
      crown.castShadow = true;
      g.add(crown);
    }
    // 가로등 (Poly Haven 모델, 장식): 건물 벽에 붙여 세워 길을 막지 않는다. 전구는 스스로 빛남
    // 위치: 시장 거리 양쪽 건물 벽, 광장 북쪽 건물 벽, 사이트 담장 안쪽 (모두 벽에서 0.4m)
    const X = (c: number) => cellCenter(c, 0).x;
    const lamps: [number, number][] = [
      [X(34), 29.6], [X(40), 31.6], [X(36), 24.4], [X(41), 22.4], // 시장 거리
      [X(16), 37.6], [X(19), 37.6], [92.4, cellCenter(0, 10).y], // 광장 둘레
      [X(33), 42.4], [X(25), 13.6], [X(33), 13.6], // A 담장, B 담장
    ];
    model("street_lamp_01").then((proto) => {
      proto.traverse((o) => {
        const mat = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
        if (!mat?.name) return;
        if (mat.name.endsWith("bulb")) { mat.emissive = new THREE.Color(1, 0.8, 0.55); mat.emissiveIntensity = 30; mat.toneMapped = false; }
        if (mat.name.endsWith("glass")) { mat.emissive = new THREE.Color(1, 0.75, 0.5); mat.emissiveIntensity = 1.5; }
      });
      for (const [x, y] of lamps) {
        const o = proto.clone();
        o.position.set(x, 0, -y);
        g.add(o);
      }
    }).catch(() => { /* 모델을 못 받으면 가로등 없이 */ });
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
    // 결계: 반투명 벽 (역할별 색: 모두 = 보라, 공격팀만 = 빨강, 수비팀만 = 파랑)
    const color = { all: 0xff3df0, atk: 0xff5a5a, def: 0x4fa8ff } as const;
    for (const w of BARRIERS) {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w.x1 - w.x0, BARRIER_HEIGHT, w.y1 - w.y0),
        new THREE.MeshBasicMaterial({ color: color[w.role], transparent: true, opacity: 0.35, depthWrite: false }));
      mesh.position.set((w.x0 + w.x1) / 2, BARRIER_HEIGHT / 2, -(w.y0 + w.y1) / 2);
      this.barrierGroup.add(mesh);
    }
    this.barrierGroup.visible = false;
    g.add(this.barrierGroup);
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
    if (want < this.camK || dt === 0) this.camK = want; // 벽 쪽으로는 바로 (벽 너머가 보이지 않게)
    else this.camK += (want - this.camK) * (1 - Math.exp(-dt / CONFIG.CAMERA_EASE_OUT_S)); // 돌아갈 때는 부드럽게
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

  /** 머리에서 d 방향 선분(0~1)이 처음 벽/집(지붕 포함)에 닿는 비율. 안 닿으면 1 */
  private hitRatio(head: { x: number; y: number; z: number }, d: { x: number; y: number; z: number }): number {
    const pad = CONFIG.CAMERA_WALL_PAD;
    let k = 1;
    for (const b of BOXES) {
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
  private arrows: { by: string; mesh: THREE.Mesh; origin: Vec3; dir: Vec3; at: number; speed: number; maxDist: number }[] = [];
  private static arrowGeo = new THREE.CylinderGeometry(0.05, 0.05, 1, 5).rotateZ(-Math.PI / 2); // 길이 방향 = +X
  private static arrowMat = new THREE.MeshBasicMaterial({ color: 0xfff1b8 });

  addArrow(by: string, origin: Vec3, dir: Vec3, at: number, speed: number, range: number, spear: boolean) {
    const mesh = new THREE.Mesh(World3D.arrowGeo, World3D.arrowMat);
    if (spear) mesh.scale.set(2, 1.4, 1.4); // 창은 더 길고 굵게
    World3D.toThree(dir.x, dir.y, dir.z, tmp);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), tmp.normalize());
    this.scene.add(mesh);
    // 벽에 닿거나 사거리 끝이면 거기서 사라진다
    this.arrows.push({ by, mesh, origin, dir, at, speed, maxDist: Math.min(range, firstSolid(origin, dir, 0)) });
  }

  /** 맞았다는 소식이 오면 그 사람이 쏜 가장 오래된 화살을 지운다 */
  removeArrow(by: string) {
    const i = this.arrows.findIndex((a) => a.by === by);
    if (i < 0) return;
    this.scene.remove(this.arrows[i]!.mesh);
    this.arrows.splice(i, 1);
  }

  updateArrows(serverNow: number) {
    this.arrows = this.arrows.filter((a) => {
      const d = (a.speed * Math.max(0, serverNow - a.at)) / 1000;
      if (d > a.maxDist) { this.scene.remove(a.mesh); return false; }
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
    shadow: new THREE.CircleGeometry(0.5, 20),
  };
  private static shadowMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.3, depthWrite: false });
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

    this.shadow = new THREE.Mesh(PlayerView.geo.shadow, PlayerView.shadowMat);
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

  /** 손에 든 무기 (기사 = 검, 궁수 = 활) */
  setWeapon(cls: ClassId) {
    this.sword.visible = cls === "KNIGHT";
    this.bow.visible = cls === "ARCHER";
    this.spear.visible = cls === "JAVELIN";
  }

  /** 맞았을 때 번쩍 */
  flash(nowMs: number) { this.flashUntil = nowMs + CONFIG.HIT_FLASH_MS; }
  /** 타격 동작 */
  swing(nowMs: number) { this.swingUntil = nowMs + CONFIG.SWING_MS; }

  /**
   * 위치/방향/상태 반영. state: 0=정상, 1=기절(눕고 반투명), 2=사망(눕고 회색)
   * invuln = 무적 중(깜빡임), dim = 재접속 대기 중(반투명)
   */
  /** 카메라가 아주 가까우면 내 캐릭터를 숨긴다 (화면을 가리지 않게) */
  nearCamera = false;

  update(x: number, y: number, z: number, faceRad: number, groundZ: number, state: 0 | 1 | 2, invuln: boolean, dim: boolean, nowMs: number) {
    World3D.toThree(x, y, z, this.group.position);
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
  }

  /** 이름표를 화면 좌표로 옮긴다 */
  placeLabel(camera: THREE.Camera, w: number, h: number) {
    if (this.nearCamera) { this.label.style.display = "none"; return; }
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
