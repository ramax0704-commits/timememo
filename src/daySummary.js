// 회고에서 '계산으로만 나오는' 부분.
//
// AI는 여기 없다. 오늘의 모양(리듬 곡선·총 기록 시간·연속 일수), 다음(기록 N일차),
// 이번 주 리포트는 전부 이 파일의 순수 함수로 만든다. 추정이 아니라 기록에서 그대로
// 세어 나오는 값이라 첫날 사용자에게도 빈 값이 뜰 일이 없다.
import { format, isSameDay, addDays, differenceInCalendarDays } from 'date-fns';

// AI 회고(시간 배분·회고 글)는 당일 기록이 이 개수부터 만들 수 있다. 그 전엔 계산 블록만.
export const SUMMARY_MIN_RECORDS = 5;
// 이 날수만큼 기록하면 주간 리포트가 열린다
export const WEEKLY_DAYS = 7;
// 누적 기록일이 이 값에 닿으면 카테고리 세트를 고정한다 (그 전엔 매일 새로 만든다)
export const FIXED_CATEGORY_FROM_DAY = 4;
export const FIXED_CATEGORY_COUNT = 5;
// 분류 안 된 기록을 묶는 이름. 숨기지 않고 같이 보여준다.
export const UNCATEGORIZED = '미분류';
// 하루에 AI 회고를 만들 수 있는 횟수 (첫 생성 + 다시 만들기 포함). 호출마다 비용이 나간다.
export const SUMMARY_DAILY_LIMIT = 3;
// 한 기록의 활동 시간 상한. 기록과 다음 기록 사이를 그 활동 시간으로 치되, 잠들거나 앱을 닫은
// 긴 공백이 통째로 한 활동에 붙지 않게 자른다.
export const ACTIVITY_CAP_MIN = 180;

export const dateKeyOf = (d) => format(d, 'yyyy-MM-dd');
const DAY_MIN = 24 * 60;

// ── 누적 기록일 / 연속 일수 ───────────────────────────────────
// 누적 = 기록이 있는 날이 며칠. 하루 빠져도 줄지 않는다.
export function countRecordDays(memos) {
  const days = new Set();
  for (const m of memos) days.add(dateKeyOf(new Date(m.recordedAt)));
  return days.size;
}

// 연속 = 오늘(오늘 기록이 없으면 어제)부터 거슬러 올라가며 빠짐없이 기록한 날 수.
export function countStreak(memos, now) {
  const days = new Set(memos.map(m => dateKeyOf(new Date(m.recordedAt))));
  let cursor = days.has(dateKeyOf(now)) ? now : addDays(now, -1);
  let streak = 0;
  while (days.has(dateKeyOf(cursor))) {
    streak += 1;
    cursor = addDays(cursor, -1);
  }
  return streak;
}

// ── 기록 시간 ────────────────────────────────────────────────
// 기록마다 '구간'이 있으면(시작·끝을 정했거나 다음 기록까지 이어지게 했으면) 그 길이를,
// 없으면 0으로 친다. 하루 전체로는 첫 기록부터 마지막 기록까지의 길이를 쓴다 —
// 구간을 따로 정하지 않는 사람이 대부분이라 그게 "오늘 기록이 이어진 시간"에 가깝다.
export function spanMinutes(sortedMemos) {
  if (sortedMemos.length < 2) return 0;
  const a = new Date(sortedMemos[0].recordedAt);
  const b = new Date(sortedMemos[sortedMemos.length - 1].recordedAt);
  return Math.max(0, Math.round((b - a) / 60000));
}

