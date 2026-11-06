// 궁극기용 Stylized 이펙트: 단색·각진 모양·탄력 있는 움직임 (애니 게임풍).
// 부드러운 그라데이션 대신 딱 떨어지는 색면을 쓰고, 크기는 튀어나왔다 줄어드는 곡선으로 움직인다.
// 모든 효과는 서버 시각 at 기준이라 모든 화면에서 같은 순간에 터진다. 좌표는 Three 좌표(y = 위).
import * as THREE from "three";

/** 톤 매핑 없이 밝은 단색 (고화질 블룸이 켜져 있으면 테두리가 살짝 번진다) */
const flat = (color: number, boost = 1) => new THREE.MeshBasicMaterial({
  color: new THREE.Color(color).multiplyScalar(boost), transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
});
/** 0→1로 튀어나오며 살짝 넘쳤다 돌아오는 곡선 */
const backOut = (t: number) => { const c = 1.9; const u = t - 1; return 1 + (c + 1) * u * u * u + c * u * u; };
const clamp01 = (t: number) => Math.min(1, Math.max(0, t));
/** 계단식 사라짐 (애니풍: 부드럽게 녹지 않고 단계로 끊김) */
const stepFade = (t: number, steps = 4) => 1 - Math.floor(clamp01(t) * steps) / steps;

interface Fx { root: THREE.Object3D; at: number; life: number; tick(t: number): void }

export class StylizedFx {
  private list: Fx[] = [];
  constructor(private scene: THREE.Scene) {}

  private add(root: THREE.Object3D, pos: THREE.Vector3, at: number, life: number, tick: (t: number) => void) {
    root.position.copy(pos);
    root.visible = false;
    this.scene.add(root);
    this.list.push({ root, at, life, tick });
  }

  /** 별 모양 폭발: 뾰족한 삼각 날개들이 튀어나왔다 계단식으로 사라진다 (안쪽 흰색 + 바깥 색) */
  burst(pos: THREE.Vector3, color: number, radius: number, at: number, spikes = 10) {
    const g = new THREE.Group();
    const shape = (r: number, inner: number, rot: number) => {
      const s = new THREE.Shape();
      for (let i = 0; i < spikes * 2; i++) {
        const a = (i / (spikes * 2)) * Math.PI * 2 + rot;
        const rr = i % 2 ? inner : r * (0.75 + 0.25 * ((i * 7919) % 3) / 2); // 날개 길이를 조금씩 다르게
        i ? s.lineTo(Math.cos(a) * rr, Math.sin(a) * rr) : s.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
      }
      return new THREE.ShapeGeometry(s);
    };
    const outer = new THREE.Mesh(shape(1, 0.38, 0), flat(color, 1.6));
    const core = new THREE.Mesh(shape(0.62, 0.28, Math.PI / spikes), flat(0xffffff, 2));
    core.position.z = 0.01;
    g.add(outer, core);
    const face = new THREE.Group(); // 땅과 수직으로 세워 어느 쪽에서 봐도 보이게 하는 대신, 카메라 방향은 update에서 맞춘다
    face.add(g);
    face.userData.billboard = true;
    this.add(face, pos, at, 420, (t) => {
      const k = t / 420;
      g.scale.setScalar(radius * backOut(clamp01(k * 3)) * (1 - 0.35 * k));
      g.rotation.z = k * 0.6;
      (outer.material as THREE.Material).opacity = stepFade(k, 3);
      (core.material as THREE.Material).opacity = stepFade(k * 1.6, 2);
    });
  }

  /** 땅에 퍼지는 충격파 고리: 두꺼웠다가 가늘어지며 퍼진다 */
  shock(pos: THREE.Vector3, color: number, radius: number, at: number, life = 520) {
    const geo = new THREE.RingGeometry(0.93, 1, 64).rotateX(-Math.PI / 2); // 얇은 띠
    const m = new THREE.Mesh(geo, flat(color, 1.4));
    const root = new THREE.Group();
    root.add(m);
    this.add(root, pos.clone().setY(pos.y + 0.06), at, life, (t) => {
      const k = t / life;
      const r = radius * (1 - (1 - k) * (1 - k) * (1 - k)); // 빠르게 퍼졌다 느려짐
      m.scale.set(r, 1, r);
      (m.material as THREE.Material).opacity = stepFade(k, 4);
    });
  }

