// Worker 환경변수/바인딩 타입 (wrangler.toml과 맞춘다)
interface Env {
  GAME_ROOM: DurableObjectNamespace<import("./room").GameRoom>;
  /** "내 기기로 방 열기"용 연결 중계 */
  SIGNAL_ROOM: DurableObjectNamespace<import("./signal").SignalRoom>;
  ALLOWED_ORIGINS: string;
  ALLOW_LAN_ORIGINS: string;
  SERVE_TEST_PAGE: string;
  /** "true"면 debug_phase 같은 개발용 메시지 허용 */
  DEBUG_COMMANDS: string;
  /** 방 서버를 만들 지역 힌트 (예: "apac" = 아시아·태평양). 비우면 처음 접속한 사람 근처 */
  ROOM_LOCATION_HINT?: string;
}
