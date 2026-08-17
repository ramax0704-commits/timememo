// 어떤 말이 많이 적히는지 세어본다.
//
// 왜 Mixpanel이 아니라 여기인가:
// 메모 내용은 **일부러 Mixpanel로 안 보낸다**(analytics.js 맨 위 규칙 — 길이·참/거짓·개수만
// 보낸다). 그래서 Mixpanel에는 셀 단어 자체가 없다. 내용은 Supabase의 memos.content 에만
// 있으므로 세는 곳도 여기다.
//
// 이 스크립트는 **집계만 출력한다.** 메모 원문은 화면에 찍지 않는다.
// 습관 키워드를 뭘로 잡을지, 어떤 활동을 자동 분류할지 정할 때 쓰라고 만든 것이다.
//
// 쓰는 법:
//   .env.local 에 SUPABASE_SERVICE_ROLE_KEY 를 넣고 (backup.js 설명과 같음)
//   npm run words            상위 40개
//   npm run words -- 100     상위 100개
//   npm run words -- 40 2    2글자 이상(기본값)
//
// 주의: service_role 키는 RLS를 무시하는 마스터 키다. 남의 기록까지 다 읽힌다.
// 외부 사용자가 생긴 뒤에는 **남의 메모 내용을 들여다보는 일**이 되므로,
// 그때는 이걸 돌리지 말거나 본인 user_id 로 좁혀서 돌릴 것.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

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

if (!url || !key) {
  console.error('.env.local 에 VITE_SUPABASE_URL 과 SUPABASE_SERVICE_ROLE_KEY 가 있어야 합니다.');
  process.exit(1);
}

const topN = Number(process.argv[2]) || 40;
const minLen = Number(process.argv[3]) || 2;

// 한국어는 띄어쓰기만으로 자르면 '운동을/운동이/운동은'이 다 딴 단어가 된다.
// 형태소 분석기를 붙이는 건 과하므로, 뒤에 붙는 조사만 떼어내는 선에서 정리한다.
// 완벽하진 않지만 "뭘 자주 쓰나"를 보기엔 충분하다.
const JOSA = /(은|는|이|가|을|를|에|에서|에게|으로|로|와|과|도|만|까지|부터|보다|의|께|한테|이랑|랑|이나|나|든지|처럼|같이|마다|조차|밖에|이며|며)$/;

// 세도 의미 없는 말들. 결과를 보고 계속 채워 넣으면 된다.
const STOP = new Set([
  '그리고', '그래서', '하지만', '근데', '그냥', '조금', '진짜', '너무', '다시', '아직',
  '오늘', '내일', '어제', '지금', '아침', '점심', '저녁', '오전', '오후',
  '해야', '했다', '한다', '하는', '하고', '해서', '되는', '있는', '없는', '같은', '많이',
]);

async function fetchAll(table, select) {
  const rows = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const res = await fetch(
      `${url}/rest/v1/${table}?select=${select}&order=created_at.asc&limit=${pageSize}&offset=${from}`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } }
    );
    if (!res.ok) {
      console.error(`${table} 읽기 실패: ${res.status} ${await res.text()}`);
      process.exit(1);
    }
    const page = await res.json();
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows;
}

const memos = await fetchAll('memos', 'content,recorded_at');

const counts = new Map();       // 단어 → 나온 횟수
const memoCounts = new Map();   // 단어 → 그 말이 들어간 메모 수 (한 메모에서 여러 번 써도 1)

for (const m of memos) {
  const seen = new Set();
  const tokens = String(m.content)
    .toLowerCase()
    // 숫자·금액·기호는 뺀다 (1000원, 3시 같은 건 단어가 아니다)
    .replace(/[0-9]+/g, ' ')
    .split(/[^가-힣a-z]+/);

  for (let t of tokens) {
    if (t.length < minLen) continue;
    // 조사를 떼고도 최소 길이를 지키는 경우에만 떼어낸다 ('가나'의 '가'까지 떼면 안 되므로)
    const stripped = t.replace(JOSA, '');
    if (stripped.length >= minLen) t = stripped;
    if (t.length < minLen || STOP.has(t)) continue;
    counts.set(t, (counts.get(t) || 0) + 1);
    if (!seen.has(t)) { seen.add(t); memoCounts.set(t, (memoCounts.get(t) || 0) + 1); }
  }
}

const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN);

console.log(`\n기록 ${memos.length}개에서 뽑은 단어 ${counts.size}종 — 상위 ${ranked.length}개\n`);
console.log('  순위  단어              총 횟수   들어간 기록 수');
console.log('  ' + '─'.repeat(48));
ranked.forEach(([word, n], i) => {
  const rank = String(i + 1).padStart(4);
  const w = word.padEnd(16, ' ');
  console.log(`  ${rank}  ${w}  ${String(n).padStart(6)}   ${String(memoCounts.get(word)).padStart(10)}`);
});
console.log('');
console.log('  "들어간 기록 수"가 총 횟수와 비슷하면 여러 날에 걸쳐 꾸준히 쓰는 말,');
console.log('  총 횟수만 크면 특정 날에 몰아 쓴 말이다. 습관 키워드 후보는 앞쪽이다.');
console.log('');