  /** 불꽃 조각: 길쭉한 마름모가 사방으로 튀고 중력으로 떨어진다 (속도 방향으로 늘어남) */
  sparks(pos: THREE.Vector3, color: number, count: number, speed: number, at: number) {
    const root = new THREE.Group();
    const geo = new THREE.OctahedronGeometry(0.09, 0).scale(1, 3.2, 1);
    const mat = flat(color, 1.8);
    const parts: { m: THREE.Mesh; v: THREE.Vector3 }[] = [];
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + Math.random() * 0.4;
      const up = 0.35 + Math.random() * 0.9;
      const v = new THREE.Vector3(Math.cos(a), up, Math.sin(a)).normalize().multiplyScalar(speed * (0.6 + Math.random() * 0.6));
      const m = new THREE.Mesh(geo, mat);
      root.add(m);
      parts.push({ m, v });
    }
    const dir = new THREE.Vector3(), Y = new THREE.Vector3(0, 1, 0);
    this.add(root, pos, at, 650, (t) => {
      const s = t / 1000;
      for (const p of parts) {
        p.m.position.set(p.v.x * s, p.v.y * s - 9 * s * s, p.v.z * s);
        dir.set(p.v.x, p.v.y - 18 * s, p.v.z).normalize();
        p.m.quaternion.setFromUnitVectors(Y, dir);
        p.m.scale.setScalar(1 - t / 650);
      }
      mat.opacity = stepFade(t / 650, 3);
    });
  }

  /** 땅 균열: 가운데서 뻗는 검은 번개 모양 금 (천천히 사라짐) */
  crack(pos: THREE.Vector3, radius: number, at: number) {
    const root = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ color: 0x15100a, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2 + Math.random() * 0.5;
      const pts: THREE.Vector2[] = [];
      let x = 0, y = 0;
      const len = radius * (0.6 + Math.random() * 0.5), segs = 4;
      for (let k = 0; k <= segs; k++) { // 지그재그 선
        const r = (k / segs) * len, j = (Math.random() - 0.5) * 0.5;
        x = Math.cos(a + j) * r; y = Math.sin(a + j) * r;
        pts.push(new THREE.Vector2(x, y));
      }
      // 선을 얇은 띠로 (밑동이 굵고 끝이 가늘게)
      const s = new THREE.Shape();
      const w = (k: number) => 0.12 * (1 - k / segs) + 0.01;
      pts.forEach((p, k) => { const nx = -Math.sin(a) * w(k), ny = Math.cos(a) * w(k); k ? s.lineTo(p.x + nx, p.y + ny) : s.moveTo(p.x + nx, p.y + ny); });
      for (let k = segs; k >= 0; k--) { const p = pts[k]!; s.lineTo(p.x + Math.sin(a) * w(k), p.y - Math.cos(a) * w(k)); }
      root.add(new THREE.Mesh(new THREE.ShapeGeometry(s).rotateX(-Math.PI / 2), mat));
    }
    this.add(root, pos.clone().setY(pos.y + 0.03), at, 2200, (t) => {
      root.scale.setScalar(clamp01(t / 90)); // 순식간에 쩍
      mat.opacity = t < 1400 ? 0.85 : 0.85 * (1 - (t - 1400) / 800);
    });
  }

  /** 하늘에서 내려꽂히는 속도선 (세로로 긴 흰 띠 여러 개) */
  speedLines(pos: THREE.Vector3, color: number, radius: number, height: number, at: number, life = 260) {
    const root = new THREE.Group();
    const mat = flat(color, 1.5);
    const lines: THREE.Mesh[] = [];
    for (let i = 0; i < 9; i++) {
      const a = Math.random() * Math.PI * 2, r = radius * Math.sqrt(Math.random());
      const l = new THREE.Mesh(new THREE.PlaneGeometry(0.06 + Math.random() * 0.06, height * (0.5 + Math.random() * 0.5)), mat);
      l.position.set(Math.cos(a) * r, height * 0.5, Math.sin(a) * r);
      l.userData.billboardY = true;
      lines.push(l);
      root.add(l);
    }
    this.add(root, pos, at, life, (t) => {
      const k = t / life;
      for (const l of lines) l.position.y = height * (0.9 - k * 0.6);
      mat.opacity = stepFade(k, 3);
    });
  }

  /** 매 프레임: 시작 전엔 숨기고, 끝나면 지우고, 카메라를 보게 돌린다 */
  update(serverNow: number, camera: THREE.Camera) {
    this.list = this.list.filter((f) => {
      const t = serverNow - f.at;
      if (t > f.life) {
        this.scene.remove(f.root);
        f.root.traverse((o) => { if (o instanceof THREE.Mesh) { o.geometry.dispose(); (o.material as THREE.Material).dispose(); } });
        return false;
      }
      f.root.visible = t >= 0;
      if (t < 0) return true;
      if (f.root.userData.billboard) f.root.quaternion.copy(camera.quaternion);
      f.root.traverse((o) => { if (o.userData.billboardY) o.rotation.y = Math.atan2(camera.position.x - f.root.position.x - o.position.x, camera.position.z - f.root.position.z - o.position.z); });
      f.tick(t);
      return true;
    });
  }
}
