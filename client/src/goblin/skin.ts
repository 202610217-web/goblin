// 고블린 스킨 설정. 색·재질·얼굴·옷·장비는 모두 여기서 바꾼다 (몸 모양은 body.ts).
// 새 스킨 = defineSkin({ ...바꿀 것만 }) → 기본 스킨 위에 덮어씌운다.
import * as THREE from "three";

/** 색 칸 (Figma 팔레트와 같은 이름) */
export type ColorSlot = "skin" | "skinShade" | "cloth" | "clothDark" | "eye" | "ink";
/** 분리된 몸 파츠. 각 파츠는 관절 위치가 원점인 그룹이라 옷·장비를 붙이거나 움직이기 쉽다 */
export type PartName =
  | "head" | "torso" | "armL" | "armR" | "handL" | "handR"
  | "legL" | "legR" | "footL" | "footR" | "earL" | "earR";

export type Mats = Record<ColorSlot, THREE.Material>;
/** 파츠에 붙일 조각을 만드는 함수. side = 그 파츠의 x 방향 부호 (캐릭터 왼쪽 L = +1, 오른쪽 R = -1, 가운데 = 0) */
export type PieceBuilder = (m: Mats, side: -1 | 0 | 1) => THREE.Object3D;

export interface GoblinSkin {
  name: string;
  colors: Record<ColorSlot, number>;
  material: { flatShading: boolean };
  /** 얼굴(눈·눈썹·코·입). head 파츠에 붙는다. 머리 중심 = (0, HEAD_CENTER_Y, 0), 얼굴 앞 = +z */
  face: PieceBuilder;
  /** 기본 옷 (파츠별). 스킨이 같은 파츠를 주면 그 파츠의 옷만 바뀐다 */
  outfit: Partial<Record<PartName, PieceBuilder>>;
  /** 장비 (모자, 무기 등). 옷 위에 덧붙는다 */
  equipment: Partial<Record<PartName, PieceBuilder>>;
}

// ---------- 기본 얼굴·옷에 쓰는 치수 (body.ts BODY와 맞춘 값) ----------
export const HEAD_R = 0.19;
export const HEAD_CENTER_Y = HEAD_R * 0.95;

const mesh = (g: THREE.BufferGeometry, m: THREE.Material, name: string) => {
  const o = new THREE.Mesh(g, m);
  o.name = name;
  return o;
};
const group = (name: string, ...kids: THREE.Object3D[]) => {
  const g = new THREE.Group();
  g.name = name;
  if (kids.length) g.add(...kids);
  return g;
};

/** 기본 얼굴: 큰 노란 눈, 찌푸린 눈썹, 앞으로 튀어나온 큰 코, 누런 송곳니 */
function baseFace(m: Mats): THREE.Object3D {
  const c = HEAD_CENTER_Y;
  const f = group("face");
  for (const s of [-1, 1]) {
    const eye = mesh(new THREE.SphereGeometry(0.052, 8, 6), m.eye, s < 0 ? "eyeL" : "eyeR");
    eye.position.set(s * 0.078, c + 0.035, 0.15);
    const pupil = mesh(new THREE.SphereGeometry(0.022, 6, 4), m.ink, "pupil");
    pupil.position.set(0, 0, 0.042);
    eye.add(pupil);
    const brow = mesh(new THREE.BoxGeometry(0.09, 0.022, 0.03), m.skinShade, "brow");
    brow.position.set(s * 0.07, c + 0.1, 0.16);
    brow.rotation.z = s * -0.35; // 안쪽이 내려간 찌푸린 눈썹
    f.add(eye, brow);
  }
  const nose = mesh(new THREE.ConeGeometry(0.06, 0.17, 6), m.skinShade, "nose");
  nose.rotation.x = Math.PI / 2 + 0.3; // 끝이 앞·아래로
  nose.position.set(0, c - 0.03, 0.235);
  const mouth = mesh(new THREE.BoxGeometry(0.13, 0.016, 0.02), m.ink, "mouth");
  mouth.position.set(0, c - 0.105, 0.17);
  f.add(nose, mouth);
  for (const s of [-1, 1]) {
    const fang = mesh(new THREE.ConeGeometry(0.012, 0.035, 4), m.eye, "fang");
    fang.position.set(s * 0.035, c - 0.088, 0.175); // 아랫니가 위로 솟은 송곳니
    f.add(fang);
  }
  return f;
}

