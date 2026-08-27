// 오늘의 회고 AI 부분(블록 2 시간 배분 + 블록 3 눈에 띈 것) — 호출·캐시·검증.
//
// 프롬프트와 실제 Claude 호출은 서버리스(api/summarize.js)에 있다. 브라우저는 키를
// 가질 수 없기 때문이다. 여기서는 "당일 기록의 시각과 본문 + 계산값 + 카테고리 힌트"만
// 보내고, 고정된 모양 { categories, highlights, narrative } 으로만 받는다.
//
// 실패하면 throw 한다. 호출하는 쪽(App)은 블록 2·3만 숨기고 블록 1·4는 그대로 둔다.
import { mockDaySummary } from './summaryMock.js';
import { RABBIT_IDS } from './rabbits.js';
import { EMOTION_LABELS } from './emotions.js';

const CACHE_KEY = 'timememo-day-summary-cache';
const CACHE_MAX = 12;

function hash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// 같은 입력이면 다시 부르지 않는다. 기록을 고치거나 추가하면 키가 바뀐다.
// 고정 카테고리 세트는 키에 넣지 않는다 — 회고를 만든 직후 세트가 정해지면서 키가 바뀌어
// 방금 만든 결과가 사라져 보이는 사고가 있었다 (8/25). 세트가 바뀌어도 만든 회고는 그대로 보여야 한다.
// 스키마 버전 — 프롬프트·출력 구조가 바뀌면 올린다. 옛 버전으로 만든 회고는 캐시에서 안 보이고
// '만들기'를 누르면 새로 만든다 (2026-08-27: 토끼 21종·done·emotions 도입 → v2).
export const SUMMARY_SCHEMA_VERSION = 2;
// 키는 '날짜|개수|v버전-해시'. 날짜가 맨 앞이어야 다른 곳(먼슬리 백필·서버 보관)이 split('|')[0]로 날짜를 읽는다.
export function summaryCacheKey(dateKey, records) {
  const body = records.map(r => `${r.time}|${r.text}`).join('\n');
  return `${dateKey}|${records.length}|v${SUMMARY_SCHEMA_VERSION}-${hash(body)}`;
}
const isCurrentSchemaKey = (k) => (k.split('|')[2] || '').startsWith(`v${SUMMARY_SCHEMA_VERSION}-`);

// 캐시에서 찾는다. loose=false(생성 경로): 정확히 같은 키, 또는 예전 저장 방식(키 끝에
// 고정 세트가 붙던 때) 호환으로 같은 날짜·같은 기록 수까지만 — 기록이 바뀌면 다시 만들어야 한다.
// loose=true(화면 복원 경로): 같은 날짜면 가장 최근 것. 회고를 만든 뒤 기록을 더 쓰면 키가
// 달라지는데, 그때 만들어둔 회고가 화면에서 사라지면 안 된다 (8/24 "회고 날아갔어").
function findCached(key, loose = false) {
  const cache = readCache();
  if (cache[key]?.data) return { ...cache[key], key };
  const prefix = loose ? key.split('|')[0] + '|' : key.split('|').slice(0, 2).join('|') + '|';
  let best = null;
  let bestKey = null;
  for (const [k, v] of Object.entries(cache)) {
    // 생성 경로에서는 옛 스키마로 만든 결과를 '같은 입력'으로 치지 않는다 — 다시 만들어야 새 형식이 나온다
    if (!loose && !isCurrentSchemaKey(k)) continue;
    if (k.startsWith(prefix) && v?.data && (!best || v.at > best.at)) { best = v; bestKey = k; }
  }
  return best ? { ...best, key: bestKey } : null;
}

// 8/27 한때 '날짜#v2|개수|해시' 꼴로 저장된 키를 지금 꼴('날짜|개수|v2-해시')로 고쳐 읽는다.
// 그 형식으로 만든 회고(8/25 등)가 사라져 보이던 문제 — 데이터는 그대로 있었다.
const LEGACY_KEY_RE = /^(\d{4}-\d{2}-\d{2})#v(\d+)\|(\d+)\|(.+)$/;
function migrateCacheKeys(obj) {
  let changed = false;
  for (const k of Object.keys(obj)) {
    const m = k.match(LEGACY_KEY_RE);
    if (!m) continue;
    const nk = `${m[1]}|${m[3]}|v${m[2]}-${m[4]}`;
    if (!obj[nk]) obj[nk] = obj[k];
    delete obj[k];
    changed = true;
  }
  if (changed) { try { localStorage.setItem(CACHE_KEY, JSON.stringify(obj)); } catch { /* 무시 */ } }
  return obj;
}
function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    return obj && typeof obj === 'object' ? migrateCacheKeys(obj) : {};
  } catch {
    return {};
  }
}

function writeCache(key, value) {
  try {
    const cache = readCache();
    cache[key] = { ...value, at: Date.now() };
    const keys = Object.keys(cache).sort((a, b) => cache[a].at - cache[b].at);
    while (keys.length > CACHE_MAX) delete cache[keys.shift()];
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    // 저장이 막힌 환경이면 그냥 매번 부른다
  }
}

// 캐시에 남아 있는 날짜별 토끼를 긁어모은다 (먼슬리 뷰 백필용).
// 캐시 키는 '날짜|개수|해시' 꼴이라 앞부분이 곧 날짜다. 샘플(mock)은 제외.
export function collectCachedRabbits() {
  const out = {};
  for (const [k, v] of Object.entries(readCache())) {
    const day = k.split('|')[0];
    const type = v?.data?.rabbit?.type;
    if (day && type && !v.mock) out[day] = type;
  }
  return out;
}

