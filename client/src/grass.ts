// 진짜 풀잎: 가는 잎 10장 묶음을 땅에 1.6만 개쯤 (잎 1장 = 삼각형 1개) (12m 칸마다 InstancedMesh 하나 → 화면 밖 칸은 안 그림).
// 잎 끝으로 갈수록 밝은 연두, 바람에 끝이 흔들린다(정점 셰이더). 그림자는 받기만 한다.
import * as THREE from "three";

/** 바람 시각(초). World3D.render가 매 프레임 넣는다 */
export const wind = { value: 0 };

const BASE = new THREE.Color(0x1c3010), TIP = new THREE.Color(0x86a04c);

/** 잎 10장 묶음 하나 (원점 = 바닥 가운데, 높이 약 0.3m). 잎 = 뿌리 두 점 + 기울어진 끝 한 점 */
function clump(rnd: () => number): THREE.BufferGeometry {
  const pos: number[] = [], col: number[] = [], idx: number[] = [];
  const c = new THREE.Color();
  for (let b = 0; b < 10; b++) {
    const yaw = rnd() * Math.PI * 2, h = 0.18 + rnd() * 0.22, w = 0.016 + rnd() * 0.014, lean = (rnd() - 0.2) * 0.3 * h;
    const r = Math.sqrt(rnd()) * 0.24, a = rnd() * Math.PI * 2, ox = Math.cos(a) * r, oz = Math.sin(a) * r;
    const fx = Math.cos(yaw), fz = Math.sin(yaw), sx = -fz, sz = fx; // 잎이 기우는 방향 f, 잎 너비 방향 s
    const v0 = pos.length / 3;
    pos.push(ox - sx * w, 0, oz - sz * w, ox + sx * w, 0, oz + sz * w, ox + fx * lean, h, oz + fz * lean);
    for (const t of [0, 0, 1]) { c.copy(BASE).lerp(TIP, t * (0.7 + rnd() * 0.3)); col.push(c.r, c.g, c.b); }
    idx.push(v0, v0 + 1, v0 + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  // 모든 정점의 법선을 위로: 앞뒤·방향에 상관없이 땅처럼 고르게 밝다 (얇은 잎이 까맣게 보이지 않게)
  g.setAttribute("normal", new THREE.Float32BufferAttribute(pos.map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  g.setIndex(idx);
  return g;
}

function material(): THREE.MeshLambertMaterial {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  m.onBeforeCompile = (s) => {
    s.uniforms.uWind = wind;
    s.vertexShader = "uniform float uWind;\n" + s.vertexShader.replace("#include <begin_vertex>", `#include <begin_vertex>
      vec4 root = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
      float gust = sin(uWind * 1.6 + root.x * 0.31 + root.z * 0.23) * 0.6 + sin(uWind * 3.1 + root.x * 1.3 - root.z * 0.7) * 0.25;
      float k = position.y * position.y * 1.6; // 뿌리는 그대로, 끝만 흔들림
      transformed.x += gust * k;
      transformed.z += gust * k * 0.6;`);
  };
  return m;
}

/**
 * x0~x1, y0~y1(지도 좌표) 안에서 keep(x, y)인 곳에 풀을 심는다. 간격 0.45m(조금씩 흔들어서 줄이 안 보이게).
 * 같은 seed면 늘 같은 자리
 */
export function grassField(x0: number, y0: number, x1: number, y1: number, keep: (x: number, y: number) => boolean, seed: number): THREE.Group {
  let s = seed;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const shapes = [clump(rnd), clump(rnd), clump(rnd)];
  const mat = material();
  const out = new THREE.Group();
  const CHUNK = 12, STEP = 0.45;
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), tint = new THREE.Color();
  for (let cx = x0; cx < x1; cx += CHUNK) for (let cy = y0; cy < y1; cy += CHUNK) {
    const spots: [number, number][] = [];
    for (let x = cx; x < Math.min(cx + CHUNK, x1); x += STEP) for (let y = cy; y < Math.min(cy + CHUNK, y1); y += STEP) {
      const px = x + rnd() * STEP, py = y + rnd() * STEP;
      if (keep(px, py)) spots.push([px, py]);
    }
    if (!spots.length) continue;
    // 칸마다 묶음 모양 하나 (3가지를 칸별로 번갈아). 묶음마다 방향·키·색을 달리 해서 반복돼 보이지 않는다 → 칸당 그리기 1번
    const im = new THREE.InstancedMesh(shapes[out.children.length % shapes.length]!, mat, spots.length);
    spots.forEach(([x, y], j) => {
      const h = 0.75 + rnd() * 0.6;
      im.setMatrixAt(j, m.compose(p.set(x, 0, -y), q.setFromAxisAngle(up, rnd() * Math.PI * 2), sc.set(1, h, 1)));
      const v = 0.8 + rnd() * 0.25;
      im.setColorAt(j, tint.setRGB(v * (0.9 + rnd() * 0.2), v, v * (0.8 + rnd() * 0.2))); // 군데군데 누렇거나 짙은 풀
    });
    im.computeBoundingSphere();
    im.receiveShadow = true;
    out.add(im);
  }
  return out;
}