export function formatMinutes(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m}분`;
  if (m === 0) return `${h}시간`;
  return `${h}시간 ${m}분`;
}

// "2시간 전", "방금" 같은 경과 표기
export function formatAgo(from, now) {
  const min = Math.max(0, Math.round((now - from) / 60000));
  if (min < 1) return '방금';
  if (min < 60) return `${min}분 전`;
  const h = Math.floor(min / 60);
  const r = min % 60;
  if (r < 10 || h >= 3) return `${h}시간 전`;
  return `${h}시간 ${r}분 전`;
}

// ── 하루 리듬 곡선 ─────────────────────────────────────────────
// 0시~24시를 30분 간격(49점)으로 훑으며, 각 점에서 기록들이 얼마나 가까이 있는지를
// 더한다(가우시안, σ=75분). 막대 대신 곡선으로 그리는 이유: 기록이 '몰린 시간대'는
// 정확한 칸이 아니라 흐름이고, 하루 전체 위에 놓여야 "내 하루가 어느 쪽에 실려 있나"가 보인다.
export const CURVE_STEP_MIN = 30;
export function buildDayCurve(dayMemos) {
  const times = dayMemos.map(m => {
    const d = new Date(m.recordedAt);
    return d.getHours() * 60 + d.getMinutes();
  });
  const sigma = 75;
  const points = [];
  let max = 0;
  for (let t = 0; t <= DAY_MIN; t += CURVE_STEP_MIN) {
    let v = 0;
    for (const ti of times) {
      const dt = (t - ti) / sigma;
      v += Math.exp(-0.5 * dt * dt);
    }
    if (v > max) max = v;
    points.push({ t, v });
  }
  const norm = max > 0 ? points.map(p => ({ t: p.t, y: p.v / max })) : points.map(p => ({ t: p.t, y: 0 }));
  const peak = max > 0 ? norm.reduce((a, b) => (b.y > a.y ? b : a)) : null;
  return { points: norm, peakMinute: peak ? peak.t : null, hasData: max > 0 };
}

// 기록 시각을 시간대 버킷으로 (이번 주 '몰린 시간대' 계산용)
export function peakHourOf(memos) {
  if (memos.length === 0) return null;
  const counts = new Map();
  for (const m of memos) {
    const h = new Date(m.recordedAt).getHours();
    counts.set(h, (counts.get(h) || 0) + 1);
  }
  let best = null;
  for (const [h, c] of counts) if (!best || c > best.count) best = { hour: h, count: c };
  return best;
}

// ── 기록마다 활동 시간 ──────────────────────────────────────────
// 시작·끝을 직접 정한 기록은 그 길이. 아니면 '이 기록부터 다음 기록까지'를 이 활동의
// 시간으로 친다 (타임블럭 뷰의 '다음 기록까지 잇기'와 같은 생각). 마지막 기록은 지금까지.
// 어느 쪽이든 3시간을 넘기면 3시간에서 자른다. 반환: Map<memo.id, minutes>
export function assignDurations(sortedMemos, now) {
  const out = new Map();
  for (let i = 0; i < sortedMemos.length; i++) {
    const m = sortedMemos[i];
    const explicit = (m.backMinutes || 0) + (m.endMinutes || 0);
    if (explicit > 0) { out.set(m.id, Math.min(explicit, ACTIVITY_CAP_MIN)); continue; }
    const start = new Date(m.recordedAt).getTime();
    const next = sortedMemos[i + 1];
    const end = next ? new Date(next.recordedAt).getTime() : now.getTime();
    out.set(m.id, Math.max(0, Math.min(Math.round((end - start) / 60000), ACTIVITY_CAP_MIN)));
  }
  return out;
}

// ── 시간대별 흐름 (오전·점심·오후·저녁) ─────────────────────────
// AI 없이 기록 시각만으로 나눈다. 각 칸에 기록 수와 대표 기록(첫 기록)을 둔다.
export const DAY_SEGMENTS = [
  { key: 'night', label: '밤', from: 0, to: 5 },
  { key: 'morning', label: '오전', from: 5, to: 12 },
  { key: 'noon', label: '점심', from: 12, to: 14 },
  { key: 'afternoon', label: '오후', from: 14, to: 18 },
  { key: 'evening', label: '저녁', from: 18, to: 24 },
];
export function buildSegments(sortedMemos, now) {
  const nowHour = now ? now.getHours() : null;
  return DAY_SEGMENTS.map(seg => {
    const items = sortedMemos.filter(m => {
      const h = new Date(m.recordedAt).getHours();
      return h >= seg.from && h < seg.to;
    });
    const cats = groupByCategory(items).filter(g => g.name !== UNCATEGORIZED);
    return {
      ...seg,
      items,
      count: items.length,
      topCategory: cats[0]?.name ?? null,
      // 지금이 이 칸 안이면 '진행 중', 지났으면 '끝', 아직이면 '예정'
      state: nowHour == null ? 'done' : nowHour >= seg.to ? 'done' : nowHour >= seg.from ? 'now' : 'later',
    };
  }).filter(seg => seg.key !== 'night' || seg.count > 0); // 밤(0~5시)은 기록 있을 때만
}

// ── 카테고리 집계 ──────────────────────────────────────────────
// memo.category(없으면 미분류) 기준. 많은 순, 미분류는 항상 맨 뒤.
// durations(Map)을 주면 기록 수 대신 활동 시간(분)으로 정렬하고 minutes를 함께 돌려준다.
export function groupByCategory(memos, durations = null) {
  const map = new Map();
  for (const m of memos) {
    const name = m.category || UNCATEGORIZED;
    if (!map.has(name)) map.set(name, []);
    map.get(name).push(m);
  }
  const groups = [...map.entries()].map(([name, items]) => ({
    name,
    items,
    count: items.length,
    minutes: durations ? items.reduce((s, m) => s + (durations.get(m.id) || 0), 0) : 0,
  }));
  groups.sort((a, b) => {
    if (a.name === UNCATEGORIZED) return 1;
    if (b.name === UNCATEGORIZED) return -1;
    return durations ? b.minutes - a.minutes : b.count - a.count;
  });
  return groups;
}

// 4일차부터 쓰는 고정 세트 후보: 지금까지 분류된 기록에서 많이 쓰인 순 상위 5개
export function topCategories(memos, n = FIXED_CATEGORY_COUNT) {
  return groupByCategory(memos.filter(m => m.category))
    .filter(g => g.name !== UNCATEGORIZED)
    .slice(0, n)
    .map(g => g.name);
}

// AI에 힌트로 넘길 '이 사람의 카테고리와 예시'. 사용자가 고친 결과가 다음 분류에 반영되는 통로다.
export function categoryHints(memos, perCategory = 3) {
  return groupByCategory(memos.filter(m => m.category))
    .filter(g => g.name !== UNCATEGORIZED)
    .slice(0, 8)
    .map(g => ({
      name: g.name,
      examples: [...g.items]
        .sort((a, b) => new Date(b.recordedAt) - new Date(a.recordedAt))
        .slice(0, perCategory)
        .map(m => m.content.slice(0, 40)),
    }));
}

// ── 오늘의 모양 + 다음 ────────────────────────────────────────
export function buildDayFacts(dayMemos, allMemos, now) {
  const sorted = [...dayMemos].sort((a, b) => new Date(a.recordedAt) - new Date(b.recordedAt));
  const recordDays = countRecordDays(allMemos);
  const durations = assignDurations(sorted, now);
  const categories = groupByCategory(sorted, durations).filter(g => g.name !== UNCATEGORIZED);
  return {
    durations,
    segments: buildSegments(sorted, now),
    count: sorted.length,
    firstAt: new Date(sorted[0].recordedAt),
    lastAt: new Date(sorted[sorted.length - 1].recordedAt),
    spanMinutes: spanMinutes(sorted),
    curve: buildDayCurve(sorted),
    peak: peakHourOf(sorted),
    activityCount: categories.length,
    streak: countStreak(allMemos, now),
    recordDays,
    // 주간 리포트까지 남은 기록일. 0이면 열린 것.
    daysToWeekly: Math.max(0, WEEKLY_DAYS - recordDays),
  };
}

// ── 이번 주 리포트 (계산만) ────────────────────────────────────
// 오늘을 포함한 최근 7일. 달력 주(월~일)로 하면 월요일마다 텅 비어 보인다.
export function buildWeekFacts(memos, now) {
  const days = [];
  for (let i = WEEKLY_DAYS - 1; i >= 0; i--) {
    const d = addDays(now, -i);
    const items = memos
      .filter(m => isSameDay(new Date(m.recordedAt), d))
      .sort((a, b) => new Date(a.recordedAt) - new Date(b.recordedAt));
    days.push({ date: d, key: dateKeyOf(d), count: items.length, items, spanMinutes: spanMinutes(items) });
  }
  const weekMemos = days.flatMap(d => d.items);
  const activeDays = days.filter(d => d.count > 0).length;
  const maxDayCount = Math.max(0, ...days.map(d => d.count));
  // 날마다 따로 계산한다 — 어제 마지막 기록이 오늘 첫 기록까지 이어지면 안 된다
  const durations = new Map();
  for (const d of days) {
    const dayEnd = isSameDay(d.date, now) ? now : new Date(d.date.getFullYear(), d.date.getMonth(), d.date.getDate(), 23, 59);
    for (const [id, min] of assignDurations(d.items, dayEnd)) durations.set(id, min);
  }
  return {
    durations,
    days,
    total: weekMemos.length,
    activeDays,
    maxDayCount,
    totalSpanMinutes: days.reduce((s, d) => s + d.spanMinutes, 0),
    peak: peakHourOf(weekMemos),
    curve: buildDayCurve(weekMemos),
    categories: groupByCategory(weekMemos, durations),
    streak: countStreak(memos, now),
  };
}

// 며칠 전 기록인지 (AI에 넘길 때 '오늘' 기준)
export const daysAgo = (d, now) => differenceInCalendarDays(now, d);

// AI에 넘기는 입력. 시각과 본문만 — 색상·id 같은 건 요약에 쓸모가 없고 보낼 이유도 없다.
export function toSummaryRecords(dayMemos) {
  return [...dayMemos]
    .sort((a, b) => new Date(a.recordedAt) - new Date(b.recordedAt))
    .map(m => ({ time: format(new Date(m.recordedAt), 'HH:mm'), text: m.content }));
}