// 기기 캐시에 남아 있는 회고 전부 (샘플 제외, 날짜당 최근 것 하나).
// 로그인하면 서버(day_reviews)로 올려 영구 보관한다 — 기기 캐시는 12개까지만 남고
// 브라우저 정리로 지워질 수 있어서, 진짜 보관처는 서버여야 한다.
export function collectCachedSummaries() {
  const byDay = new Map();
  for (const [k, v] of Object.entries(readCache())) {
    const day = k.split('|')[0];
    if (!day || !v?.data || v.mock) continue;
    const prev = byDay.get(day);
    if (!prev || (v.at || 0) > prev.at) byDay.set(day, { day, key: k, data: v.data, at: v.at || 0 });
  }
  return [...byDay.values()];
}

// 앱을 다시 열었을 때 이미 만들어 둔 회고가 있으면 네트워크 없이 바로 보여준다.
// key에는 실제로 매칭된 캐시 키가 담긴다 — 지금 키와 다르면 화면이 '이후 기록 추가됨'을 안다.
export function peekSummaryCache(key) {
  const cached = key ? findCached(key, true) : null;
  return cached?.data ? { data: cached.data, mock: Boolean(cached.mock), key: cached.key } : null;
}

// 받은 JSON을 고정 스키마로 정리한다. 못 맞추면 null.
export function normalizeSummary(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const narrative = typeof obj.narrative === 'string' ? obj.narrative.trim().slice(0, 150) : '';
  if (!narrative) return null;
  const strs = (arr, max, len) => (Array.isArray(arr) ? arr : [])
    .filter(x => typeof x === 'string').map(x => x.trim().slice(0, len)).filter(Boolean).slice(0, max);
  const headline = typeof obj.headline === 'string' ? obj.headline.trim().slice(0, 40) : '';
  const thoughtFlow = (Array.isArray(obj.thoughtFlow) ? obj.thoughtFlow : [])
    .filter(s => s && ['시작', '전환', '결론'].includes(s.stage) && typeof s.text === 'string' && s.text.trim())
    .map(s => ({ stage: s.stage, text: s.text.trim().slice(0, 80) }))
    .slice(0, 3);
  const loops = (Array.isArray(obj.loops) ? obj.loops : [])
    .filter(l => l && typeof l.from === 'string' && typeof l.to === 'string' && l.from.trim() && l.to.trim())
    .map(l => ({ from: l.from.trim().slice(0, 40), to: l.to.trim().slice(0, 40) }))
    .slice(0, 4);
  const energyWords = { up: strs(obj.energyWords?.up, 6, 16), down: strs(obj.energyWords?.down, 6, 16) };
  const keywords = strs(obj.keywords, 4, 8);
  const done = strs(obj.done, 5, 30);
  const emotions = (Array.isArray(obj.emotions) ? obj.emotions : [])
    .filter(e => e && Number.isInteger(e.index) && e.index >= 0 && EMOTION_LABELS.includes(e.label)
      && typeof e.quote === 'string' && e.quote.trim())
    .map(e => ({ index: e.index, label: e.label, quote: e.quote.trim().slice(0, 40) }))
    .slice(0, 4);
  const rabbit = obj.rabbit && RABBIT_IDS.includes(obj.rabbit.type) && typeof obj.rabbit.reason === 'string' && obj.rabbit.reason.trim()
    ? { type: obj.rabbit.type, reason: obj.rabbit.reason.trim().slice(0, 160) }
    : null;
  return { headline, narrative, thoughtFlow, loops, energyWords, keywords, done, emotions, rabbit };
}

// records: [{ time, text }] 시간순 / facts: 계산값
// force: 같은 입력이라도 캐시를 건너뛰고 새로 만든다 ('다시 만들기').
export async function requestDaySummary({ dateKey, records, facts, signal, force = false }) {
  const key = summaryCacheKey(dateKey, records);
  const cached = force ? null : findCached(key);
  if (cached?.data) return { data: cached.data, mock: Boolean(cached.mock), fromCache: true };

  let payload;
  // 응답이 영영 안 오는 경우(모바일에서 백그라운드로 갔다 오거나 서버가 멈췄을 때)에 대비해
  // 50초가 지나면 끊고 실패로 돌린다. 화면이 "읽는 중"에 갇히면 안 된다.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 50000);
  if (signal) signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  try {
    const res = await fetch('/api/summarize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: dateKey, records, facts }),
      signal: ctrl.signal,
    });
    if (res.status === 429) {
      // 서비스 전체 하루 상한. 이건 샘플로 대신하지 않는다 — 돈을 안 쓰려고 막은 것이다.
      const err = new Error('daily-cap');
      err.code = 'daily-cap';
      throw err;
    }
    if (!res.ok) throw new Error(`summarize ${res.status}`);
    payload = await res.json();
    clearTimeout(timer);
  } catch (e) {
    if (signal?.aborted || e.code === 'daily-cap') throw e;
    if (e.name === 'AbortError') throw new Error('summarize timeout');
    // 로컬 개발(vite dev)에는 /api가 없다. 화면을 확인할 수 있게 샘플로 대신한다.
    // 배포 환경에서는 그대로 실패시킨다 — 샘플이 실제 회고인 척 보이면 안 된다.
    if (!import.meta.env.DEV) throw e;
    payload = { ...mockDaySummary(records, { facts }), mock: true };
  }

  const data = normalizeSummary(payload);
  if (!data) throw new Error('summary schema mismatch');
  const result = { data, mock: Boolean(payload.mock) };
  // 샘플은 캐시하지 않는다 — 키를 넣는 순간부터 실제 회고가 보여야 한다
  if (!result.mock) writeCache(key, result);
  return result;
}
