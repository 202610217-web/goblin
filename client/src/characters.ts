// 직업별 3D 캐릭터 (KayKit Adventurers, CC0 — client/public/chars/LICENSE.txt)
// 동작은 모델에 들어 있는 애니메이션을 섞어서(crossfade) 부드럽게 바꾼다. 걷기·달리기는 실제 이동 속도에 맞춰 재생 속도를 바꾼다.
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import type { ClassId } from "../../shared/classes";
import { PHYS } from "../../shared/world";

const FILE: Record<ClassId, string> = { KNIGHT: "knight", ARCHER: "rogue_hooded", JAVELIN: "barbarian", GOBLIN: "rogue" };
/** 공격 동작 (직업별) */
const ATTACK: Record<ClassId, string> = { KNIGHT: "1H_Melee_Attack_Slice_Diagonal", ARCHER: "2H_Ranged_Shoot", JAVELIN: "Throw", GOBLIN: "1H_Melee_Attack_Stab" };

export type Pose = "idle" | "walk" | "run" | "air" | "down" | "dead" | "work" | "revive";
const CLIP: Record<Pose, string> = {
  idle: "Idle", walk: "Walking_A", run: "Running_A", air: "Jump_Idle",
  down: "Lie_Idle", dead: "Death_A", work: "1H_Melee_Attack_Chop", revive: "PickUp",
};
/** 걷기·달리기 동작이 원래 표현하는 속도 (m/s, 모델 키에 맞춘 값). 실제 속도 / 이 값 = 재생 속도 */
const NOMINAL_SPEED = { walk: 2.6, run: 5.6 };
const FADE = 0.2;
/** 앉기: 무릎 굽힘 각도, 상체 숙임 (라디안). 걷기 동작 위에 덧씌워서 "앉아서 걷기"가 된다 */
const CROUCH = { KNEE: 1.0, LEAN: 0.35 };
const X_AXIS = new THREE.Vector3(1, 0, 0);
const q = new THREE.Quaternion();
const v3 = new THREE.Vector3();

interface Loaded { scene: THREE.Object3D; clips: THREE.AnimationClip[]; scale: number }
const cache = new Map<ClassId, Promise<Loaded>>();
function load(cls: ClassId): Promise<Loaded> {
  let p = cache.get(cls);
  if (!p) {
    p = new GLTFLoader().loadAsync(`${import.meta.env.BASE_URL}chars/${FILE[cls]}.glb`).then((g) => {
      g.scene.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.frustumCulled = false; } });
      const h = new THREE.Box3().setFromObject(g.scene).getSize(new THREE.Vector3()).y;
      return { scene: g.scene, clips: g.animations, scale: (PHYS.PLAYER_HEIGHT * 0.95) / h };
    });
    cache.set(cls, p);
  }
  return p;
}

// ---------- 무기 모델 (KayKit 화살·단검, CC0 — client/public/props/LICENSE.txt). 길이 방향 = +Y, 촉 = +Y 끝, 가운데가 원점 ----------
const loadProp = (n: string) => new GLTFLoader().loadAsync(`${import.meta.env.BASE_URL}props/${n}.gltf`).then((g) => {
  g.scene.traverse((o) => { o.castShadow = true; });
  return g.scene;
});
/** 창: 나무 자루 + 끝에 단검 날 (단검 손잡이는 자루 속으로) */
function buildSpear(dagger: THREE.Object3D): THREE.Object3D {
  const spear = new THREE.Group();
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.028, 1.7, 8), new THREE.MeshStandardMaterial({ color: 0x7a5230, roughness: 0.8 }));
  shaft.position.y = -0.15;
  const head = dagger.clone();
  head.scale.setScalar(0.42);
  head.position.y = 0.72; // 손잡이(-0.22)가 자루 끝(0.7)에 묻힘
  shaft.castShadow = true;
  spear.add(shaft, head);
  return spear;
}
export const PROPS = Promise.all([loadProp("arrow"), loadProp("dagger")]).then(([arrow, dagger]) => {
  arrow.rotation.x = Math.PI; // 원본은 촉이 -Y
  arrow.scale.setScalar(1.3);
  return { arrow: new THREE.Group().add(arrow), spear: buildSpear(dagger) };
});
PROPS.catch(() => { /* 못 받으면 예전 막대 그대로 */ });

