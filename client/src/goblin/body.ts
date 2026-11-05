// 고블린 베이스 바디 (로우폴리). 키 약 1.2m, 3등신, 큰 뾰족귀·코·눈, 구부정한 자세.
// 좌표: Three.js 기준 y = 위, +z = 앞(얼굴 방향), 발바닥 = y 0.
// 파츠마다 관절 위치에 원점을 둔 그룹을 만들어서, 나중에 파츠별로 돌리거나(애니메이션) 옷·장비를 붙일 수 있다.
import * as THREE from "three";
import { BASE_SKIN, type GoblinSkin, HEAD_CENTER_Y, HEAD_R, type Mats, type PartName, makeMats } from "./skin";

/** 몸 치수 (m) */
export const BODY = {
  HIP_Y: 0.4, // 엉덩이 높이 (다리 0.4m = 1등신)
  HIP_W: 0.085, // 다리 사이 반폭
  FOOT_H: 0.09, // 발목 높이
  LEG_R: 0.052,
  TORSO_LEN: 0.34,
  TORSO_R_TOP: 0.12,
  TORSO_R_BOTTOM: 0.15,
  LEAN: 0.3, // 상체를 앞으로 숙인 각 (약 17°)
  SHOULDER_W: 0.155,
  ARM_LEN: 0.33, // 손이 무릎 근처까지 오게
  ARM_R: 0.033,
  NECK_LEN: 0.05,
  HEAD_FORWARD: 0.1, // 머리를 몸통보다 앞으로 (구부정)
  EAR_LEN: 0.3, // 머리 높이보다 조금 짧게, 옆·위로
} as const;

export interface Goblin {
  root: THREE.Group;
  parts: Record<PartName, THREE.Group>;
}

const mesh = (g: THREE.BufferGeometry, m: THREE.Material, name: string) => {
  const o = new THREE.Mesh(g, m);
  o.name = name;
  return o;
};
const part = (name: string, parent: THREE.Object3D, x: number, y: number, z: number) => {
  const g = new THREE.Group();
  g.name = name;
  g.position.set(x, y, z);
  parent.add(g);
  return g;
};
/** 끝이 +y로 가는 원기둥/원뿔을 원점에서 아래(-y)로 늘어지게 (팔·다리용) */
const hanging = (g: THREE.BufferGeometry, len: number) => g.translate(0, -len / 2, 0);

