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
import { useEffect, useState } from 'react';
import { format } from 'date-fns';
import { ko } from 'date-fns/locale';
import { Sparkles, Lock, Inbox, RefreshCw, X, Plus, Flame } from 'lucide-react';
import {
  SUMMARY_MIN_RECORDS, SUMMARY_DAILY_LIMIT, WEEKLY_DAYS, UNCATEGORIZED, groupByCategory, formatMinutes,
} from './daySummary';

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

export function DayCurve({ curve, now, peakLabel }) {
  if (!curve?.hasData) return null;
  const { line, area } = curvePath(curve.points);
  const nowMin = now ? now.getHours() * 60 + now.getMinutes() : null;
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
          <span className={`day-curve-peak${peakX > 70 ? ' day-curve-peak--left' : ''}`} style={{ left: `${peakX}%` }}>{peakLabel}</span>
        )}
      </div>
      <div className="day-curve-axis">
        <span>오전 12시</span><span>오전 6시</span><span>오후 12시</span><span>오후 6시</span>
      </div>
    </div>
  );
}

// ── 카테고리 고르기 (기록 하나의 분류를 바꾼다) ────────────────
function CategoryPicker({ memo, categories, onPick, onClose }) {
  const [custom, setCustom] = useState('');
  const current = memo.category || UNCATEGORIZED;
  const options = [...categories.filter(c => c !== UNCATEGORIZED), UNCATEGORIZED];
  return (
    <div className="cat-picker-backdrop" onClick={onClose}>
      <div className="cat-picker" onClick={e => e.stopPropagation()} role="dialog" aria-label="카테고리 바꾸기">
        <div className="cat-picker-head">
          <span className="cat-picker-memo">{format(new Date(memo.recordedAt), 'HH:mm')} · {memo.content}</span>
          <button type="button" className="cat-picker-close" onClick={onClose} aria-label="닫기"><X size={16} /></button>
        </div>
        <div className="cat-picker-list">
          {options.map(name => (
            <button
              key={name}
              type="button"
              className={`cat-picker-item${name === current ? ' cat-picker-item--on' : ''}`}
              onClick={() => onPick(name === UNCATEGORIZED ? null : name)}
            >
              {name}
            </button>
          ))}
        </div>
        <form
          className="cat-picker-new"
          onSubmit={e => { e.preventDefault(); const v = custom.trim(); if (v) onPick(v.slice(0, 12)); }}
        >
          <input
            type="text"
            value={custom}
            onChange={e => setCustom(e.target.value)}
            placeholder="새 카테고리 (2~5자)"
            maxLength={12}
          />
          <button type="submit" disabled={!custom.trim()} aria-label="추가"><Plus size={16} /></button>
        </form>
      </div>
    </div>
  );
}

