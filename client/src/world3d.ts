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
    this.camera = new THREE.PerspectiveCamera(CONFIG.CAMERA_FOV, 16 / 9, 0.1, 200);
    this.scene.background = new THREE.Color(0x8fb8de);
    this.scene.fog = new THREE.Fog(0x8fb8de, 45, 90);

    // 조명: 그림자는 성능 때문에 끄고, 발밑 원형 그림자로 대신한다
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x556644, 1.4));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(-20, 40, 10);
    this.scene.add(sun);

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
  }

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
    this.classic.visible = map === "CLASSIC";
    this.neon.visible = map === "NEON";
    const sky = map === "NEON" ? 0x1a1c2c : 0x8fb8de;
    (this.scene.background as THREE.Color).setHex(sky);
    this.scene.fog!.color.setHex(sky);
  }

  /** 준비 시간 결계 보이기/숨기기 */
  setBarriers(on: boolean) { this.barrierGroup.visible = on; }

  private buildMap() {
    this.scene.add(this.classic);
    // 바닥
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(PHYS.MAP_X, PHYS.MAP_Y),
      new THREE.MeshLambertMaterial({ color: 0x6f9a5a }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(PHYS.MAP_X / 2, 0, -PHYS.MAP_Y / 2);
    this.classic.add(ground);
    const grid = new THREE.GridHelper(PHYS.MAP_X, PHYS.MAP_X, 0x5c8549, 0x5c8549);
    grid.scale.z = PHYS.MAP_Y / PHYS.MAP_X;
    grid.position.set(PHYS.MAP_X / 2, 0.01, -PHYS.MAP_Y / 2);
    this.classic.add(grid);

    // 맵 테두리 (낮은 울타리, 보기용)
    const fenceMat = new THREE.MeshLambertMaterial({ color: 0x7a5a3a });
    const fence = (cx: number, cy: number, sx: number, sy: number) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(sx, 0.6, sy), fenceMat);
      m.position.set(cx, 0.3, -cy);
      this.classic.add(m);
    };
    fence(PHYS.MAP_X / 2, -0.1, PHYS.MAP_X + 0.4, 0.2);
    fence(PHYS.MAP_X / 2, PHYS.MAP_Y + 0.1, PHYS.MAP_X + 0.4, 0.2);
    fence(-0.1, PHYS.MAP_Y / 2, 0.2, PHYS.MAP_Y);
    fence(PHYS.MAP_X + 0.1, PHYS.MAP_Y / 2, 0.2, PHYS.MAP_Y);

    // 충돌 상자들 (서버와 같은 데이터)
    const mats: Record<string, THREE.Material> = {
      wall: new THREE.MeshLambertMaterial({ color: 0x9a9a9a }),
      crate: new THREE.MeshLambertMaterial({ color: 0xb98a4b }),
      step: new THREE.MeshLambertMaterial({ color: 0xc9c2b0 }),
      platform: new THREE.MeshLambertMaterial({ color: 0xd8d0bb }),
      houseA: new THREE.MeshLambertMaterial({ color: 0xc9a08a }),
      houseB: new THREE.MeshLambertMaterial({ color: 0x8aa0c9 }),
    };
    for (const b of BOXES_BY_MAP.CLASSIC) {
      const sx = b.x1 - b.x0, sy = b.y1 - b.y0, sz = b.z1 - b.z0;
      const key = b.kind === "house" ? `house${b.team}` : b.kind;
      const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sz, sy), mats[key]);
      m.position.set((b.x0 + b.x1) / 2, (b.z0 + b.z1) / 2, -(b.y0 + b.y1) / 2);
      this.classic.add(m);
    }

    // 집 지붕 (보기용 사각뿔) + 문
    for (const t of ["A", "B"] as TeamId[]) {
      const h = HOUSES[t];
      const roof = new THREE.Mesh(
        new THREE.ConeGeometry(h.size * 0.78, 2.4, 4),
        new THREE.MeshLambertMaterial({ color: CONFIG.TEAM_COLOR[t] }),
      );
      roof.rotation.y = Math.PI / 4;
      roof.position.set(h.x, h.height + 1.2, -h.y);
      this.classic.add(roof);
      const doorX = t === "A" ? h.x + h.size / 2 + 0.01 : h.x - h.size / 2 - 0.01;
      const door = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 2.4), new THREE.MeshLambertMaterial({ color: 0x5a3a22 }));
      door.rotation.y = t === "A" ? Math.PI / 2 : -Math.PI / 2;
      door.position.set(doorX, 1.2, -h.y);
      this.classic.add(door);
    }
  }

  /** NEON DISTRICT: 서버와 같은 충돌 상자(BOXES_BY_MAP.NEON)를 그대로 그리고, 네온 테두리·나무·사이트 글자만 장식으로 더한다 */
  private buildNeon() {
    const g = this.neon;
    this.scene.add(g);
    const m = MAPS.NEON, w = m.x1 - m.x0, h = m.y1 - m.y0;
    const plane = (r: { x0: number; y0: number; x1: number; y1: number }, color: number, y: number, opacity = 1) => {
      const p = new THREE.Mesh(new THREE.PlaneGeometry(r.x1 - r.x0, r.y1 - r.y0),
        new THREE.MeshLambertMaterial({ color, transparent: opacity < 1, opacity, depthWrite: opacity === 1 }));
      p.rotation.x = -Math.PI / 2;
      p.position.set((r.x0 + r.x1) / 2, y, -(r.y0 + r.y1) / 2);
      g.add(p);
    };
    plane(m, 0x2a2d3a, 0); // 아스팔트
    plane(NEON_ZONES.siteA, 0xffb02e, 0.01, 0.18);
    plane(NEON_ZONES.siteB, 0x2ee6ff, 0.01, 0.16);
    plane(NEON_ZONES.spawnAtk, 0xff5a5a, 0.02, 0.35);
    plane(NEON_ZONES.spawnDef, 0x4fa8ff, 0.02, 0.35);
    const fenceMat = new THREE.MeshLambertMaterial({ color: 0x44485c });
    for (const [cx, cy, sx, sy] of [[m.x0 + w / 2, -0.1, w + 0.4, 0.2], [m.x0 + w / 2, h + 0.1, w + 0.4, 0.2], [m.x0 - 0.1, h / 2, 0.2, h], [m.x1 + 0.1, h / 2, 0.2, h]] as const) {
      const f = new THREE.Mesh(new THREE.BoxGeometry(sx, 1.2, sy), fenceMat);
      f.position.set(cx, 0.6, -cy);
      g.add(f);
    }
    const mats: Record<string, THREE.Material> = {
      building: new THREE.MeshLambertMaterial({ color: 0x343a55 }),
      wall: new THREE.MeshLambertMaterial({ color: 0x7d8396 }),
      hedge: new THREE.MeshLambertMaterial({ color: 0x2f7a3e }),
      crate: new THREE.MeshLambertMaterial({ color: 0xa27a46 }),
      prop: new THREE.MeshLambertMaterial({ color: 0x6d5f86 }),
      step: new THREE.MeshLambertMaterial({ color: 0x8b93a6 }),
      platform: new THREE.MeshLambertMaterial({ color: 0x9aa2b5 }),
      ramp: new THREE.MeshLambertMaterial({ color: 0x8b93a6 }),
      A: new THREE.MeshLambertMaterial({ color: 0xffb02e, emissive: 0x553300 }),
      B: new THREE.MeshLambertMaterial({ color: 0x2ee6ff, emissive: 0x004450 }),
    };
    const edge = { building: new THREE.LineBasicMaterial({ color: 0xff3df0 }), building2: new THREE.LineBasicMaterial({ color: 0x2ee6ff }) };
    BOXES_BY_MAP.NEON.forEach((b: Box, i) => {
      const geo = new THREE.BoxGeometry(b.x1 - b.x0, b.z1 - b.z0, b.y1 - b.y0);
      const mesh = new THREE.Mesh(geo, mats[b.site ?? b.kind]);
      mesh.position.set((b.x0 + b.x1) / 2, (b.z0 + b.z1) / 2, -(b.y0 + b.y1) / 2);
      g.add(mesh);
      // 건물 모서리 네온 선 (장식)
      if (b.kind === "building") {
        const line = new THREE.LineSegments(new THREE.EdgesGeometry(geo), i % 2 ? edge.building : edge.building2);
        line.position.copy(mesh.position);
        g.add(line);
      }
    });
    // 나무 잎 (장식, 충돌은 기둥만)
    const leaf = new THREE.MeshLambertMaterial({ color: 0x2f8f4e });
    for (let s = 0; s < NEON_GRID.length; s++) for (let c = 0; c < NEON_GRID[s]!.length; c++) {
      if (NEON_GRID[s]![c] !== "o") continue;
      const p = cellCenter(c, s);
      const crown = new THREE.Mesh(new THREE.SphereGeometry(1.3, 10, 8), leaf);
      crown.position.set(p.x, 3.4, -p.y);
      g.add(crown);
    }
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
    this.renderer.render(this.scene, this.camera);
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
  private bodyMat: THREE.MeshLambertMaterial;
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
    this.bodyMat = new THREE.MeshLambertMaterial({ color: this.baseColor.clone(), transparent: true });
    const body = new THREE.Mesh(PlayerView.geo.body, this.bodyMat);
    body.position.y = PHYS.PLAYER_HEIGHT / 2;
    // 바라보는 방향 표시 (앞쪽 = +X)
    const visor = new THREE.Mesh(PlayerView.geo.visor, new THREE.MeshLambertMaterial({ color: isMe ? 0xffffff : 0x222222 }));
    visor.position.set(PHYS.PLAYER_HALF * 0.85, PHYS.PLAYER_HEIGHT * 0.78, 0);
    // 타격할 때 앞으로 뻗는 주먹
    this.fist = new THREE.Mesh(PlayerView.geo.fist, new THREE.MeshLambertMaterial({ color: 0xffe0b0 }));
    this.fist.position.set(PHYS.PLAYER_HALF, PHYS.PLAYER_HEIGHT * 0.55, -0.25);
    const wood = new THREE.MeshLambertMaterial({ color: 0x8a5a2b });
    this.sword = new THREE.Mesh(PlayerView.geo.sword, new THREE.MeshLambertMaterial({ color: 0xd8dde6 }));
    this.bow = new THREE.Mesh(PlayerView.geo.bow, wood);
    this.bow.visible = false;
    this.spear.add(new THREE.Mesh(PlayerView.geo.spear, wood), new THREE.Mesh(PlayerView.geo.spearTip, new THREE.MeshLambertMaterial({ color: 0xc8ccd4 })));
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