export function buildGoblin(skin: GoblinSkin = BASE_SKIN, mats: Mats = makeMats(skin)): Goblin {
  const B = BODY;
  const root = new THREE.Group();
  root.name = `goblin:${skin.name}`;
  const parts = {} as Record<PartName, THREE.Group>;

  // ---- 다리 + 발 (엉덩이 관절에서 아래로) ----
  const legLen = B.HIP_Y - B.FOOT_H;
  for (const s of [-1, 1] as const) {
    const L = s > 0 ? "L" : "R"; // +z를 보고 있으니 캐릭터의 왼쪽 = +x
    const leg = part(`leg${L}`, root, s * B.HIP_W, B.HIP_Y, 0);
    leg.add(mesh(hanging(new THREE.CylinderGeometry(B.LEG_R, B.LEG_R * 0.85, legLen, 8), legLen), mats.skin, "leg"));
    const foot = part(`foot${L}`, leg, 0, -legLen, 0);
    const f = mesh(new THREE.SphereGeometry(1, 8, 5), mats.skin, "foot");
    f.scale.set(0.075, B.FOOT_H / 2, 0.14); // 크고 납작한 발, 앞으로 길게
    f.position.set(s * 0.012, -B.FOOT_H / 2, 0.055);
    foot.add(f);
    parts[`leg${L}`] = leg;
    parts[`foot${L}`] = foot;
  }

  // ---- 몸통 (엉덩이에서 위로, 앞으로 숙임) ----
  const torso = part("torso", root, 0, B.HIP_Y, 0);
  torso.rotation.x = B.LEAN;
  const t = mesh(new THREE.CylinderGeometry(B.TORSO_R_TOP, B.TORSO_R_BOTTOM, B.TORSO_LEN, 10).translate(0, B.TORSO_LEN / 2, 0), mats.skin, "torso");
  t.scale.z = 0.85; // 앞뒤로 약간 납작
  const neck = mesh(new THREE.CylinderGeometry(0.05, 0.06, B.NECK_LEN + 0.04, 8), mats.skin, "neck");
  neck.position.set(0, B.TORSO_LEN + B.NECK_LEN / 2, 0.03);
  torso.add(t, neck);
  parts.torso = torso;

  // ---- 팔 + 손 (어깨 관절에서 아래로. 몸통이 숙인 만큼 되돌려 팔은 거의 수직으로 늘어짐) ----
  for (const s of [-1, 1] as const) {
    const L = s > 0 ? "L" : "R"; // +z를 보고 있으니 캐릭터의 왼쪽 = +x
    const arm = part(`arm${L}`, torso, s * B.SHOULDER_W, B.TORSO_LEN - 0.04, 0);
    arm.rotation.set(-B.LEAN + 0.08, 0, s * 0.14); // 살짝 앞으로, 바깥으로 벌림
    const shoulder = mesh(new THREE.SphereGeometry(0.045, 8, 5), mats.skin, "shoulder");
    arm.add(shoulder, mesh(hanging(new THREE.CylinderGeometry(B.ARM_R * 1.2, B.ARM_R, B.ARM_LEN, 8), B.ARM_LEN), mats.skin, "arm"));
    const hand = part(`hand${L}`, arm, 0, -B.ARM_LEN, 0);
    const palm = mesh(new THREE.IcosahedronGeometry(0.05, 1), mats.skin, "palm");
    palm.scale.set(1, 1.15, 0.8);
    palm.position.y = -0.035;
    hand.add(palm);
    for (let i = 0; i < 3; i++) { // 손가락 3개 + 검은 손톱
      const finger = mesh(hanging(new THREE.ConeGeometry(0.014, 0.045, 5), 0.045), mats.ink, "claw");
      finger.position.set(s * 0.012 * (1 - i), -0.07, 0.028 - i * 0.026);
      hand.add(finger);
    }
    parts[`arm${L}`] = arm;
    parts[`hand${L}`] = hand;
  }

  // ---- 머리 + 귀 (목 위. 몸통 숙임을 되돌려 얼굴은 정면, 위치는 앞으로) ----
  const head = part("head", torso, 0, B.TORSO_LEN + B.NECK_LEN, B.HEAD_FORWARD);
  head.rotation.x = -B.LEAN;
  const skull = mesh(new THREE.SphereGeometry(HEAD_R, 14, 10), mats.skin, "skull");
  skull.scale.set(1.15, 1, 1.05); // 가로로 넓은 머리
  skull.position.y = HEAD_CENTER_Y;
  const jaw = mesh(new THREE.SphereGeometry(HEAD_R * 0.8, 10, 6), mats.skin, "jaw");
  jaw.scale.set(1.1, 0.6, 1);
  jaw.position.set(0, HEAD_CENTER_Y - 0.085, 0.04); // 아래턱을 앞으로 내밀어 원숭이 같은 옆모습
  head.add(skull, jaw);
  parts.head = head;

  for (const s of [-1, 1] as const) {
    const L = s > 0 ? "L" : "R"; // +z를 보고 있으니 캐릭터의 왼쪽 = +x
    const ear = part(`ear${L}`, head, s * HEAD_R * 1.02, HEAD_CENTER_Y + 0.04, -0.02);
    ear.rotation.set(-0.25, 0, -s * (Math.PI / 2 - 0.5)); // 옆으로 뻗고 위·뒤로 젖힘
    const outer = mesh(new THREE.ConeGeometry(0.075, B.EAR_LEN, 5).translate(0, B.EAR_LEN / 2, 0), mats.skin, "ear");
    outer.scale.z = 0.35; // 납작한 귀
    const inner = mesh(new THREE.ConeGeometry(0.045, B.EAR_LEN * 0.7, 5).translate(0, B.EAR_LEN * 0.35, 0), mats.skinShade, "earInner");
    inner.scale.z = 0.3;
    inner.position.z = 0.012;
    ear.add(outer, inner);
    parts[`ear${L}`] = ear;
  }

  // ---- 스킨: 얼굴 → 옷 → 장비 순서로 파츠에 붙인다 ----
  head.add(skin.face(mats, 0));
  const sideOf = (p: PartName): -1 | 0 | 1 => (p.endsWith("L") ? 1 : p.endsWith("R") ? -1 : 0);
  for (const layer of [skin.outfit, skin.equipment]) {
    for (const [p, build] of Object.entries(layer) as [PartName, NonNullable<GoblinSkin["outfit"][PartName]>][]) {
      parts[p].add(build(mats, sideOf(p)));
    }
  }
  return { root, parts };
}

/** 삼각형 수 (로우폴리 예산 1,500~3,000 확인용) */
export function triangleCount(obj: THREE.Object3D): number {
  let n = 0;
  obj.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const g = o.geometry as THREE.BufferGeometry;
    n += (g.index ? g.index.count : g.attributes.position!.count) / 3;
  });
  return n;
}
