// 회고에서 '계산으로만 나오는' 부분.
//
// AI는 여기 없다. 오늘의 모양(리듬 곡선·총 기록 시간·연속 일수), 다음(기록 N일차),
// 이번 주 리포트는 전부 이 파일의 순수 함수로 만든다. 추정이 아니라 기록에서 그대로
// 세어 나오는 값이라 첫날 사용자에게도 빈 값이 뜰 일이 없다.
import { format, addDays, differenceInCalendarDays } from 'date-fns';

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
export const SUMMARY_DAILY_LIMIT = 2;
// 한 기록의 활동 시간 상한. 기록과 다음 기록 사이를 그 활동 시간으로 치되, 잠들거나 앱을 닫은
// 긴 공백이 통째로 한 활동에 붙지 않게 자른다.
export const ACTIVITY_CAP_MIN = 180;

export const dateKeyOf = (d) => format(d, 'yyyy-MM-dd');
const DAY_MIN = 24 * 60;

// ── 하루의 경계 = 새벽 2시 ─────────────────────────────────────
// 자정~01:59에 쓴 기록은 '그 밤'의 끝이지 다음 날의 시작이 아니다. 회고·기록 수·연속 일수·
// 이번 주는 모두 이 경계로 센다. (타임라인·시간표의 날짜 헤더는 달력 날짜 그대로 — 새벽 1시에
// 열면 13일이 보이고, 그 기록이 12일 회고에 들어간다는 건 2시 자리의 구분선으로 알린다.)
export const DAY_START_HOUR = 2;
export const DAY_START_MIN = DAY_START_HOUR * 60;
export const reviewDayOf = (d) => new Date(new Date(d).getTime() - DAY_START_MIN * 60000);
export const reviewKeyOf = (d) => dateKeyOf(reviewDayOf(d));
// 기록 시각 → 회고 하루 안에서의 분 (02:00 = 0, 다음날 01:59 = 1439)
export const minuteInReviewDay = (d) => {
  const t = new Date(d);
  return (t.getHours() * 60 + t.getMinutes() - DAY_START_MIN + DAY_MIN) % DAY_MIN;
};

// ── 누적 기록일 / 연속 일수 ───────────────────────────────────
// 누적 = 기록이 있는 날이 며칠. 하루 빠져도 줄지 않는다.
export function countRecordDays(memos) {
  const days = new Set();
  for (const m of memos) days.add(reviewKeyOf(new Date(m.recordedAt)));
  return days.size;
}

