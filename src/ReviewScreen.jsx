// '회고' 탭 — 오늘 기록으로 내가 어떤 하루를 보냈는지, 그리고 이번 주.
//
// [오늘]
//   1. 오늘의 모양 — 계산. 총 기록 시간, 연속 일수, 하루 리듬 곡선(기록이 몰린 시간대).
//   2. 오늘의 시간 배분 — AI 분류 + 사용자 수정. 기록마다 category로 저장되므로
//                       AI를 다시 부르지 않아도 기록의 category만으로 그린다.
//   3. 오늘의 회고 — AI. 한 줄 제목, 회고 글, 사고의 흐름, 시도→결과, 에너지 단어, 의미 단어.
//   4. 다음 — 계산. "기록 N일차", 주간 리포트까지 남은 기록일.
//   2·3은 사용자가 '오늘 회고 만들기'를 눌러야 만들어진다 (자동 생성 없음, 기록 5개부터).
//   로그인해야 만들 수 있고, 실패하면 2·3만 빠지고 1·4는 그대로다.
// [이번 주]
//   최근 7일. 전부 계산값 — 총 기록 시간, 기록한 날, 리듬 곡선, 날짜별 기록 수, 카테고리 분포.
import { useEffect, useRef, useState } from 'react';
import { format } from 'date-fns';
import { ko } from 'date-fns/locale';
import { Lock, Inbox, RefreshCw, Check } from 'lucide-react';
import {
  SUMMARY_MIN_RECORDS, SUMMARY_DAILY_LIMIT, WEEKLY_DAYS,
} from './daySummary';
import { rabbitById } from './rabbits';

const hourLabel = (h) => `${String(h).padStart(2, '0')}시`;

// ── 하루 리듬 곡선 ─────────────────────────────────────────────
// 0시~24시 위에 기록이 몰린 정도를 부드러운 선으로. 막대가 아니라 곡선인 이유는
// '몰린 시간대'가 칸이 아니라 흐름이기 때문이다. 현재 시각에 점을 찍는다 (오늘일 때).
// SVG를 가로로 늘려 그리므로(viewBox + none) 선 굵기는 non-scaling으로 고정한다.
const CURVE_W = 100;
const CURVE_H = 40;
function curvePath(points) {
  const xs = points.map(p => (p.t / 1440) * CURVE_W);
  const ys = points.map(p => CURVE_H - 3 - p.y * (CURVE_H - 8));
  if (points.length < 2) return { line: '', area: '' };
  // Catmull-Rom → 3차 베지어
  let d = `M ${xs[0]} ${ys[0]}`;
  for (let i = 0; i < points.length - 1; i++) {
    const x0 = xs[i - 1] ?? xs[i], y0 = ys[i - 1] ?? ys[i];
    const x1 = xs[i], y1 = ys[i];
    const x2 = xs[i + 1], y2 = ys[i + 1];
    const x3 = xs[i + 2] ?? x2, y3 = ys[i + 2] ?? y2;
    const c1x = x1 + (x2 - x0) / 6, c1y = y1 + (y2 - y0) / 6;
    const c2x = x2 - (x3 - x1) / 6, c2y = y2 - (y3 - y1) / 6;
    d += ` C ${c1x.toFixed(2)} ${c1y.toFixed(2)}, ${c2x.toFixed(2)} ${c2y.toFixed(2)}, ${x2.toFixed(2)} ${y2.toFixed(2)}`;
  }
  const area = `${d} L ${CURVE_W} ${CURVE_H} L 0 ${CURVE_H} Z`;
  return { line: d, area };
}

const ampmLabel = (h) => {
  const hh = ((h % 24) + 24) % 24;
  return hh < 12 ? `오전 ${hh === 0 ? 12 : hh}시` : `오후 ${hh === 12 ? 12 : hh - 12}시`;
};

