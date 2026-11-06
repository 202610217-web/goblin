// 버튼 배치 바꾸기: 편집 중엔 버튼을 끌어서 옮기고, 위치(#buttons 상자 오른쪽·아래 기준 px)를 기기에 저장한다.
const KEY = "btnLayout";
const IDS = ["attackBtn", "jumpBtn", "crouchBtn", "skillBtn", "ultBtn"];
type Layout = Record<string, { r: number; b: number }>;

function load(): Layout {
  try { return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Layout; } catch { return {}; }
}
function apply(l: Layout) {
  for (const id of IDS) {
    const el = document.getElementById(id)!, p = l[id];
    el.style.right = p ? `${p.r}px` : "";
    el.style.bottom = p ? `${p.b}px` : "";
  }
}

export function setupLayoutEditor(openBtn: HTMLElement, bar: HTMLElement, resetBtn: HTMLElement, doneBtn: HTMLElement) {
  let layout = load();
  apply(layout);
  const box = document.getElementById("buttons")!;
  let drag: { id: string; pid: number; x0: number; y0: number; r0: number; b0: number; rect: DOMRect; k: number } | null = null;

  // 편집 중에는 캡처 단계에서 가로채서 원래 버튼 동작(타격 등)이 안 일어나게 한다
  box.addEventListener("pointerdown", (e) => {
    if (!document.body.classList.contains("editLayout")) return;
    const el = (e.target as HTMLElement).closest<HTMLElement>(".gameBtn");
    if (!el || drag) return;
    e.stopPropagation();
    e.preventDefault();
    const cs = getComputedStyle(el);
    // 화면 크기에 따라 #buttons가 축소돼 있을 수 있어서, 손가락 이동을 상자 좌표로 바꾼다
    drag = { id: el.id, pid: e.pointerId, x0: e.clientX, y0: e.clientY, r0: parseFloat(cs.right), b0: parseFloat(cs.bottom), rect: el.getBoundingClientRect(), k: box.getBoundingClientRect().width / box.offsetWidth || 1 };
    el.setPointerCapture(e.pointerId);
  }, { capture: true });
  box.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.pid) return;
    const { rect } = drag;
    // 화면 밖으로는 못 나가게
    const dx = Math.min(innerWidth - rect.right, Math.max(-rect.left, e.clientX - drag.x0));
    const dy = Math.min(innerHeight - rect.bottom, Math.max(-rect.top, e.clientY - drag.y0));
    layout[drag.id] = { r: Math.round(drag.r0 - dx / drag.k), b: Math.round(drag.b0 - dy / drag.k) };
    apply(layout);
  }, { capture: true });
  const end = (e: PointerEvent) => { if (drag && e.pointerId === drag.pid) drag = null; };
  box.addEventListener("pointerup", end, { capture: true });
  box.addEventListener("pointercancel", end, { capture: true });

  const edit = (on: boolean) => {
    document.body.classList.toggle("editLayout", on);
    bar.classList.toggle("hidden", !on);
  };
  openBtn.onclick = () => edit(true);
  resetBtn.onclick = () => { layout = {}; apply(layout); };
  doneBtn.onclick = () => {
    try { localStorage.setItem(KEY, JSON.stringify(layout)); } catch { /* 저장 못 해도 이번 접속 동안은 유지 */ }
    edit(false);
  };
}