export class Character {
  readonly root = new THREE.Group();
  ready = false;
  private mixer: THREE.AnimationMixer | null = null;
  private actions = new Map<string, THREE.AnimationAction>();
  private current: THREE.AnimationAction | null = null;
  private pose: Pose = "idle";
  private oneShot: THREE.AnimationAction | null = null;
  private mats: THREE.MeshStandardMaterial[] = [];
  private baseColors: THREE.Color[] = [];
  private model: THREE.Object3D | null = null;
  private legs: [THREE.Object3D, THREE.Object3D, THREE.Object3D][] = [];
  private spine: THREE.Object3D | null = null;
  /** 앉아 있는지 (update에서 천천히 굽힌다) */
  crouch = false;
  private crouchW = 0;
  private bent: [THREE.Object3D, THREE.Quaternion][] = [];
  private bend(b: THREE.Object3D, angle: number) {
    this.bent.push([b, b.quaternion.clone()]);
    b.quaternion.multiply(q.setFromAxisAngle(X_AXIS, angle));
  }

  constructor(readonly cls: ClassId) {
    load(cls).then((l) => {
      const model = cloneSkinned(l.scene);
      model.scale.setScalar(l.scale);
      model.rotation.y = Math.PI / 2; // 모델 정면(+Z)을 게임 캐릭터 정면(+X)으로
      model.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        const mat = (m.material as THREE.MeshStandardMaterial).clone(); // 사람마다 번쩍임·투명도를 따로
        if (cls === "GOBLIN" && m.name.startsWith("Rogue_Head")) mat.color.setHex(0x8fd16a); // 초록 피부
        m.material = mat;
        this.mats.push(mat);
        this.baseColors.push(mat.color.clone());
      });
      // 앉기용 다리 뼈 (허벅지, 정강이, 발)와 허리
      for (const s of ["l", "r"]) {
        const b = ["upperleg", "lowerleg", "foot"].map((n) => model.getObjectByName(n + s)); // three가 이름의 점을 지움 (upperleg.l → upperlegl)
        if (b.every(Boolean)) this.legs.push(b as [THREE.Object3D, THREE.Object3D, THREE.Object3D]);
      }
      this.spine = model.getObjectByName("spine") ?? null;
      this.model = model;
      if (cls === "JAVELIN") this.addSpear(model, l.scale);
      this.root.add(model);
      this.mixer = new THREE.AnimationMixer(model);
      for (const c of l.clips) this.actions.set(c.name, this.mixer.clipAction(c));
      const dead = this.actions.get(CLIP.dead)!;
      dead.setLoop(THREE.LoopOnce, 1);
      dead.clampWhenFinished = true; // 쓰러진 자세 그대로
      this.mixer.addEventListener("finished", (e) => {
        if (e.action !== this.oneShot) return;
        this.oneShot = null;
        this.fadeTo(this.actions.get(CLIP[this.pose])!);
      });
      this.current = this.actions.get(CLIP[this.pose])!;
      this.current.play();
      this.ready = true;
    }).catch(() => { /* 모델을 못 받으면 예전 도형 캐릭터 그대로 */ });
  }

  /** 바바리안 오른손(handslot.r, three에선 handslotr)에 창 (모델 축척을 되돌려 실제 m 크기로) */
  private addSpear(model: THREE.Object3D, scale: number) {
    const hand = model.getObjectByName("handslotr");
    if (!hand) return;
    PROPS.then((p) => {
      const spear = p.spear.clone();
      spear.scale.setScalar(1 / scale);
      spear.position.y = 0.35 / scale;
      hand.add(spear);
    }).catch(() => {});
  }

  private fadeTo(next: THREE.AnimationAction) {
    if (next === this.current) return;
    next.reset().setEffectiveWeight(1).fadeIn(FADE).play();
    this.current?.fadeOut(FADE);
    this.current = next;
  }

  /** 지금 상태의 기본 동작 (같으면 재생 속도만 맞춘다). speed = 실제 수평 속도 m/s */
  setPose(p: Pose, speed = 0) {
    if (!this.ready) { this.pose = p; return; }
    const a = this.actions.get(CLIP[p])!;
    if (p === "walk" || p === "run") a.timeScale = THREE.MathUtils.clamp(speed / NOMINAL_SPEED[p], 0.6, 1.6);
    if (p === this.pose && (this.oneShot || this.current === a)) return;
    this.pose = p;
    if (p === "down" || p === "dead") this.oneShot = null; // 쓰러지면 공격 동작은 끊는다
    if (!this.oneShot) this.fadeTo(a);
  }

  /** 한 번만 재생하고 원래 동작으로 돌아가는 동작 */
  private playOnce(name: string, timeScale: number) {
    if (!this.ready || this.pose === "down" || this.pose === "dead") return;
    const a = this.actions.get(name);
    if (!a) return;
    a.setLoop(THREE.LoopOnce, 1);
    a.clampWhenFinished = true; // 끝 자세를 잡고 있다가 다음 동작으로 섞인다 (안 잡으면 섞이는 동안 T자 자세가 비침)
    a.timeScale = timeScale;
    this.oneShot = a;
    this.current?.fadeOut(0.08);
    a.reset().setEffectiveWeight(1).fadeIn(0.08).play();
    this.current = a;
  }

  attack() { this.playOnce(ATTACK[this.cls], 1.5); }
  hit() { if (!this.oneShot) this.playOnce("Hit_A", 1.6); }

  /** 번쩍임(맞음) · 투명도(기절·무적·재접속) · 회색(사망) */
  setLook(flash: boolean, opacity: number, dead: boolean) {
    this.mats.forEach((m, i) => {
      m.emissive.setRGB(flash ? 0.9 : 0, flash ? 0.9 : 0, flash ? 0.9 : 0);
      m.transparent = opacity < 1;
      m.opacity = opacity;
      m.color.copy(this.baseColors[i]!).multiplyScalar(dead ? 0.45 : 1);
    });
  }

  update(dt: number) {
    for (const [b, saved] of this.bent) b.quaternion.copy(saved); // 지난 프레임에 굽힌 걸 되돌린다 (동작이 없는 뼈에 쌓이지 않게)
    this.bent.length = 0;
    this.mixer?.update(dt);
    // 앉기: 동작이 정한 자세 위에 무릎을 굽히고(허벅지 앞, 정강이 뒤, 발 평평) 몸 전체를 그만큼 내린다
    this.crouchW += ((this.crouch ? 1 : 0) - this.crouchW) * Math.min(1, dt * 12);
    if (!this.model) return;
    const w = this.crouchW < 0.01 ? 0 : this.crouchW;
    const k = CROUCH.KNEE * w;
    this.model.position.y = 0;
    if (!w) return;
    const before = this.footY();
    for (const [up, low, foot] of this.legs) {
      this.bend(up, -k); // 이 모델 뼈는 -X 회전이 앞으로 굽힘
      this.bend(low, 1.7 * k);
      this.bend(foot, -0.7 * k);
    }
    if (this.spine) this.bend(this.spine, CROUCH.LEAN * w);
    this.model.position.y = before - this.footY(); // 굽혀서 떠오른 만큼 내려서 발이 땅에 닿게 (걷다 든 발은 그대로)
  }

  /** 낮은 쪽 발 높이 (캐릭터 기준) */
  private footY(): number {
    let y = Infinity;
    for (const l of this.legs) y = Math.min(y, this.root.worldToLocal(l[2].getWorldPosition(v3)).y);
    return y;
  }
}
