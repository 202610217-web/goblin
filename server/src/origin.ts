// Origin 검사 (순수 함수)

export interface OriginPolicy {
  /** 정확히 일치해야 하는 허용 Origin 목록 */
  allowed: string[];
  /** true면 사설 LAN 주소(192.168.x.x, 10.x.x.x, 172.16~31.x.x)의 http Origin도 허용 */
  allowLan: boolean;
}

/** 환경변수 문자열로 정책을 만든다 */
export function makeOriginPolicy(allowedCsv: string | undefined, allowLan: string | undefined): OriginPolicy {
  return {
    allowed: (allowedCsv ?? "")
      .split(",")
      .map((s) => s.trim().replace(/\/+$/, ""))
      .filter((s) => s.length > 0),
    allowLan: allowLan === "true",
  };
}

/** 사설 IPv4 주소인지 확인 */
function isPrivateIPv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b, c, d] = m.slice(1).map(Number) as [number, number, number, number];
  if ([a, b, c, d].some((n) => n > 255)) return false;
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

/** 이 Origin으로 접속을 허용할지 판단 */
export function isOriginAllowed(origin: string | null, policy: OriginPolicy): boolean {
  if (!origin) return false; // 브라우저는 WebSocket 접속 시 항상 Origin을 보낸다
  if (policy.allowed.includes(origin)) return true;
  if (policy.allowLan) {
    try {
      const url = new URL(origin);
      // 개발 서버는 http만 쓰므로 http + 사설 IP만 허용
      if (url.protocol === "http:" && isPrivateIPv4(url.hostname)) return true;
    } catch {
      return false;
    }
  }
  return false;
}