// 연속 = 오늘(오늘 기록이 없으면 어제)부터 거슬러 올라가며 빠짐없이 기록한 날 수.
export function countStreak(memos, now) {
  const days = new Set(memos.map(m => reviewKeyOf(new Date(m.recordedAt))));
  const today = reviewDayOf(now);
  let cursor = days.has(dateKeyOf(today)) ? today : addDays(today, -1);
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

// ── 하루 리듬 곡선 ─────────────────────────────────────────────
// 0시~24시를 30분 간격(49점)으로 훑으며, 각 점에서 기록들이 얼마나 가까이 있는지를
// 더한다(가우시안, σ=75분). 막대 대신 곡선으로 그리는 이유: 기록이 '몰린 시간대'는
// 정확한 칸이 아니라 흐름이고, 하루 전체 위에 놓여야 "내 하루가 어느 쪽에 실려 있나"가 보인다.
export const CURVE_STEP_MIN = 30;
export function buildDayCurve(dayMemos) {
  // 곡선의 가로축은 회고 하루(02:00 → 다음날 02:00)다. 자정 넘어 쓴 기록이 왼쪽 끝이 아니라
  // 오른쪽 끝(하루의 마무리)에 놓인다.
  const times = dayMemos.map(m => minuteInReviewDay(m.recordedAt));
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
  return { points: norm, peakMinute: peak ? peak.t : null, hasData: max > 0, offsetMin: DAY_START_MIN };
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
// from/to는 시각(시). 하루가 새벽 2시에 시작하므로 '밤'(자정~2시)은 맨 뒤다.
export const DAY_SEGMENTS = [
  { key: 'dawn', label: '새벽', from: 2, to: 5 },
  { key: 'morning', label: '오전', from: 5, to: 12 },
  { key: 'noon', label: '점심', from: 12, to: 14 },
  { key: 'afternoon', label: '오후', from: 14, to: 18 },
  { key: 'evening', label: '저녁', from: 18, to: 24 },
  { key: 'night', label: '밤', from: 24, to: 26 },
];
export function buildSegments(sortedMemos, now) {
  // 회고 하루 안의 분으로 비교한다 (02:00 = 0). 밤 칸(24~26시)은 다음날 0~2시.
  const toMin = (h) => h * 60 - DAY_START_MIN;
  const nowMin = now ? minuteInReviewDay(now) : null;
  return DAY_SEGMENTS.map(seg => {
    const items = sortedMemos.filter(m => {
      const t = minuteInReviewDay(m.recordedAt);
      return t >= toMin(seg.from) && t < toMin(seg.to);
    });
    const cats = groupByCategory(items).filter(g => g.name !== UNCATEGORIZED);
    return {
      ...seg,
      items,
      count: items.length,
      topCategory: cats[0]?.name ?? null,
      // 지금이 이 칸 안이면 '진행 중', 지났으면 '끝', 아직이면 '예정'
      state: nowMin == null ? 'done' : nowMin >= toMin(seg.to) ? 'done' : nowMin >= toMin(seg.from) ? 'now' : 'later',
    };
  }).filter(seg => (seg.key !== 'night' && seg.key !== 'dawn') || seg.count > 0); // 새벽·밤은 기록 있을 때만
}

// ── 키워드 추출 (AI 없음) ──────────────────────────────────────
// 시간대별 흐름에서 기록 원문 대신 보여줄 단어들. 형태소 분석 없이
// 낱말을 자르고 흔한 조사를 꼬리에서 떼어낸다. 완벽하진 않아도
// "뭘 했는지"의 단서가 되는 명사 위주가 남는다.
const TRAILING_PARTICLES = [
  '에서부터', '에게서', '한테서', '으로부터', '로부터', '이라서', '라서', '까지', '부터', '처럼', '조차', '마저',
  '에서', '에게', '한테', '으로', '이랑', '하고', '들이', '들을', '들은', '보다', '밖에',
  '을', '를', '이', '가', '은', '는', '에', '의', '와', '과', '도', '만', '로', '랑', '요',
];
const KEYWORD_STOPWORDS = new Set([
  '오늘', '지금', '아까', '이제', '다시', '조금', '좀', '너무', '진짜', '정말', '완전', '그냥', '계속',
  '하고', '해서', '하는', '했다', '했음', '하기', '해야', '하다', '있다', '있음', '없다', '없음',
  '그리고', '그래서', '근데', '그런데', '하지만', '이거', '저거', '그거', '여기', '거기', '우리', '내가', '나는',
  '시작', '끝남', '완료', '중간', '이후', '이전', '동안', '하루', '시간', '기록',
]);
export function extractKeywords(memos, max = 5) {
  const freq = new Map();
  const order = new Map(); // 같은 횟수면 먼저 나온 단어부터
  let seq = 0;
  for (const m of memos) {
    for (let w of (m.content || '').split(/[^0-9A-Za-z가-힣]+/)) {
      if (!w) continue;
      for (const p of TRAILING_PARTICLES) {
        if (w.length > p.length + 1 && w.endsWith(p)) { w = w.slice(0, -p.length); break; }
      }
      if (w.length < 2 || w.length > 12 || KEYWORD_STOPWORDS.has(w)) continue;
      if (!freq.has(w)) order.set(w, seq++);
      freq.set(w, (freq.get(w) || 0) + 1);
    }
  }
  const ranked = [...freq.entries()]
    .sort((a, b) => (b[1] - a[1]) || (order.get(a[0]) - order.get(b[0])))
    .map(e => e[0]);
  // '준비'와 '준비함'처럼 한쪽이 다른 쪽의 머리인 단어는 하나만 남긴다
  const picked = [];
  for (const w of ranked) {
    if (picked.length >= max) break;
    if (picked.some(p => p.startsWith(w) || w.startsWith(p))) continue;
    picked.push(w);
  }
  return picked;
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
// now: 오늘이면 현재 시각, 지난 날이면 그 하루의 끝(다음날 01:59). past=true면 '진행 중' 칸이 없다.
export function buildDayFacts(dayMemos, allMemos, now, { past = false } = {}) {
  const sorted = [...dayMemos].sort((a, b) => new Date(a.recordedAt) - new Date(b.recordedAt));
  const recordDays = countRecordDays(allMemos);
  const durations = assignDurations(sorted, now);
  const categories = groupByCategory(sorted, durations).filter(g => g.name !== UNCATEGORIZED);
  return {
    durations,
    segments: buildSegments(sorted, past ? null : now),
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
  // 창의 끝은 달력 날짜의 오늘. (새벽 1시여도 오늘은 오늘 — 그 날의 회고가 아직 비어 있을 뿐)
  const todayKey = dateKeyOf(now);
  for (let i = WEEKLY_DAYS - 1; i >= 0; i--) {
    const d = addDays(new Date(now.getFullYear(), now.getMonth(), now.getDate()), -i);
    const key = dateKeyOf(d);
    const items = memos
      .filter(m => reviewKeyOf(new Date(m.recordedAt)) === key)
      .sort((a, b) => new Date(a.recordedAt) - new Date(b.recordedAt));
    days.push({ date: d, key: dateKeyOf(d), count: items.length, items, spanMinutes: spanMinutes(items) });
  }
  const weekMemos = days.flatMap(d => d.items);
  const activeDays = days.filter(d => d.count > 0).length;
  const maxDayCount = Math.max(0, ...days.map(d => d.count));
  // 날마다 따로 계산한다 — 어제 마지막 기록이 오늘 첫 기록까지 이어지면 안 된다
  const durations = new Map();
  for (const d of days) {
    // 하루의 끝은 다음날 01:59 (새벽 2시 경계)
    const dayEnd = d.key === todayKey ? now : new Date(d.date.getFullYear(), d.date.getMonth(), d.date.getDate() + 1, DAY_START_HOUR - 1, 59);
    for (const [id, min] of assignDurations(d.items, dayEnd)) durations.set(id, min);
  }
  return {
    durations,
    days,
    total: weekMemos.length,
    activeDays,
    maxDayCount,
    // 첫 기록~마지막 기록 사이(span)를 더하면 기록 없이 흘려보낸 시간까지 다 들어가
    // 일주일에 100시간 넘는 숫자가 나온다. '이번 주 시간 배분'과 같은 활동 시간으로 센다.
    totalActivityMinutes: [...durations.values()].reduce((s, m) => s + m, 0),
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
