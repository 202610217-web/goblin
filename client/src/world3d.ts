// Three.js 장면: 맵, 캐릭터, 3인칭 카메라
// 좌표 변환: 게임 (x=동, y=북, z=위) → Three.js (X=x, Y=z, Z=-y)
import * as THREE from "three";
import { BOXES, HOUSES, PHYS, type TeamId } from "../../shared/world";
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

  /** 3인칭 카메라: 대상 뒤쪽 위에서 바라본다 */
  updateCamera(x: number, y: number, z: number) {
    this.pitch = Math.min(CONFIG.CAMERA_PITCH_MAX, Math.max(CONFIG.CAMERA_PITCH_MIN, this.pitch));
    const d = CONFIG.CAMERA_DISTANCE;
    const tz = z + CONFIG.CAMERA_TARGET_HEIGHT;
    const back = d * Math.cos(this.pitch);
    const cx = x - Math.cos(this.yaw) * back;
    const cy = y - Math.sin(this.yaw) * back;
    const cz = tz + d * Math.sin(this.pitch);
    World3D.toThree(cx, cy, cz, this.camera.position);
    this.camera.lookAt(World3D.toThree(x, y, tz, tmp));
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}

/** 캐릭터 1명의 화면 표시 (메시와 이름표를 재사용) */
export class PlayerView {
  readonly group = new THREE.Group();
  private shadow: THREE.Mesh;
  private body: THREE.Mesh;
  readonly label: HTMLDivElement;
  private static geo = {
    body: new THREE.CapsuleGeometry(PHYS.PLAYER_HALF, PHYS.PLAYER_HEIGHT - PHYS.PLAYER_HALF * 2, 4, 12),
    visor: new THREE.BoxGeometry(0.2, 0.25, 0.55),
    shadow: new THREE.CircleGeometry(0.5, 20),
  };
  private static shadowMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.3, depthWrite: false });

  constructor(scene: THREE.Scene, team: TeamId, nickname: string, isMe: boolean) {
    const mat = new THREE.MeshLambertMaterial({ color: CONFIG.TEAM_COLOR[team] });
    this.body = new THREE.Mesh(PlayerView.geo.body, mat);
    this.body.position.y = PHYS.PLAYER_HEIGHT / 2;
    // 바라보는 방향 표시 (앞쪽 = +X)
    const visor = new THREE.Mesh(PlayerView.geo.visor, new THREE.MeshLambertMaterial({ color: isMe ? 0xffffff : 0x222222 }));
    visor.position.set(PHYS.PLAYER_HALF * 0.85, PHYS.PLAYER_HEIGHT * 0.78, 0);
    this.group.add(this.body, visor);
    scene.add(this.group);

    this.shadow = new THREE.Mesh(PlayerView.geo.shadow, PlayerView.shadowMat);
    this.shadow.rotation.x = -Math.PI / 2;
    scene.add(this.shadow);

    this.label = document.createElement("div");
    this.label.className = "label";
    this.label.style.color = team === "A" ? "#ffb3b3" : "#b8ccff";
    this.label.textContent = isMe ? `${nickname} (나)` : nickname;
    document.body.appendChild(this.label);
  }

  setNickname(text: string) {
    if (this.label.textContent !== text) this.label.textContent = text;
  }

  /** 위치/방향/바닥 높이 반영 */
  update(x: number, y: number, z: number, faceRad: number, groundZ: number, dim: boolean) {
    World3D.toThree(x, y, z, this.group.position);
    this.group.rotation.y = faceRad;
    World3D.toThree(x, y, groundZ + 0.02, this.shadow.position);
    const s = Math.max(0.4, 1 - (z - groundZ) * 0.25); // 높이 뜰수록 그림자 작게
    this.shadow.scale.setScalar(s);
    (this.body.material as THREE.MeshLambertMaterial).opacity = dim ? 0.45 : 1;
    (this.body.material as THREE.MeshLambertMaterial).transparent = dim;
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