export function DayCurve({ curve, now, peakLabel }) {
  if (!curve?.hasData) return null;
  const { line, area } = curvePath(curve.points);
  // 가로축은 회고 하루(새벽 2시 → 다음날 새벽 2시). 곡선 좌표도 그 기준이다.
  const offset = curve.offsetMin ?? 0;
  const nowMin = now ? (now.getHours() * 60 + now.getMinutes() - offset + 1440) % 1440 : null;
  // 현재 시각의 곡선 높이 (가장 가까운 점)
  let nowPt = null;
  if (nowMin != null) {
    const p = curve.points.reduce((a, b) => (Math.abs(b.t - nowMin) < Math.abs(a.t - nowMin) ? b : a));
    nowPt = { x: (nowMin / 1440) * CURVE_W, y: CURVE_H - 3 - p.y * (CURVE_H - 8) };
  }
  const peakX = curve.peakMinute != null ? (curve.peakMinute / 1440) * 100 : null;
  return (
    <div className="day-curve" role="img" aria-label={peakLabel ? `하루 리듬. ${peakLabel}` : '하루 리듬'}>
      <div className="day-curve-plot">
        <svg viewBox={`0 0 ${CURVE_W} ${CURVE_H}`} preserveAspectRatio="none" className="day-curve-svg">
          <defs>
            <linearGradient id="dayCurveFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#4a72ff" stopOpacity="0.28" />
              <stop offset="100%" stopColor="#4a72ff" stopOpacity="0.02" />
            </linearGradient>
          </defs>
          {[25, 50, 75].map(p => (
            <line key={p} x1={p} y1="0" x2={p} y2={CURVE_H} className="day-curve-grid" vectorEffect="non-scaling-stroke" />
          ))}
          <path d={area} fill="url(#dayCurveFill)" />
          <path d={line} className="day-curve-line" vectorEffect="non-scaling-stroke" />
          {nowPt && (
            <>
              <line x1={nowPt.x} y1={nowPt.y} x2={nowPt.x} y2={CURVE_H} className="day-curve-now-line" vectorEffect="non-scaling-stroke" />
            </>
          )}
        </svg>
        {nowPt && (
          <span className="day-curve-now-dot" style={{ left: `${nowPt.x}%`, top: `${(nowPt.y / CURVE_H) * 100}%` }} />
        )}
        {peakX != null && peakLabel && (
          <span className={`day-curve-peak${peakX > 70 ? ' day-curve-peak--left' : peakX < 14 ? ' day-curve-peak--start' : ''}`} style={{ left: `${peakX}%` }}>{peakLabel}</span>
        )}
      </div>
      <div className="day-curve-axis">
        {[0, 6, 12, 18].map(h => <span key={h}>{ampmLabel(h + offset / 60)}</span>)}
      </div>
    </div>
  );
}

// ── 오늘의 토끼 (AI 회고의 대표 결과) ─────────────────────────
// 숫자 대신, 오늘 기록에서 읽힌 상태·감정을 토끼 아키타입으로 비춰준다.
// 회고 글과 한 덩어리로 보여야 해서 ReflectionBlock 머리에 들어간다.
function RabbitHero({ rabbit }) {
  const info = rabbitById(rabbit?.type);
  if (!info) return null;
  return (
    <div className="rabbit-hero">
      {info.image && <img className="rabbit-photo" src={info.image} alt={info.name} />}
      <span className="rabbit-label">오늘의 토끼</span>
      <h2 className="rabbit-name">{info.name}</h2>
      <p className="rabbit-desc">{info.desc}</p>
      {rabbit.reason && <p className="rabbit-reason">{rabbit.reason}</p>}
      <p className="rabbit-trivia">{info.trivia}</p>
    </div>
  );
}

