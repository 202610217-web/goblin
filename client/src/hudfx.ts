// 전투 화면 피드백: 목표 표시(화면 위 A/B·집 거리), 맞힘 표시, 맞은 방향, 데미지 숫자, 기절/사망 알림
import * as THREE from "three";

const v = new THREE.Vector3();

/** 목표 표시가 머무는 화면 영역 여백 (px): 위 = 점수판·팀 체력 아래, 아래 = 버튼 위, 옆 = 미니맵·알림 피함 */
const TOP = 175, BOTTOM = 150, SIDE = 70;

export interface Objective { key: string; label: string; x: number; y: number; z: number; color: string; active: boolean }

/** 3D 목표 위치를 화면에 표시. 화면 밖(뒤쪽 포함)이면 가장자리에 화살표로 붙인다 */
export class ObjectiveMarkers {
  private els = new Map<string, HTMLDivElement>();

  constructor(private root: HTMLElement) {}

  update(camera: THREE.Camera, list: Objective[], me: { x: number; y: number } | null) {
    const w = window.innerWidth, h = window.innerHeight;
    const seen = new Set<string>();
    for (const o of list) {
      seen.add(o.key);
      let el = this.els.get(o.key);
      if (!el) {
        el = document.createElement("div");
        el.className = "objMarker";
        el.innerHTML = `<i></i><b></b><span></span>`;
        this.root.appendChild(el);
        this.els.set(o.key, el);
      }
      v.set(o.x, o.z, -o.y).project(camera); // 게임 좌표 → Three 좌표 → 화면
      const behind = v.z > 1;
      let sx = ((v.x + 1) / 2) * w, sy = ((1 - v.y) / 2) * h;
      if (behind) { sx = w - sx; sy = h - BOTTOM; } // 뒤쪽은 좌우를 뒤집어 아래 가장자리에
      const off = behind || sx < SIDE || sx > w - SIDE || sy < TOP || sy > h - BOTTOM;
      sx = Math.min(w - SIDE, Math.max(SIDE, sx));
      sy = Math.min(h - BOTTOM, Math.max(TOP, sy));
      el.style.transform = `translate(${sx}px, ${sy}px) translate(-50%, -50%)`;
      el.style.setProperty("--c", o.color);
      el.classList.toggle("off", off);
      el.classList.toggle("active", o.active);
      // 화면 밖이면 그쪽을 가리키는 화살표
      const ang = Math.atan2(sy - h / 2, sx - w / 2);
      (el.firstChild as HTMLElement).style.transform = `rotate(${ang}rad) translateX(38px)`;
      (el.children[1] as HTMLElement).textContent = o.label;
      (el.children[2] as HTMLElement).textContent = me ? `${Math.round(Math.hypot(o.x - me.x, o.y - me.y))}m` : "";
    }
    for (const [k, el] of this.els) el.style.display = seen.has(k) ? "" : "none";
  }
}

/** 조준점에 잠깐 X 표시 (내 공격이 맞았을 때) */
export function hitMarker(crosshair: HTMLElement) {
  crosshair.classList.remove("hit");
  void crosshair.offsetWidth; // 애니메이션 다시 시작
  crosshair.classList.add("hit");
}

/** 맞은 방향 표시: 화면 가운데를 기준으로 공격한 쪽 가장자리가 붉게. rel = 카메라 정면 기준 각도 (왼쪽 +) */
export function damageDirection(root: HTMLElement, rel: number) {
  const el = document.createElement("div");
  el.className = "dmgDir";
  el.style.transform = `rotate(${-rel}rad)`;
  root.appendChild(el);
  setTimeout(() => el.remove(), 900);
}

/** 이름표 위로 떠오르는 데미지 숫자 */
export function damageNumber(label: HTMLElement, n: number) {
  const el = document.createElement("div");
  el.className = "dmgNum";
  el.textContent = `-${n}`;
  label.appendChild(el);
  setTimeout(() => el.remove(), 900);
}

/** 오른쪽 위 알림 줄 (5초 뒤 사라짐, 최대 4줄) */
export function feed(root: HTMLElement, text: string, kind: "down" | "dead" | "up" | "info") {
  const el = document.createElement("div");
  el.className = `feedItem ${kind}`;
  el.textContent = text;
  root.prepend(el);
  while (root.children.length > 4) root.lastChild!.remove();
  setTimeout(() => el.remove(), 5000);
}
