// 브라우저(호스트 기기)에서 서버 방 코드(server/src/room.ts)를 돌리기 위한 "cloudflare:workers" 대역
// Vite가 "cloudflare:workers" 를 이 파일로 바꿔 넣는다.

/** Durable Object 기본 클래스 대역: ctx, env 만 들고 있다 */
export class DurableObject<E = unknown> {
  protected ctx: any;
  protected env: E;
  constructor(ctx: unknown, env: E) {
    this.ctx = ctx;
    this.env = env;
  }
}

/** ping 자동 응답 설정에 쓰는 클래스 대역 */
class WebSocketRequestResponsePair {
  constructor(public request: string, public response: string) {}
}
(globalThis as any).WebSocketRequestResponsePair ??= WebSocketRequestResponsePair;