// ── 오늘의 회고 (AI) — 토끼 + 회고 글이 한 덩어리 ─────────────
function ReflectionBlock({ data, mock, stale, busy, usesLeft, onGenerate }) {
  const hasFlow = data.thoughtFlow?.length > 0;
  const hasLoops = data.loops?.length > 0;
  const up = data.energyWords?.up ?? [];
  const down = data.energyWords?.down ?? [];
  const hasEnergy = up.length > 0 || down.length > 0;
  const hasKeywords = data.keywords?.length > 0;

  return (
    <section className="day-summary reflection" aria-label="오늘의 회고">
      {/* 제목 없이 결과부터 — 이미지 → 어떤 토끼인지 → 회고 글 순서 */}
      {mock && <span className="day-summary-mock" title="AI 키가 아직 없어 샘플로 보여줍니다">샘플</span>}
      {data.rabbit && <RabbitHero rabbit={data.rabbit} />}
      {data.headline && <h2 className="reflection-headline">{data.headline}</h2>}
      <p className="day-summary-narrative reflection-narrative">{data.narrative}</p>

      {hasFlow && (
        <div className="reflection-section">
          <div className="reflection-label">사고의 흐름</div>
          <ol className="flow-list">
            {data.thoughtFlow.map((s, i) => (
              <li key={i} className="flow-item">
                <span className="flow-stage">{s.stage}</span>
                <span className="flow-text">{s.text}</span>
              </li>
            ))}
          </ol>
        </div>
      )}

      {hasLoops && (
        <div className="reflection-section">
          <div className="reflection-label">시도 → 결과</div>
          <ul className="loop-list">
            {data.loops.map((l, i) => (
              <li key={i} className="loop-item">
                <span className="loop-from">{l.from}</span>
                <span className="loop-arrow">→</span>
                <span className="loop-to">{l.to}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {hasEnergy && (
        <div className="reflection-section">
          <div className="reflection-label">에너지 단어</div>
          <div className="energy-rows">
            {up.length > 0 && (
              <div className="energy-row">
                <span className="energy-tag energy-tag--up">활력</span>
                <div className="day-summary-keywords">{up.map((w, i) => <span key={i} className="day-summary-chip day-summary-chip--up">{w}</span>)}</div>
              </div>
            )}
            {down.length > 0 && (
              <div className="energy-row">
                <span className="energy-tag energy-tag--down">소모</span>
                <div className="day-summary-keywords">{down.map((w, i) => <span key={i} className="day-summary-chip day-summary-chip--down">{w}</span>)}</div>
              </div>
            )}
          </div>
        </div>
      )}

      {hasKeywords && (
        <div className="reflection-section">
          <div className="reflection-label">오늘을 점화한 단어</div>
          <div className="day-summary-keywords">
            {data.keywords.map((k, i) => <span key={i} className="day-summary-chip day-summary-chip--meaning">{k}</span>)}
          </div>
        </div>
      )}

      {stale && (
        <div className="day-summary-stale">
          <span>{usesLeft > 0 ? `이후에 기록이 더 추가됐어요. (오늘 ${usesLeft}회 남음)` : '이후에 기록이 더 추가됐어요. 오늘 횟수를 다 썼어요.'}</span>
          <button type="button" className="day-summary-btn day-summary-btn--ghost" onClick={onGenerate} disabled={busy || usesLeft <= 0}>
            <RefreshCw size={12} /> 다시 만들기
          </button>
        </div>
      )}
    </section>
  );
}

// ── AI 만들기 전/중/실패 상태 ─────────────────────────────────
// 기다리는 동안 얼마나 걸리는지 알려준다. 기록이 많으면 20~30초도 걸리는데,
// 아무 말 없이 돌기만 하면 멈춘 줄 안다. 50초가 지나면 앱이 스스로 끊고 '다시 시도'를 보여준다.
function LoadingHint({ startedAt }) {
  const [sec, setSec] = useState(0);
  useEffect(() => {
    if (!startedAt) return;
    const id = setInterval(() => setSec(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(id);
  }, [startedAt]);
  return (
    <p className="day-summary-muted" style={{ fontSize: '0.75rem', marginTop: '4px' }}>
      {sec < 15 ? '보통 10초 안팎 걸려요' : '기록이 많은 날은 조금 더 걸려요'}{sec > 0 ? ` · ${sec}초` : ''}
    </p>
  );
}

function AIGate({ ai, locked, recordCount, busy, usesLeft, onGenerate, onLoginClick }) {
  if (locked) {
    return (
      <section className="day-summary day-summary--ai-gate">
        <div className="day-summary-ai-title"><Lock size={13} /> 오늘의 회고</div>
        <p className="day-summary-muted">
          오늘 남긴 말들에서 사고의 흐름과 에너지를 읽어, 어떤 하루였는지 비춰드려요.
        </p>
        <button type="button" className="day-summary-btn" onClick={onLoginClick}>구글로 로그인하고 회고 보기</button>
      </section>
    );
  }
  if (ai?.status === 'loading') {
    return (
      <section className="day-summary day-summary--ai-gate" aria-live="polite">
        <div className="day-summary-ai-title">오늘의 회고</div>
        <p className="day-summary-muted day-summary-loading-text">오늘 남긴 말들을 읽는 중…</p>
        <LoadingHint startedAt={ai.startedAt} />
      </section>
    );
  }
  const short = recordCount < SUMMARY_MIN_RECORDS;
  const exhausted = usesLeft <= 0;
  return (
    <section className="day-summary day-summary--ai-gate">
      <div className="day-summary-ai-title">오늘의 회고</div>
      {ai?.status === 'capped' ? (
        <p className="day-summary-muted">오늘은 회고를 만들 수 있는 전체 사용량이 다 찼어요. 내일 다시 열려요.</p>
      ) : ai?.status === 'failed' ? (
        <p className="day-summary-muted">지금은 만들 수 없어요. 잠시 후 다시 시도해 주세요.</p>
      ) : exhausted ? (
        <p className="day-summary-muted">오늘 만들 수 있는 횟수({SUMMARY_DAILY_LIMIT}회)를 다 썼어요. 내일 다시 만들 수 있어요.</p>
      ) : short ? (
        <p className="day-summary-muted">
          기록 {SUMMARY_MIN_RECORDS}개부터 만들 수 있어요. 지금 {recordCount}개 — {SUMMARY_MIN_RECORDS - recordCount}개만 더 남기면 돼요.
        </p>
      ) : (
        <p className="day-summary-muted">오늘 남긴 말 {recordCount}개에서 사고의 흐름과 에너지를 읽어, 어떤 하루였는지 비춰드려요.</p>
      )}
      <button type="button" className="day-summary-btn" onClick={onGenerate} disabled={short || busy || exhausted || ai?.status === 'capped'}>
        {ai?.status === 'failed' ? '다시 시도' : '오늘 회고 만들기'}
      </button>
      {!short && !exhausted && ai?.status !== 'failed' && (
        <span className="day-summary-uses">하루 {SUMMARY_DAILY_LIMIT}회 · 오늘 {usesLeft}회 남음</span>
      )}
    </section>
  );
}

// ── 오늘의 모양 (블록 1) ──────────────────────────────────────
// 몰린 시간은 곡선의 꼭대기(가우시안 합의 최대점)로 잡는다. 기록이 한 칸에 몰린 게 아니라
// 여러 시각에 흩어져 있을 때도 '무게중심'이 보이기 때문이다.
const peakHourFromCurve = (curve) => (curve?.peakMinute != null ? Math.floor(((curve.peakMinute + (curve.offsetMin ?? 0)) % 1440) / 60) : null);

// 기록 수·총 시간·연속 일수 같은 숫자는 하루를 이해하는 데 도움이 안 돼 뺐다.
// 리듬 곡선만 남긴다 — 하루가 어느 쪽에 실려 있었는지는 숫자가 아니라 모양으로 보인다.
function ShapeBlock({ facts, now, dayLabel }) {
  const peakHour = peakHourFromCurve(facts.curve);
  const peakLabel = peakHour != null ? `${hourLabel(peakHour)}쯤 가장 많이` : null;
  return (
    <section className="day-summary shape" aria-label="하루 리듬">
      <header className="day-summary-head">
        <span className="day-summary-title">{dayLabel || '하루 리듬'}</span>
      </header>
      <DayCurve curve={facts.curve} now={now} peakLabel={peakLabel} />
    </section>
  );
}

// ── 이번 주 습관 트래킹 ───────────────────────────────────────
// 등록한 습관 키워드가 들어간 기록이 그날 있으면 체크. 기록하는 행동만으로
// 습관이 주 단위로 쌓여 보인다. (키워드 등록은 마이페이지 > 먼슬리 습관 키워드)
function HabitWeek({ week, habitKeywords }) {
  const active = (habitKeywords || []).filter(k => k?.name && !k.endedAt);
  return (
    <section className="day-summary" aria-label="이번 주 습관">
      <header className="day-summary-head">
        <span className="day-summary-title">이번 주 습관</span>
        <span className="day-summary-count">키워드가 든 기록 기준</span>
      </header>
      {active.length === 0 ? (
        <p className="day-summary-muted">
          마이페이지에서 습관 키워드를 등록해 보세요. 그 단어가 들어간 기록을 남긴 날마다 여기에 체크돼요.
        </p>
      ) : (
        <div className="habit-week">
          <div className="habit-week-row habit-week-row--head" aria-hidden="true">
            <span className="habit-week-name" />
            {week.days.map(d => <span key={d.key} className="habit-week-day">{format(d.date, 'E', { locale: ko })}</span>)}
          </div>
          {active.map(k => (
            <div key={k.name} className="habit-week-row">
              <span className="habit-week-name">
                <span className="habit-week-dot" style={{ backgroundColor: `var(--habit-${k.color})` }} />
                {k.name}
              </span>
              {week.days.map(d => {
                const done = d.items.some(m => m.content.includes(k.name));
                return (
                  <span key={d.key} className={`habit-week-cell${done ? ' habit-week-cell--on' : ''}`} aria-label={done ? '함' : '안 함'}>
                    <Check size={14} strokeWidth={3} />
                  </span>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ── 이번 주 ──────────────────────────────────────────────────
function WeekView({ week, habitKeywords, onViewed }) {
  useEffect(() => { onViewed?.(); }, [onViewed]);
  const peakHour = peakHourFromCurve(week.curve);
  const peakLabel = peakHour != null ? `${hourLabel(peakHour)}쯤 가장 많이` : null;

  return (
    <>
      <section className="day-summary shape" aria-label="이번 주 기록">
        <header className="day-summary-head">
          <span className="day-summary-title">이번 주 리듬</span>
          <span className="day-summary-count">기록한 날 {week.activeDays}/{WEEKLY_DAYS}일</span>
        </header>
        <DayCurve curve={week.curve} now={null} peakLabel={peakLabel} />
        {/* 이 막대가 뭘 세는지 그래프만 봐서는 안 보였다 — 제목을 붙인다 */}
        <div className="week-bars-caption">날짜별 기록 수</div>
        <div className="week-bars" role="img" aria-label="날짜별 기록 수">
          {week.days.map(d => (
            <div key={d.key} className="week-bar-slot">
              <span className="week-bar-count">{d.count > 0 ? d.count : ''}</span>
              <div className="week-bar-track">
                <div
                  className={`week-bar${d.count === week.maxDayCount && d.count > 0 ? ' week-bar--max' : ''}${d.count === 0 ? ' week-bar--empty' : ''}`}
                  style={{ height: `${d.count === 0 ? 0 : Math.max(12, (d.count / week.maxDayCount) * 100)}%` }}
                />
              </div>
              <span className="week-bar-label">{format(d.date, 'E', { locale: ko })}</span>
            </div>
          ))}
        </div>
      </section>

      <HabitWeek week={week} habitKeywords={habitKeywords} />
    </>
  );
}

// ── 화면 ──────────────────────────────────────────────────────
export default function ReviewScreen({
  facts, dayLabel, isToday = true, onSwipeDay, week, now, ai, locked, busy, usesLeft,
  habitKeywords, onGenerate, onLoginClick, onViewed, onWeekViewed, viewKey, onGoTimeline,
}) {
  const [mode, setMode] = useState('today'); // 'today' | 'week'

  // 탭에 들어와 오늘의 모양을 실제로 본 시점 (기록이 있을 때만 의미가 있다)
  useEffect(() => {
    if (mode === 'today' && facts) onViewed?.(viewKey);
  }, [mode, facts, viewKey, onViewed]);

  const aiOk = ai?.status === 'ok' && ai.data;

  // 좌우로 밀면 날짜가 바뀐다 (타임라인 채팅창과 같은 손짓). 세로 스크롤과 헷갈리지 않게
  // 가로로 충분히(50px↑), 세로보다 확실히 더 움직였을 때만.
  const swipeRef = useRef(null);
  const onPointerDown = (e) => { if (e.pointerType === 'mouse' && e.button !== 0) return; swipeRef.current = { x: e.clientX, y: e.clientY }; };
  const onPointerUp = (e) => {
    const d = swipeRef.current; swipeRef.current = null;
    if (!d || mode !== 'today' || !onSwipeDay) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    onSwipeDay(dx < 0 ? 1 : -1); // 왼쪽으로 밀면 다음 날
  };

  return (
    <div className="review-screen" onPointerDown={onPointerDown} onPointerUp={onPointerUp} onPointerCancel={() => { swipeRef.current = null; }}>
      <div className="review-seg" role="tablist">
        <button type="button" role="tab" aria-selected={mode === 'today'} className={`review-seg-btn${mode === 'today' ? ' review-seg-btn--on' : ''}`} onClick={() => setMode('today')}>오늘</button>
        <button type="button" role="tab" aria-selected={mode === 'week'} className={`review-seg-btn${mode === 'week' ? ' review-seg-btn--on' : ''}`} onClick={() => setMode('week')}>이번 주</button>
      </div>

      {mode === 'week' ? (
        <WeekView week={week} habitKeywords={habitKeywords} onViewed={onWeekViewed} />
      ) : (
        <>
          {!facts ? (
            <div className="review-empty">
              <Inbox size={44} strokeWidth={1} />
              {isToday ? (
                <>
                  <p>
                    오늘 기록이 아직 없어요.<br />
                    타임라인에 한 줄 남기면 여기에 하루의 모양이 쌓여요.
                  </p>
                  <button type="button" className="day-summary-btn" onClick={onGoTimeline}>기록하러 가기</button>
                </>
              ) : (
                <p>이 날은 기록이 없어요.</p>
              )}
            </div>
          ) : (
            <>
          {/* 회고를 만들면 결과(토끼+회고 글)가 한 덩어리로 맨 위에, 리듬 곡선은 그 아래로.
              만들기 전에는 리듬 곡선 아래에 만들기 버튼이 있다 — 결과가 위아래로 찢어지지 않는다 */}
          {aiOk && !locked ? (
            <>
              <ReflectionBlock data={ai.data} mock={ai.mock} stale={ai.stale} busy={busy} usesLeft={usesLeft} onGenerate={onGenerate} />
              <ShapeBlock facts={facts} now={isToday ? now : null} dayLabel={dayLabel} />
            </>
          ) : (
            <>
              <ShapeBlock facts={facts} now={isToday ? now : null} dayLabel={dayLabel} />
              <AIGate ai={ai} locked={locked} recordCount={facts.count} busy={busy} usesLeft={usesLeft} onGenerate={onGenerate} onLoginClick={onLoginClick} />
            </>
          )}

          {/* 다음 — 계산값만. 첫날이어도 빈 칸이 없다 */}
          <footer className="day-summary-hook">
            <strong>기록 {facts.recordDays}일차</strong>
            <span>
              {facts.daysToWeekly > 0
                ? `주간 리포트까지 ${facts.daysToWeekly}일 더 기록하면 돼요`
                : '주간 리포트가 열렸어요 · 이번 주 탭'}
            </span>
          </footer>
            </>
          )}
        </>
      )}
    </div>
  );
}
