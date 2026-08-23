// 오늘의 회고 AI 부분(블록 2 시간 배분 + 블록 3 눈에 띈 것) — 호출·캐시·검증.
//
// 프롬프트와 실제 Claude 호출은 서버리스(api/summarize.js)에 있다. 브라우저는 키를
// 가질 수 없기 때문이다. 여기서는 "당일 기록의 시각과 본문 + 계산값 + 카테고리 힌트"만
// 보내고, 고정된 모양 { categories, highlights, narrative } 으로만 받는다.
//
// 실패하면 throw 한다. 호출하는 쪽(App)은 블록 2·3만 숨기고 블록 1·4는 그대로 둔다.
import { mockDaySummary } from './summaryMock.js';

const CACHE_KEY = 'timememo-day-summary-cache';
const CACHE_MAX = 12;

function hash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// 같은 입력이면 다시 부르지 않는다. 기록을 고치거나 추가하면, 고정 세트가 바뀌면 키가 바뀐다.
export function summaryCacheKey(dateKey, records, fixedCategories = []) {
  const body = records.map(r => `${r.time}|${r.text}`).join('\n') + '\n#' + fixedCategories.join(',');
  return `${dateKey}|${records.length}|${hash(body)}`;
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
  const cached = key ? readCache()[key] : null;
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
  return { categories, headline, narrative, thoughtFlow, loops, energyWords, keywords };
}

// records: [{ time, text }] 시간순 / facts: 계산값 / fixedCategories: 고정 세트 / knownCategories: 힌트
export async function requestDaySummary({ dateKey, records, facts, fixedCategories = [], knownCategories = [], signal }) {
  const key = summaryCacheKey(dateKey, records, fixedCategories);
  const cached = readCache()[key];
  if (cached?.data) return { data: cached.data, mock: Boolean(cached.mock), fromCache: true };

  let payload;
  try {
    const res = await fetch('/api/summarize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: dateKey, records, facts, fixedCategories, knownCategories }),
      signal,
    });
    if (!res.ok) throw new Error(`summarize ${res.status}`);
    payload = await res.json();
  } catch (e) {
    if (signal?.aborted) throw e;
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
