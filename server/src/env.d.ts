// Worker 환경변수/바인딩 타입 (wrangler.toml과 맞춘다)
interface Env {
  GAME_ROOM: DurableObjectNamespace<import("./room").GameRoom>;
  ALLOWED_ORIGINS: string;
  ALLOW_LAN_ORIGINS: string;
  SERVE_TEST_PAGE: string;
  /** "true"면 debug_phase 같은 개발용 메시지 허용 */
  DEBUG_COMMANDS: string;
}
