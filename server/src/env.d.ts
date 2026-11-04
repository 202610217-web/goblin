// Worker 환경변수/바인딩 타입 (wrangler.toml과 맞춘다)
interface Env {
  GAME_ROOM: DurableObjectNamespace<import("./room").GameRoom>;
  ALLOWED_ORIGINS: string;
  ALLOW_LAN_ORIGINS: string;
  SERVE_TEST_PAGE: string;
}
