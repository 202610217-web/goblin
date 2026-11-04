// 화면 쪽 타입 검사용 GameRoom 선언 (실제 코드는 Vite가 server/src/room.ts 를 넣는다)
export declare class GameRoom {
  constructor(ctx: unknown, env: unknown);
  acceptPeer(server: unknown, code: string, edge: string, roomLabel?: string): Promise<void>;
  webSocketMessage(ws: unknown, raw: string): Promise<void>;
  webSocketClose(ws: unknown, code: number, reason: string, wasClean: boolean): Promise<void>;
  alarm(): Promise<void>;
}
