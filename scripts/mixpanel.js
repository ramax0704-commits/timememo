// Mixpanel 데이터 가져오기
//
// 왜 Export API인가: 무료 플랜은 JQL/Query API가 막혀 있다(402). 원본 내보내기(Export API)만 된다.
// 그래서 원본을 받아 backups/ 에 저장하고, 집계는 여기서 직접 한다.
//
// 쓰는 법:
//   .env.local 에 MIXPANEL_API_SECRET 를 넣는다.
//     (Mixpanel → Settings → Project Settings → Access Keys → API Secret)
//   npm run mp            최근 30일
//   npm run mp -- 7       최근 7일
//
// 주의: API Secret은 프로젝트 전체 이벤트를 읽는 비밀키다. 커밋 금지(.env.local은 gitignore).
// 메모 내용은 애초에 Mixpanel로 안 보내므로(analytics.js 규칙) 여기엔 없다.

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = {};
const envPath = join(root, '.env.local');
if (existsSync(envPath)) for (const line of readFileSync(envPath, 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const secret = env.MIXPANEL_API_SECRET;
if (!secret) { console.error('.env.local 에 MIXPANEL_API_SECRET 이 있어야 합니다.'); process.exit(1); }

const days = Number(process.argv[2]) || 30;
const fmt = (d) => d.toISOString().slice(0, 10);
const to = new Date();
const from = new Date(Date.now() - (days - 1) * 86400000);
const auth = 'Basic ' + Buffer.from(secret + ':').toString('base64');

const r = await fetch(`https://data.mixpanel.com/api/2.0/export?from_date=${fmt(from)}&to_date=${fmt(to)}`, { headers: { Authorization: auth } });
if (!r.ok) { console.error(`Mixpanel 오류 ${r.status}: ${await r.text()}`); process.exit(1); }
const text = await r.text();
mkdirSync(join(root, 'backups'), { recursive: true });
const out = join(root, 'backups', `mixpanel-${fmt(to)}.jsonl`);
writeFileSync(out, text);
const rows = text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
console.log(`원본 저장: ${out} (${rows.length}건, ${fmt(from)} ~ ${fmt(to)})`);

const id = (e) => e.properties.distinct_id || e.properties.$device_id;
const day = (e) => new Date(e.properties.time * 1000 + 9 * 3600e3).toISOString().slice(0, 10); // KST
const pct = (a, b) => (b ? Math.round((a / b) * 100) + '%' : '-');

const byName = {};
for (const e of rows) byName[e.event] = (byName[e.event] || 0) + 1;
console.log('\n== 이벤트별 건수 ==');
for (const [k, v] of Object.entries(byName).sort((a, b) => b[1] - a[1])) console.log(String(v).padStart(6), k);

const daily = {};
for (const e of rows) {
  const d = (daily[day(e)] ??= { all: new Set(), open: new Set(), tour: new Set(), memo: new Set() });
  d.all.add(id(e));
  if (e.event === 'App Opened') d.open.add(id(e));
  if (e.event === 'Tour') d.tour.add(id(e));
  if (e.event === 'Memo Created') d.memo.add(id(e));
}
console.log('\n== 일별 (KST)  활성 / 앱진입 / 투어 / 기록 / 진입→기록 ==');
for (const k of Object.keys(daily).sort()) {
  const x = daily[k];
  console.log(k, String(x.all.size).padStart(5), String(x.open.size).padStart(5), String(x.tour.size).padStart(5), String(x.memo.size).padStart(5), pct(x.memo.size, x.open.size).padStart(6));
}

const users = {};
for (const e of rows) {
  const u = (users[id(e)] ??= { open: 0, tour: 0, memo: 0, days: new Set() });
  u.days.add(day(e));
  if (e.event === 'App Opened') u.open++;
  if (e.event === 'Tour') u.tour++;
  if (e.event === 'Memo Created') u.memo++;
}
const opened = Object.values(users).filter((u) => u.open);
const memo = opened.filter((u) => u.memo);
const bucket = (n, b) => b.find(([lim]) => n >= lim)[1];
const count = (arr, f) => arr.reduce((m, u) => ((m[f(u)] = (m[f(u)] || 0) + 1), m), {});
console.log('\n== 사용자 단위 ==');
console.log(`앱 진입 ${opened.length}명 → 기록 남김 ${memo.length}명 (${pct(memo.length, opened.length)})`);
console.log(`  기록O: 투어 탐 ${memo.filter((u) => u.tour).length} / 투어 없이 ${memo.filter((u) => !u.tour).length}`);
console.log(`  기록X: 투어만 탐 ${opened.filter((u) => u.tour && !u.memo).length} / 아무것도 안 함 ${opened.filter((u) => !u.tour && !u.memo).length}`);
console.log('기록 횟수 분포(기록자):', count(memo, (u) => bucket(u.memo, [[20, '20+'], [5, '5-19'], [2, '2-4'], [1, '1']])));
console.log('방문 일수 분포(진입자):', count(opened, (u) => bucket(u.days.size, [[5, '5일+'], [2, '2-4일'], [1, '1일']])));
console.log('방문 일수 분포(기록자):', count(memo, (u) => bucket(u.days.size, [[5, '5일+'], [2, '2-4일'], [1, '1일']])));
