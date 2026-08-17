import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { execSync } from 'node:child_process'

// 이 빌드가 언제, 어느 커밋으로 만들어졌는지를 앱 안에 박아둔다.
// 폰(특히 홈 화면에 추가한 웹앱)은 한 번 띄운 화면을 계속 붙잡고 있어서,
// "고쳤다는데 왜 그대로냐"가 옛 코드를 보고 있는 건지 진짜 버그인지 구분이 안 됐다.
// 마이페이지 아래에 한 줄로 띄워두면 5초 만에 갈린다.
const buildTime = new Date().toISOString();
let buildCommit = 'local';
try {
  buildCommit = execSync('git rev-parse --short HEAD').toString().trim();
} catch {
  // 깃 정보가 없는 환경(예: 소스만 복사된 빌드)에서는 그냥 넘어간다
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  define: {
    __BUILD_TIME__: JSON.stringify(buildTime),
    __BUILD_COMMIT__: JSON.stringify(buildCommit),
  },
})