// ── 블록 2: 오늘의 시간 배분 ──────────────────────────────────
// 기록의 category로 그린다. 미분류는 숨기지 않는다 — 어떤 입력이 분류되지 않는지 보는 것도 목적이다.
// 기록 수가 아니라 '활동 시간'으로 그린다. 기록 한 줄은 다음 기록까지의 시간을 대표한다고 보고
// (최대 3시간), 카테고리별로 그 시간을 더한다. "오늘 업무에 4시간, 휴식에 1시간"이어야
// 다음 행동(내일은 휴식을 더, 이 일은 줄이기)이 나온다. 기록 수 비중은 그걸 못 준다.
function CategoryBlock({ memos, durations, fixedCategories, onEdit, mock }) {
  const [picking, setPicking] = useState(null);
  const groups = groupByCategory(memos, durations);
  const totalMin = groups.reduce((s, g) => s + g.minutes, 0) || 1;
  const names = [...new Set([...fixedCategories, ...groups.map(g => g.name)])];

  return (
    <section className="day-summary" aria-label="오늘의 시간 배분">
      <header className="day-summary-head">
        <span className="day-summary-title">오늘의 시간 배분</span>
        <span className="day-summary-count">
          {mock && <span className="day-summary-mock" title="AI 키가 아직 없어 샘플로 분류했습니다">샘플</span>}
          활동 시간 기준
        </span>
      </header>
      <div className="cat-list">
        {groups.map(g => (
          <div key={g.name} className={`cat-row${g.name === UNCATEGORIZED ? ' cat-row--none' : ''}`}>
            <div className="cat-row-head">
              <span className="cat-row-name">{g.name}</span>
              <span className="cat-row-count">{formatMinutes(g.minutes)} · {Math.round((g.minutes / totalMin) * 100)}%</span>
            </div>
            <div className="cat-row-bar"><div className="cat-row-fill" style={{ width: `${(g.minutes / totalMin) * 100}%` }} /></div>
            <div className="cat-row-items">
              {g.items.map(m => (
                <button key={m.id} type="button" className="cat-chip" onClick={() => setPicking(m)} title="탭해서 카테고리 바꾸기">
                  <span className="cat-chip-time">{format(new Date(m.recordedAt), 'HH:mm')}</span>
                  <span className="cat-chip-text">{m.content}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
      <p className="day-summary-muted cat-hint">기록부터 다음 기록까지를 그 활동의 시간으로 쳐요(최대 3시간). 기록을 탭하면 카테고리를 바꿀 수 있고, 바꾼 건 다음 분류에 반영돼요.</p>
      {picking && (
        <CategoryPicker
          memo={picking}
          categories={names}
          onClose={() => setPicking(null)}
          onPick={(name) => { onEdit(picking, name); setPicking(null); }}
        />
      )}
    </section>
  );
}

// ── 시간대별 흐름 (AI 없음) ───────────────────────────────────
// 오전·점심·오후·저녁으로 나눈 간단 리포트. 지금 시간대는 '진행 중', 아직 안 온 칸은 흐리게.
// 하루가 끝나기 전에도 "오전은 이렇게 지나갔다"를 볼 수 있게 하는 칸이다.
function SegmentBlock({ segments }) {
  return (
    <section className="day-summary" aria-label="시간대별 흐름">
      <header className="day-summary-head">
        <span className="day-summary-title">시간대별 흐름</span>
        <span className="day-summary-count">기록 시각 기준</span>
      </header>
      <div className="seg-list">
        {segments.map(seg => (
          <div key={seg.key} className={`seg-row seg-row--${seg.state}`}>
            <div className="seg-head">
              <span className="seg-label">{seg.label}</span>
              <span className="seg-range">{String(seg.from).padStart(2, '0')}–{String(seg.to).padStart(2, '0')}시</span>
              {seg.state === 'now' && <span className="seg-now">진행 중</span>}
              <span className="seg-count">{seg.count > 0 ? `${seg.count}개` : (seg.state === 'later' ? '' : '기록 없음')}</span>
            </div>
            {seg.count > 0 && (
              <div className="seg-body">
                {seg.topCategory && <span className="seg-cat">{seg.topCategory}</span>}
                <span className="seg-text">
                  {seg.items[0].content}
                  {seg.count > 1 && <span className="seg-more"> 외 {seg.count - 1}개</span>}
                </span>
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

// ── 블록 3: 오늘의 회고 (AI) ──────────────────────────────────
function ReflectionBlock({ data, mock, stale, busy, usesLeft, onGenerate }) {
  const hasFlow = data.thoughtFlow?.length > 0;
  const hasLoops = data.loops?.length > 0;
  const up = data.energyWords?.up ?? [];
  const down = data.energyWords?.down ?? [];
  const hasEnergy = up.length > 0 || down.length > 0;
  const hasKeywords = data.keywords?.length > 0;

  return (
    <section className="day-summary reflection" aria-label="오늘의 회고">
      <header className="day-summary-head">
        <span className="day-summary-title"><Sparkles size={13} /> 오늘의 회고</span>
        {mock && <span className="day-summary-mock" title="AI 키가 아직 없어 샘플로 보여줍니다">샘플</span>}
      </header>
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
        <div className="day-summary-ai-title"><Sparkles size={13} /> 오늘의 회고</div>
        <p className="day-summary-muted day-summary-loading-text">오늘 남긴 말들을 읽는 중…</p>
      </section>
    );
  }
  const short = recordCount < SUMMARY_MIN_RECORDS;
  const exhausted = usesLeft <= 0;
  return (
    <section className="day-summary day-summary--ai-gate">
      <div className="day-summary-ai-title"><Sparkles size={13} /> 오늘의 회고</div>
      {ai?.status === 'failed' ? (
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
      <button type="button" className="day-summary-btn" onClick={onGenerate} disabled={short || busy || exhausted}>
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
const peakHourFromCurve = (curve) => (curve?.peakMinute != null ? Math.floor(curve.peakMinute / 60) : null);

function ShapeBlock({ facts, now }) {
  const peakHour = peakHourFromCurve(facts.curve);
  const peakLabel = peakHour != null ? `${hourLabel(peakHour)}쯤 가장 많이` : null;
  return (
    <section className="day-summary shape" aria-label="오늘의 모양">
      <div className="shape-top">
        <div className="shape-main">
          <span className="day-summary-stat-label">총 기록 시간</span>
          <span className="shape-big">{facts.spanMinutes > 0 ? formatMinutes(facts.spanMinutes) : '—'}</span>
        </div>
        {facts.streak > 0 && (
          <span className="streak-badge"><Flame size={13} /> {facts.streak}일 연속</span>
        )}
      </div>
      <div className="shape-sub">
        기록 <strong>{facts.count}회</strong>
        {facts.activityCount > 0 && <> · 활동 <strong>{facts.activityCount}개</strong></>}
        {peakHour != null && <> · 몰린 시간 <strong>{hourLabel(peakHour)}</strong></>}
      </div>
      <DayCurve curve={facts.curve} now={now} peakLabel={peakLabel} />
    </section>
  );
}

// ── 이번 주 ──────────────────────────────────────────────────
function WeekView({ week, onViewed }) {
  useEffect(() => { onViewed?.(); }, [onViewed]);
  const cats = week.categories;
  const catTotal = cats.reduce((s, g) => s + g.minutes, 0) || 1;
  const hasCats = cats.some(g => g.minutes > 0);
  const peakHour = peakHourFromCurve(week.curve);
  const peakLabel = peakHour != null ? `${hourLabel(peakHour)}쯤 가장 많이` : null;

  return (
    <>
      <section className="day-summary shape" aria-label="이번 주 기록">
        <div className="shape-top">
          <div className="shape-main">
            <span className="day-summary-stat-label">최근 7일 총 기록 시간</span>
            <span className="shape-big">{week.totalSpanMinutes > 0 ? formatMinutes(week.totalSpanMinutes) : '—'}</span>
          </div>
          {week.streak > 0 && (
            <span className="streak-badge"><Flame size={13} /> {week.streak}일 연속</span>
          )}
        </div>
        <div className="shape-sub">
          기록 <strong>{week.total}회</strong> · 기록한 날 <strong>{week.activeDays}/{WEEKLY_DAYS}일</strong>
          {peakHour != null && <> · 몰린 시간 <strong>{hourLabel(peakHour)}</strong></>}
        </div>
        <DayCurve curve={week.curve} now={null} peakLabel={peakLabel} />
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

      <section className="day-summary" aria-label="이번 주 시간 배분">
        <header className="day-summary-head">
          <span className="day-summary-title">이번 주 시간 배분</span>
          <span className="day-summary-count">활동 시간 기준</span>
        </header>
        {!hasCats ? (
          <p className="day-summary-muted">아직 분류된 기록이 없어요. 오늘 탭에서 회고를 만들면 여기에 쌓여요.</p>
        ) : (
          <div className="cat-list cat-list--compact">
            {cats.map(g => (
              <div key={g.name} className={`cat-row${g.name === UNCATEGORIZED ? ' cat-row--none' : ''}`}>
                <div className="cat-row-head">
                  <span className="cat-row-name">{g.name}</span>
                  <span className="cat-row-count">{formatMinutes(g.minutes)} · {Math.round((g.minutes / catTotal) * 100)}%</span>
                </div>
                <div className="cat-row-bar"><div className="cat-row-fill" style={{ width: `${(g.minutes / catTotal) * 100}%` }} /></div>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}

// ── 화면 ──────────────────────────────────────────────────────
export default function ReviewScreen({
  facts, todayMemos, week, now, ai, locked, busy, usesLeft, fixedCategories,
  onGenerate, onLoginClick, onViewed, onWeekViewed, viewKey, onGoTimeline, onEditCategory,
}) {
  const [mode, setMode] = useState('today'); // 'today' | 'week'

  // 탭에 들어와 오늘의 모양을 실제로 본 시점 (기록이 있을 때만 의미가 있다)
  useEffect(() => {
    if (mode === 'today' && facts) onViewed?.(viewKey);
  }, [mode, facts, viewKey, onViewed]);

  const hasCategories = todayMemos.some(m => m.category);
  const aiOk = ai?.status === 'ok' && ai.data;

  return (
    <div className="review-screen">
      <div className="review-seg" role="tablist">
        <button type="button" role="tab" aria-selected={mode === 'today'} className={`review-seg-btn${mode === 'today' ? ' review-seg-btn--on' : ''}`} onClick={() => setMode('today')}>오늘</button>
        <button type="button" role="tab" aria-selected={mode === 'week'} className={`review-seg-btn${mode === 'week' ? ' review-seg-btn--on' : ''}`} onClick={() => setMode('week')}>이번 주</button>
      </div>

      {mode === 'week' ? (
        <WeekView week={week} onViewed={onWeekViewed} />
      ) : !facts ? (
        <div className="review-empty">
          <Inbox size={44} strokeWidth={1} />
          <p>
            오늘 기록이 아직 없어요.<br />
            타임라인에 한 줄 남기면 여기에 하루의 모양이 쌓여요.
          </p>
          <button type="button" className="day-summary-btn" onClick={onGoTimeline}>기록하러 가기</button>
        </div>
      ) : (
        <>
          <ShapeBlock facts={facts} now={now} />

          {/* 시간대별 흐름 — AI 없이, 하루 중간에도 볼 수 있는 칸 */}
          <SegmentBlock segments={facts.segments} />

          {/* 오늘의 회고 (AI) / 만들기 버튼 */}
          {aiOk && !locked ? (
            <ReflectionBlock data={ai.data} mock={ai.mock} stale={ai.stale} busy={busy} usesLeft={usesLeft} onGenerate={onGenerate} />
          ) : (
            <AIGate ai={ai} locked={locked} recordCount={facts.count} busy={busy} usesLeft={usesLeft} onGenerate={onGenerate} onLoginClick={onLoginClick} />
          )}

          {/* 시간 배분 — 분류가 있으면 AI 상태와 상관없이 그린다 (활동 시간 기준) */}
          {hasCategories && !locked && (
            <CategoryBlock
              memos={todayMemos}
              durations={facts.durations}
              fixedCategories={fixedCategories}
              onEdit={onEditCategory}
              mock={Boolean(aiOk && ai.mock)}
            />
          )}

          {/* 4. 다음 — 계산값만. 첫날이어도 빈 칸이 없다 */}
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
    </div>
  );
}
