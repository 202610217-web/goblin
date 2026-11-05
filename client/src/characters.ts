// 직업별 3D 캐릭터 (KayKit Adventurers, CC0 — client/public/chars/LICENSE.txt)
// 동작은 모델에 들어 있는 애니메이션을 섞어서(crossfade) 부드럽게 바꾼다. 걷기·달리기는 실제 이동 속도에 맞춰 재생 속도를 바꾼다.
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import type { ClassId } from "../../shared/classes";
import { PHYS } from "../../shared/world";

const FILE: Record<ClassId, string> = { KNIGHT: "knight", ARCHER: "rogue_hooded", JAVELIN: "barbarian" };
/** 공격 동작 (직업별) */
const ATTACK: Record<ClassId, string> = { KNIGHT: "1H_Melee_Attack_Slice_Diagonal", ARCHER: "2H_Ranged_Shoot", JAVELIN: "Throw" };

export type Pose = "idle" | "walk" | "run" | "air" | "down" | "dead" | "work" | "revive";
const CLIP: Record<Pose, string> = {
  idle: "Idle", walk: "Walking_A", run: "Running_A", air: "Jump_Idle",
  down: "Lie_Idle", dead: "Death_A", work: "1H_Melee_Attack_Chop", revive: "PickUp",
};
/** 걷기·달리기 동작이 원래 표현하는 속도 (m/s, 모델 키에 맞춘 값). 실제 속도 / 이 값 = 재생 속도 */
const NOMINAL_SPEED = { walk: 2.6, run: 5.6 };
const FADE = 0.2;

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

export class Character {
  readonly root = new THREE.Group();
  ready = false;
  private mixer: THREE.AnimationMixer | null = null;
  private actions = new Map<string, THREE.AnimationAction>();
  private current: THREE.AnimationAction | null = null;
  private pose: Pose = "idle";
  private oneShot: THREE.AnimationAction | null = null;
  private mats: THREE.MeshStandardMaterial[] = [];

  constructor(readonly cls: ClassId) {
    load(cls).then((l) => {
      const model = cloneSkinned(l.scene);
      model.scale.setScalar(l.scale);
      model.rotation.y = Math.PI / 2; // 모델 정면(+Z)을 게임 캐릭터 정면(+X)으로
      model.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        m.material = (m.material as THREE.MeshStandardMaterial).clone(); // 사람마다 번쩍임·투명도를 따로
        this.mats.push(m.material as THREE.MeshStandardMaterial);
      });
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

  /** 바바리안 손(handslot.r)에 창: 나무 자루 + 쇠 날 (모델 축척을 되돌려 실제 m 크기로) */
  private addSpear(model: THREE.Object3D, scale: number) {
    const hand = model.getObjectByName("handslot.r");
    if (!hand) return;
    const k = 1 / scale;
    const spear = new THREE.Group();
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.025 * k, 0.025 * k, 1.9 * k, 8), new THREE.MeshStandardMaterial({ color: 0x7a5230, roughness: 0.8 }));
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.06 * k, 0.28 * k, 8), new THREE.MeshStandardMaterial({ color: 0xc8ccd4, metalness: 1, roughness: 0.3 }));
    tip.position.y = 1.08 * k;
    shaft.castShadow = tip.castShadow = true;
    spear.add(shaft, tip);
    spear.position.y = 0.2 * k;
    hand.add(spear);
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
    for (const m of this.mats) {
      m.emissive.setRGB(flash ? 0.9 : 0, flash ? 0.9 : 0, flash ? 0.9 : 0);
      m.transparent = opacity < 1;
      m.opacity = opacity;
      m.color.setScalar(dead ? 0.45 : 1);
    }
  }

  update(dt: number) { this.mixer?.update(dt); }
}
