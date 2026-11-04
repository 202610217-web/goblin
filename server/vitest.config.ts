import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// 순수 함수 단위 테스트 + "내 기기로 방 열기" 어댑터 테스트 (Workers 런타임 없이 Node에서 실행)
export default defineConfig({
  test: { include: ["tests/**/*.test.ts"] },
  resolve: {
    alias: {
      // 서버 방 코드를 브라우저 어댑터로 돌릴 때와 같은 대역을 쓴다
      "cloudflare:workers": fileURLToPath(new URL("../client/src/host/workersShim.ts", import.meta.url)),
      "@goblin/room": fileURLToPath(new URL("./src/room.ts", import.meta.url)),
    },
  },
});
