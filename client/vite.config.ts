import { defineConfig } from "vite";

export default defineConfig({
  // GitHub Pages 배포 시 저장소 이름 경로에서도 동작하도록 상대 경로 사용
  base: "./",
  server: {
    host: true, // 같은 와이파이의 패드/폰에서 접속 가능
    port: 5173,
    fs: { allow: [".."] }, // ../shared 폴더 import 허용
  },
});
