// 미니맵: 실제 충돌 데이터(BOXES_BY_MAP, BARRIERS, SITES)를 그대로 위에서 내려다본 그림. 북쪽이 위.
import { NEON_REGIONS, NEON_ZONES } from "../../shared/neon";
import { BARRIERS, BOXES_BY_MAP, type Box, MAPS, type MapId } from "../../shared/world";

const KIND_COLOR: Record<Box["kind"], string> = {
  building: "#3b4160", wall: "#8a90a2", hedge: "#2f7a3e", crate: "#a27a46", cargo: "#8a6438",
  planter: "#4f8a4a", jersey: "#c9c4b8", fountain: "#5a8ea8", tree: "#2f6b3a",
  step: "#6f7888", platform: "#8c95a8", ramp: "#7c8596", house: "#c9a08a",
};
const SITE_COLOR = { A: "#ffb02e", B: "#2ee6ff" } as const;
const TEAM_COLOR = { A: "#ff6b6b", B: "#5f95ff" } as const;
const BARRIER_COLOR = { all: "#ff3df0", atk: "#ff5a5a", def: "#4fa8ff" } as const;

export interface MinimapDot { x: number; y: number; face: number; team: "A" | "B"; me: boolean }

export class Minimap {
  private bg = document.createElement("canvas");
  private key = "";
  private k = 1; // 1m당 픽셀

  constructor(private canvas: HTMLCanvasElement) {}

  /** 맵이나 크기가 바뀔 때만 바닥·건물·사이트·스폰·구역 이름을 다시 그린다 */
  private build(map: MapId) {
    const m = MAPS[map];
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cssW = this.canvas.clientWidth || 200;
    this.k = (cssW / (m.x1 - m.x0)) * dpr;
    for (const c of [this.canvas, this.bg]) { c.width = Math.round((m.x1 - m.x0) * this.k); c.height = Math.round((m.y1 - m.y0) * this.k); }
    this.canvas.style.height = `${(cssW * (m.y1 - m.y0)) / (m.x1 - m.x0)}px`;
    const g = this.bg.getContext("2d")!;
    g.fillStyle = map === "NEON" ? "#1d2030" : "#5d7f4f";
    g.fillRect(0, 0, this.bg.width, this.bg.height);
    if (map === "NEON") {
      const zone = (r: { x0: number; y0: number; x1: number; y1: number }, fill: string) => { g.fillStyle = fill; this.rect(g, map, r); };
      zone(NEON_ZONES.siteA, "rgba(255,176,46,0.16)");
      zone(NEON_ZONES.siteB, "rgba(46,230,255,0.14)");
      zone(NEON_ZONES.spawnAtk, "rgba(255,90,90,0.35)");
      zone(NEON_ZONES.spawnDef, "rgba(79,168,255,0.35)");
    }
    for (const b of [...BOXES_BY_MAP[map]].sort((p, q) => p.z1 - q.z1)) {
      g.fillStyle = b.site ? SITE_COLOR[b.site] : b.kind === "house" && b.team ? TEAM_COLOR[b.team] : KIND_COLOR[b.kind];
      this.rect(g, map, b);
    }
    g.textAlign = "center";
    g.textBaseline = "middle";
    if (map === "NEON") {
      g.font = `${Math.round(2.2 * this.k)}px sans-serif`;
      g.fillStyle = "rgba(255,255,255,0.55)";
      for (const r of NEON_REGIONS) g.fillText(r.name, ...this.px(map, r.x, r.y));
      g.font = `bold ${Math.round(4 * this.k)}px sans-serif`;
      for (const b of BOXES_BY_MAP.NEON) if (b.site) { g.fillStyle = "#111"; g.fillText(b.site, ...this.px(map, (b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2)); }
      g.font = `bold ${Math.round(2.4 * this.k)}px sans-serif`;
      g.fillStyle = "#fff";
      g.fillText("공격", ...this.px(map, (NEON_ZONES.spawnAtk.x0 + NEON_ZONES.spawnAtk.x1) / 2, (NEON_ZONES.spawnAtk.y0 + NEON_ZONES.spawnAtk.y1) / 2));
      g.fillText("수비", ...this.px(map, (NEON_ZONES.spawnDef.x0 + NEON_ZONES.spawnDef.x1) / 2, (NEON_ZONES.spawnDef.y0 + NEON_ZONES.spawnDef.y1) / 2));
    }
  }

  private px(map: MapId, x: number, y: number): [number, number] {
    const m = MAPS[map];
    return [(x - m.x0) * this.k, (m.y1 - y) * this.k];
  }

  private rect(g: CanvasRenderingContext2D, map: MapId, r: { x0: number; y0: number; x1: number; y1: number }) {
    const [x, y] = this.px(map, r.x0, r.y1);
    g.fillRect(x, y, (r.x1 - r.x0) * this.k, (r.y1 - r.y0) * this.k);
  }

  /** 매 프레임: 결계(작동 중이면)와 사람 위치·방향 */
  draw(map: MapId, dots: MinimapDot[], barriers: boolean) {
    const key = `${map}:${this.canvas.clientWidth}`;
    if (key !== this.key) { this.key = key; this.build(map); }
    const g = this.canvas.getContext("2d")!;
    g.drawImage(this.bg, 0, 0);
    if (barriers && map === "NEON") {
      for (const w of BARRIERS) { g.fillStyle = BARRIER_COLOR[w.role]; this.rect(g, map, w); }
    }
    for (const d of dots) {
      const [x, y] = this.px(map, d.x, d.y);
      const r = (d.me ? 2.2 : 1.7) * this.k;
      g.save();
      g.translate(x, y);
      g.rotate(-d.face); // 화면 y는 아래가 +라서 반대로
      g.beginPath();
      g.moveTo(r * 1.4, 0); g.lineTo(-r, r * 0.9); g.lineTo(-r * 0.5, 0); g.lineTo(-r, -r * 0.9); g.closePath();
      g.fillStyle = TEAM_COLOR[d.team];
      g.fill();
      if (d.me) { g.lineWidth = 0.5 * this.k; g.strokeStyle = "#fff"; g.stroke(); }
      g.restore();
    }
  }
}
