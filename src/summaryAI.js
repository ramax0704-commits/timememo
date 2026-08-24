// 오늘의 회고 AI 부분(블록 2 시간 배분 + 블록 3 눈에 띈 것) — 호출·캐시·검증.
//
// 프롬프트와 실제 Claude 호출은 서버리스(api/summarize.js)에 있다. 브라우저는 키를
// 가질 수 없기 때문이다. 여기서는 "당일 기록의 시각과 본문 + 계산값 + 카테고리 힌트"만
// 보내고, 고정된 모양 { categories, highlights, narrative } 으로만 받는다.
//
// 실패하면 throw 한다. 호출하는 쪽(App)은 블록 2·3만 숨기고 블록 1·4는 그대로 둔다.
import { mockDaySummary } from './summaryMock.js';
import { RABBIT_IDS } from './rabbits.js';

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
export function summaryCacheKey(dateKey, records) {
  const body = records.map(r => `${r.time}|${r.text}`).join('\n');
  return `${dateKey}|${records.length}|${hash(body)}`;
}

// 예전 방식(키 끝에 고정 세트가 붙던 때)으로 저장된 것도 찾는다: 같은 날짜·같은 기록 수 중 가장 최근 것
function findCached(key) {
  const cache = readCache();
  if (cache[key]?.data) return cache[key];
  const prefix = key.split('|').slice(0, 2).join('|') + '|';
  let best = null;
  for (const [k, v] of Object.entries(cache)) {
    if (k.startsWith(prefix) && v?.data && (!best || v.at > best.at)) best = v;
  }
  return best;
}

function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    return obj && typeof obj === 'object' ? obj : {};
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

// 앱을 다시 열었을 때 이미 만들어 둔 회고가 있으면 네트워크 없이 바로 보여준다
export function peekSummaryCache(key) {
  const cached = key ? findCached(key) : null;
  return cached?.data ? { data: cached.data, mock: Boolean(cached.mock) } : null;
}

// 받은 JSON을 고정 스키마로 정리한다. 못 맞추면 null.
export function normalizeSummary(obj, recordCount) {
  if (!obj || typeof obj !== 'object') return null;
  const seen = new Set();
  const categories = (Array.isArray(obj.categories) ? obj.categories : [])
    .map(c => {
      const name = typeof c?.name === 'string' ? c.name.trim().replace(/^#/, '').slice(0, 12) : '';
      const recordIndexes = Array.isArray(c?.recordIndexes)
        ? [...new Set(c.recordIndexes.filter(i => Number.isInteger(i) && i >= 0 && i < recordCount && !seen.has(i)))]
        : [];
      recordIndexes.forEach(i => seen.add(i));
      return { name, recordIndexes };
    })
    .filter(c => c.name && c.recordIndexes.length > 0)
    .slice(0, 6);
  const narrative = typeof obj.narrative === 'string' ? obj.narrative.trim() : '';
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
  const rabbit = obj.rabbit && RABBIT_IDS.includes(obj.rabbit.type) && typeof obj.rabbit.reason === 'string' && obj.rabbit.reason.trim()
    ? { type: obj.rabbit.type, reason: obj.rabbit.reason.trim().slice(0, 160) }
    : null;
  const SEGMENT_NAMES = ['새벽', '오전', '점심', '오후', '저녁', '밤'];
  const segSeen = new Set();
  const segmentStates = (Array.isArray(obj.segmentStates) ? obj.segmentStates : [])
    .filter(s => s && SEGMENT_NAMES.includes(s.segment) && typeof s.state === 'string' && s.state.trim() && !segSeen.has(s.segment) && segSeen.add(s.segment))
    .map(s => ({ segment: s.segment, state: s.state.trim().slice(0, 40) }))
    .slice(0, 6);
  return { categories, headline, narrative, thoughtFlow, loops, energyWords, keywords, rabbit, segmentStates };
}

// records: [{ time, text }] 시간순 / facts: 계산값 / fixedCategories: 고정 세트 / knownCategories: 힌트
export async function requestDaySummary({ dateKey, records, facts, fixedCategories = [], knownCategories = [], signal }) {
  const key = summaryCacheKey(dateKey, records);
  const cached = findCached(key);
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
      body: JSON.stringify({ date: dateKey, records, facts, fixedCategories, knownCategories }),
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
    payload = { ...mockDaySummary(records, { fixedCategories, facts }), mock: true };
  }

  const data = normalizeSummary(payload, records.length);
  if (!data) throw new Error('summary schema mismatch');
  const result = { data, mock: Boolean(payload.mock) };
  // 샘플은 캐시하지 않는다 — 키를 넣는 순간부터 실제 회고가 보여야 한다
  if (!result.mock) writeCache(key, result);
  return result;
}
