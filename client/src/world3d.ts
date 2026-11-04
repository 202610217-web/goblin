// Three.js 장면: 맵, 캐릭터, 3인칭 카메라
// 좌표 변환: 게임 (x=동, y=북, z=위) → Three.js (X=x, Y=z, Z=-y)
import * as THREE from "three";
import { BOXES, HOUSES, PHYS, type TeamId } from "../../shared/world";
import { AIM, aimRay, clampPitch, rayAabb } from "../../shared/aim";
import type { Body } from "../../shared/sim";
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
    this.resize();
    window.addEventListener("resize", () => this.resize());
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

  private buildMap() {
    // 바닥
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(PHYS.MAP_X, PHYS.MAP_Y),
      new THREE.MeshLambertMaterial({ color: 0x6f9a5a }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(PHYS.MAP_X / 2, 0, -PHYS.MAP_Y / 2);
    this.scene.add(ground);
    const grid = new THREE.GridHelper(PHYS.MAP_X, PHYS.MAP_X, 0x5c8549, 0x5c8549);
    grid.scale.z = PHYS.MAP_Y / PHYS.MAP_X;
    grid.position.set(PHYS.MAP_X / 2, 0.01, -PHYS.MAP_Y / 2);
    this.scene.add(grid);

    // 맵 테두리 (낮은 울타리, 보기용)
    const fenceMat = new THREE.MeshLambertMaterial({ color: 0x7a5a3a });
    const fence = (cx: number, cy: number, sx: number, sy: number) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(sx, 0.6, sy), fenceMat);
      m.position.set(cx, 0.3, -cy);
      this.scene.add(m);
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
    for (const b of BOXES) {
      const sx = b.x1 - b.x0, sy = b.y1 - b.y0, sz = b.z1 - b.z0;
      const key = b.kind === "house" ? `house${b.team}` : b.kind;
      const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sz, sy), mats[key]);
      m.position.set((b.x0 + b.x1) / 2, (b.z0 + b.z1) / 2, -(b.y0 + b.y1) / 2);
      this.scene.add(m);
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
      this.scene.add(roof);
      const doorX = t === "A" ? h.x + h.size / 2 + 0.01 : h.x - h.size / 2 - 0.01;
      const door = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 2.4), new THREE.MeshLambertMaterial({ color: 0x5a3a22 }));
      door.rotation.y = t === "A" ? Math.PI / 2 : -Math.PI / 2;
      door.position.set(doorX, 1.2, -h.y);
      this.scene.add(door);
    }
  }

  /**
   * 3인칭 카메라: 오른쪽 어깨 뒤 위에서 바라본다.
   * 서버 타격 판정과 같은 광선(shared/aim.ts aimRay)을 써서 화면 가운데 = 조준점이 되게 한다.
   */
  updateCamera(x: number, y: number, z: number) {
    this.pitch = clampPitch(this.pitch);
    const { origin, dir } = aimRay({ x, y, z } as Body, this.yaw, this.pitch);
    // 카메라와 캐릭터 머리 사이를 벽/집이 가리면, 같은 조준선 위에서 카메라를 앞으로 당긴다
    // (조준선 자체는 그대로라 조준점과 서버 판정이 달라지지 않는다)
    const head = { x, y, z: z + AIM.CAMERA_TARGET_HEIGHT };
    let t = 0;
    for (let i = 0; i < 24 && this.blockedBetween(head, origin.x + dir.x * t, origin.y + dir.y * t, origin.z + dir.z * t); i++) t += 0.25;
    World3D.toThree(origin.x + dir.x * t, origin.y + dir.y * t, origin.z + dir.z * t, this.camera.position);
    this.camera.lookAt(World3D.toThree(origin.x + dir.x, origin.y + dir.y, origin.z + dir.z, tmp));
  }

  /** 머리(head)에서 카메라 위치(cx,cy,cz)까지 선분이 상자에 막히는지 */
  private blockedBetween(head: { x: number; y: number; z: number }, cx: number, cy: number, cz: number): boolean {
    const d = { x: cx - head.x, y: cy - head.y, z: cz - head.z };
    for (const b of BOXES) {
      const t = rayAabb(head, d, { x: b.x0 - 0.15, y: b.y0 - 0.15, z: b.z0 }, { x: b.x1 + 0.15, y: b.y1 + 0.15, z: b.z1 + 0.15 });
      if (t !== null && t > 0.02 && t <= 1) return true;
    }
    return false;
  }

  render() {
    this.renderer.render(this.scene, this.camera);
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
    shadow: new THREE.CircleGeometry(0.5, 20),
  };
  private static shadowMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.3, depthWrite: false });
  private static flashColor = new THREE.Color(0xffffff);
  private static deadColor = new THREE.Color(0x444444);
  private fist: THREE.Mesh;

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

  /** 맞았을 때 번쩍 */
  flash(nowMs: number) { this.flashUntil = nowMs + CONFIG.HIT_FLASH_MS; }
  /** 타격 동작 */
  swing(nowMs: number) { this.swingUntil = nowMs + CONFIG.SWING_MS; }

  /**
   * 위치/방향/상태 반영. state: 0=정상, 1=기절(눕고 반투명), 2=사망(눕고 회색)
   * invuln = 무적 중(깜빡임), dim = 재접속 대기 중(반투명)
   */
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

    const sw = Math.max(0, this.swingUntil - nowMs) / CONFIG.SWING_MS; // 1 → 0
    this.fist.position.x = PHYS.PLAYER_HALF + Math.sin(sw * Math.PI) * 0.7;
    this.fist.visible = state === 0;
    this.hpWrap.style.display = state === 2 ? "none" : "";
  }

  /** 이름표를 화면 좌표로 옮긴다 */
  placeLabel(camera: THREE.Camera, w: number, h: number) {
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
