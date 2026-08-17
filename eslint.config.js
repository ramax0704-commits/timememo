import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: {
        ...globals.browser,
        // vite.config.js의 define이 빌드할 때 박아 넣는 값 (배포 시각·커밋)
        __BUILD_TIME__: 'readonly',
        __BUILD_COMMIT__: 'readonly',
      },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  },
  {
    // api/ 는 Vercel 서버리스 함수, scripts/ 는 로컬에서 도는 Node 스크립트라
    // 브라우저가 아니라 Node 환경이다 (process, console 등)
    files: ['api/**/*.js', 'scripts/**/*.js', 'vite.config.js'],
    languageOptions: { globals: globals.node },
  },
])
