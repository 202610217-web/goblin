// 전투 화면 피드백: 맞힘 표시, 맞은 방향, 데미지 숫자, 처치 알림
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
