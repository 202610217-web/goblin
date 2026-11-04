// Worker 진입점: /ws?room=코드 요청을 해당 방의 Durable Object로 넘긴다.
import { normalizeRoomCode } from "./lobby";
import { isOriginAllowed, makeOriginPolicy } from "./origin";
import testPage from "./dev/test.html";

export { GameRoom } from "./room";
export { SignalRoom } from "./signal";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // 개발용 테스트 페이지 (SERVE_TEST_PAGE=true 일 때만)
    if (url.pathname === "/test" && env.SERVE_TEST_PAGE === "true") {
      return new Response(testPage, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    // /ws = Cloudflare 방 서버, /signal = "내 기기로 방 열기"용 연결 중계
    if (url.pathname !== "/ws" && url.pathname !== "/signal") return new Response("Not found", { status: 404 });

    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket 연결만 가능해요", { status: 426 });
    }

    // Origin 검사: 허용 목록(+ 개발용 LAN)만 통과
    const policy = makeOriginPolicy(env.ALLOWED_ORIGINS, env.ALLOW_LAN_ORIGINS);
    if (!isOriginAllowed(request.headers.get("Origin"), policy)) {
      return new Response("허용되지 않은 Origin", { status: 403 });
    }

    const room = normalizeRoomCode(url.searchParams.get("room"));
    if (!room) return new Response("방 코드는 4~6자리 영문/숫자예요", { status: 400 });

    // 방 서버/연결 중계는 처음 만들어질 때 위치가 정해진다. 위치 힌트(예: apac = 아시아·태평양)가 있으면
    // 누가 먼저 들어오든(예: 미국 LAX로 연결되는 인터넷) 그 지역에 만든다
    const hint = env.ROOM_LOCATION_HINT?.trim();
    const where = hint ? { locationHint: hint as DurableObjectLocationHint } : undefined;

    if (url.pathname === "/signal") {
      // 직접 연결이 막힌 네트워크에서는 게임 메시지도 여기를 거치므로 방 서버와 같은 지역에 둔다
      return env.SIGNAL_ROOM.get(env.SIGNAL_ROOM.idFromName(room), where).fetch(request);
    }

    // 방 코드 이름으로 Durable Object를 찾는다 (같은 코드 = 같은 방)
    const stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(room), where);
    const headers = new Headers(request.headers);
    headers.set("X-Room-Code", room);
    // 접속한 사람이 들어온 Cloudflare 위치(공항 코드, 예: ICN). 핑이 높을 때 원인 확인용
    headers.set("X-Edge-Colo", String((request as { cf?: { colo?: string } }).cf?.colo ?? "?"));
    return stub.fetch(new Request(request.url, { headers }));
  },
} satisfies ExportedHandler<Env>;