/** 해진 튜닉: 아래 끝을 들쭉날쭉하게 + 벨트 + 가슴 천 패치 */
function tunic(m: Mats): THREE.Object3D {
  const h = 0.32;
  const g = new THREE.CylinderGeometry(0.14, 0.175, h, 10, 2);
  const pos = g.attributes.position!;
  for (let i = 0; i < pos.count; i++) {
    if (pos.getY(i) < -h / 2 + 1e-6) pos.setY(i, pos.getY(i) - (i % 2 ? 0.045 : 0)); // 지그재그 밑단
  }
  g.computeVertexNormals();
  const body = mesh(g, m.cloth, "tunic");
  body.position.y = h / 2;
  const belt = mesh(new THREE.CylinderGeometry(0.172, 0.176, 0.04, 10), m.clothDark, "belt");
  belt.position.y = 0.07;
  const patch = mesh(new THREE.BoxGeometry(0.05, 0.05, 0.02), m.clothDark, "patch");
  patch.position.set(0.06, 0.22, 0.142);
  patch.rotation.z = 0.25;
  return group("outfit", body, belt, patch);
}

/** 반바지 한쪽 (다리 윗부분을 덮음) */
const shorts: PieceBuilder = (m) => {
  const o = mesh(new THREE.CylinderGeometry(0.08, 0.085, 0.13, 8), m.clothDark, "shorts");
  o.position.y = -0.045;
  return group("outfit", o);
};

/** 발목 천 감개 */
const footWrap: PieceBuilder = (m) => {
  const o = mesh(new THREE.CylinderGeometry(0.052, 0.058, 0.04, 8), m.clothDark, "wrap");
  o.position.y = 0.01;
  return group("outfit", o);
};

export const BASE_SKIN: GoblinSkin = {
  name: "base",
  colors: {
    skin: 0x6fa33a,
    skinShade: 0x4c7a28,
    cloth: 0x7a5432,
    clothDark: 0x4a3120,
    eye: 0xf2d14b,
    ink: 0x1e1a16,
  },
  material: { flatShading: true }, // 로우폴리 각진 면
  face: baseFace,
  outfit: { torso: tunic, legL: shorts, legR: shorts, footL: footWrap, footR: footWrap },
  equipment: {},
};

/** 기본 스킨 위에 바꿀 것만 덮어씌운 스킨. outfit·equipment는 파츠 단위로 합친다 */
export function defineSkin(over: Partial<Omit<GoblinSkin, "colors" | "material">> & {
  colors?: Partial<GoblinSkin["colors"]>;
  material?: Partial<GoblinSkin["material"]>;
}, base: GoblinSkin = BASE_SKIN): GoblinSkin {
  return {
    ...base,
    ...over,
    colors: { ...base.colors, ...over.colors },
    material: { ...base.material, ...over.material },
    outfit: { ...base.outfit, ...over.outfit },
    equipment: { ...base.equipment, ...over.equipment },
  };
}

/** 스킨 색·재질로 재질 6개를 만든다 (파츠가 같은 색 칸이면 같은 재질을 나눠 씀) */
export function makeMats(skin: GoblinSkin): Mats {
  const out = {} as Mats;
  for (const k of Object.keys(skin.colors) as ColorSlot[]) {
    out[k] = new THREE.MeshLambertMaterial({ color: skin.colors[k], flatShading: skin.material.flatShading });
  }
  return out;
}
