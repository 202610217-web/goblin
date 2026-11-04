import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  resolve: {
    alias: {
      // "내 기기로 방 만들기": 서버 방 코드(server/src/room.ts)를 이 기기 브라우저에서 그대로 돌린다
      "@goblin/room": fileURLToPath(new URL("../server/src/room.ts", import.meta.url)),
      "cloudflare:workers": fileURLToPath(new URL("./src/host/workersShim.ts", import.meta.url)),
    },
  },
  // GitHub Pages 배포 시 저장소 이름 경로에서도 동작하도록 상대 경로 사용
  base: "./",
  // 호스트용 게임 서버 Worker도 ES 모듈로 (Safari 15+ 지원)
  worker: { format: "es" },
  server: {
    host: true, // 같은 와이파이의 패드/폰에서 접속 가능
    port: 5173,
    fs: { allow: [".."] }, // ../shared 폴더 import 허용
  },
});
