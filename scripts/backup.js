// 타임메모 수동 백업
//
// Supabase 무료 플랜은 자동 백업이 없다. 사고가 나면 복구 수단이 아예 없으므로
// 남의 기록을 받기 시작하면 주기적으로 이걸 돌려 둔다.
//
// 쓰는 법:
//   1) Supabase 대시보드 → Project Settings → API Keys 에서 service_role 키를 복사
//   2) .env.local 에 아래 줄을 추가 (이 파일은 .gitignore 에 걸려 있어 깃허브에 안 올라간다)
//        SUPABASE_SERVICE_ROLE_KEY=여기에붙여넣기
//   3) npm run backup
//
// service_role 키는 RLS를 통째로 무시하는 마스터 키다. 채팅창이나 깃허브,
// 프론트엔드 코드에 절대 넣지 말 것. .env.local 안에만 둔다.
//
// 결과: backups/timememo-YYYY-MM-DD-HHmm.json

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// .env.local 을 직접 읽는다 (빌드 도구 없이 도는 스크립트라 dotenv를 안 쓴다)
function readEnv() {
  const env = {};
  const path = join(root, '.env.local');
  if (!existsSync(path)) return env;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return env;
}

const env = readEnv();
const url = env.VITE_SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;

if (!url) {
  console.error('.env.local 에 VITE_SUPABASE_URL 이 없습니다.');
  process.exit(1);
}
if (!key) {
  console.error('.env.local 에 SUPABASE_SERVICE_ROLE_KEY 가 없습니다.');
  console.error('Supabase 대시보드 → Project Settings → API Keys 에서 service_role 키를 복사해');
  console.error('.env.local 에 SUPABASE_SERVICE_ROLE_KEY=... 로 추가한 뒤 다시 실행하세요.');
  process.exit(1);
}

const headers = { apikey: key, Authorization: `Bearer ${key}` };

// 한 번에 다 받으면 큰 테이블에서 잘리므로 1000개씩 끊어 받는다
async function fetchAll(table) {
  const rows = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const res = await fetch(`${url}/rest/v1/${table}?select=*&order=id`, {
      headers: { ...headers, Range: `${from}-${from + pageSize - 1}` },
    });
    if (!res.ok) throw new Error(`${table}: HTTP ${res.status} ${await res.text()}`);
    const batch = await res.json();
    rows.push(...batch);
    if (batch.length < pageSize) return rows;
  }
}

// 계정 목록도 같이 남긴다. 기록만 있고 누구 것인지 모르면 복구가 안 된다.
async function fetchUsers() {
  const res = await fetch(`${url}/auth/v1/admin/users?per_page=1000`, { headers });
  if (!res.ok) throw new Error(`users: HTTP ${res.status}`);
  const data = await res.json();
  return (data.users || []).map(u => ({
    id: u.id,
    email: u.email,
    provider: u.app_metadata?.provider,
    created_at: u.created_at,
    last_sign_in_at: u.last_sign_in_at,
  }));
}

const stamp = new Date().toISOString().slice(0, 16).replace('T', '-').replace(':', '');
const outDir = join(root, 'backups');
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, `timememo-${stamp}.json`);

try {
  const [memos, settings, todos, users] = await Promise.all([
    fetchAll('memos'),
    fetchAll('settings'),
    fetchAll('todos'),
    fetchUsers(),
  ]);

  writeFileSync(outPath, JSON.stringify({ backedUpAt: new Date().toISOString(), users, memos, settings, todos }, null, 2));

  console.log('백업 완료:', outPath);
  console.table({
    계정: users.length,
    메모: memos.length,
    설정: settings.length,
    할일: todos.length,
  });
} catch (e) {
  console.error('백업 실패:', e.message);
  process.exit(1);
}
