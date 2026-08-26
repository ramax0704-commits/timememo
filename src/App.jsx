import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  format,
  isSameDay,
  startOfMonth,
  endOfMonth,
  startOfWeek,
  endOfWeek,
  addDays,
  subMonths,
  addMonths,
  isSameMonth,
  isToday,
  differenceInCalendarDays,
  parseISO,
  parse
} from 'date-fns';
import { ko } from 'date-fns/locale';
import { Send, ChevronLeft, ChevronRight, Inbox, User, CreditCard, ShieldAlert, X, Trash2, Clock, LayoutGrid, Tag, Plus, ListChecks, CornerDownLeft, Palette, HelpCircle, MessageSquare, Sparkles } from 'lucide-react';
import { supabase, setRememberMe, getRememberMe } from './supabase';
import { track, identifyUser, resetUser, markFirstMemo } from './analytics';
import { loadGuestRows, saveGuestRows, clearGuestRows, newGuestId } from './guestStore';
import {
  SUMMARY_MIN_RECORDS, SUMMARY_DAILY_LIMIT, dateKeyOf, reviewKeyOf,
  buildDayFacts, buildWeekFacts, toSummaryRecords, countRecordDays,
} from './daySummary';
import { requestDaySummary, summaryCacheKey, peekSummaryCache, collectCachedRabbits, collectCachedSummaries, normalizeSummary } from './summaryAI';
import ReviewScreen from './ReviewScreen';
import TourOverlay from './TourOverlay';
import Splash from './Splash';

// Supabase 행(snake_case)을 앱에서 쓰는 형태(camelCase)로 변환
function rowToMemo(row) {
  return {
    id: row.id,
    content: row.content,
    color: row.color,
    recordedAt: row.recorded_at,
    // 스케줄 뷰 블록 길이 (기본은 짧은 블록)
    spansToNext: row.spans_to_next ?? false, // 이 기록 시각 → 다음 기록 시각
    // 끝나고 남긴 기록: 이전 기록 시각부터 이 기록 시각까지
    spansFromPrev: row.spans_from_prev ?? false,
    // 시작 시각을 직접 고쳤을 때 '기록 시각에서 몇 분 전'인지. spansFromPrev보다 우선한다
    backMinutes: row.back_minutes ?? 0,
    // 종료 시각을 직접 고쳤을 때 '기록 시각에서 몇 분 후'인지. spansToNext보다 우선한다
    endMinutes: row.end_minutes ?? 0,
    // 회고에서 붙는 활동 카테고리. null = 미분류. 본문은 건드리지 않는다.
    category: row.category ?? null,
  };
}

// ── 컬러 팔레트 ──────────────────────────────────────────────
const COLOR_PALETTE = [
  { id: 'default', bg: '#f9f9fb', label: '기본' },
  { id: 'yellow',  bg: '#fffbeb', label: '노랑' },
  { id: 'green',   bg: '#f0fdf4', label: '연두' },
  { id: 'blue',    bg: '#eff6ff', label: '하늘' },
  { id: 'purple',  bg: '#faf5ff', label: '연보라' },
  { id: 'pink',    bg: '#fdf2f8', label: '연핑크' },
  { id: 'orange',  bg: '#fff7ed', label: '연주황' },
];

const COLOR_BORDER = {
  default: '#e8e8f0',
  yellow:  '#fde68a',
  green:   '#bbf7d0',
  blue:    '#bfdbfe',
  purple:  '#e9d5ff',
  pink:    '#fbcfe8',
  orange:  '#fed7aa',
};

// 터치 기기 여부 (모바일에서는 입력창 자동 포커스를 하지 않음)
const IS_TOUCH_DEVICE = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;

// 터치/마우스 구분을 CSS 미디어쿼리(hover)에 맡기지 않고 body 클래스로 내려준다.
// 삼성 인터넷 등 일부 안드로이드 브라우저가 (hover: hover)를 '마우스 있음'으로
// 잘못 답해서, 갤럭시가 PC 취급되어 스와이프 삭제가 사라지고 PC용 휴지통이 떴다.
if (typeof document !== 'undefined') {
  document.body.classList.add(IS_TOUCH_DEVICE ? 'touch-device' : 'mouse-device');
}

// 습관 키워드 색상 (배경은 --habit-* CSS 변수, 테두리는 한 톤 진하게)
const HABIT_BORDER = {
  purple: '#d8b4fe',
  blue:   '#93c5fd',
  green:  '#86efac',
  pink:   '#f9a8d4',
  orange: '#fdba74',
};

// 체험 모드에서 브라우저에 담아둔 기록을 화면에 쓸 모양으로 꺼낸다
// 앱을 켠 직후 첫 요청은 토큰 갱신 중이거나 네트워크가 아직 안 붙어 실패할 수 있다.
// 한 번 실패했다고 포기하면 기록이 다 날아간 것처럼 빈 화면이 남으므로 몇 번 더 시도한다.
async function fetchWithRetry(run, tries = 4) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    const res = await run();
    if (!res.error) return res;
    last = res;
    await new Promise(r => setTimeout(r, 500 * 2 ** i));
  }
  return last;
}

function loadGuestMemos() {
  return loadGuestRows()
    .map(rowToMemo)
    .sort((a, b) => new Date(a.recordedAt) - new Date(b.recordedAt));
}

// 이메일 회원가입 개폐 스위치.
// Supabase 기본 SMTP는 시간당 2통 + 팀 멤버 주소로만 발송이라, 모르는 사람이
// 이메일로 가입하면 인증 메일을 못 받고 그대로 막힌다. 그래서 신규 가입은
// 구글로만 받는다(구글은 인증 메일 자체가 없음).
// 기존 이메일 계정의 '로그인'은 그대로 열려 있다 — 막으면 기존 사용자가 자기
// 데이터에 못 들어간다.
// 커스텀 SMTP(Resend 등)를 붙이면 이 값만 true로 바꾸면 된다.
const EMAIL_SIGNUP_ENABLED = false;

// 이메일 로그인 개폐 스위치.
// 2026-08-16에 운영자 계정 데이터를 구글 계정으로 옮기면서 이메일 계정이 하나도
// 남지 않았다. 아무도 안 쓰는 입구를 열어둘 이유가 없어 닫는다.
// 이메일 가입자가 다시 생기면(= EMAIL_SIGNUP_ENABLED를 켜면) 이것도 같이 켜야 한다.
const EMAIL_LOGIN_ENABLED = false;

// ── 가계부 파싱 ───────────────────────────────────────────────
const INCOME_KEYWORDS = ['수입', '월급', '입금', '받음', '용돈', '환급', '이체받음', '급여'];
const EXPENSE_KEYWORDS = ['지출', '결제', '구매', '구입', '샀', '먹음', '소비', '납부', '지불'];

function parseFinance(text) {
  // 숫자 추출 (콤마 포함)
  const numMatch = text.replace(/,/g, '').match(/[\d]+/g);
  if (!numMatch) return null;
  const amount = parseInt(numMatch[numMatch.length - 1], 10);
  if (!amount || amount < 10) return null;

  // 명시적 +/- 기호
  if (/\+\s*[\d,]+/.test(text)) return { type: 'income', amount };
  if (/-\s*[\d,]+/.test(text)) return { type: 'expense', amount };

  // 수입/지출 키워드
  const lowerText = text;
  if (INCOME_KEYWORDS.some(k => lowerText.includes(k))) return { type: 'income', amount };
  if (EXPENSE_KEYWORDS.some(k => lowerText.includes(k))) return { type: 'expense', amount };

  // '원' 이 포함되면 지출로 기본 처리
  if (/\d+\s*원/.test(text)) return { type: 'expense', amount };

  return null;
}

// ── 입력 앞머리 시간 파싱 ─────────────────────────────────────
// "11시 40분 밥 먹음" → 11:40 단일 기록 '밥 먹음'
// "11:30~2:30 수영함" → 11:30부터 구간 기록 '수영함'
// 시각은 글 맨 앞에 있을 때만 읽는다. 본문 속 숫자를 시각으로 오해하면 안 된다.
const TIME_TOKEN = '(오전|오후)?\\s*(\\d{1,2})(?::(\\d{2})|시\\s*(?:(\\d{1,2})\\s*분?)?)';
const RANGE_RE = new RegExp(`^${TIME_TOKEN}\\s*[~\\-]\\s*${TIME_TOKEN}\\s+([\\s\\S]+)$`);
const SINGLE_RE = new RegExp(`^${TIME_TOKEN}\\s+([\\s\\S]+)$`);

// 오전/오후 없이 적힌 1~12시는 하루에 두 번 있다. "지금보다 과거이면서 가장 가까운 쪽"으로
// 읽는다 — 기록은 방금 한 일을 적는 것이기 때문이다. 둘 다 미래면 이른 쪽(오전)으로.
// 오전/오후가 없으면 오전으로 읽는다 ("7시" = 아침 7시). 저녁은 "오후 7시" 또는 "19시".
// 예전엔 '지금보다 과거인 가장 가까운 쪽'으로 읽었는데, 같은 글자가 시각에 따라 다르게
// 저장돼 헷갈렸다. 규칙이 하나면 외울 게 없다. (12시는 정오)
// eslint-disable-next-line no-unused-vars
function resolveClock(ampm, h, m, nowMin) {
  if (ampm === '오전') return (h % 12) * 60 + m;
  if (ampm === '오후') return ((h % 12) + 12) * 60 + m;
  if (h >= 12) return h * 60 + m; // 12시(정오)와 24시간 표기
  return h * 60 + m;
}
// 앞머리가 시각으로 읽히는지 — 내용이 아직 없어도(시각 뒤 스페이스 한 번) 색을 입힌다
const PREFIX_RE = new RegExp(`^${TIME_TOKEN}(?:\\s*[~\\-]\\s*${TIME_TOKEN})?\\s`);
// 입력 앞머리의 시각(범위)을 분 단위로 뽑는다. 내용이 아직 없어도(시각 뒤 공백) 잡아
// 시간표에 '잡힌 영역'을 미리 보여주는 데 쓴다. content는 안 본다.
const SPAN_RANGE_RE = new RegExp(`^${TIME_TOKEN}\\s*[~\\-]\\s*${TIME_TOKEN}\\s`);
const SPAN_SINGLE_RE = new RegExp(`^${TIME_TOKEN}\\s`);
function parseTimeSpan(text, now) {
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const rd = (am, hh, cm, km) => { const h = parseInt(hh, 10); const m = parseInt(cm ?? km ?? '0', 10); if (h > 24 || m > 59) return null; return { am, h, m }; };
  let x = text.match(SPAN_RANGE_RE);
  if (x) {
    const a = rd(x[1], x[2], x[3], x[4]); const b = rd(x[5], x[6], x[7], x[8]);
    if (a && b) {
      const start = resolveClock(a.am, a.h, a.m, nowMin);
      let end = b.am ? resolveClock(b.am, b.h, b.m, nowMin) : (b.h > 12 ? b.h * 60 + b.m : (b.h % 12) * 60 + b.m);
      while (end <= start) end += 12 * 60;
      return { start, end };
    }
  }
  x = text.match(SPAN_SINGLE_RE);
  if (x) { const a = rd(x[1], x[2], x[3], x[4]); if (a) return { start: resolveClock(a.am, a.h, a.m, nowMin), end: null }; }
  return null;
}

function parseTimePrefix(text, now) {
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const readToken = (am, hh, colonMin, koMin) => {
    const h = parseInt(hh, 10);
    const m = parseInt(colonMin ?? koMin ?? '0', 10);
    if (h > 24 || m > 59) return null;
    return { am, h, m };
  };

  const r = text.match(RANGE_RE);
  if (r) {
    const a = readToken(r[1], r[2], r[3], r[4]);
    const b = readToken(r[5], r[6], r[7], r[8]);
    const content = r[9].trim();
    if (a && b && content) {
      const start = resolveClock(a.am, a.h, a.m, nowMin);
      // 끝은 시작보다 뒤여야 한다. "11:30~2:30"의 2:30은 14:30이다.
      let end = b.am ? resolveClock(b.am, b.h, b.m, nowMin) : (b.h > 12 ? b.h * 60 + b.m : (b.h % 12) * 60 + b.m);
      while (end <= start) end += 12 * 60;
      return { kind: 'range', startMin: start, durationMin: end - start, content };
    }
  }

  const s = text.match(SINGLE_RE);
  if (s) {
    const a = readToken(s[1], s[2], s[3], s[4]);
    const content = s[5].trim();
    // "3시 반 먹음"처럼 분이 없어도 되지만, "1등 했다"류 오인을 막기 위해
    // 시각 표기가 명확할 때만(오전/오후·콜론·'시') 시각으로 본다 — 정규식이 이미 보장한다.
    if (a && content) {
      return { kind: 'single', startMin: resolveClock(a.am, a.h, a.m, nowMin), content };
    }
  }
  return null;
}

function formatMoney(n) {
  return n.toLocaleString('ko-KR') + '원';
}

function formatMoneyShort(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + '백만';
  if (n >= 10000) return (n / 10000).toFixed(1).replace(/\.0$/, '') + '만';
  if (n >= 1000) return (n / 1000).toFixed(0) + '천';
  return n.toString();
}

// ── 날짜별 먼슬리 집계 ─────────────────────────────────────────
// ── 걸린 시간 표기 ───────────────────────────────────────────
// '1시간 30분'은 말풍선 안에 넣기엔 길고, '1:30'은 기록 시각과 헷갈린다.
// 짧으면서 시각과 안 헷갈리는 '1h 30m' 꼴을 쓴다.
function formatDuration(min) {
  const m = Math.round(min);
  if (m < 1) return null;
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h === 0) return `${r}m`;
  if (r === 0) return `${h}h`;
  return `${h}h ${r}m`;
}

// ── 본문 속 링크 ─────────────────────────────────────────────
// 캡처 그룹 하나로 split하면 홀수 인덱스가 링크다
const URL_REGEX = /(https?:\/\/[^\s]+|www\.[^\s]+)/g;

function renderLineWithLinks(line) {
  // /g 정규식은 test()가 lastIndex를 옮겨 다음 호출을 놓치므로 검사는 따로 한다
  if (!/https?:\/\/|www\./.test(line)) return line;
  return line.split(URL_REGEX).map((part, i) => {
    if (i % 2 === 1) {
      const href = part.startsWith('www.') ? `https://${part}` : part;
      return (
        <a
          key={i}
          className="memo-link"
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          onClick={e => e.stopPropagation()}
        >
          {part}
        </a>
      );
    }
    return part;
  });
}

// ── 할 일 정렬·묶기 ──────────────────────────────────────────
// 적어둔 날로 묶는다. **마감일이 아니라 '언제 적었나'** 다.
// 날짜를 마감으로 쓰면 '어제 못 한 것'이 생겨 목록 자체가 압박이 되므로,
// todos 테이블에는 여전히 날짜 컬럼을 두지 않고 created_at만 쓴다.
function sortTodos(list) {
  return [...list].sort((a, b) => {
    const da = new Date(a.created_at), db = new Date(b.created_at);
    if (!isSameDay(da, db)) return da - db;          // 적은 날짜 순
    if (a.done !== b.done) return a.done ? 1 : -1;   // 같은 날 안에서 완료한 건 아래로
    return da - db;
  });
}

function groupTodosByDay(list) {
  const groups = [];
  for (const t of list) {
    const at = new Date(t.created_at);
    const last = groups[groups.length - 1];
    if (last && isSameDay(last.date, at)) last.items.push(t);
    else groups.push({ date: at, items: [t] });
  }
  return groups;
}

function todoDayLabel(date) {
  if (isToday(date)) return '오늘';
  if (isSameDay(date, addDays(new Date(), -1))) return '어제';
  return format(date, 'M월 d일 (E)', { locale: ko });
}

// ── 메모 아이템 컴포넌트 ──────────────────────────────────────
// 제스처가 셋이라 한 곳에서 조율한다:
//   짧게 탭 → 수정 시트, 좌우로 밀기 → 삭제 버튼, 꾹 누르기(0.45초) → 순서 옮기기.
// 예전에는 touch 이벤트를 썼는데, 포인터 이벤트로 바꿔서 PC 마우스도 같이 통한다.
function MemoItem({ memo, onEdit, onDeleteWithUndo, habitKeywords, dimmed, duration, reorder }) {
  const [swiped, setSwiped] = useState(false);
  // 드래그 중 위치는 App이 자동 스크롤과 함께 DOM에 직접 그린다 (여기선 상태만)
  const [dragging, setDragging] = useState(false);
  // { x, y, id, mode: 'pending' | 'swipe' | 'scroll' | 'drag', timer }
  const gestureRef = useRef(null);
  // 스와이프·드래그 뒤에 따라오는 click이 수정 시트를 열지 않게 막는다
  const suppressClickRef = useRef(false);

  // 습관 키워드가 포함된 메모는 키워드 색으로 표시 (사용자가 직접 색을 고른 경우는 그대로)
  const memoDateKey = format(new Date(memo.recordedAt), 'yyyy-MM-dd');
  const habitMatch = (memo.color || 'default') === 'default'
    ? habitKeywords?.find(k => k?.name && memo.content.includes(k.name) && (!k.endedAt || memoDateKey < k.endedAt))
    : null;

  const colorBg = habitMatch
    ? `var(--habit-${habitMatch.color})`
    : (COLOR_PALETTE.find(c => c.id === (memo.color || 'default'))?.bg || '#f9f9fb');
  const colorBorder = habitMatch
    ? (HABIT_BORDER[habitMatch.color] || '#e8e8f0')
    : (COLOR_BORDER[memo.color || 'default'] || '#e8e8f0');

  const clearGesture = () => {
    if (gestureRef.current?.timer) clearTimeout(gestureRef.current.timer);
    gestureRef.current = null;
  };

  const endDrag = (commit) => {
    setDragging(false);
    reorder?.onEnd(commit);
  };

  const onPointerDown = (e) => {
    // 지난 제스처가 남긴 클릭 억제를 여기서 푼다 (다음 탭까지 막으면 안 된다)
    suppressClickRef.current = false;
    if (!e.isPrimary) return;
    if (e.target.closest('button, a, input, textarea')) return;
    clearGesture();
    const g = { x: e.clientX, y: e.clientY, id: e.pointerId, el: e.currentTarget, mode: 'pending', timer: null };
    g.timer = setTimeout(() => {
      if (gestureRef.current !== g || g.mode !== 'pending') return;
      g.mode = 'drag';
      suppressClickRef.current = true;
      setSwiped(false);
      setDragging(true);
      // 마우스는 커서가 요소 밖으로 나가면 이벤트가 끊긴다 — 캡처로 붙잡아둔다
      // (터치는 원래 처음 누른 요소가 끝까지 받는다)
      try { g.el.setPointerCapture(g.id); } catch { /* 이미 떼었으면 무시 */ }
      navigator.vibrate?.(15);
      reorder?.onStart(memo, g.y);
    }, 450);
    gestureRef.current = g;
  };

  const onPointerMove = (e) => {
    const g = gestureRef.current;
    if (!g || e.pointerId !== g.id) return;
    if (e.pointerType === 'mouse' && !(e.buttons & 1)) return; // 마우스는 누른 채 끌 때만
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    if (g.mode === 'drag') {
      reorder?.onMove(e.clientY);
      return;
    }
    if (g.mode === 'pending' && Math.hypot(dx, dy) > 8) {
      clearTimeout(g.timer);
      // 가로로 확실히 밀면 스와이프, 아니면 세로 스크롤에 맡긴다
      g.mode = Math.abs(dx) > Math.abs(dy) * 1.2 ? 'swipe' : 'scroll';
    }
  };

  const onPointerUp = (e) => {
    const g = gestureRef.current;
    if (!g || e.pointerId !== g.id) return;
    if (g.mode === 'drag') {
      endDrag(true);
    } else if (g.mode === 'swipe') {
      const dx = e.clientX - g.x;
      if (dx < -40) { setSwiped(true); suppressClickRef.current = true; }
      else if (dx > 40) { setSwiped(false); suppressClickRef.current = true; }
    }
    clearGesture();
  };

  const onPointerCancel = () => {
    if (gestureRef.current?.mode === 'drag') endDrag(false);
    clearGesture();
  };

  return (
    <div
      className={`memo-swipe-wrapper ${swiped ? 'swiped' : ''}${dragging ? ' dragging' : ''}`}
      style={dimmed ? { opacity: 0.45 } : undefined}
      // 채팅창 ↔ 타임블럭을 오갈 때 '보고 있던 시각'을 이 값으로 읽는다
      data-at={memo.recordedAt}
      // 순서 옮기기가 떨어뜨릴 자리를 찾을 때 쓴다
      data-id={memo.id}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onClickCapture={(e) => {
        if (suppressClickRef.current) {
          e.preventDefault();
          e.stopPropagation();
          suppressClickRef.current = false;
        }
      }}
    >
      {/* 삭제 버튼 (스와이프 시 노출) */}
      <button
        className="memo-delete-reveal-btn"
        onClick={(e) => {
          e.stopPropagation();
          setSwiped(false);
          onDeleteWithUndo(memo);
        }}
        aria-label="삭제"
      >
        <Trash2 size={18} />
      </button>

      {/* 메모 본체 */}
      <div className="memo-item">
        {/* 시각이든 말풍선이든 같은 편집 시트를 연다.
            어디를 눌렀냐에 따라 할 수 있는 일이 달라지면 왔다갔다 하게 된다 */}
        <div
          className="memo-time-container"
          onClick={() => onEdit(memo)}
          title="기록 수정하기"
        >
          {/* 시작 시각을 직접 고친 기록(backMinutes)은 적은 시각이 아니라 시작 시각을 보여준다 */}
          <span className="memo-time">{format(new Date(new Date(memo.recordedAt).getTime() - (memo.backMinutes || 0) * 60000), 'aa h:mm', { locale: ko })}</span>
        </div>
        <div
          className="memo-content"
          style={{ backgroundColor: colorBg, borderColor: colorBorder, cursor: 'pointer' }}
          onClick={() => onEdit(memo)}
          title="기록 수정하기"
        >
          {memo.content.split('\n').map((line, i, arr) => (
            <React.Fragment key={i}>
              {renderLineWithLinks(line)}
              {i !== arr.length - 1 && <br />}
            </React.Fragment>
          ))}
          {/* 구간 기록은 말풍선 안, 글 끝에 걸린 시간을 회색으로 */}
          {duration != null && formatDuration(duration) && (
            <span className="memo-duration">{formatDuration(duration)}</span>
          )}
        </div>

        {/* 웹 호버 삭제 버튼 */}
        <button
          className="memo-hover-delete-btn"
          onClick={(e) => {
            e.stopPropagation();
            onDeleteWithUndo(memo);
          }}
          aria-label="삭제"
          title="삭제"
        >
          <Trash2 size={15} />
        </button>
      </div>
    </div>
  );
}

// ── 시간 휠 피커 ─────────────────────────────────────────────
// 기기 기본 time 입력은 iOS는 휠, 갤럭시는 시계 다이얼이라 제각각이었다.
// 어느 기기에서나 똑같이 위아래로 돌려 고르도록 앱 안에서 직접 그린다.
// 스크롤 스냅으로 굴러가고, 멈춘 자리의 값을 읽는다.
const WHEEL_ITEM_H = 36;

function WheelColumn({ options, value, onChange, ariaLabel }) {
  const ref = useRef(null);
  const settleTimer = useRef(null);
  // 마지막으로 우리가 보고한 값. 바깥에서 온 값 변화(다른 기록 열기 등)와 구분한다
  const reportedRef = useRef(value);

  const indexOf = (v) => options.findIndex(o => o.value === v);

  // 처음 열릴 때 현재 값 자리로
  useEffect(() => {
    const idx = indexOf(value);
    if (idx >= 0 && ref.current) ref.current.scrollTop = idx * WHEEL_ITEM_H;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 바깥에서 값이 바뀌면 그 자리로 (내가 굴려서 보고한 값이면 이미 그 자리다)
  useEffect(() => {
    if (value === reportedRef.current) return;
    const idx = indexOf(value);
    if (idx >= 0 && ref.current) ref.current.scrollTop = idx * WHEEL_ITEM_H;
    reportedRef.current = value;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  // 스크롤이 멎으면 가운데 온 값을 읽는다
  const handleScroll = () => {
    clearTimeout(settleTimer.current);
    settleTimer.current = setTimeout(() => {
      const el = ref.current;
      if (!el) return;
      const idx = Math.max(0, Math.min(options.length - 1, Math.round(el.scrollTop / WHEEL_ITEM_H)));
      const opt = options[idx];
      if (opt.value !== value) {
        reportedRef.current = opt.value;
        onChange(opt.value);
      }
    }, 140);
  };

  useEffect(() => () => clearTimeout(settleTimer.current), []);

  return (
    <div className="wheel-col" ref={ref} onScroll={handleScroll} aria-label={ariaLabel}>
      <div className="wheel-pad" aria-hidden="true" />
      {options.map((o, i) => (
        <div
          key={o.value}
          className={`wheel-item${o.value === value ? ' wheel-item--active' : ''}`}
          onClick={() => ref.current?.scrollTo({ top: i * WHEEL_ITEM_H, behavior: 'smooth' })}
        >
          {o.label}
        </div>
      ))}
      <div className="wheel-pad" aria-hidden="true" />
    </div>
  );
}

const WHEEL_AMPM_OPTS = [{ value: 'AM', label: '오전' }, { value: 'PM', label: '오후' }];
const WHEEL_HOUR_OPTS = Array.from({ length: 12 }, (_, i) => ({ value: i + 1, label: String(i + 1) }));
const WHEEL_MIN_OPTS = Array.from({ length: 60 }, (_, i) => ({ value: i, label: String(i).padStart(2, '0') }));

function TimeWheelPicker({ value, onChange }) {
  const [h24, m] = (value || '09:00').split(':').map(Number);
  const ampm = h24 < 12 ? 'AM' : 'PM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;

  // 두 휠을 연달아 빨리 돌리면, 나중 휠이 보고하는 순간 아직 이전 휠의 값이
  // 화면에 반영되기 전이라 옛값과 조합돼버린다 (오후로 돌렸는데 오전으로 저장되던 원인).
  // 그래서 마지막으로 합쳐진 값을 ref에 들고, 보고가 올 때마다 거기에 덧쓴다.
  const draftRef = useRef({ ampm, h12, m });
  useEffect(() => {
    draftRef.current = { ampm, h12, m };
  }, [ampm, h12, m]);

  const emit = (patch) => {
    draftRef.current = { ...draftRef.current, ...patch };
    const d = draftRef.current;
    let h = d.h12 % 12;
    if (d.ampm === 'PM') h += 12;
    onChange(`${String(h).padStart(2, '0')}:${String(d.m).padStart(2, '0')}`);
  };

  return (
    <div className="time-wheel">
      <div className="time-wheel-band" aria-hidden="true" />
      <WheelColumn options={WHEEL_AMPM_OPTS} value={ampm} onChange={v => emit({ ampm: v })} ariaLabel="오전/오후" />
      <WheelColumn options={WHEEL_HOUR_OPTS} value={h12} onChange={v => emit({ h12: v })} ariaLabel="시" />
      <WheelColumn options={WHEEL_MIN_OPTS} value={m} onChange={v => emit({ m: v })} ariaLabel="분" />
    </div>
  );
}

// Date(또는 iso)를 '오후 2:15' 꼴로
const timeLabelOf = (d) => format(new Date(d), 'aa h:mm', { locale: ko });

// 'HH:mm'을 '오후 2:15' 꼴로
const timeLabel12 = (str) => {
  if (!str) return '--:--';
  const [h, m] = str.split(':').map(Number);
  const ampm = h < 12 ? '오전' : '오후';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${ampm} ${h12}:${String(m).padStart(2, '0')}`;
};

// ── 시간 범위 조정 시트 (드래그 핸들 + 고급선택 휠) ──────────────
// 잡힌 시간대를 세부 조정한다. 캘린더처럼 위/아래 핸들로 시작·끝을,
// 가운데를 잡아 통째로 이동. '고급선택'을 누르면 다이얼(휠)로 바뀐다.
// 단일 시각은 드래그가 의미 없어 바로 휠로 연다.
const RS_PX_PER_MIN = 1;      // 기본 배율 (분당 픽셀)
const RS_VIEW_H = 300;        // 타임라인 표시 높이
function TimeRangeSheet({ init, onDone, onCancel }) {
  const isRange = init.isRange;
  const [start, setStart] = useState(init.start);
  const [end, setEnd] = useState(init.end != null ? init.end : init.start + 30);
  const [mode, setMode] = useState(isRange ? 'drag' : 'wheel');
  const [wheelSel, setWheelSel] = useState('start');
  const areaRef = useRef(null);
  const dragRef = useRef(null);

  const fmt = (min) => {
    const d = new Date(init.dayMs + min * 60000);
    const h = d.getHours();
    return `${h < 12 ? '오전' : '오후'} ${h % 12 === 0 ? 12 : h % 12}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  const snap = (v) => Math.round(v / 5) * 5;

  // 타임라인 창: 범위 앞뒤 90분 여유. 화면 높이에 맞춰 배율을 줄인다.
  const winStart = Math.max(0, Math.min(start, init.start) - 90);
  const winEnd = Math.min(1440, Math.max(end, init.start + 30) + 90);
  const ppm = Math.min(RS_PX_PER_MIN, RS_VIEW_H / Math.max(60, winEnd - winStart));
  const yOf = (min) => (min - winStart) * ppm;
  const hours = [];
  for (let h = Math.ceil(winStart / 60); h <= Math.floor(winEnd / 60); h++) hours.push(h);

  const onHandleDown = (type) => (e) => {
    e.stopPropagation();
    dragRef.current = { type, id: e.pointerId, y: e.clientY, s0: start, e0: end };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* 캡처 불가여도 드래그는 진행 */ }
  };
  const onMove = (e) => {
    const g = dragRef.current;
    if (!g || e.pointerId !== g.id) return;
    const dMin = snap((e.clientY - g.y) / ppm);
    if (g.type === 'start') setStart(Math.max(winStart, Math.min(g.s0 + dMin, end - 5)));
    else if (g.type === 'end') setEnd(Math.min(winEnd, Math.max(g.e0 + dMin, start + 5)));
    else if (g.type === 'move') {
      const len = g.e0 - g.s0;
      let ns = g.s0 + dMin;
      ns = Math.max(winStart, Math.min(ns, winEnd - len));
      setStart(ns); setEnd(ns + len);
    }
  };
  const onUp = () => { dragRef.current = null; };

  const dur = (() => {
    const t = end - start;
    const h = Math.floor(t / 60), m = t % 60;
    return `${h > 0 ? `${h}시간 ` : ''}${m > 0 ? `${m}분` : (h > 0 ? '' : '0분')}`.trim();
  })();

  const done = () => onDone(start, isRange ? end : null);

  return (
    <div className="block-sheet-overlay block-sheet-overlay--peek" onClick={onCancel}>
      <div className="block-sheet range-sheet" onClick={e => e.stopPropagation()}>
        <div className="block-sheet-handle" />
        <div className="range-sheet-head">
          <h3>시간</h3>
          {isRange && (
            <button type="button" className="range-adv-btn" onClick={() => setMode(m => (m === 'drag' ? 'wheel' : 'drag'))}>
              {mode === 'drag' ? '고급선택' : '드래그'}
            </button>
          )}
        </div>

        {mode === 'drag' ? (
          <div className="range-timeline" ref={areaRef} style={{ height: `${(winEnd - winStart) * ppm}px` }}
               onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
            {hours.map(h => (
              <div key={h} className="range-hour" style={{ top: `${yOf(h * 60)}px` }}>
                <span>{`${String(h % 24).padStart(2, '0')}:00`}</span>
              </div>
            ))}
            <div className="range-block" style={{ top: `${yOf(start)}px`, height: `${yOf(end) - yOf(start)}px` }}
                 onPointerDown={onHandleDown('move')} onPointerMove={onMove} onPointerUp={onUp}>
              <div className="range-block-label">{fmt(start)} - {fmt(end)}<br /><span className="range-block-dur">{dur}</span></div>
              <div className="range-handle range-handle--top" onPointerDown={onHandleDown('start')} />
              <div className="range-handle range-handle--bot" onPointerDown={onHandleDown('end')} />
            </div>
          </div>
        ) : (
          <div className="range-wheel-wrap">
            {isRange && (
              <div className="block-time-row">
                <button type="button" className={`block-input block-time-btn${wheelSel === 'start' ? ' open' : ''}`} onClick={() => setWheelSel('start')}>{fmt(start)}</button>
                <span className="block-time-sep">→</span>
                <button type="button" className={`block-input block-time-btn${wheelSel === 'end' ? ' open' : ''}`} onClick={() => setWheelSel('end')}>{fmt(end)}</button>
              </div>
            )}
            <TimeWheelPicker
              value={`${String(Math.floor(((wheelSel === 'end' ? end : start) % 1440) / 60)).padStart(2, '0')}:${String((wheelSel === 'end' ? end : start) % 60).padStart(2, '0')}`}
              onChange={(v) => {
                const [h, mi] = v.split(':').map(Number); const mins = h * 60 + mi;
                if (wheelSel === 'end') setEnd(Math.max(start + 5, mins < start ? mins + 1440 : mins));
                else setStart(mins);
              }}
            />
            {isRange && <p className="range-dur-line">{fmt(start)} → {fmt(end)} · {dur}</p>}
          </div>
        )}

        <div className="block-sheet-actions">
          <button className="btn-cancel" onClick={onCancel}>취소</button>
          <button className="btn-save" onClick={done}>완료</button>
        </div>
      </div>
    </div>
  );
}

// ── 온보딩 ───────────────────────────────────────────────────
// 처음 온 사람에게 핵심 사용법을 카드 몇 장으로. 닫으면 다시 안 뜨고,
// 마이페이지 '사용법 다시 보기'로 언제든 다시 볼 수 있다.
const ONBOARDING_KEY = 'timememo-onboarding-done';
// 스플래시(첫 화면)에서 '구글로 시작' 또는 '로그인 없이'를 고른 적이 있는지
const SPLASH_KEY = 'timememo-splash-done';

// ── 투어(움직이는 온보딩)용 샘플 데이터 ─────────────────────────
// 투어에서 사용자가 직접 쓴 기록 두 개에 더해, "하루가 쌓이면 이렇게 된다"를 보여주려고
// 아침 기록 세 개를 뽕뽕뽕 얹는다. 이 샘플들은 저장되지 않고 투어가 끝나면 걷힌다.
// (사용자가 쓴 진짜 기록은 그대로 남아 첫 기록이 된다)
function makeTourSamples(now) {
  const at = (h, m) => new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m).toISOString();
  const mk = (id, recordedAt, content, category) => ({
    id: `tour-${id}`, content, color: 'default', recordedAt, category,
    spansToNext: false, spansFromPrev: false, backMinutes: 0, endMinutes: 0,
  });
  return [
    mk(1, at(8, 40), '아침 스트레칭하고 커피. 오늘은 좀 여유롭게 시작', '휴식'),
    mk(2, at(9, 30), '카페에서 기획서 초안 작성. 집중 잘 됨', '기획업무'),
    mk(3, at(11, 10), '기획서 1차 완료, 팀에 공유. 드디어 끝', '기획업무'),
  ];
}
// 투어에서 보여주는 회고 예시 (AI를 부르지 않는다 — 비용도, 기다림도 없어야 한다)
const TOUR_AI = {
  status: 'ok', mock: false, stale: false,
  data: {
    categories: [],
    headline: '여유롭게 시작해서 "드디어 끝"까지',
    narrative: '"여유롭게 시작"한 아침이 그대로 오전 집중으로 이어졌어요. 기획서를 넘기고 "드디어 끝"이라고 쓴 뒤, 산책과 햇빛이 바로 따라왔고요. 끝낸 뒤에 쉬는 순서가 오늘 안에 그대로 있었어요.',
    thoughtFlow: [
      { stage: '시작', text: '"오늘은 좀 여유롭게 시작"' },
      { stage: '전환', text: '기획서를 끝내고 나서 몸을 움직이는 쪽으로' },
      { stage: '결론', text: '"햇빛 좋았다" — 끝낸 뒤의 산책' },
    ],
    loops: [{ from: '기획서 초안 집중', to: '1차 완료, 팀 공유' }],
    energyWords: { up: ['여유롭게', '집중 잘 됨', '드디어 끝', '햇빛 좋았다'], down: [] },
    keywords: ['마무리', '회복', '몰입'],
    rabbit: { type: 'moon', reason: '"드디어 끝"까지, 절구를 찧듯 묵묵히 과업을 끝낸 하루였어요.' },
    segmentStates: [
      { segment: '오전', state: '집중이 붙어 있었어요' },
      { segment: '저녁', state: '끝내고 한숨 돌렸어요' },
    ],
  },
};
function FeedbackCard({ user }) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  const submit = async () => {
    const content = text.trim();
    if (!content || sending) return;
    setSending(true);
    try {
      const { error } = await supabase.from('feedback').insert({
        content: content.slice(0, 2000),
        user_id: user?.id ?? null,
      });
      if (error) throw error;
      track('Feedback Sent', { guest: !user, content_length: content.length });
      setText('');
      setSent(true);
    } catch {
      alert('전송에 실패했습니다. 잠시 후 다시 시도해주세요.');
    } finally {
      setSending(false);
    }
  };

  if (sent) {
    return (
      <p style={{ fontSize: '0.85rem', color: 'var(--primary-color)', textAlign: 'center', margin: '8px 0', lineHeight: 1.5 }}>
        남겨주셔서 감사합니다. 잘 읽어볼게요 🙂
        <button
          type="button"
          onClick={() => setSent(false)}
          style={{ display: 'block', margin: '6px auto 0', background: 'none', border: 'none', color: '#999', fontSize: '0.8rem', cursor: 'pointer', textDecoration: 'underline' }}
        >
          하나 더 남기기
        </button>
      </p>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <textarea
        className="input-field"
        rows={3}
        maxLength={2000}
        placeholder={user
          ? '불편한 점, 바라는 점, 문의 무엇이든 편하게 남겨주세요.'
          : '불편한 점, 바라는 점, 문의 무엇이든 편하게 남겨주세요.\n답장이 필요하면 이메일 등 연락처를 함께 적어주세요.'}
        value={text}
        onChange={e => setText(e.target.value)}
        style={{ resize: 'none', fontSize: '0.875rem', lineHeight: 1.5 }}
      />
      <button
        type="button"
        className="btn-save"
        onClick={submit}
        disabled={!text.trim() || sending}
        style={{ width: '100%', opacity: !text.trim() || sending ? 0.5 : 1 }}
      >
        {sending ? '보내는 중...' : '의견 보내기'}
      </button>
    </div>
  );
}


// ── 요일 띠 (헤더) ───────────────────────────────────────────
// 고른 날이 든 한 주(일~토)를 보여주고, 누르면 그 날로. 좌우로 밀면 한 주씩 넘어간다.
// maxDate가 있으면 그 뒤 날짜는 누를 수 없다 (회고는 오늘까지). marked = 기록 있는 날 점.
function WeekStrip({ selected, onPick, maxDate, marked }) {
  const start = startOfWeek(selected, { weekStartsOn: 0 });
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const maxKey = maxDate ? dateKeyOf(maxDate) : null;
  const dragRef = useRef(null);
  const swipedRef = useRef(false);
  const onDown = (e) => { dragRef.current = { x: e.clientX, y: e.clientY }; swipedRef.current = false; };
  const onUp = (e) => {
    const d = dragRef.current; dragRef.current = null;
    if (!d) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    swipedRef.current = true;
    let next = addDays(selected, dx < 0 ? 7 : -7);
    if (maxKey && dateKeyOf(next) > maxKey) next = maxDate;
    if (dateKeyOf(next) !== dateKeyOf(selected)) onPick(next);
  };
  return (
    <div className="week-strip" onPointerDown={onDown} onPointerUp={onUp} onPointerCancel={() => { dragRef.current = null; }}>
      {days.map(day => {
        const key = dateKeyOf(day);
        const disabled = Boolean(maxKey && key > maxKey);
        const on = isSameDay(day, selected);
        return (
          <button
            key={key}
            type="button"
            className={`week-day${on ? ' week-day--on' : ''}${isToday(day) ? ' week-day--today' : ''}`}
            disabled={disabled}
            onClick={() => { if (!swipedRef.current) onPick(day); }}
          >
            <span className="week-day-name">{format(day, 'E', { locale: ko })}</span>
            <span className="week-day-num">{format(day, 'd')}</span>
            <span className={`week-day-dot${marked?.has(key) ? ' week-day-dot--on' : ''}`} />
          </button>
        );
      })}
    </div>
  );
}

// ── 받은 의견 (관리자 전용) ─────────────────────────────────
// 서버의 admin_list_feedback()가 호출자 이메일을 확인하므로, 여기서의 이메일 비교는
// "카드를 보여줄지"만 정한다. 다른 계정이 호출해도 빈 목록이 온다.
const ADMIN_EMAIL = 'ramax0704@gmail.com';

// ── 가입 전 동의 ──────────────────────────────────────────────
// 구글 로그인은 곧 가입이라, 처음 누를 때 이용약관·개인정보 수집에 동의를 받는다.
// 동의 시각은 기기(localStorage)에 먼저 남기고, 로그인이 끝나면 settings.consent_at에도 적는다.
const CONSENT_KEY = 'timememo-consent';
const CONSENT_VERSION = '2026-08-25';
// 전문 페이지(약관·방침)는 같은 창에서 열리고, 거기서 돌아올 때 '/?consent=1'로 온다.
// 앱은 그 표시를 보고 로그인 화면 + 동의 시트를 다시 띄운다 (새 창으로 열려도 동작한다).
const consentReturnRequested = () => {
  try { return new URLSearchParams(window.location.search).get('consent') === '1'; } catch { return false; }
};

function ConsentRow({ checked, onChange, children }) {
  return (
    <label className={`consent-row${checked ? ' consent-row--on' : ''}`}>
      <input type="checkbox" checked={checked} onChange={onChange} />
      <span className="consent-check" aria-hidden="true">✓</span>
      <span className="consent-text">{children}</span>
    </label>
  );
}

function ConsentSheet({ onAgree, onClose }) {
  const [terms, setTerms] = useState(false);
  const [privacy, setPrivacy] = useState(false);
  const all = terms && privacy;
  const toggleAll = () => { const v = !all; setTerms(v); setPrivacy(v); };
  return (
    <div className="consent-backdrop" onClick={onClose}>
      <div className="consent-sheet" role="dialog" aria-label="서비스 이용 동의" onClick={e => e.stopPropagation()}>
        <h3 className="consent-title">시작하기 전에 동의가 필요해요</h3>
        <p className="consent-desc">구글 계정으로 로그인하면 타임메모에 가입돼요. 기록은 본인만 볼 수 있어요.</p>
        <ConsentRow checked={all} onChange={toggleAll}><strong>전체 동의</strong></ConsentRow>
        <div className="consent-divider" />
        <ConsentRow checked={terms} onChange={() => setTerms(v => !v)}>
          <em>[필수]</em> <a href="/terms.html?from=consent" onClick={e => e.stopPropagation()}>이용약관</a> 동의
        </ConsentRow>
        <ConsentRow checked={privacy} onChange={() => setPrivacy(v => !v)}>
          <em>[필수]</em> <a href="/privacy.html?from=consent" onClick={e => e.stopPropagation()}>개인정보 수집·이용</a> 동의
          <span className="consent-sub">이메일·이름·기록 내용 / 서비스 제공·AI 회고 생성 / 탈퇴 시까지 보관 · 국외(Supabase·Anthropic 등) 처리 포함</span>
        </ConsentRow>
        <button type="button" className="btn-save consent-btn" disabled={!all} onClick={onAgree}>
          동의하고 구글로 계속하기
        </button>
        <button type="button" className="consent-close" onClick={onClose}>다음에 할게요</button>
      </div>
    </div>
  );
}

function AdminFeedbackList() {
  const [items, setItems] = useState(null); // null = 불러오는 중
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    supabase.rpc('admin_list_feedback').then(({ data, error }) => {
      if (!alive) return;
      if (error) { setFailed(true); setItems([]); return; }
      setItems(data ?? []);
    });
    return () => { alive = false; };
  }, []);

  if (items === null) {
    return <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', margin: 0 }}>불러오는 중...</p>;
  }
  if (failed) {
    return <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', margin: 0 }}>목록을 불러오지 못했어요. (admin_list_feedback 함수가 DB에 있는지 확인)</p>;
  }
  if (items.length === 0) {
    return <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', margin: 0 }}>아직 받은 의견이 없어요.</p>;
  }
  return (
    <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '10px', maxHeight: '50vh', overflowY: 'auto' }}>
      {items.map(f => (
        <li key={f.id} style={{ padding: '10px 12px', background: 'var(--bg-app)', borderRadius: '10px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '4px' }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.user_email || '비로그인'}</span>
            <span style={{ flexShrink: 0 }}>{format(new Date(f.created_at), 'M월 d일 HH:mm')}</span>
          </div>
          <p style={{ margin: 0, fontSize: '0.85rem', lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{f.content}</p>
        </li>
      ))}
    </ul>
  );
}

// ── 블록 구간 계산 (타임블럭 뷰와 위클리 뷰가 함께 쓴다) ──
// 기본은 30분짜리 짧은 블록. 자동으로 이어 붙이면 실제보다 오래 한 것처럼 보여
// 부담을 주기 때문에, 앞뒤로 늘리는 건 기록마다 켜는 선택제다.
const MIN_BLOCK_MINUTES = 30;

// ── 체험 기록이 사라지는 것에 대한 안내 ──────────────────────
// 로그인 안 한 사람의 기록은 브라우저에만 있다. 그런데 사파리는 한동안
// 방문이 없으면 사이트가 저장해둔 걸 지운다. 그래서 일주일 뒤에 돌아온
// 사람은 써둔 게 없어진 화면을 만난다. 홈 화면에 추가한 웹앱은 예외다.
const isIOSDevice = /iP(hone|ad|od)/.test(navigator.userAgent);
const isStandaloneApp = () =>
  window.navigator.standalone === true ||
  window.matchMedia?.('(display-mode: standalone)').matches === true;
// 안내를 띄우기 시작하는 기록 수. 처음부터 띄우면 써보기도 전에 로그인부터
// 권하는 꼴이라, 몇 줄 써서 아까워질 때쯤 알려준다.
const SAVE_NOTICE_AFTER = 3;
const SAVE_NOTICE_KEY = 'timememo-save-notice-dismissed';
// 회고 안내 토스트를 띄운 날 — 뒤에 회고일(yyyy-MM-dd)이 붙는다. 하루에 한 번만 띄운다
const REVIEW_TOAST_PREFIX = 'timememo-review-toast-';
// 오늘 AI 회고를 몇 번 만들었는지 ({ 'yyyy-MM-dd': n }). 호출마다 비용이 나가므로 하루 횟수를 막는다.
// 기기 로컬이라 완벽한 잠금은 아니다 — 진짜 결제 연동을 하면 서버에서 세야 한다.
const SUMMARY_USES_KEY = 'timememo-summary-uses';
// 날짜별 '오늘의 토끼' ({ 'yyyy-MM-dd': rabbitId }). 먼슬리 뷰가 이걸로 한 달을 그린다.
// 기기에 항상 저장하고, 로그인이면 day_rabbits 테이블에도 얹는다 (기기 간 동기화).
const DAY_RABBITS_KEY = 'timememo-day-rabbits';
function readDayRabbits() {
  try {
    const obj = JSON.parse(localStorage.getItem(DAY_RABBITS_KEY) || '{}');
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}
function readSummaryUses() {
  try {
    const obj = JSON.parse(localStorage.getItem(SUMMARY_USES_KEY) || '{}');
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}
// 입력창 플레이스홀더. 입력 필드를 나누지 않고 질문만 돌린다 — 입력 마찰은 이 서비스의 가장 큰 리스크다.
const INPUT_PROMPTS = ['지금 뭐 하고 있어요?', '방금 뭐 끝냈어요?', '지금 어디서 뭐 해요?'];

// 타임블럭은 날짜를 끊지 않고 이어서 스크롤한다.
// 한 번에 그려두는 날짜 수 — 이보다 멀리 가려면 헤더 화살표나 달력을 쓴다.
// 7일이었는데 스크롤로 훑기엔 너무 짧다는 피드백으로 14일로 늘렸다.
// 늘린 만큼 화면 전환이 느려진다(180개 기록 기준 7일 73~125ms, 14일 111~196ms,
// 21일 151~263ms, 30일 217~383ms). 더 늘리려면 이 숫자만 바꾸면 된다.
//
// 예전에는 2일치만 깔아두고 위 끝에 닿을 때마다 3일씩 더 깔았다. 그런데 앞에
// 날짜를 붙이면 보던 자리가 그만큼 밀려서 스크롤을 되돌려줘야 하는데,
// iOS는 관성으로 미끄러지는 중에 스크롤 위치를 바꿔도 무시하고 원래 가려던
// 자리로 계속 간다. 그래서 되돌리기가 먹히지 않고 헤더 날짜가 며칠씩 튀었다.
// 처음부터 다 깔아두면 도중에 앞에 붙일 일이 없어 되돌릴 것도 없다.
const TIMELINE_DAYS_BEFORE = 14;
const TIMELINE_DAYS_AFTER = 1;
const DAY_MINUTES = 24 * 60;
// 스크롤이 멎고 이만큼 지나야 날짜를 확정한다. 관성으로 스쳐 지나간 날짜마다
// 앱 전체를 다시 그리면 스크롤이 걸리고 날짜가 훅훅 지나가는 느낌을 준다.
const DATE_COMMIT_DELAY = 160;

// 끝 시각을 직접 정하지 않고 '다음 기록까지' 자동으로 잇고 있는 상태인지.
// 종료 시각을 직접 저장하면(endMinutes) 그쪽이 이기므로 자동이 아니게 된다.
const isAutoEnd = (memo) => !!memo?.spansToNext && !memo?.endMinutes;
// 시작 시각을 직접 정하지 않고 '이전 기록부터' 자동으로 잇고 있는 상태인지
const isAutoStart = (memo) => !!memo?.spansFromPrev && !memo?.backMinutes;

// 얼마나 걸렸는지가 있는 기록('구간')인지, 그냥 그때 적어둔 한 줄('한 순간')인지.
// 앞뒤로 늘린 흔적이 하나도 없으면 순간이다.
// 순간짜리 메모에까지 시작·종료를 물으면 적을 때마다 쓸데없는 결정을 하게 된다.
const isRangeMemo = (m) => !!m && (
  (m.backMinutes || 0) > 0 || (m.endMinutes || 0) > 0 || !!m.spansFromPrev || !!m.spansToNext
);

// clampDawn: 하루를 잘라서 보여주는 화면(위클리)에서만 켠다.
// 하루짜리 칸에서는 새벽 기록이 전날 밤까지 거슬러 올라가면 칸을 넘쳐버리기 때문에
// 새벽 2시에서 끊어야 했다. 이어서 스크롤하는 타임블럭에서는 그냥 이어지면 되므로 끈다.
function buildDayBlocks(sortedMemos, { dayStartMs, nowMs, gridMinutes, clampDawn = false }) {
  const posOf = (iso) => (new Date(iso).getTime() - dayStartMs) / 60000;
  const blocks = [];

  for (let i = 0; i < sortedMemos.length; i++) {
    const memo = sortedMemos[i];
    const prevMemo = sortedMemos[i - 1];
    const nextMemo = sortedMemos[i + 1];
    const spansNext = !!memo.spansToNext;
    const spansPrev = !!memo.spansFromPrev;
    const backMin = Math.max(0, memo.backMinutes || 0);
    const endMin = Math.max(0, memo.endMinutes || 0);

    const ownPos = posOf(memo.recordedAt);
    const prevPos = prevMemo ? posOf(prevMemo.recordedAt) : null;
    const nextPos = nextMemo ? posOf(nextMemo.recordedAt) : null;

    // 시작 — 직접 고친 값(backMinutes)이 먼저다.
    // 없으면 '이전 기록부터' 자동 규칙(끝나고 남긴 기록)을 따른다.
    let startPos = ownPos;
    if (backMin > 0) {
      startPos = ownPos - backMin;
    } else if (spansPrev) {
      // 이전 기록이 '끝난 데'부터 잇는다. 이전 기록의 끝을 직접 늘려뒀으면(endMinutes)
      // 기록 시각이 아니라 그 늘린 끝이 경계다 — 기록 시각에 붙이면 늘린 구간과 겹친다
      // (블록을 꾹 눌러 옮기거나 끝을 고친 뒤 '이전 기록부터'가 옛 시각에 붙던 버그).
      const prevEndPos = prevPos !== null ? prevPos + Math.max(0, prevMemo.endMinutes || 0) : null;
      startPos = prevEndPos !== null ? Math.min(prevEndPos, ownPos) : ownPos - MIN_BLOCK_MINUTES;
    }
    const startsEarlier = startPos < ownPos;
    if (clampDawn && startsEarlier) {
      // 새벽(00:00~01:59) 기록은 밤의 마지막으로 보고 그 너머까지 거슬러 올라가지 않는다
      if (ownPos >= 120 && startPos < 120) startPos = 120;
    }

    // 끝 — 직접 고친 값(endMinutes)이 먼저다.
    // 없으면 '다음 기록까지' 자동 규칙(다음 기록 시각, 없으면 지금)을 따른다.
    let endPos;
    if (endMin > 0) {
      endPos = ownPos + endMin;
    } else if (spansNext) {
      if (nextPos !== null) {
        // 같은 이유의 거울: 다음 기록이 시작을 직접 당겨뒀으면(backMinutes)
        // 그 당긴 시작 전까지만 잇는다 — 다음 기록 시각까지 가면 겹친다
        endPos = Math.max(ownPos, nextPos - Math.max(0, nextMemo.backMinutes || 0));
      } else {
        const nowPosInDay = (nowMs - dayStartMs) / 60000;
        endPos = (nowPosInDay > ownPos && nowPosInDay < gridMinutes)
          ? nowPosInDay
          : ownPos + MIN_BLOCK_MINUTES;
      }
    } else if (startsEarlier) {
      endPos = ownPos; // 끝나고 남긴 기록이므로 이 기록 시각에서 끝난다
    } else {
      // 다음 기록이 30분 안에 있으면 겹치지 않게 거기까지만
      endPos = ownPos + MIN_BLOCK_MINUTES;
      if (nextPos !== null && nextPos > ownPos) endPos = Math.min(endPos, nextPos);
    }
    if (clampDawn && endPos > ownPos) {
      // 새벽 기록이 새벽 2시를 넘겨 이어지지 않게 자른다
      const dawnCutoff = ownPos < 120 ? 120 : (ownPos >= 1440 && ownPos < gridMinutes ? gridMinutes : null);
      if (dawnCutoff !== null && endPos > dawnCutoff) endPos = dawnCutoff;
    }

    if (endPos < startPos) endPos = startPos;
    startPos = Math.max(startPos, 0);
    endPos = Math.min(endPos, gridMinutes);

    blocks.push({
      memo, prevMemo, nextMemo,
      startPos, endPos, ownPos,
      spansNext, spansPrev, backMin, endMin, startsEarlier,
      // 하루짜리 칸에서 다음날 새벽으로 넘어간 기록 (흐리게). 이어서 그릴 땐 쓰지 않는다
      isCarry: clampDawn && ownPos >= DAY_MINUTES,
    });
  }
  return blocks;
}

// ── 메인 앱 ───────────────────────────────────────────────────
function App() {
  // 비밀번호 재설정 링크로 들어왔는지 판별
  // Site URL 설정에 따라 ?mode=resetPassword 쿼리가 유실될 수 있으므로
  // Supabase가 붙여주는 해시(type=recovery)와 PASSWORD_RECOVERY 이벤트로도 감지한다
  const urlParams = new URLSearchParams(window.location.search);
  const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const [isRecovery, setIsRecovery] = useState(
    urlParams.get('mode') === 'resetPassword' || hashParams.get('type') === 'recovery'
  );

  // Global States
  // 로그인 전이면 브라우저에 담아둔 체험 기록으로 시작한다
  const [memos, setMemos] = useState(loadGuestMemos);
  // 토큰이 갱신되면 서버 데이터를 다시 읽는다 (첫 로드가 만료 토큰으로 실패했을 수 있다)
  const [refetchTick, setRefetchTick] = useState(0);
  const [selectedDate, setSelectedDate] = useState(new Date());
  // 타임블럭이 이어서 그려둔 날짜 창의 기준일. selectedDate가 창을 벗어날 때만 따라온다.
  // (헤더 날짜는 스크롤을 따라 계속 바뀌는데, 그때마다 창을 다시 잡으면 화면이 튄다)
  const [anchorDate, setAnchorDate] = useState(new Date());
  const [inputText, setInputText] = useState('');
  // 입력창 활성화 여부(칩 표시·헤더 접기용)
  const [inputFocused, setInputFocused] = useState(false);
  // 빈 자리를 누른 직후 뜨는 시각 조정 시트. { isRange, dayMs, draftStart, draftEnd, wheel }
  const [slotPick, setSlotPick] = useState(null);
  // 잡힌 시간대를 눌러 여는 조정 시트 (드래그 핸들 + 고급선택 휠). { isRange, start, end, dayMs }
  const [rangeSheet, setRangeSheet] = useState(null);
  const [selectedColor, setSelectedColor] = useState('default');
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [activeView, setActiveView] = useState('timeline'); // 'timeline' | 'settings'

  // Auth States
  const [currentUser, setCurrentUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authView, setAuthView] = useState('login'); // 'login' | 'signup' | 'forgotPassword' | 'emailVerification'
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authConfirmPassword, setAuthConfirmPassword] = useState('');
  const [authError, setAuthError] = useState('');
  const [submittingAuth, setSubmittingAuth] = useState(false);
  const [rememberMe, setRememberMeState] = useState(getRememberMe());
  const [showMyPage, setShowMyPage] = useState(false);
  // 체험 모드: 로그인 전에도 앱을 쓰게 하고, 로그인 화면은 필요할 때만 띄운다
  const [showLogin, setShowLogin] = useState(false);
  // 기록이 이 기기에만 있다는 안내를 닫았는지 (닫으면 다시 안 띄운다)
  const [saveNoticeDismissed, setSaveNoticeDismissed] = useState(
    () => localStorage.getItem(SAVE_NOTICE_KEY) === '1'
  );
  // 로그인 직후 체험 기록을 계정으로 옮기는 중인지
  const [migratingGuest, setMigratingGuest] = useState(false);
  // 체험 모드 = 로그인 안 한 상태. 기록은 브라우저에만 담긴다.
  const isGuest = !currentUser;

  // ── 오늘의 회고(AI) 상태 ───────────────────────────────────
  // key = 날짜 + 당일 기록 내용의 해시. 기록이 늘거나 바뀌면 키가 달라져 '이후 기록이 추가됨'을 안다.
  const [summaryAI, setSummaryAI] = useState({ key: null, status: 'idle', data: null, mock: false });
  const [summaryBusy, setSummaryBusy] = useState(false);
  // 날짜별 토끼: 기기 저장분 + 회고 캐시에 남은 것(백필)을 합쳐서 시작한다
  const [dayRabbits, setDayRabbits] = useState(() => ({ ...collectCachedRabbits(), ...readDayRabbits() }));
  const weekViewedRef = useRef(false);
  const [summaryUses, setSummaryUses] = useState(readSummaryUses);
  const [reviewDayPick, setReviewDayPick] = useState(null); // 회고 탭에서 고른 날 (null=오늘)
  const [showConsent, setShowConsent] = useState(false); // 가입 전 동의 시트
  // 입력창 질문. 질문형이 동사를 유도해 분류가 잘 되게 한다. 보낼 때마다 다음 질문으로 돈다.
  const [promptIdx, setPromptIdx] = useState(() => Math.floor(Math.random() * INPUT_PROMPTS.length));
  // 이번 세션에 '회고를 만들었다 / 오늘의 모양을 봤다'를 날짜별로 기억 (이벤트 중복 방지)
  const summaryGeneratedRef = useRef(new Set());
  const summaryViewedRef = useRef(new Set());
  const [deletingAccount, setDeletingAccount] = useState(false);
  const [forgotEmail, setForgotEmail] = useState('');
  const [forgotEmailSent, setForgotEmailSent] = useState(false);
  const [forgotEmailError, setForgotEmailError] = useState('');

  // 비밀번호 재설정 상태
  const [resetNewPw, setResetNewPw] = useState('');
  const [resetConfirmPw, setResetConfirmPw] = useState('');
  const [resetError, setResetError] = useState('');
  const [resetSuccess, setResetSuccess] = useState(false);
  const [resetSubmitting, setResetSubmitting] = useState(false);

  // 비밀번호 변경 상태
  const [showPasswordChange, setShowPasswordChange] = useState(false);
  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmNewPw, setConfirmNewPw] = useState('');
  const [passwordChangeError, setPasswordChangeError] = useState('');
  const [passwordChangeSuccess, setPasswordChangeSuccess] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);

  // 기록 편집 시트 — 채팅창과 타임블럭이 같은 것을 쓴다.
  // 시각을 눌렀을 때와 내용을 눌렀을 때가 다르면 두 화면 사이를 왔다갔다 하게 되므로
  // 내용·색상·날짜·시작/종료·삭제를 한 곳에 모아둔다.
  const [editingMemo, setEditingMemo] = useState(null);
  const [editContentStr, setEditContentStr] = useState('');
  const [editMemoColor, setEditMemoColor] = useState('default');
  const [editDateStr, setEditDateStr] = useState('');   // yyyy-MM-dd
  const [editStartStr, setEditStartStr] = useState(''); // HH:mm
  const [editEndStr, setEditEndStr] = useState('');     // HH:mm
  // 'moment' = 한 순간 (시각 하나) | 'range' = 구간 (시작~종료)
  const [editMode, setEditMode] = useState('moment');
  // 자동 잇기 체크박스도 초안이다 — 저장을 눌러야 반영된다.
  // (예전엔 누르는 즉시 저장돼서, 배경을 눌러 '취소'해도 이미 바뀌어 있었다)
  const [editSpansFromPrev, setEditSpansFromPrev] = useState(false);
  const [editSpansToNext, setEditSpansToNext] = useState(false);
  // 열었을 때의 시각 값. 사용자가 시간을 건드리지 않았으면 저장할 때 시간 관련
  // 필드를 아예 손대지 않는다 (자동으로 이어지던 설정이 조용히 고정값으로 굳는 걸 막는다)
  const [editInitial, setEditInitial] = useState(null);
  // 시간 휠이 지금 어느 칸(시작/종료)을 고치고 있는지
  const [openTimeWheel, setOpenTimeWheel] = useState(null); // 'start' | 'end' | null
  // 온보딩 (첫 방문 안내)
  // 투어(움직이는 온보딩). active 동안 memos는 샘플로 바뀌고 끝나면 원래대로 돌아온다.
  // contIso: 투어 중 '이어서'로 저장한 진짜 기록의 시각 — 시간표에서 그 블록을 강조할 때 쓴다
  const [tour, setTour] = useState({ active: false, step: 0, aiStatus: 'idle', contIso: null });
  const [showSplash, setShowSplash] = useState(false);
  const appContainerRef = useRef(null);
  // 꾹 눌러 순서 옮기기 (채팅창)
  const [draggingMemoId, setDraggingMemoId] = useState(null);
  const [reorderDrop, setReorderDrop] = useState(null); // 이 기록 앞에 놓는다 (id) | 'end' | null
  const reorderRef = useRef(null);
  // 옮긴 직후 뜨는 시각 확정 시트 — 휠로 시각을 다듬고 확정해야 옮기기가 끝난다.
  // (자동으로 잡힌 시각을 그냥 믿게 두면 몇 시가 됐는지 모른 채 지나간다)
  const [moveConfirm, setMoveConfirm] = useState(null);
  // 확정한 뒤에도 마음을 바꿀 수 있게 잠깐 띄우는 되돌리기 토스트
  const [moveUndoToast, setMoveUndoToast] = useState(null); // { memoId, prev, timer }
  // 타임블럭 블록 꾹 눌러 이동 — 드래그 중에는 리렌더 없이 DOM에 직접 그린다
  // (14일치 판을 손가락 따라 매번 다시 그리면 뚝뚝 끊긴다)
  const scheduleDragRef = useRef(null);
  const schedulePxMapRef = useRef(null); // 최신 렌더의 시간 ↔ 픽셀 변환
  const scheduleBadgeRef = useRef(null); // 드래그 중 놓일 시각을 보여주는 배지
  const scheduleSuppressClickRef = useRef(false);
  const [showCalendar, setShowCalendar] = useState(false);
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [showScheduleView, setShowScheduleView] = useState(false);
  // 할 일 리스트 (날짜에 묶지 않는다 — 이월도 독촉도 없음)
  const [todos, setTodos] = useState([]);
  const [showTodoSheet, setShowTodoSheet] = useState(false);
  const [todoInput, setTodoInput] = useState('');

  // Undo Toast
  const [undoToast, setUndoToast] = useState(null); // { memo, timer }
  // 회고 안내 토스트 — 기록이 회고 가능 개수(SUMMARY_MIN_RECORDS)에 닿으면 하루 한 번
  const [reviewToast, setReviewToast] = useState(null); // { timer }
  useEffect(() => {
    if (activeView !== 'timeline') return;
    // 투어 중에는 샘플로 개수가 차므로 여기서 세지 않는다 — 투어가 제 토스트를 따로 띄운다
    if (tour.active) return;
    // 새벽 2시 규칙과 같은 기준으로 '지금 채우고 있는 하루'의 기록을 센다
    const key = reviewKeyOf(new Date());
    const count = memos.filter(m => reviewKeyOf(new Date(m.recordedAt)) === key).length;
    if (count < SUMMARY_MIN_RECORDS) return;
    const storageKey = REVIEW_TOAST_PREFIX + key;
    if (localStorage.getItem(storageKey) === '1') return;
    try { localStorage.setItem(storageKey, '1'); } catch { /* 무시 */ }
    track('Review Toast Shown', { memo_count: count });
    const timer = setTimeout(() => setReviewToast(null), 8000);
    setReviewToast(prev => { if (prev?.timer) clearTimeout(prev.timer); return { timer }; });
  }, [memos, activeView]);
  const openReviewFromToast = () => {
    setReviewToast(prev => { if (prev?.timer) clearTimeout(prev.timer); return null; });
    track('Review Toast Click');
    setActiveView('review');
  };

  // Settings (habit keywords)
  const [habitKeywords, setHabitKeywords] = useState([]);
  const [newKeyword, setNewKeyword] = useState('');
  const [newKeywordColor, setNewKeywordColor] = useState('purple');
  // 키워드 관리 모달: 모달 안에서 수정하고 저장을 눌러야 반영됨
  const [showKeywordModal, setShowKeywordModal] = useState(false);
  const [draftKeywords, setDraftKeywords] = useState([]);
  const [deletingKeyword, setDeletingKeyword] = useState(null);

  const timelineRef = useRef(null);
  const inputRef = useRef(null);
  const scrollPositionRef = useRef(null);
  const justAddedRef = useRef(null); // 방금 등록한 기록의 recorded_at — 그 자리로 화면을 옮긴다


  // ── 순서 옮기는 동안 화면 스크롤을 멈춘다 ────────────────────
  // touch-action은 제스처 시작 시점에 정해져 도중에 못 바꾸므로,
  // 드래그 중에만 touchmove 기본 동작을 직접 막는다.
  useEffect(() => {
    if (!draggingMemoId) return;
    const prevent = (e) => e.preventDefault();
    window.addEventListener('touchmove', prevent, { passive: false });
    return () => window.removeEventListener('touchmove', prevent);
  }, [draggingMemoId]);

  // ── 현재 시간 (스케줄 뷰 빨간 줄 등) 1분마다 갱신 ─────────────
  const [nowTime, setNowTime] = useState(new Date());
  useEffect(() => {
    const interval = setInterval(() => setNowTime(new Date()), 60000);
    return () => clearInterval(interval);
  }, []);

  // 타임블럭 스크롤러 — 자리 잡기는 아래 자동 스크롤 effect가 맡는다
  const scheduleViewRef = useRef(null);

  // ── 모바일: 입력창에 포커스되면(키보드 올라오면) 하단 네비 숨김 ─
  useEffect(() => {
    if (!window.matchMedia('(pointer: coarse)').matches) return; // 터치 기기에서만
    const isTextField = (el) =>
      el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'submit'].includes(el.type)));
    const onFocusIn = (e) => {
      if (isTextField(e.target)) document.body.classList.add('keyboard-open');
    };
    const onFocusOut = () => {
      setTimeout(() => {
        if (!isTextField(document.activeElement)) document.body.classList.remove('keyboard-open');
      }, 50);
    };
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    return () => {
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
      document.body.classList.remove('keyboard-open');
    };
  }, []);

  // ── 자정 자동 날짜 전환 ──────────────────────────────────────
  useEffect(() => {
    const interval = setInterval(() => {
      const now = new Date();
      setSelectedDate(prev => {
        if (isToday(prev)) {
          // 오늘을 보고 있었는데 날짜가 바뀌면 새 날짜로.
          // 이어서 그리는 창도 새 날을 품도록 같이 옮긴다
          if (!isSameDay(prev, now)) {
            setAnchorDate(now);
            return now;
          }
        }
        return prev;
      });
    }, 30000); // 30초마다 체크
    return () => clearInterval(interval);
  }, []);

  // ── Auth 상태 변화 감지 ───────────────────────────────────────
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setCurrentUser(session?.user ?? null);
      if (session?.user) identifyUser(session.user);
      setAuthLoading(false);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      // 재설정 링크 클릭 시 임시 로그인되므로, 홈이 아니라 새 비밀번호 화면을 띄운다
      if (event === 'PASSWORD_RECOVERY') setIsRecovery(true);
      if (session?.user) {
        identifyUser(session.user);
        // 구글 로그인은 첫 로그인이 곧 가입이라 가입 시점을 따로 잡을 데가 없다.
        // 계정이 만들어진 지 1분 안이면 방금 가입한 것으로 본다.
        // (이메일 가입은 인증 메일을 거쳐 한참 뒤에 로그인되므로 여기서 안 잡고 가입 폼에서 직접 보낸다)
        const provider = session.user.app_metadata?.provider;
        const justCreated = Date.now() - new Date(session.user.created_at).getTime() < 60000;
        if (event === 'SIGNED_IN' && provider === 'google' && justCreated) {
          track('Signed Up', { method: 'google' });
        }
      } else if (event === 'SIGNED_OUT') {
        resetUser();
      }
      if (event === 'TOKEN_REFRESHED') setRefetchTick(t => t + 1);
      setCurrentUser(session?.user ?? null);
      // 로그아웃하면 체험 모드로 돌아간다 (보통은 비어 있다)
      if (!session?.user) setMemos(loadGuestMemos());
      setAuthLoading(false);
    });
    return () => subscription.unsubscribe();
  }, []);

  // ── 화면 이동 기록 ───────────────────────────────────────────
  // 탭 버튼마다 심지 않고 상태 변화를 한 곳에서 본다.
  // 먼슬리 날짜를 눌러 스케줄로 들어가는 것처럼 버튼을 안 거치는 경로까지 같이 잡힌다.
  const lastScreenRef = useRef(null);
  useEffect(() => {
    // 로그인 화면을 보고 있는 동안은 세지 않는다 (앱 화면을 본 게 아니다)
    if (showLogin) return;
    const screen =
      activeView === 'timeline'
        ? (showScheduleView ? 'timeline_schedule' : 'timeline_chat')
        : activeView === 'settings' ? 'mypage' : activeView;
    if (lastScreenRef.current === screen) return;
    // 체험 중 조회와 로그인 후 조회는 성격이 달라 구분해서 남긴다
    track('Screen Viewed', { screen, previous_screen: lastScreenRef.current, guest: isGuest });
    lastScreenRef.current = screen;
  }, [isGuest, showLogin, activeView, showScheduleView]);

  // ── 메모 불러오기 + 실시간 동기화 ────────────────────────────
  const userId = currentUser?.id;
  // 체험 기록 한 건의 값을 바꾼다 (서버 update 자리에 들어가는 대역)
  const patchGuestRow = (id, patch) => {
    saveGuestRows(loadGuestRows().map(r => (r.id === id ? { ...r, ...patch } : r)));
  };
  useEffect(() => {
    // 체험 모드에는 서버가 없다. 기록은 state 초기값과 로그아웃 시점에 채운다.
    if (!userId) return;

    const sortByTime = (list) => [...list].sort((a, b) => new Date(a.recordedAt) - new Date(b.recordedAt));

    const fetchMemos = async () => {
      const { data, error } = await fetchWithRetry(() => supabase
        .from('memos')
        .select('*')
        .order('recorded_at', { ascending: true }));
      if (error) {
        console.error('Error fetching memos:', error);
        return;
      }
      setMemos(data.map(rowToMemo));
    };
    fetchMemos();

    const channel = supabase
      .channel('memos-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'memos', filter: `user_id=eq.${userId}` }, (payload) => {
        if (payload.eventType === 'INSERT') {
          const memo = rowToMemo(payload.new);
          setMemos(prev => prev.some(m => m.id === memo.id) ? prev : sortByTime([...prev, memo]));
        } else if (payload.eventType === 'UPDATE') {
          const memo = rowToMemo(payload.new);
          setMemos(prev => sortByTime(prev.map(m => (m.id === memo.id ? memo : m))));
        } else if (payload.eventType === 'DELETE') {
          setMemos(prev => prev.filter(m => m.id !== payload.old.id));
        }
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [userId, refetchTick]);

  // ── 체험 기록을 계정으로 옮기기 ──────────────────────────────
  // 로그인하고 나서 써둔 게 사라지면 로그인 벽보다 나쁜 경험이 된다.
  // 그래서 로그인 직후 딱 한 번, 브라우저에 담긴 걸 계정으로 올린다.
  useEffect(() => {
    if (!userId) return;
    const rows = loadGuestRows();
    if (rows.length === 0) return;

    let cancelled = false;
    (async () => {
      setMigratingGuest(true);
      const payload = rows.map(r => ({
        user_id: userId,
        content: r.content,
        color: r.color ?? 'default',
        recorded_at: r.recorded_at,
        spans_from_prev: r.spans_from_prev ?? false,
        spans_to_next: r.spans_to_next ?? false,
        back_minutes: r.back_minutes ?? 0,
        category: r.category ?? null,
      }));
      const { error } = await supabase.from('memos').insert(payload);
      if (error) {
        // 실패하면 체험 기록을 지우지 않는다. 다음 로그인 때 다시 시도할 수 있어야 한다.
        console.error('체험 기록 이관 실패:', error);
        if (!cancelled) setMigratingGuest(false);
        return;
      }
      clearGuestRows();
      track('Guest Memos Migrated', { count: payload.length });

      // 임시 id로 들고 있던 화면 상태를 서버 기준으로 다시 맞춘다
      const { data } = await supabase.from('memos').select('*').order('recorded_at', { ascending: true });
      if (cancelled) return;
      if (data) setMemos(data.map(rowToMemo));
      setMigratingGuest(false);
    })();

    return () => { cancelled = true; };
  }, [userId]);

  // ── Settings 불러오기 ────────────────────────────────────────
  useEffect(() => {
    if (!userId) return;
    const loadSettings = async () => {
      const { data, error } = await supabase
        .from('settings')
        .select('habit_keywords')
        .eq('user_id', userId)
        .maybeSingle();
      if (error) {
        console.error('Error loading settings:', error);
        return;
      }
      if (data?.habit_keywords && Array.isArray(data.habit_keywords)) {
        setHabitKeywords(data.habit_keywords);
      }
    };
    loadSettings();
  }, [userId]);

  // ── 할 일 불러오기 ──────────────────────────────────────────
  useEffect(() => {
    if (!userId) return;

    const fetchTodos = async () => {
      const { data, error } = await fetchWithRetry(() => supabase.from('todos').select('*'));
      if (error) {
        console.error('Error fetching todos:', error);
        return;
      }
      setTodos(sortTodos(data));
    };
    fetchTodos();

    const channel = supabase
      .channel('todos-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'todos', filter: `user_id=eq.${userId}` }, (payload) => {
        if (payload.eventType === 'INSERT') {
          setTodos(prev => prev.some(t => t.id === payload.new.id) ? prev : sortTodos([...prev, payload.new]));
        } else if (payload.eventType === 'UPDATE') {
          setTodos(prev => sortTodos(prev.map(t => (t.id === payload.new.id ? payload.new : t))));
        } else if (payload.eventType === 'DELETE') {
          setTodos(prev => prev.filter(t => t.id !== payload.old.id));
        }
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [userId, refetchTick]);

  // ── 입력 포커스 (터치 기기에서는 키보드가 멋대로 안 뜨게 제외) ─
  useEffect(() => {
    if (currentUser && activeView === 'timeline' && !IS_TOUCH_DEVICE) {
      inputRef.current?.focus();
    }
    // selectedDate는 이제 스크롤을 따라 계속 바뀌므로 여기 넣지 않는다.
    // 넣으면 훑어볼 때마다 입력창이 포커스를 뺏어간다.
  }, [currentUser, activeView]);

  // ── 새 메모를 남기면 그게 보이도록 아래로, 삭제 후에는 보던 자리로 ──
  // 예전에는 selectedDate가 바뀔 때도 맨 아래로 보냈다. 이제 selectedDate는
  // 스크롤을 따라 바뀌므로, 그대로 두면 위로 훑을 때마다 아래로 되돌려버린다.
  const prevMemoCount = useRef(memos.length);
  useEffect(() => {
    // 보고 있는 뷰의 스크롤 상자. 채팅뷰는 timelineRef, 시간표뷰는 scheduleViewRef.
    // (채팅 상자는 시간표뷰에서 렌더되지 않아 null이다 — 여기서 걸러 return하면
    //  시간표뷰에선 등록 후 스크롤이 아예 안 돌던 버그가 있었다)
    const chatEl = timelineRef.current;
    const el = showScheduleView ? scheduleViewRef.current : chatEl;
    const prevCount = prevMemoCount.current;
    prevMemoCount.current = memos.length;
    if (!el) return;
    if (scrollPositionRef.current !== null && chatEl) {
      chatEl.scrollTop = scrollPositionRef.current; // 삭제 후 위치 복원 (채팅뷰)
      scrollPositionRef.current = null;
      return;
    }
    if (memos.length > prevCount) {
      // 방금 등록한 기록이면 그 자리로 화면을 옮긴다 (시간 지정·시간표 등록은 맨 아래가 아닐 수 있다).
      // 채팅뷰·시간표뷰 모두 요소에 data-at(=recorded_at)이 있어 같은 방식으로 찾는다.
      // 다음 프레임에 옮긴다 — 시간표는 이 기록으로 시간축이 늘어나며 레이아웃이 한 번 더 바뀌므로,
      // 그 자리 계산은 정착된 뒤라야 맞다.
      const iso = justAddedRef.current;
      justAddedRef.current = null;
      if (iso) {
        // 시각·내용은 블록(또는 말풍선) 맨 위에 있다. 블록의 '위 가장자리'를 화면 상단 근처로
        // 올려야 긴 구간이어도 "몇 시에 뭘 했는지"가 잘리지 않는다.
        // scrollTop 직접 계산은 판 높이가 바뀌는 도중에 어긋나므로, 위 가장자리를 기준으로
        // 스크롤하는 scrollIntoView(block:'start')에 맡기고, 아래로 조금(64px) 여백을 준다.
        const doScroll = () => {
          const scroller = showScheduleView ? scheduleViewRef.current : timelineRef.current;
          const target = scroller?.querySelector(`[data-at="${iso}"]`);
          if (!target || !scroller) return;
          const sr = scroller.getBoundingClientRect();
          const tr = target.getBoundingClientRect();
          // 블록 위 가장자리를 상자 위에서 96px 아래에 둔다 — 시각·내용 줄이 경계에 잘리지 않게
          // 넉넉히 띄운다. (scrollIntoView는 iOS에서 바깥 컨테이너까지 밀어 잘렸다)
          scroller.scrollTop = Math.max(0, scroller.scrollTop + (tr.top - sr.top) - 96);
          // 이 스크롤을 '확정 위치'로 못박는다. 안 그러면 스크롤에 반응하는 날짜 커밋과
          // 자동 정렬이 뒤늦게 끼어들어 방금 맞춘 자리를 다시 옮겨('됐다 안됐다') 버린다.
          clearTimeout(dateCommitTimerRef.current);
          if (showScheduleView) {
            autoScrollKeyRef.current = `${showScheduleView}|${memos.length > 0}|${format(effectiveAnchor, 'yyyy-MM-dd')}`;
            autoScrollRef.current = { view: showScheduleView, top: scroller.scrollTop };
            lastScrollTopRef.current = scroller.scrollTop;
          }
        };
        // 시간표뷰는 등록과 동시에 키보드가 내려가며 판 높이가 계속 바뀐다.
        // 정착 시점을 하나로 못 잡으므로 몇 번에 걸쳐 다시 맞춘다(같은 자리로 가는 것이라 안전).
        if (showScheduleView) [150, 400, 650].forEach(d => setTimeout(doScroll, d));
        else requestAnimationFrame(doScroll);
        return;
      }
      // (여기까지 왔으면 iso가 없는 경우 — 이론상 잘 안 온다) 채팅뷰면 맨 아래로.
      if (!showScheduleView && chatEl) {
        const spacer = chatEl.querySelector('.timeline-bottom-space');
        chatEl.scrollTop = Math.max(0, chatEl.scrollHeight - chatEl.clientHeight - (spacer?.offsetHeight ?? 0) + 28);
      }
    }
  }, [memos, showScheduleView]);

  const selectedDayStartMs = new Date(
    selectedDate.getFullYear(), selectedDate.getMonth(), selectedDate.getDate()
  ).getTime();
  // 잡힌 시간 영역 — 시간표뷰에서 등록 전에 미리 띠로 보여준다.
  // 시간 조정 시트(slotPick)가 열려 있으면 그 휠 값으로 라이브 표시, 아니면 입력창 앞머리에서.
  const hmToMin = (str) => { const [h, mi] = str.split(':').map(Number); return h * 60 + mi; };
  const pendingSpan = (() => {
    if (!showScheduleView) return null;
    if (slotPick) {
      const start = hmToMin(slotPick.draftStart);
      let end = slotPick.isRange ? hmToMin(slotPick.draftEnd) : null;
      if (end != null && end <= start) end += 1440;
      return { start, end, dayMs: slotPick.dayMs };
    }
    const t = parseTimeSpan(inputText, nowTime);
    return t ? { ...t, dayMs: selectedDayStartMs } : null;
  })();
  const pendingKey = pendingSpan ? `${pendingSpan.start}-${pendingSpan.end}-${pendingSpan.dayMs}-${!!slotPick}` : null;
  // 잡힌 시간 영역이 생기거나 바뀌면 그 띠를 화면에 보여준다 (등록 전에).
  // 이러면 등록해도 블록이 이미 보이던 자리에 나타나 화면이 안 튄다.
  useEffect(() => {
    if (!showScheduleView || !pendingKey) return;
    const doScroll = () => {
      const sc = scheduleViewRef.current;
      const band = sc?.querySelector('.schedule-pending-band');
      if (!sc || !band) return;
      const sr = sc.getBoundingClientRect();
      const br = band.getBoundingClientRect();
      // 이미 위쪽에 잘 보이면 건드리지 않는다 (타이핑 중 계속 튕기지 않게)
      if (br.top >= sr.top + 72 && br.top <= sr.bottom - 100) return;
      sc.scrollTop = Math.max(0, sc.scrollTop + (br.top - sr.top) - 96);
    };
    // 헤더 접힘·키보드 오르내림으로 판 높이가 바뀌므로 몇 번에 걸쳐 맞춘다
    const timers = [60, 260, 500].map(d => setTimeout(doScroll, d));
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showScheduleView, pendingKey]);

  // ── 모바일 Visual Viewport ───────────────────────────────────
  useEffect(() => {
    // 키보드가 올라오는 '도중'에도 이벤트가 오는데, 그때 값으로 높이를 잡으면
    // 앱이 실제 보이는 영역보다 짧아져서 아래에 회색 띠가 남는다.
    // 그래서 애니메이션이 끝났을 즈음 한 번 더 맞춘다.
    const applyVh = () => {
      if (!window.visualViewport) return;
      document.documentElement.style.setProperty('--vh', `${window.visualViewport.height}px`);
    };
    let settle = null;
    const handleResize = () => {
      if (!window.visualViewport) return;
      // 키보드가 올라와 화면이 줄어들 때, 채팅창 바닥 근처를 보고 있었다면 그 자리를 지킨다.
      // 안 지키면 화면이 줄어든 만큼 마지막 기록이 입력창 밑으로 숨는다.
      const chat = timelineRef.current;
      const fromBottom = chat ? chat.scrollHeight - chat.clientHeight - chat.scrollTop : null;
      applyVh();
      if (chat && fromBottom != null && fromBottom < 200) {
        chat.scrollTop = chat.scrollHeight - chat.clientHeight - fromBottom;
      }
      window.scrollTo(0, 0);
      clearTimeout(settle);
      settle = setTimeout(() => {
        applyVh();
        if (chat && fromBottom != null && fromBottom < 200) {
          chat.scrollTop = chat.scrollHeight - chat.clientHeight - fromBottom;
        }
      }, 300);
    };
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', handleResize);
      window.visualViewport.addEventListener('scroll', handleResize);
      handleResize();
    }
    return () => {
      clearTimeout(settle);
      if (window.visualViewport) {
        window.visualViewport.removeEventListener('resize', handleResize);
        window.visualViewport.removeEventListener('scroll', handleResize);
      }
    };
  }, []);


  const displayedMemos = memos.filter(m => isSameDay(new Date(m.recordedAt), selectedDate));

  // 다음날 자정~새벽 2시 메모: 전날 채팅창에도 흐리게 함께 표시
  const lateNightMemos = memos.filter(m => {
    const min = (new Date(m.recordedAt).getTime() - selectedDayStartMs) / 60000;
    return min >= DAY_MINUTES && min < DAY_MINUTES + 120; // 다음날 00:00 ~ 01:59
  });
  // 채팅창은 고른 날짜 하루만 보여준다. 헤더 날짜와 화면 내용이 어긋나면 안 된다.
  const chatMemos = [...displayedMemos, ...lateNightMemos];
  // ── 오늘의 회고 ──────────────────────────────────────────────
  // 대상은 항상 '오늘'이다 (헤더에서 고른 날짜가 아니라). 오늘의 모양(1)과 다음(4)은 여기서
  // 바로 계산하고, 시간 배분(2)·눈에 띈 것(3)은 회고 탭에서 사용자가 버튼을 눌렀을 때만 만든다.
  // 기록이 어느 날 회고에 들어가는지는 새벽 2시 경계(daySummary.reviewKeyOf)로 정한다.
  // 자정~01:59 기록은 전날의 끝이라 전날 회고에 들어간다.
  // '오늘'은 달력 날짜다 (새벽 1시여도 오늘은 24일). 새벽 2시 경계는 "자정~01:59 기록은 전날 회고에
  // 들어간다"에만 쓴다 — 그래서 새벽 1시의 24일 회고는 비어 있고, ‹로 23일에 가면 방금 쓴 기록이 들어 있다.
  const todayKey = dateKeyOf(nowTime);
  const todayReviewDate = new Date(nowTime.getFullYear(), nowTime.getMonth(), nowTime.getDate());
  // 회고 탭에서 보고 있는 날. null = 오늘. 지난 날로 넘기면 그 날의 회고를 본다.
  // 횟수 제한은 언제나 '오늘' 기준으로 센다 — 지난 날 회고를 만들어도 오늘 횟수가 깎인다.
  const reviewDay = reviewDayPick ?? todayReviewDate;
  const reviewKey = dateKeyOf(reviewDay);
  const reviewIsToday = reviewKey === todayKey;
  const todayMemos = memos
    .filter(m => reviewKeyOf(new Date(m.recordedAt)) === reviewKey)
    .sort((a, b) => new Date(a.recordedAt) - new Date(b.recordedAt));
  // 다음날 자정~새벽 2시 기록이 이 하루에 들어가 있을 때만 "어느 날 · 새벽 2시까지"를 적어 준다.
  // (그런 기록이 없으면 달력 날짜와 같으니 따로 말할 게 없다)
  const hasDawnTail = todayMemos.some(m => !isSameDay(new Date(m.recordedAt), reviewDay));
  const todayLabel = hasDawnTail ? `${format(reviewDay, 'M월 d일 (E)', { locale: ko })} · 새벽 2시까지` : null;
  // 지난 날은 그 하루의 끝(다음날 01:59)을 '지금'으로 삼아 마지막 기록의 길이를 잰다
  const reviewDayEnd = reviewIsToday
    ? nowTime
    : new Date(reviewDay.getFullYear(), reviewDay.getMonth(), reviewDay.getDate() + 1, 1, 59);
  const todayFacts = todayMemos.length > 0 ? buildDayFacts(todayMemos, memos, reviewDayEnd, { past: !reviewIsToday }) : null;
  const weekFacts = buildWeekFacts(memos, nowTime);
  const todayRecords = todayFacts ? toSummaryRecords(todayMemos) : null;
  const summaryKey = todayRecords ? summaryCacheKey(reviewKey, todayRecords) : null;
  const summaryUsesLeft = Math.max(0, SUMMARY_DAILY_LIMIT - (summaryUses[todayKey] || 0));
  const canGenerate = Boolean(summaryKey) && todayMemos.length >= SUMMARY_MIN_RECORDS && summaryUsesLeft > 0;
  const pickReviewDay = (day) => {
    if (dateKeyOf(day) > todayKey) return;
    setReviewDayPick(dateKeyOf(day) === todayKey ? null : day);
  };
  // 헤더가 보여주는 날짜: 회고 탭은 보고 있는 회고일, 나머지는 타임라인 날짜
  const headerDate = activeView === 'review' ? reviewDay : selectedDate;
  // 자정을 넘기면 '오늘'을 보고 있던 타임라인은 새 오늘로 따라간다 (앱을 켜둔 채 날이 바뀌는 경우).
  // 일부러 지난 날짜를 보고 있었으면 그대로 둔다.
  const lastTodayKeyRef = useRef(todayKey);
  useEffect(() => {
    const prevKey = lastTodayKeyRef.current;
    if (prevKey === todayKey) return;
    lastTodayKeyRef.current = todayKey;
    if (dateKeyOf(selectedDate) === prevKey) {
      const id = setTimeout(() => setSelectedDate(new Date(nowTime.getFullYear(), nowTime.getMonth(), nowTime.getDate())), 0);
      return () => clearTimeout(id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [todayKey]);
  const memoDayKeys = new Set(memos.map(m => dateKeyOf(new Date(m.recordedAt))));

  // 약관·방침 전문을 보고 '/?consent=1'로 돌아온 사람은 동의 시트를 다시 띄운다
  useEffect(() => {
    if (authLoading) return;
    if (!consentReturnRequested()) return;
    try { window.history.replaceState(null, '', '/'); } catch { /* 무시 */ }
    if (currentUser) return;
    const id = setTimeout(() => { setShowLogin(true); setShowConsent(true); }, 0);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading]);

  // 기기에 남긴 동의 시각을 계정에도 적어 둔다 (한 번만). 동의 증빙은 서버에 있어야 한다.
  useEffect(() => {
    if (!currentUser) return;
    let local = null;
    try { local = JSON.parse(localStorage.getItem(CONSENT_KEY) || 'null'); } catch { /* 무시 */ }
    if (!local?.at) return;
    let alive = true;
    supabase.from('settings').select('consent_at').eq('user_id', currentUser.id).maybeSingle().then(({ data, error }) => {
      if (!alive || error || data?.consent_at) return;
      supabase.from('settings').upsert({ user_id: currentUser.id, consent_at: local.at, consent_version: local.version ?? null, updated_at: new Date().toISOString() })
        .then(({ error: e }) => { if (e) console.error('Error saving consent:', e); });
    });
    return () => { alive = false; };
  }, [currentUser]);

  // 회고 탭에 넘길 AI 상태. 같은 키면 그대로, 오늘 것인데 키가 달라졌으면 '이후 기록 추가됨'으로 표시.
  const summaryForScreen =
    !summaryAI.key ? { status: 'idle' }
      : summaryAI.key === summaryKey ? summaryAI
      : (summaryAI.status === 'ok' && summaryAI.key.startsWith(`${reviewKey}|`)) ? { ...summaryAI, stale: true }
      : { status: 'idle' };

  // 회고 탭을 나가면 보던 날짜를 오늘로 되돌린다 (다음에 들어올 때 늘 오늘부터)
  useEffect(() => {
    if (activeView === 'review') return;
    const id = setTimeout(() => setReviewDayPick(null), 0);
    return () => clearTimeout(id);
  }, [activeView]);

  // 앱을 다시 열었을 때: 이미 만들어 둔 이 날의 회고를 보여준다.
  // 1순위 기기 캐시(빠름), 없으면 서버(day_reviews — 다른 기기에서 만들었거나 캐시가 밀려난 경우).
  // 매칭된 키를 그대로 쓴다 — 만들고 나서 기록을 더 썼다면 키가 달라져 있고,
  // 그러면 화면이 '이후에 기록이 더 추가됐어요 + 다시 만들기'를 알아서 띄운다.
  useEffect(() => {
    if (activeView !== 'review' || !summaryKey || isGuest) return;
    const day = summaryKey.split('|')[0];
    const applyResult = (key, data, mock) => {
      setSummaryAI(prev => {
        // 이 날의 결과가 이미 화면 상태에 있으면 그대로 둔다 (방금 만든 결과를 덮지 않는다)
        if (prev.status === 'ok' && typeof prev.key === 'string' && prev.key.startsWith(`${day}|`)) return prev;
        return { key, status: 'ok', data, mock };
      });
    };
    const cached = peekSummaryCache(summaryKey);
    if (cached) {
      const id = setTimeout(() => applyResult(cached.key ?? summaryKey, cached.data, cached.mock), 0);
      return () => clearTimeout(id);
    }
    let alive = true;
    supabase.from('day_reviews').select('data, cache_key').eq('day', day).maybeSingle().then(({ data: row, error }) => {
      if (!alive || error || !row?.data) return;
      const clean = normalizeSummary(row.data);
      if (clean) applyResult(row.cache_key || `${day}|server`, clean, false);
    });
    return () => { alive = false; };
  }, [activeView, summaryKey, isGuest]);

  // 로그인하면 기기 캐시에만 있던 회고들을 서버로 올려 영구 보관한다 (이미 있는 날짜는 건드리지 않는다)
  useEffect(() => {
    if (!userId) return;
    const entries = collectCachedSummaries();
    if (entries.length === 0) return;
    supabase.from('day_reviews')
      .upsert(
        entries.map(e => ({ user_id: userId, day: e.day, data: e.data, cache_key: e.key })),
        { onConflict: 'user_id,day', ignoreDuplicates: true }
      )
      .then(({ error }) => { if (error) console.error('Error syncing cached reviews:', error); });
  }, [userId]);

  // 기록 하나의 카테고리를 바꿔 저장한다 (체험이면 기기, 아니면 서버). 본문은 건드리지 않는다.
  // 그날의 토끼를 저장한다. 기기에 먼저, 로그인이면 서버에도.
  const saveDayRabbit = (dayKey, type) => {
    setDayRabbits(prev => {
      if (prev[dayKey] === type) return prev;
      const next = { ...prev, [dayKey]: type };
      try { localStorage.setItem(DAY_RABBITS_KEY, JSON.stringify(next)); } catch { /* 무시 */ }
      return next;
    });
    if (currentUser) {
      supabase.from('day_rabbits')
        .upsert({ user_id: currentUser.id, day: dayKey, rabbit: type, updated_at: new Date().toISOString() })
        .then(({ error }) => { if (error) console.error('Error saving day rabbit:', error); });
    }
  };

  // 로그인하면 서버에 쌓인 날짜별 토끼를 내려받아 합친다 (다른 기기에서 만든 것 포함)
  useEffect(() => {
    if (!userId) return;
    let alive = true;
    supabase.from('day_rabbits').select('day, rabbit').limit(500).then(({ data, error }) => {
      if (!alive || error || !Array.isArray(data)) return;
      setDayRabbits(prev => {
        const next = { ...prev };
        for (const r of data) if (r?.day && typeof r.rabbit === 'string') next[r.day] = r.rabbit;
        try { localStorage.setItem(DAY_RABBITS_KEY, JSON.stringify(next)); } catch { /* 무시 */ }
        return next;
      });
    });
    return () => { alive = false; };
  }, [userId]);

  const generateSummary = async () => {
    if (!canGenerate || isGuest || summaryBusy) return;
    const key = summaryKey;
    const records = todayRecords;
    const regenerate = summaryGeneratedRef.current.has(reviewKey);
    const facts = {
      count: todayFacts.count,
      spanMinutes: todayFacts.spanMinutes,
      peakHour: todayFacts.peak?.hour ?? null,
      streak: todayFacts.streak,
      recordDays: todayFacts.recordDays,
    };
    setSummaryBusy(true);
    setSummaryAI({ key, status: 'loading', data: null, mock: false, startedAt: Date.now() });
    const startedAt = Date.now();
    try {
      const { data, mock, fromCache } = await requestDaySummary({
        dateKey: reviewKey,
        records,
        facts,
      });
      setSummaryAI({ key, status: 'ok', data, mock });
      // 실제로 AI를 부른 경우에만 오늘 횟수를 깎는다 (캐시 히트·샘플은 비용이 없다)
      if (!fromCache && !mock) {
        const next = { [todayKey]: (summaryUses[todayKey] || 0) + 1 };
        setSummaryUses(next);
        try { localStorage.setItem(SUMMARY_USES_KEY, JSON.stringify(next)); } catch { /* 무시 */ }
      }
      // 그날의 토끼를 먼슬리에 쌓는다 (샘플은 제외)
      if (!mock && data.rabbit?.type) saveDayRabbit(reviewKey, data.rabbit.type);
      // 회고 글을 서버에 영구 보관한다 — 기기 캐시는 12개 한도·브라우저 정리에 취약하다
      if (!mock && currentUser) {
        supabase.from('day_reviews')
          .upsert({ user_id: currentUser.id, day: reviewKey, data, cache_key: key, updated_at: new Date().toISOString() })
          .then(({ error }) => { if (error) console.error('Error saving day review:', error); });
      }
      summaryGeneratedRef.current.add(reviewKey);
      track('summary_generated', {
        memo_count: records.length,
        record_days: countRecordDays(memos),
        hour: new Date().getHours(),
        has_flow: data.thoughtFlow.length > 0,
        loops: data.loops.length,
        energy_words: data.energyWords.up.length + data.energyWords.down.length,
        // 어떤 토끼가 얼마나 나오는지 — 매칭 분포가 한쪽으로 쏠리면 기준을 손봐야 한다
        rabbit: data.rabbit?.type ?? null,
        mock,
        from_cache: fromCache,
        regenerate,
        uses_left: fromCache || mock ? summaryUsesLeft : summaryUsesLeft - 1,
        duration_ms: Date.now() - startedAt,
      });
    } catch (e) {
      console.error('오늘 회고 실패:', e);
      const capped = e?.code === 'daily-cap';
      setSummaryAI({ key, status: capped ? 'capped' : 'failed', data: null, mock: false });
      track('Summary AI', { status: capped ? 'capped' : 'failed', memo_count: records.length, error: String(e?.message || e).slice(0, 80), duration_ms: Date.now() - startedAt });
    } finally {
      setSummaryBusy(false);
    }
  };

  // 회고 탭에서 오늘의 모양을 실제로 본 시점 — 날짜별로 세션에 한 번
  const handleSummaryViewed = useCallback((dayKey) => {
    if (summaryViewedRef.current.has(dayKey)) return;
    summaryViewedRef.current.add(dayKey);
    track('summary_viewed', { guest: isGuest, day: dayKey, memo_count: todayMemos.length });
  }, [isGuest, todayMemos.length]);

  const handleWeekViewed = useCallback(() => {
    if (weekViewedRef.current) return;
    weekViewedRef.current = true;
    track('Weekly Report Viewed', { guest: isGuest, active_days: weekFacts.activeDays, total: weekFacts.total });
  }, [isGuest, weekFacts.activeDays, weekFacts.total]);

  // ── 채팅창 순서 옮기기 (꾹 눌러 드래그) ──────────────────────
  // 채팅은 시간순 정렬이라, 순서를 바꾼다 = 시각을 바꾼다.
  // 떨어뜨린 자리의 앞뒤 기록 시각 사이 한가운데로 옮긴다.
  // 드래그 중 기록이 화면 밖(헤더 뒤)으로 사라지면 안 된다.
  // 손가락이 가장자리에 닿으면 목록을 자동 스크롤하고, 기록은 화면 안에 붙잡아둔다.
  const REORDER_EDGE = 70;      // 이 안쪽에 손가락이 오면 자동 스크롤
  const REORDER_PIN = 40;       // 기록이 화면 끝에서 이만큼 안쪽에 고정

  // 옮기기 전 상태 스냅샷 — 되돌리기가 시각뿐 아니라 구간 설정까지 원래대로 복구한다
  const snapshotMoveFields = (memo) => ({
    db: {
      recorded_at: memo.recordedAt,
      back_minutes: memo.backMinutes || 0,
      end_minutes: memo.endMinutes || 0,
      spans_from_prev: !!memo.spansFromPrev,
      spans_to_next: !!memo.spansToNext,
    },
    local: {
      recordedAt: memo.recordedAt,
      backMinutes: memo.backMinutes || 0,
      endMinutes: memo.endMinutes || 0,
      spansFromPrev: !!memo.spansFromPrev,
      spansToNext: !!memo.spansToNext,
    },
  });

  const applyChatDrag = () => {
    const st = reorderRef.current;
    const cont = timelineRef.current;
    if (!st || !cont || !st.el) return;
    const r = cont.getBoundingClientRect();
    // 손가락이 컨테이너를 벗어나도 기록은 화면 안에 고정한다
    const pinnedY = Math.max(r.top + REORDER_PIN, Math.min(r.bottom - REORDER_PIN, st.lastY));
    // 자동 스크롤로 밀린 만큼도 함께 따라와야 손가락 밑에 머문다
    const dy = (pinnedY - st.startY) + (cont.scrollTop - st.startScrollTop);
    st.el.style.transform = `translateY(${dy}px)`;
    let drop = 'end';
    for (const el of st.els) {
      const rr = el.getBoundingClientRect();
      if (pinnedY < rr.top + rr.height / 2) { drop = el.dataset.id; break; }
    }
    // 화면 표시용 상태와 별개로 ref에도 담는다 — 손을 떼는 순간 React가 아직
    // 마지막 이동을 반영하기 전이면 상태는 한 칸 전 자리를 가리키고 있어서,
    // 그대로 쓰면 엉뚱한 시각으로 옮겨진다.
    st.drop = drop;
    setReorderDrop(prev => (prev === drop ? prev : drop));
  };

  const beginMemoReorder = (memo, startY) => {
    // 이전 이동의 되돌리기 토스트는 정리한다 (되돌릴 대상이 섞이면 안 된다)
    setMoveUndoToast(prev => { if (prev?.timer) clearTimeout(prev.timer); return null; });
    const cont = timelineRef.current;
    const els = [...(cont?.querySelectorAll('.memo-swipe-wrapper[data-id]') || [])]
      .filter(el => el.dataset.id !== String(memo.id));
    const el = cont?.querySelector(`.memo-swipe-wrapper[data-id="${memo.id}"]`) || null;
    const st = {
      memo, els, el,
      startY, lastY: startY,
      startScrollTop: cont?.scrollTop ?? 0,
      raf: 0,
    };
    reorderRef.current = st;
    setDraggingMemoId(memo.id);
    setReorderDrop(null);
    // 가장자리 자동 스크롤 — 손가락이 안 움직여도 계속 밀려야 하므로 프레임마다 돈다
    const step = () => {
      if (reorderRef.current !== st) return;
      const c = timelineRef.current;
      if (c) {
        const r = c.getBoundingClientRect();
        if (st.lastY < r.top + REORDER_EDGE) {
          c.scrollTop -= Math.min(14, (r.top + REORDER_EDGE - st.lastY) / 3);
        } else if (st.lastY > r.bottom - REORDER_EDGE) {
          c.scrollTop += Math.min(14, (st.lastY - (r.bottom - REORDER_EDGE)) / 3);
        }
        applyChatDrag();
      }
      st.raf = requestAnimationFrame(step);
    };
    st.raf = requestAnimationFrame(step);
  };

  const moveMemoReorder = (clientY) => {
    const st = reorderRef.current;
    if (!st) return;
    st.lastY = clientY;
    applyChatDrag();
  };

  const endMemoReorder = async (commit) => {
    const st = reorderRef.current;
    const drop = st?.drop ?? reorderDrop;
    reorderRef.current = null;
    setDraggingMemoId(null);
    setReorderDrop(null);
    if (st) {
      cancelAnimationFrame(st.raf);
      if (st.el) st.el.style.transform = '';
    }
    if (!commit || !st || drop == null) return;

    const ordered = chatMemos.filter(m => m.id !== st.memo.id);
    let prev;
    let next = null;
    if (drop === 'end') {
      prev = ordered[ordered.length - 1] || null;
    } else {
      const idx = ordered.findIndex(m => String(m.id) === drop);
      if (idx < 0) return;
      next = ordered[idx];
      prev = idx > 0 ? ordered[idx - 1] : null;
    }
    const own = new Date(st.memo.recordedAt).getTime();
    const prevMs = prev ? new Date(prev.recordedAt).getTime() : null;
    const nextMs = next ? new Date(next.recordedAt).getTime() : null;
    // 이미 그 사이에 있으면(제자리) 아무것도 하지 않는다
    if ((prevMs == null || prevMs <= own) && (nextMs == null || own <= nextMs)) return;

    let newMs;
    if (prevMs != null && nextMs != null) newMs = Math.round((prevMs + nextMs) / 2);
    else if (nextMs != null) newMs = Math.max(selectedDayStartMs, nextMs - 30 * 60000);
    else if (prevMs != null) newMs = prevMs + 30 * 60000;
    else return;

    const iso = new Date(newMs).toISOString();
    const ok = await writeMemoFields(st.memo.id, { recorded_at: iso }, { recordedAt: iso });
    if (!ok) return;
    track('Memo Reordered', { guest: isGuest });
    // 옮기기는 아직 안 끝났다 — 시각을 확인/수정해야 완료다.
    // 구간 기록은 시작·종료를 각각 고칠 수 있게 둘 다 담아둔다.
    const isRange = isRangeMemo(st.memo);
    const before = blockRangeOf(st.memo);
    const after = blockRangeOf(st.memo, { recordedAt: iso });
    const startStr = hhmm(isRange ? after.start : new Date(iso));
    const endStr = hhmm(after.end);
    setMoveConfirm({
      memoId: st.memo.id,
      prev: snapshotMoveFields(st.memo),
      appliedIso: iso,
      isRange,
      baseIso: isRange ? after.start.toISOString() : iso, // 날짜의 기준
      draftStart: startStr,
      draftEnd: endStr,
      initStart: startStr,
      initEnd: endStr,
      wheel: 'start',
      prevLabel: isRange
        ? `${timeLabelOf(before.start)} → ${timeLabelOf(before.end)}`
        : timeLabelOf(st.memo.recordedAt),
    });
  };

  // 확정: 휠에서 고친 시각으로 옮기기를 마친다.
  // 시작·종료를 손대지 않았으면 드롭 시각 그대로 두고 아무것도 더 쓰지 않는다.
  // 단, 자동 잇기 구간('이전 기록부터'·'다음 기록까지')은 예외 — 경계가 recordedAt이
  // 아니라 이웃 기록에 붙어 있어서, recordedAt만 옮기면 시작(또는 끝)이 제자리에
  // 남는다. 드롭한 자리의 구간을 명시적으로 굳혀야 옮겨진다.
  const confirmMove = async () => {
    const m = moveConfirm;
    if (!m) return;
    setMoveConfirm(null);
    const startChanged = m.draftStart !== m.initStart;
    const endChanged = m.isRange && m.draftEnd !== m.initEnd;
    const p = m.prev.local;
    const autoLinked = (p.spansFromPrev && !p.backMinutes) || (p.spansToNext && !p.endMinutes);

    if (startChanged || endChanged || (m.isRange && autoLinked)) {
      const toMin = (s) => { const [h, mi] = s.split(':').map(Number); return h * 60 + mi; };
      const base = new Date(m.baseIso);

      if (!m.isRange) {
        const [h, mi] = m.draftStart.split(':').map(Number);
        base.setHours(h, mi, 0, 0);
        const iso = base.toISOString();
        await writeMemoFields(m.memoId, { recorded_at: iso }, { recordedAt: iso });
      } else {
        // 구간: 수정 시트의 저장과 같은 규칙 —
        // 시작·종료를 직접 정했으니 자동 잇기 대신 명시적인 구간으로 굳힌다.
        const startMin = toMin(m.draftStart);
        let endMin = toMin(m.draftEnd);
        if (endMin < startMin) endMin += 1440; // 자정을 넘긴 구간
        base.setHours(0, startMin, 0, 0);
        const startMs = base.getTime();
        const endMs = startMs + (endMin - startMin) * 60000;
        // 기록 시각(말풍선에 찍히는 시각)은 구간 안으로 끌어온다
        const ownMs = Math.min(Math.max(new Date(m.appliedIso).getTime(), startMs), endMs);
        const iso = new Date(ownMs).toISOString();
        await writeMemoFields(
          m.memoId,
          {
            recorded_at: iso,
            back_minutes: Math.round((ownMs - startMs) / 60000),
            end_minutes: Math.round((endMs - ownMs) / 60000),
            spans_from_prev: false,
            spans_to_next: false,
          },
          {
            recordedAt: iso,
            backMinutes: Math.round((ownMs - startMs) / 60000),
            endMinutes: Math.round((endMs - ownMs) / 60000),
            spansFromPrev: false,
            spansToNext: false,
          },
        );
      }
    }

    // 확정한 뒤에도 잠깐은 마음을 바꿀 수 있게 되돌리기 토스트를 띄운다
    const timer = setTimeout(() => setMoveUndoToast(null), 6000);
    setMoveUndoToast(prevT => {
      if (prevT?.timer) clearTimeout(prevT.timer);
      return { memoId: m.memoId, prev: m.prev, timer };
    });
  };

  // 시트의 되돌리기·바깥 터치 — 시간을 정하지 않았다는 뜻이므로 옮기기 전으로 복구
  const undoMove = async () => {
    const m = moveConfirm;
    if (!m) return;
    setMoveConfirm(null);
    await writeMemoFields(m.memoId, m.prev.db, m.prev.local);
  };

  // 확정 후 토스트의 되돌리기 — 구간 설정까지 통째로 옮기기 전으로
  const undoMoveAfterConfirm = async () => {
    const t = moveUndoToast;
    if (!t) return;
    clearTimeout(t.timer);
    setMoveUndoToast(null);
    await writeMemoFields(t.memoId, t.prev.db, t.prev.local);
  };

  const memoReorder = { onStart: beginMemoReorder, onMove: moveMemoReorder, onEnd: endMemoReorder };

  // ── 타임블럭 블록 꾹 눌러 이동 ──────────────────────────────
  // 채팅과 달리 시간선이 있으므로, 놓은 위치의 시각(5분 단위)이 그대로 새 시각이 된다.
  // 시간 → 픽셀 변환(timeToPx)은 몰린 구간을 늘리느라 비선형이라, 역변환은 이분탐색으로 푼다.
  const schedulePxToTime = (px) => {
    const map = schedulePxMapRef.current;
    if (!map) return 0;
    let lo = 0;
    let hi = map.gridMinutes;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (map.timeToPx(mid) < px) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  };

  const updateScheduleDragBadge = (g) => {
    const map = schedulePxMapRef.current;
    const badge = scheduleBadgeRef.current;
    if (!map || !badge) return;
    // 얼마나 끌었는지(상대값)만 시각에 더한다. 놓인 픽셀을 절대 시각으로 읽으면
    // 몰린 구간에서 쌓아 올린 블록의 top이 제 시각과 어긋나 있어서,
    // 꾹 눌렀다 그대로 떼기만 해도 시각이 바뀌어버린다.
    const draggedMin = schedulePxToTime(g.schedule.top + g.dy) - schedulePxToTime(g.schedule.top);
    const delta = Math.round(draggedMin / 5) * 5; // 5분 단위
    // 움직였을 때만 결과 시각도 5분 단위로 스냅한다 (12:39에서 끌면 1:29가 아니라 1:30에 떨어지게).
    // 안 움직였으면(delta 0) 원래 시각을 조금도 건드리지 않는다.
    let t = g.schedule.startPos + delta;
    if (delta !== 0) t = Math.round(t / 5) * 5;
    t = Math.max(0, Math.min(map.gridMinutes, t));
    g.newStartPos = t;
    badge.style.display = 'block';
    badge.style.top = `${map.timeToPx(t)}px`;
    badge.textContent = format(new Date(windowStartMs + t * 60000), 'aa h:mm', { locale: ko });
  };

  // 드래그 위치 반영 — 손가락을 화면 안에 붙잡고(pinned), 자동 스크롤만큼 따라온다
  const applyScheduleDrag = (g) => {
    const cont = scheduleViewRef.current;
    if (!cont) return;
    const r = cont.getBoundingClientRect();
    const pinnedY = Math.max(r.top + REORDER_PIN, Math.min(r.bottom - REORDER_PIN, g.lastClientY));
    g.dy = (pinnedY - g.y) + (cont.scrollTop - g.startScrollTop);
    g.el.style.transform = `translateY(${g.dy}px) scale(0.96)`;
    updateScheduleDragBadge(g);
  };

  const endScheduleDrag = (g, commit) => {
    clearTimeout(g.timer);
    cancelAnimationFrame(g.raf);
    if (g.prevent) window.removeEventListener('touchmove', g.prevent);
    g.el.classList.remove('schedule-block--moving');
    g.el.style.transform = '';
    if (scheduleBadgeRef.current) scheduleBadgeRef.current.style.display = 'none';
    scheduleDragRef.current = null;
    if (!commit || g.mode !== 'drag' || g.newStartPos == null) return;
    const shift = g.newStartPos - g.schedule.startPos;
    if (!shift) return;
    // 블록의 시작을 옮긴 만큼 기록 시각도 같이 민다 (구간 길이는 그대로)
    const oldIso = g.schedule.memo.recordedAt;
    const iso = new Date(new Date(oldIso).getTime() + shift * 60000).toISOString();
    writeMemoFields(g.schedule.memo.id, { recorded_at: iso }, { recordedAt: iso }).then((ok) => {
      if (!ok) return;
      track('Memo Reordered', { guest: isGuest, view: 'schedule' });
      // 옮기기는 아직 안 끝났다 — 시각을 확인/수정해야 완료다.
      // 구간 기록은 시작·종료를 각각 고칠 수 있다 (블록의 시작·끝은 이미 계산돼 있다).
      const isRange = isRangeMemo(g.schedule.memo);
      const durationMin = Math.round(g.schedule.endPos - g.schedule.startPos);
      const startBefore = new Date(windowStartMs + g.schedule.startPos * 60000);
      const endBefore = new Date(windowStartMs + g.schedule.endPos * 60000);
      const startAfter = new Date(windowStartMs + g.newStartPos * 60000);
      const endAfter = new Date(startAfter.getTime() + durationMin * 60000);
      const startStr = hhmm(isRange ? startAfter : new Date(iso));
      const endStr = hhmm(endAfter);
      setMoveConfirm({
        memoId: g.schedule.memo.id,
        prev: snapshotMoveFields(g.schedule.memo),
        appliedIso: iso,
        isRange,
        baseIso: isRange ? startAfter.toISOString() : iso,
        draftStart: startStr,
        draftEnd: endStr,
        initStart: startStr,
        initEnd: endStr,
        wheel: 'start',
        prevLabel: isRange
          ? `${timeLabelOf(startBefore)} → ${timeLabelOf(endBefore)}`
          : timeLabelOf(oldIso),
      });
    });
  };

  // ── 시간표 빈 자리 눌러 시각 고르기 ────────────────────────
  // 탭: 그 시각(5분 단위)이 입력창에 걸린다. 꾹 누르고 끌다 떼기: 누른 시각부터 뗀 시각까지 구간.
  // 블록 위에서 시작한 건 블록 제스처(옮기기)라 여기서 받지 않는다.
  const scheduleGridRef = useRef(null);
  const scheduleSlotRef = useRef(null);
  const scheduleSlotHighlightRef = useRef(null);
  const gridMinuteAt = (clientY) => {
    const grid = scheduleGridRef.current;
    const map = schedulePxMapRef.current;
    if (!grid || !map) return null;
    const r = grid.getBoundingClientRect();
    const min = schedulePxToTime(clientY - r.top);
    return Math.max(0, Math.min(map.gridMinutes, Math.round(min / 5) * 5));
  };
  const paintSlotHighlight = (g) => {
    const el = scheduleSlotHighlightRef.current;
    const map = schedulePxMapRef.current;
    const badge = scheduleBadgeRef.current;
    if (!el || !map) return;
    const a = Math.min(g.startMin, g.curMin);
    const b = Math.max(g.startMin, g.curMin, a + 5);
    el.style.display = 'block';
    el.style.top = `${map.timeToPx(a)}px`;
    el.style.height = `${map.timeToPx(b) - map.timeToPx(a)}px`;
    if (badge) {
      badge.style.display = 'block';
      badge.style.top = `${map.timeToPx(g.curMin)}px`;
      badge.textContent = `${clockLabel(windowStartMs + a * 60000)} → ${clockLabel(windowStartMs + b * 60000)}`;
    }
  };
  // 잡힌 시각을 입력창 앞머리에 글자로 넣고 포커스 — 채팅에 "오전 9시 밥"이라 적는 것과 같은 모양.
  const applyTimeToInput = (localStartMin, localEndMin, dayMs) => {
    const startMs = dayMs + localStartMin * 60000;
    const prefix = clockLabel(startMs) + (localEndMin != null ? `~${clockLabel(dayMs + localEndMin * 60000)}` : '') + ' ';
    setInputText(prev => prefix + prev.replace(PREFIX_RE, ''));
    if (!isSameDay(new Date(startMs), selectedDate)) setSelectedDate(new Date(startMs));
    const el = inputRef.current;
    if (el) { el.focus(); setTimeout(() => el.setSelectionRange(el.value.length, el.value.length), 0); }
  };
  // 드래그/터치로 잡으면 휠 시트 없이 바로 입력할 수 있게 한다 (시각은 밴드로 보이고, 눌러 조정 가능).
  const pickSlot = (startMin, endMin) => {
    const dayOff = Math.floor(startMin / DAY_MINUTES) * DAY_MINUTES;
    const dayMs = windowStartMs + dayOff * 60000;
    applyTimeToInput(startMin - dayOff, endMin != null ? endMin - dayOff : null, dayMs);
    track('Schedule Slot Picked', { range: endMin != null, guest: isGuest });
  };
  // 잡힌 시간대(밴드 또는 입력창 시각)를 눌러 조정 시트를 연다.
  const openBandEditor = () => {
    if (!pendingSpan) return;
    setRangeSheet({ isRange: pendingSpan.end != null, start: pendingSpan.start, end: pendingSpan.end, dayMs: pendingSpan.dayMs });
  };
  const applyRangeSheet = (startMin, endMin) => {
    setRangeSheet(null);
    if (rangeSheet) applyTimeToInput(startMin, endMin, rangeSheet.dayMs);
  };
  // 시트에서 확인 — 그제야 입력창에 시각이 걸리고 포커스가 간다
  const confirmSlotPick = () => {
    const sp = slotPick;
    if (!sp) return;
    setSlotPick(null);
    const toMin = (str) => { const [h, mi] = str.split(':').map(Number); return h * 60 + mi; };
    const startMin = toMin(sp.draftStart);
    let endMin = sp.isRange ? toMin(sp.draftEnd) : null;
    if (endMin != null && endMin <= startMin) endMin += DAY_MINUTES; // 자정을 넘긴 구간
    applyTimeToInput(startMin, endMin, sp.dayMs);
  };
  const endSlotGesture = (g, commit) => {
    clearTimeout(g.timer);
    cancelAnimationFrame(g.raf);
    if (g.prevent) window.removeEventListener('touchmove', g.prevent);
    if (scheduleSlotHighlightRef.current) scheduleSlotHighlightRef.current.style.display = 'none';
    if (scheduleBadgeRef.current) scheduleBadgeRef.current.style.display = 'none';
    scheduleSlotRef.current = null;
    if (!commit) return;
    if (g.mode === 'range') {
      const a = Math.min(g.startMin, g.curMin);
      const b = Math.max(g.startMin, g.curMin, a + 5);
      pickSlot(a, b);
    } else if (g.mode === 'pending') {
      pickSlot(g.startMin, null);
    }
  };
  const onScheduleGridPointerDown = (e) => {
    if (!e.isPrimary || e.target.closest('.schedule-block')) return;
    const startMin = gridMinuteAt(e.clientY);
    if (startMin == null) return;
    const el = e.currentTarget; // 타이머 안에서는 currentTarget이 비어 있다
    const g = { id: e.pointerId, x: e.clientX, y: e.clientY, lastClientY: e.clientY, startMin, curMin: startMin, mode: 'pending', timer: null, prevent: null, raf: 0 };
    g.timer = setTimeout(() => {
      if (scheduleSlotRef.current !== g || g.mode !== 'pending') return;
      g.mode = 'range';
      try { el.setPointerCapture(g.id); } catch { /* 이미 떼었으면 무시 */ }
      navigator.vibrate?.(15);
      g.prevent = (ev) => ev.preventDefault();
      window.addEventListener('touchmove', g.prevent, { passive: false });
      paintSlotHighlight(g);
      // 가장자리 자동 스크롤 — 화면 밖 시각까지 끌 수 있어야 한다 (3시에 눌러 7시까지)
      const step = () => {
        if (scheduleSlotRef.current !== g || g.mode !== 'range') return;
        const cont = scheduleViewRef.current;
        if (cont) {
          const r = cont.getBoundingClientRect();
          let moved = false;
          if (g.lastClientY < r.top + REORDER_EDGE) {
            cont.scrollTop -= Math.min(14, (r.top + REORDER_EDGE - g.lastClientY) / 3); moved = true;
          } else if (g.lastClientY > r.bottom - REORDER_EDGE) {
            cont.scrollTop += Math.min(14, (g.lastClientY - (r.bottom - REORDER_EDGE)) / 3); moved = true;
          }
          if (moved) {
            const m = gridMinuteAt(g.lastClientY);
            if (m != null) { g.curMin = m; paintSlotHighlight(g); }
          }
        }
        g.raf = requestAnimationFrame(step);
      };
      g.raf = requestAnimationFrame(step);
    }, 450);
    scheduleSlotRef.current = g;
  };
  const onScheduleGridPointerMove = (e) => {
    const g = scheduleSlotRef.current;
    if (!g || e.pointerId !== g.id) return;
    if (g.mode === 'pending') {
      // 꾹 누르기 전에 움직이면 스크롤이다
      if (Math.hypot(e.clientX - g.x, e.clientY - g.y) > 8) { clearTimeout(g.timer); g.mode = 'scroll'; }
      return;
    }
    if (g.mode !== 'range') return;
    g.lastClientY = e.clientY;
    const m = gridMinuteAt(e.clientY);
    if (m != null) { g.curMin = m; paintSlotHighlight(g); }
  };
  const onScheduleGridPointerUp = (e) => {
    const g = scheduleSlotRef.current;
    if (!g || e.pointerId !== g.id) return;
    endSlotGesture(g, true);
  };
  const onScheduleGridPointerCancel = (e) => {
    const g = scheduleSlotRef.current;
    if (!g || e.pointerId !== g.id) return;
    endSlotGesture(g, false);
  };

  const onScheduleBlockPointerDown = (e, schedule) => {
    scheduleSuppressClickRef.current = false;
    if (!e.isPrimary) return;
    const el = e.currentTarget;
    const g = {
      id: e.pointerId, x: e.clientX, y: e.clientY, lastClientY: e.clientY, el, schedule,
      mode: 'pending', dy: 0, timer: null, prevent: null, newStartPos: null,
      startScrollTop: scheduleViewRef.current?.scrollTop ?? 0, raf: 0,
    };
    g.timer = setTimeout(() => {
      if (scheduleDragRef.current !== g || g.mode !== 'pending') return;
      g.mode = 'drag';
      scheduleSuppressClickRef.current = true;
      // 이전 이동의 되돌리기 토스트는 정리한다 (되돌릴 대상이 섞이면 안 된다)
      setMoveUndoToast(prev => { if (prev?.timer) clearTimeout(prev.timer); return null; });
      // 마우스는 커서가 블록 밖으로 나가면 이벤트가 끊긴다 — 캡처로 붙잡아둔다
      try { el.setPointerCapture(g.id); } catch { /* 이미 떼었으면 무시 */ }
      navigator.vibrate?.(15);
      // '이동 가능 상태'가 눈에 보이게 — 살짝 줄어들며 들리고, 시각 배지가 뜬다
      el.classList.add('schedule-block--moving');
      g.prevent = (ev) => ev.preventDefault();
      window.addEventListener('touchmove', g.prevent, { passive: false });
      applyScheduleDrag(g);
      // 가장자리 자동 스크롤 — 위로 쭉 끌면 헤더에 가려지는 대신 판이 넘어간다
      const step = () => {
        if (scheduleDragRef.current !== g || g.mode !== 'drag') return;
        const cont = scheduleViewRef.current;
        if (cont) {
          const r = cont.getBoundingClientRect();
          if (g.lastClientY < r.top + REORDER_EDGE) {
            cont.scrollTop -= Math.min(14, (r.top + REORDER_EDGE - g.lastClientY) / 3);
          } else if (g.lastClientY > r.bottom - REORDER_EDGE) {
            cont.scrollTop += Math.min(14, (g.lastClientY - (r.bottom - REORDER_EDGE)) / 3);
          }
          applyScheduleDrag(g);
        }
        g.raf = requestAnimationFrame(step);
      };
      g.raf = requestAnimationFrame(step);
    }, 450);
    scheduleDragRef.current = g;
  };

  const onScheduleBlockPointerMove = (e) => {
    const g = scheduleDragRef.current;
    if (!g || e.pointerId !== g.id) return;
    if (e.pointerType === 'mouse' && !(e.buttons & 1)) return;
    const dy = e.clientY - g.y;
    if (g.mode === 'pending') {
      // 꾹 누르기 전에 움직이면 스크롤이다 — 이동 모드로 들어가지 않는다
      if (Math.hypot(e.clientX - g.x, dy) > 8) { clearTimeout(g.timer); g.mode = 'scroll'; }
      return;
    }
    if (g.mode !== 'drag') return;
    g.lastClientY = e.clientY;
    applyScheduleDrag(g);
  };

  const onScheduleBlockPointerUp = (e) => {
    const g = scheduleDragRef.current;
    if (!g || e.pointerId !== g.id) return;
    endScheduleDrag(g, true);
  };

  const onScheduleBlockPointerCancel = (e) => {
    const g = scheduleDragRef.current;
    if (!g || e.pointerId !== g.id) return;
    endScheduleDrag(g, false);
  };

  // 기록이 이 기기에만 있다는 안내를 지금 띄울 때인지.
  //
  // 홈 화면 앱에서도 띄운다. 사파리의 7일 삭제만 비켜갈 뿐, 기록이 이 기기
  // 하나에만 있다는 건 똑같다 — 앱을 지우거나 폰을 바꾸면 사라지고 다른
  // 기기에서는 못 본다. 홈 화면 앱에는 '홈 화면에 추가' 안내만 뺀다(이미 했으니).
  const inStandaloneApp = isStandaloneApp();
  const showSaveNotice =
    isGuest && memos.length >= SAVE_NOTICE_AFTER && !saveNoticeDismissed && !tour.active;

  // 안내가 실제로 눈에 띈 순간을 한 번만 남긴다.
  // (이 안내가 로그인으로 이어지는지 봐야 붙여둘 값어치가 있는지 알 수 있다)
  const saveNoticeSeenRef = useRef(false);
  useEffect(() => {
    if (!showSaveNotice || saveNoticeSeenRef.current) return;
    saveNoticeSeenRef.current = true;
    track('Save Prompt', { action: 'shown', platform: isIOSDevice ? 'ios' : 'other', standalone: inStandaloneApp, memo_count: memos.length });
  }, [showSaveNotice, memos.length, inStandaloneApp]);

  const dismissSaveNotice = (action) => {
    localStorage.setItem(SAVE_NOTICE_KEY, '1');
    setSaveNoticeDismissed(true);
    track('Save Prompt', { action, platform: isIOSDevice ? 'ios' : 'other', standalone: inStandaloneApp, memo_count: memos.length });
  };

  // ── 타임블럭이 이어서 훑는 날짜 창 ──────────────────────────
  // 날짜마다 판을 새로 그리면 자정에서 블록이 뚝 끊긴다.
  // 그래서 여러 날을 한 시간 축에 이어서 그리고, 스크롤로 자정을 넘나든다.
  // 창은 anchorDate 기준으로 처음부터 한 번에 다 깔린다 (스크롤 도중에 늘리지 않는다).
  //
  // 다만 보고 있는 날짜가 창 밖으로 나가면 그 날짜를 기준으로 다시 잡는다.
  // (예: 먼슬리에서 지난달 날짜를 고르고 타임라인으로 넘어온 경우)
  // 이걸 상태로 두고 effect에서 고치면 헤더가 한 프레임 비었다가 채워지고,
  // 그 사이에 스크롤이 일어나면 창 안의 엉뚱한 날짜로 튕긴다. 그래서 렌더 시점에 계산한다.
  const anchorGap = differenceInCalendarDays(selectedDate, anchorDate);
  const effectiveAnchor =
    anchorGap > TIMELINE_DAYS_AFTER || anchorGap < -TIMELINE_DAYS_BEFORE ? selectedDate : anchorDate;
  const windowStart = new Date(
    effectiveAnchor.getFullYear(), effectiveAnchor.getMonth(), effectiveAnchor.getDate() - TIMELINE_DAYS_BEFORE
  );
  const windowStartMs = windowStart.getTime();
  const windowDayCount = TIMELINE_DAYS_BEFORE + 1 + TIMELINE_DAYS_AFTER;
  const windowMinutes = windowDayCount * DAY_MINUTES;
  const windowDays = Array.from({ length: windowDayCount }, (_, i) => addDays(windowStart, i));

  // 창 안의 모든 기록. 자정을 넘는 블록도 여기서 그대로 이어 그린다
  const timelineMemos = memos
    .filter(m => {
      const min = (new Date(m.recordedAt).getTime() - windowStartMs) / 60000;
      return min >= 0 && min < windowMinutes;
    })
    .sort((a, b) => new Date(a.recordedAt) - new Date(b.recordedAt));

  // 편집 시트가 블록 구간을 계산할 때 쓰는 기준점 (타임블럭과 같은 판 위에서 재야 한다)
  const dayStartMs = windowStartMs;

  // ── 구간 기록의 걸린 시간 (채팅창 말풍선 뒤 회색 표시용) ──────
  // 타임블럭이 그리는 구간과 똑같은 규칙으로 계산해야 두 화면의 숫자가 같다.
  const chatDurations = {};
  if (timelineMemos.length > 0) {
    for (const b of buildDayBlocks(timelineMemos, {
      dayStartMs: windowStartMs, nowMs: nowTime.getTime(), gridMinutes: windowMinutes,
    })) {
      if (isRangeMemo(b.memo)) chatDurations[b.memo.id] = b.endPos - b.startPos;
    }
  }


  const dayInWindow = (day) => windowDays.some(d => isSameDay(d, day));

  // ── 스크롤 ↔ 헤더 날짜 ──────────────────────────────────────
  // 스크롤이 자정을 지나면 헤더의 두 날짜가 겹치며 바뀐다.
  // 매 픽셀마다 리렌더하면 무거우므로, 흐려지는 효과는 DOM에 직접 쓰고
  // 날짜가 실제로 바뀐 순간에만 selectedDate를 건드린다.
  const headerStackRef = useRef(null);
  const scrollDayRef = useRef(0);
  // 스크롤이 멎고 이만큼 지나야 selectedDate를 바꾼다 (관성으로 스쳐 지나간 날짜는 무시)
  const dateCommitTimerRef = useRef(null);
  // 직전 스크롤 위치. 날짜가 스크롤한 거리만큼만 움직였는지 검산하는 데 쓴다
  const lastScrollTopRef = useRef(0);
  // 사용자가 날짜를 직접 고른 횟수. 이 값이 늘면 그 날짜로 옮긴다.
  // (스크롤 때문에 날짜가 바뀐 경우와 구분해야 화면이 스스로 튀지 않는다)
  const [navSeq, setNavSeq] = useState(0);
  const CROSSFADE_PX = 56;

  const paintHeaderDay = (index, progress) => {
    const stack = headerStackRef.current;
    if (!stack) return;
    for (const el of stack.children) {
      const i = Number(el.dataset.dayLabel);
      el.style.opacity = i === index ? String(1 - progress)
        : i === index + 1 ? String(progress)
        : '0';
    }
  };

  // 지금 화면 맨 위에 어느 날짜가 걸려 있는지 보고 헤더를 맞춘다.
  // 스크롤할 때뿐 아니라 자리를 잡은 직후에도 불러서, 헤더와 화면이 어긋나지 않게 한다.
  // force: 방금 우리가 스크롤을 옮겨놓은 직후. 그땐 '민 거리' 검산이 의미가 없다
  const syncHeaderToScroll = (el, force = false) => {
    if (!el) return;
    // 스크롤할 게 없으면(기록이 적어 한 화면에 다 들어옴) 헤더를 건드리지 않는다.
    // 맨 위에 걸린 날짜를 따라가면 오늘 쓰러 들어왔는데 며칠 전 날짜가 떠 있게 된다.
    if (el.scrollHeight - el.clientHeight < 4) return;
    const marks = el.querySelectorAll('[data-day-index]');
    if (!marks.length) return;
    // 기준선은 화면 맨 위가 아니라 위쪽 1/3.
    // 맨 위로 재면 화면 대부분이 오늘인데도 위에 살짝 걸친 어제가 헤더를 차지한다.
    const base = el.getBoundingClientRect().top + el.clientHeight / 3;
    let index = 0;
    let progress = 0;
    // 아직 첫 날짜 경계도 지나지 않았으면(맨 위) 겹침 없이 그 날짜만 보여준다.
    // 이게 없으면 화면 맨 위에서 다음 날짜로 반쯤 넘어간 채 시작한다.
    let passedAny = false;
    for (const mark of marks) {
      const i = Number(mark.dataset.dayIndex);
      const offset = mark.getBoundingClientRect().top - base;
      if (offset <= 1) { index = i; progress = 0; passedAny = true; continue; }
      // 다음 날짜 경계가 위쪽에 가까워질수록 헤더가 그쪽으로 넘어간다
      if (passedAny && offset < CROSSFADE_PX) progress = 1 - offset / CROSSFADE_PX;
      break;
    }
    // ── 잘못 잰 값 걸러내기 ──────────────────────────────────
    // 여기서 나오는 index는 화면 위치를 '잰' 값이라, 재는 순간이 나쁘면
    // (관성·고무줄 중이거나 판을 다시 그리는 도중) 엉뚱한 값이 나온다.
    // 그대로 쓰면 헤더가 창 맨 앞 날짜로 슉 넘어간다.

    // 맨 위도 아닌데 기준선 위로 지나온 날짜 경계가 하나도 없으면 잘못 잰 것이다.
    // (이 경우 index가 0으로 떨어져 창의 첫 날짜가 뜬다)
    if (!passedAny && el.scrollTop > 4) return;

    // 날짜는 스크롤한 거리만큼만 움직일 수 있다. 하루가 최소 1440px인데
    // 그만큼 밀지도 않고 며칠씩 건너뛴 값이 나왔다면 잰 게 잘못된 것이다.
    const prevIndex = scrollDayRef.current;
    const movedPx = Math.abs(el.scrollTop - lastScrollTopRef.current);
    lastScrollTopRef.current = el.scrollTop;
    const dayGap = Math.abs(index - prevIndex);
    if (!force && dayGap > 1 && movedPx < (dayGap - 1) * DAY_MINUTES) return;

    paintHeaderDay(index, progress);
    if (scrollDayRef.current !== index) {
      scrollDayRef.current = index;
      const day = windowDays[index];
      // 헤더 글자는 위에서 DOM으로 이미 바꿨다. selectedDate는 손을 떼고
      // 미끄러짐이 멎은 뒤에 한 번만 바꾼다. 경계를 지날 때마다 바꾸면
      // 관성으로 지나가는 며칠이 전부 리렌더를 일으켜 스크롤이 걸린다.
      if (day) {
        clearTimeout(dateCommitTimerRef.current);
        dateCommitTimerRef.current = setTimeout(() => {
          setSelectedDate(prev => (isSameDay(prev, day) ? prev : day));
        }, DATE_COMMIT_DELAY);
      }
    }
  };

  // 창은 처음부터 다 깔려 있으므로 스크롤 중에 할 일은 헤더를 맞추는 것뿐이다.
  const handleTimelineScroll = (e) => {
    syncHeaderToScroll(e.currentTarget);
  };

  useEffect(() => () => clearTimeout(dateCommitTimerRef.current), []);

  // 화살표·달력으로 날짜를 고르면 그 날짜가 화면 위로 오도록 옮긴다.
  // 창 밖의 날짜면 창을 다시 잡고, 다음 렌더에서 옮겨진다.
  const goToDay = (day) => {
    setSelectedDate(day);
    if (!dayInWindow(day)) setAnchorDate(day);
    setNavSeq(n => n + 1);
  };

  const timelineScrollerEl = () => (showScheduleView ? scheduleViewRef.current : timelineRef.current);

  // ── 채팅창 빈 곳 좌우 스와이프 → 날짜 이동 ────────────────────
  // 바닥에 늘 남겨두는 여백(.timeline-bottom-space)만이 아니라, 기록이 적어
  // 아래가 넓게 빌 때 그 한가운데서 밀어도 통해야 한다. 그래서 위치(띠)가
  // 아니라 '무엇을 짚었는가'로 빈 곳을 판정한다.
  // 기록 위에서는 기록 자신의 좌우 스와이프(삭제)가 우선이라 건드리지 않는다.
  // 터치 대신 포인터 이벤트를 쓴다: PC 마우스 드래그도 같이 통하고,
  // .timeline의 touch-action: pan-y 덕에 가로 제스처를 브라우저가
  // 스크롤로 가로채(touchcancel) 버리지 않는다.
  const chatSwipeRef = useRef(null);
  const chatSwipeScrollPendingRef = useRef(false);
  const handleChatBlankPointerDown = (e) => {
    if (!e.isPrimary || e.target.closest('.memo-group, button, input, textarea, a')) {
      chatSwipeRef.current = null;
      return;
    }
    chatSwipeRef.current = { id: e.pointerId, x: e.clientX, y: e.clientY, done: false };
  };
  const handleChatBlankPointerMove = (e) => {
    const s = chatSwipeRef.current;
    if (!s || s.done || e.pointerId !== s.id) return;
    if (e.pointerType === 'mouse' && !(e.buttons & 1)) return; // 마우스는 누른 채 끌 때만
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    // 가로로 확실히 민 것만 (세로 스크롤과 헷갈리지 않게)
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    s.done = true;
    chatSwipeScrollPendingRef.current = true;
    goToDay(addDays(selectedDate, dx < 0 ? 1 : -1)); // 왼쪽으로 밀면 다음 날
  };
  const handleChatBlankPointerEnd = () => { chatSwipeRef.current = null; };

  // 스와이프로 날짜를 옮긴 직후엔 그 날의 최신 기록이 보이게 맨 아래로
  useEffect(() => {
    if (!chatSwipeScrollPendingRef.current) return;
    chatSwipeScrollPendingRef.current = false;
    const el = timelineRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [selectedDate]);

  // ── 채팅창 ↔ 타임블럭: 보고 있던 시각을 그대로 이어준다 ────────
  // 두 화면은 같은 하루를 다른 방식으로 보여주는 것이라, 오갈 때마다
  // 지금 시각으로 되돌려버리면 보던 자리를 매번 다시 찾아야 한다.
  const viewAnchorRef = useRef(null); // 넘어갈 때 담아두는 '보고 있던 시각'(ms)

  // 지금 화면에서 기준선(위 1/3)에 걸린 시각을 읽는다
  const readFocusTime = () => {
    const el = timelineScrollerEl();
    if (!el) return null;
    const refY = el.getBoundingClientRect().top + el.clientHeight / 3;
    if (showScheduleView) {
      // 타임블럭: 왼쪽 시간 눈금이 창 시작부터 한 시간씩 순서대로 놓여 있다
      const labels = el.querySelectorAll('.schedule-hour-label');
      let hour = -1;
      for (let i = 0; i < labels.length; i++) {
        if (labels[i].getBoundingClientRect().top <= refY) hour = i;
        else break;
      }
      return hour < 0 ? null : windowStartMs + hour * 3600000;
    }
    // 채팅창: 기준선에 걸린(또는 그 아래 첫) 기록의 시각
    const items = el.querySelectorAll('[data-at]');
    for (const it of items) {
      if (it.getBoundingClientRect().bottom >= refY) return new Date(it.dataset.at).getTime();
    }
    const last = items[items.length - 1];
    return last ? new Date(last.dataset.at).getTime() : null;
  };

  const toggleScheduleView = () => {
    // 채팅창 맨 아래(기본 자리)에서 넘어갈 때는 시각을 잇지 않는다.
    // 맨 아래 = 최신 기록을 보고 있던 것이라, 타임블럭의 기본 자리
    // (가장 최근 기록을 가운데로)가 곧 이어보기다. 위로 스크롤해서
    // 옛 기록을 보던 중일 때만 그 시각을 그대로 이어준다.
    const el = timelineScrollerEl();
    const chatAtBottom = !showScheduleView && el &&
      el.scrollHeight - el.clientHeight - el.scrollTop < 8;
    let carried = chatAtBottom ? null : readFocusTime();
    // 채팅창에는 다음날 새벽(~02시) 기록도 이어 보여주지만, 타임블럭으로
    // 넘어갈 때의 기준은 그 날 23:59까지다. 새벽 기록의 시각이 잡히면
    // 그걸 잇지 않고 기본 규칙(그 날의 가장 최근 기록)에 맡긴다.
    // 안 그러면 8월 17일 채팅창에서 넘어갔는데 8월 18일 새벽에 떨어진다.
    if (carried != null && !showScheduleView) {
      const dayEnd = new Date(
        selectedDate.getFullYear(), selectedDate.getMonth(), selectedDate.getDate() + 1
      ).getTime();
      if (carried >= dayEnd) carried = null;
    }
    viewAnchorRef.current = carried;
    setShowScheduleView(v => !v);
  };

  // 고른 날짜로 실제로 옮기는 곳
  useEffect(() => {
    if (navSeq === 0 || activeView !== 'timeline') return;
    // 스크롤 때문에 예약해둔 날짜 변경이 남아 있으면 지운다. 안 지우면
    // 화살표·달력·'오늘로'로 옮긴 직후에 그게 뒤늦게 터져서 방금 고른
    // 날짜를 아까 훑던 날짜로 되돌려버린다.
    clearTimeout(dateCommitTimerRef.current);
    const idx = windowDays.findIndex(d => isSameDay(d, selectedDate));
    if (idx < 0) return;
    const el = timelineScrollerEl();
    // 오늘로 갈 때는 그 날 00시가 아니라 지금 시각이 보여야 한다
    const nowLine = isToday(selectedDate) ? el?.querySelector('.schedule-now-line') : null;
    const target = nowLine || el?.querySelector(`[data-day-index="${idx}"]`);
    if (!target) return;
    const delta = target.getBoundingClientRect().top - el.getBoundingClientRect().top;
    el.scrollTop = Math.max(0, el.scrollTop + delta - (nowLine ? el.clientHeight / 3 : 0));
    // 여기서 옮긴 자리도 '자동으로 맞춰둔 자리'로 쳐서, 뒤이어 도는 자동
    // 자리잡기가 이걸 사용자 스크롤로 오해하고 덮어쓰지 않게 한다
    autoScrollRef.current = { view: showScheduleView, top: el.scrollTop };
    lastScrollTopRef.current = el.scrollTop;
    scrollDayRef.current = idx;
    paintHeaderDay(idx, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navSeq]);

  // 타임라인을 열거나 화면을 바꿀 때 한 번 자리를 잡아준다.
  // 오늘이면 지금 시각, 아니면 그 날 머리로.
  const autoScrollKeyRef = useRef('');
  // 자동으로 맞춰둔 스크롤 위치. 여기서 벗어나 있으면 사용자가 훑고 있다는 뜻이다
  // 자동으로 맞춰둔 스크롤 위치와, 그 위치를 잰 스크롤 상자.
  // (채팅창과 타임블럭은 서로 다른 상자라 같이 들고 있어야 비교가 된다)
  const autoScrollRef = useRef(null); // { view, top } — 어느 화면에서 어디에 맞춰뒀는지
  useEffect(() => {
    if (activeView !== 'timeline') {
      // 탭을 떠나면 '맞춰둔 자리' 기억을 지운다. 돌아올 때 화면이 새로 만들어지며
      // 스크롤이 판 맨 위(창의 첫 날)로 리셋되는데, 옛 기억과 비교하면 그걸
      // '사용자가 맨 위로 스크롤했다'로 오해해 자리를 안 잡아주고 — 헤더가
      // 창의 첫 날짜(예: 8월 11일)로 확정되는 사고가 났다 (8/25).
      autoScrollKeyRef.current = '';
      autoScrollRef.current = null;
      // 떠나기 직전 스크롤이 예약해 둔 날짜 변경도 무효다
      clearTimeout(dateCommitTimerRef.current);
      return;
    }
    const key = `${showScheduleView}|${memos.length > 0}|${format(effectiveAnchor, 'yyyy-MM-dd')}`;
    if (autoScrollKeyRef.current === key) return;
    const el = timelineScrollerEl();
    if (!el) return;
    // 사용자가 이미 훑고 있으면 건드리지 않는다.
    // 자동 자리잡기는 화면을 처음 열었을 때 도와주는 것이지, 보고 있는 사람을
    // 다른 데로 끌고 가는 기능이 아니다. (기록이 늦게 불러와지는 등으로 이 효과가
    // 다시 돌 때, 스크롤 중이던 사람을 엉뚱한 자리로 던져버렸다)
    //
    // 단, 채팅창 ↔ 타임블럭은 **같은 DOM 상자를 재사용**하면서 안에 든 내용만
    // 갈아끼운다. 그때 scrollTop은 0으로 돌아가는데, 이걸 '사용자가 맨 위로
    // 옮겼다'고 오해하면 자리를 안 잡아주고, 화면은 창의 첫 날(오늘-7일)에
    // 머문 채로 남는다. 그래서 기준은 상자가 아니라 **어느 화면이었는지**로 잡는다.
    const placed = autoScrollRef.current;
    const placedAt = placed && placed.view === showScheduleView ? placed.top : -1;
    if (placedAt >= 0 && Math.abs(el.scrollTop - placedAt) > 8) {
      // 같은 화면에서 사용자가 옮긴 것 — 기준은 그대로 두고 손대지 않는다
      autoScrollKeyRef.current = key;
      return;
    }
    // 이 화면에 대해선 한 번만 시도한다. 실패해도 매 렌더마다 다시 덤비지 않는다.
    autoScrollKeyRef.current = key;
    // 지금 어느 화면인지를 먼저 새겨둔다. 자리를 못 잡고 빠져나가더라도(예: 채팅창엔
    // 날짜 표식이 없어서 대상이 없다) 이 기록은 남아야 한다. 안 남기면 다음에 타임블럭으로
    // 돌아왔을 때 '이전 타임블럭에서 맞춰둔 자리'가 아직 유효한 줄 알고, 새로 그려져
    // 0으로 돌아온 스크롤을 '사용자가 맨 위로 올린 것'으로 오해해 자리를 안 잡아준다.
    // (같은 effect 안에서 읽고 다시 쓰는 모양이라 린트가 잡지만, 렌더 중이 아니라 안전하다)
    // eslint-disable-next-line react-hooks/immutability
    autoScrollRef.current = { view: showScheduleView, top: -1 };
    // 화면을 갈아탄 것이라면, 저쪽에서 보고 있던 시각을 그대로 이어준다.
    // (오갈 때마다 지금 시각으로 되돌리면 보던 자리를 매번 다시 찾아야 한다)
    const carried = viewAnchorRef.current;
    viewAnchorRef.current = null;
    if (carried != null) {
      const carriedTarget = showScheduleView
        // 타임블럭: 창 시작부터 몇 시간째인지로 눈금을 찾는다
        ? el.querySelectorAll('.schedule-hour-label')[Math.round((carried - windowStartMs) / 3600000)]
        // 채팅창: 그 시각 이후 첫 기록
        : [...el.querySelectorAll('[data-at]')].find(it => new Date(it.dataset.at).getTime() >= carried);
      if (carriedTarget) {
        const d = carriedTarget.getBoundingClientRect().top - el.getBoundingClientRect().top;
        el.scrollTop = Math.max(0, el.scrollTop + d - el.clientHeight / 3);
        autoScrollRef.current = { view: showScheduleView, top: el.scrollTop };
        lastScrollTopRef.current = el.scrollTop;
        // 방금 우리가 옮겨놓았으니 검산 없이 헤더를 맞춘다.
        // (안 그러면 scrollDayRef가 옛값에 머물러 이후 스크롤이 전부 막힌다)
        syncHeaderToScroll(el, true);
        return;
      }
    }
    const idx = windowDays.findIndex(d => isSameDay(d, selectedDate));
    // 어디로 갈지 모르면 아예 움직이지 않는다.
    // 예전엔 Math.max(0, idx)로 창의 첫 날(오늘-7일)로 보냈는데, 그게 바로
    // 8월 17일을 보다가 갑자기 8월 10일로 튀던 원인이다.
    if (idx < 0) return;
    if (showScheduleView) {
      // 타임블럭 기본 자리: 그 날의 가장 최근 기록을 화면 가운데로.
      // 채팅창은 최신 기록이 맨 아래에 보이는 화면이라, 여기로 넘어왔을 때
      // 같은 기록이 가운데 있어야 보던 콘텐츠가 이어진다.
      // 기록이 하나도 없으면 지금 시각(빨간 선)을 가운데로.
      let latest = null;
      for (const b of el.querySelectorAll('.schedule-block[data-at]')) {
        const at = new Date(b.dataset.at);
        if (!isSameDay(at, selectedDate)) continue;
        if (!latest || at >= new Date(latest.dataset.at)) latest = b;
      }
      const nowLine = isToday(selectedDate) ? el.querySelector('.schedule-now-line') : null;
      const centerTarget = latest || nowLine;
      if (centerTarget) {
        const r = centerTarget.getBoundingClientRect();
        // 긴 블록은 가운데 맞추면 시각·내용(맨 위)이 위로 잘려 아래만 보인다.
        // 화면 높이의 60%보다 크면 상단을 96px 아래에 두고, 아니면 가운데.
        const tall = r.height > el.clientHeight * 0.45;
        const delta = tall
          ? (r.top - el.getBoundingClientRect().top) - 96
          : (r.top + r.height / 2 - el.getBoundingClientRect().top) - el.clientHeight / 2;
        el.scrollTop = Math.max(0, el.scrollTop + delta);
        autoScrollRef.current = { view: showScheduleView, top: el.scrollTop };
        scrollDayRef.current = idx;
        lastScrollTopRef.current = el.scrollTop;
        paintHeaderDay(idx, 0);
        return;
      }
    }
    // 채팅창에서 오늘을 보는 기본 자리는 맨 아래(최신 기록) — 메신저와 같다.
    // 오늘의 첫 기록으로 잡으면 돌아올 때마다 최신까지 다시 내려야 한다 (8/25).
    if (!showScheduleView && isToday(selectedDate)) {
      const spacer = el.querySelector('.timeline-bottom-space');
      el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight - (spacer?.offsetHeight ?? 0) + 28);
      autoScrollRef.current = { view: showScheduleView, top: el.scrollTop };
      scrollDayRef.current = idx;
      lastScrollTopRef.current = el.scrollTop;
      paintHeaderDay(idx, 0);
      return;
    }
    const nowLine = isToday(selectedDate) ? el.querySelector('.schedule-now-line') : null;
    const target = nowLine || el.querySelector(`[data-day-index="${idx}"]`);
    if (!target) return;
    const delta = target.getBoundingClientRect().top - el.getBoundingClientRect().top;
    // 지금 시각은 화면 위 1/3 지점에 두어야 앞뒤가 같이 보인다
    el.scrollTop = Math.max(0, el.scrollTop + delta - (nowLine ? el.clientHeight / 3 : 0));
    // 방금 맞춰둔 자리를 기록해 둔다 (다음에 이 화면으로 돌아왔을 때 기준이 된다)
    autoScrollRef.current = { view: showScheduleView, top: el.scrollTop };
    scrollDayRef.current = idx;
    lastScrollTopRef.current = el.scrollTop;
    paintHeaderDay(idx, 0);
  });

  // 메모 내용/날짜에 적용되는 습관 키워드 찾기 (종료된 키워드는 종료일 이전 기록에만 적용)
  const habitMatchFor = (content, iso) => {
    const dateKey = format(new Date(iso), 'yyyy-MM-dd');
    return habitKeywords.find(k => k?.name && content.includes(k.name) && (!k.endedAt || dateKey < k.endedAt));
  };

  // ── 시간대별 그룹핑 ──────────────────────────────────────────
  function groupMemosByHour(memoList) {
    const groups = [];
    let currentHour = null;
    let currentGroup = [];

    memoList.forEach(memo => {
      const hour = new Date(memo.recordedAt).getHours();
      if (hour !== currentHour) {
        if (currentGroup.length > 0) groups.push(currentGroup);
        currentHour = hour;
        currentGroup = [memo];
      } else {
        currentGroup.push(memo);
      }
    });
    if (currentGroup.length > 0) groups.push(currentGroup);
    return groups;
  }

  // ── Undo 삭제 ────────────────────────────────────────────────
  const handleDeleteWithUndo = useCallback(async (memo) => {
    // 스크롤 위치 저장
    scrollPositionRef.current = timelineRef.current?.scrollTop ?? null;

    // 기존 Undo 취소
    if (undoToast?.timer) clearTimeout(undoToast.timer);

    // 낙관적 삭제 (로컬에서 먼저 제거)
    setMemos(prev => prev.filter(m => m.id !== memo.id));

    const timer = setTimeout(async () => {
      // 체험 모드는 브라우저에서만 지우면 끝
      if (isGuest) {
        saveGuestRows(loadGuestRows().filter(r => r.id !== memo.id));
        setUndoToast(null);
        return;
      }
      // 5초 후 실제 삭제
      const { error } = await supabase.from('memos').delete().eq('id', memo.id);
      if (error) {
        console.error('Error deleting memo:', error);
        setMemos(prev => [...prev, memo].sort((a, b) => new Date(a.recordedAt) - new Date(b.recordedAt)));
      }
      setUndoToast(null);
    }, 5000);

    setUndoToast({ memo, timer });
  }, [isGuest, undoToast]);

  const handleUndo = useCallback(async () => {
    if (!undoToast) return;
    clearTimeout(undoToast.timer);
    // 메모 복원 (낙관적으로 이미 제거됐으므로 다시 추가)
    setMemos(prev => [...prev, undoToast.memo].sort((a, b) => new Date(a.recordedAt) - new Date(b.recordedAt)));
    setUndoToast(null);
    scrollPositionRef.current = null;
  }, [undoToast]);

  // ── 인증 ─────────────────────────────────────────────────────
  const handleAuthSubmit = async (e) => {
    e.preventDefault();
    setAuthError('');
    if (!authEmail.trim() || !authPassword.trim()) {
      setAuthError('이메일과 비밀번호를 입력해주세요.');
      return;
    }
    if (authView === 'signup' ? !EMAIL_SIGNUP_ENABLED : !EMAIL_LOGIN_ENABLED) {
      setAuthError('지금은 구글 계정으로만 이용할 수 있어요.');
      return;
    }
    if (authView === 'signup') {
      if (authPassword !== authConfirmPassword) {
        setAuthError('비밀번호가 일치하지 않습니다.');
        return;
      }
      const hasLetter = /[A-Za-z]/.test(authPassword);
      const hasNumber = /\d/.test(authPassword);
      const hasSpecial = /[^A-Za-z0-9]/.test(authPassword);
      const hasSpace = /\s/.test(authPassword);
      const isLengthValid = authPassword.length >= 8 && authPassword.length <= 16;
      if (hasSpace) {
        setAuthError('비밀번호에 공백을 포함할 수 없습니다.');
        return;
      }
      if (!isLengthValid || !hasLetter || !hasNumber || !hasSpecial) {
        setAuthError('영문, 숫자, 특수문자를 포함하여 8자리 이상 16자리 이하로 설정해 주세요.');
        return;
      }
    }
    setSubmittingAuth(true);
    try {
      if (authView === 'signup') {
        const { data, error } = await supabase.auth.signUp({
          email: authEmail,
          password: authPassword,
          options: { emailRedirectTo: window.location.origin }
        });
        if (error) throw error;
        // 이미 가입된 이메일이면 identities가 빈 배열로 반환됨
        if (data.user && data.user.identities && data.user.identities.length === 0) {
          setAuthError('이미 가입된 이메일입니다.');
          return;
        }
        track('Signed Up', { method: 'email' });
        // 인증 메일 발송됨 화면으로 (재발송 위해 authEmail은 유지)
        setAuthView('emailVerification');
        setAuthPassword('');
        setAuthConfirmPassword('');
      } else {
        setRememberMe(rememberMe);
        const { error } = await supabase.auth.signInWithPassword({
          email: authEmail,
          password: authPassword
        });
        if (error) throw error;
        setAuthEmail('');
        setAuthPassword('');
        setAuthConfirmPassword('');
      }
    } catch (error) {
      console.error('인증 에러:', error.message, error);
      const msg = error.message || '';
      let errorMsg;
      if (msg.includes('Invalid login credentials')) errorMsg = '이메일 또는 비밀번호가 올바르지 않습니다.';
      else if (msg.includes('Email not confirmed')) errorMsg = '이메일 인증이 완료되지 않았습니다. 받은편지함의 인증 링크를 클릭해주세요.';
      else if (msg.includes('already registered')) errorMsg = '이미 가입된 이메일입니다.';
      else if (msg.toLowerCase().includes('invalid') && msg.toLowerCase().includes('email')) errorMsg = '유효하지 않은 이메일 형식입니다.';
      else if (msg.includes('rate limit') || msg.includes('Too many') || msg.includes('seconds')) errorMsg = '너무 많은 요청을 보냈습니다. 잠시 후 다시 시도해주세요.';
      else if (msg.includes('Password should')) errorMsg = '비밀번호 강도가 너무 약합니다. (최소 8자리)';
      else errorMsg = '인증에 실패했습니다. 다시 시도해주세요.';
      setAuthError(errorMsg);
    } finally {
      setSubmittingAuth(false);
    }
  };

  const handleForgotPassword = async (e) => {
    e.preventDefault();
    setForgotEmailError('');
    setForgotEmailSent(false);
    if (!forgotEmail.trim()) {
      setForgotEmailError('이메일을 입력해주세요.');
      return;
    }
    setSubmittingAuth(true);
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(forgotEmail, {
        redirectTo: `${window.location.origin}/?mode=resetPassword`
      });
      if (error) throw error;
      setForgotEmailSent(true);
      setForgotEmail('');
    } catch (error) {
      const msg = error.message || '';
      let errorMsg;
      if (msg.toLowerCase().includes('invalid')) errorMsg = '유효하지 않은 이메일 형식입니다.';
      else if (msg.includes('rate limit') || msg.includes('seconds')) errorMsg = '잠시 후 다시 시도해주세요.';
      else errorMsg = '비밀번호 재설정 이메일 발송에 실패했습니다.';
      setForgotEmailError(errorMsg);
    } finally {
      setSubmittingAuth(false);
    }
  };

  const handleResendVerificationEmail = async () => {
    if (!authEmail) return;
    setSubmittingAuth(true);
    try {
      const { error } = await supabase.auth.resend({
        type: 'signup',
        email: authEmail,
        options: { emailRedirectTo: window.location.origin }
      });
      if (error) throw error;
      setAuthError('');
      alert('인증 이메일이 재발송되었습니다.');
    } catch (error) {
      setAuthError('인증 이메일 발송에 실패했습니다. 잠시 후 다시 시도해주세요.');
    } finally {
      setSubmittingAuth(false);
    }
  };

  // ── 기록 편집 시트 ───────────────────────────────────────────
  // 채팅창(시각/말풍선)과 타임블럭(블록) 어디서 열어도 같은 시트, 같은 기능이다.

  // 이 기록이 화면에서 차지하는 구간 [시작, 끝].
  // 두 화면이 같은 값을 보여주도록 타임블럭을 그릴 때와 똑같은 규칙으로 계산한다.
  // patched를 주면 그 값을 적용했을 때의 구간을 미리 계산해준다.
  const blockRangeOf = (memo, patched) => {
    const target = patched ? { ...memo, ...patched } : memo;
    const sorted = timelineMemos
      .map(m => (m.id === target.id ? target : m))
      .sort((a, b) => new Date(a.recordedAt) - new Date(b.recordedAt));
    const block = buildDayBlocks(sorted, {
      dayStartMs, nowMs: nowTime.getTime(), gridMinutes: windowMinutes,
    }).find(b => b.memo.id === target.id);
    if (!block) {
      const own = new Date(target.recordedAt).getTime();
      return { start: new Date(own), end: new Date(own + MIN_BLOCK_MINUTES * 60000) };
    }
    return {
      start: new Date(dayStartMs + block.startPos * 60000),
      end: new Date(dayStartMs + block.endPos * 60000),
    };
  };

  const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

  const openBlockEditor = (memo) => {
    const range = isRangeMemo(memo);
    const { start, end } = blockRangeOf(memo);
    // 순간짜리는 적은 시각 하나만 보여준다 (블록으로 그릴 때 붙는 기본 30분은 시각이 아니다)
    const startStr = range ? hhmm(start) : hhmm(new Date(memo.recordedAt));
    // 새벽(0~2시) 기록은 '전날 밤'의 기록이다 — 채팅·위클리와 같은 규칙.
    // 저장된 날짜(다음날)를 그대로 보여주면, 어제 페이지에서 쓴 기록의 시간을
    // 고쳤을 뿐인데 오늘로 옮겨져버린다.
    const own = new Date(memo.recordedAt);
    const nightBase = own.getHours() < 2 ? addDays(own, -1) : own;
    const snapshot = {
      date: format(nightBase, 'yyyy-MM-dd'),
      start: startStr,
      end: hhmm(end),
      mode: range ? 'range' : 'moment',
      autoStart: isAutoStart(memo),
      autoEnd: isAutoEnd(memo),
    };
    setEditingMemo(memo);
    setEditContentStr(memo.content);
    setEditMemoColor(memo.color || 'default');
    setEditDateStr(snapshot.date);
    setEditStartStr(snapshot.start);
    setEditEndStr(snapshot.end);
    setEditMode(snapshot.mode);
    setEditSpansFromPrev(snapshot.autoStart);
    setEditSpansToNext(snapshot.autoEnd);
    setEditInitial(snapshot);
    setOpenTimeWheel(null);
  };

  // 한 순간 ↔ 구간 전환. 저장을 눌러야 반영된다.
  const switchEditMode = (mode) => {
    if (mode === editMode) return;
    if (mode === 'range') {
      // 구간으로 바꾸면 적은 시각부터 30분짜리로 시작한다
      const [h, m] = editStartStr.split(':').map(Number);
      const end = new Date(0);
      end.setHours(h, m + MIN_BLOCK_MINUTES, 0, 0);
      setEditEndStr(hhmm(end));
    }
    // 순간으로 돌아가면 종료 칸이 사라진다 — 열려 있던 종료 휠도 같이 닫는다
    if (mode === 'moment') setOpenTimeWheel(w => (w === 'end' ? null : w));
    setEditMode(mode);
  };

  const closeBlockEditor = () => {
    setEditingMemo(null);
    setEditInitial(null);
    setOpenTimeWheel(null);
  };

  // 기록 한 건을 고쳐 쓴다. 체험 모드는 서버 대신 브라우저에 쓴다.
  const writeMemoFields = async (memoId, dbFields, localFields) => {
    if (isGuest) {
      patchGuestRow(memoId, dbFields);
    } else {
      const { error } = await supabase.from('memos').update(dbFields).eq('id', memoId);
      if (error) {
        console.error('Error updating memo:', error);
        alert('변경에 실패했습니다. 잠시 후 다시 시도해주세요.');
        return false;
      }
    }
    setMemos(prev => prev.map(m => m.id === memoId ? { ...m, ...localFields } : m)
      .sort((a, b) => new Date(a.recordedAt) - new Date(b.recordedAt)));
    setEditingMemo(m => (m && m.id === memoId ? { ...m, ...localFields } : m));
    return true;
  };

  // '이전 기록부터 / 다음 기록까지 자동으로 잇기' 토글 — 초안만 바꾼다 (저장해야 반영).
  // 직접 정한 시각과 배타적이라, 켜면 그 칸은 자동 계산값을 보여주고 잠긴다.
  const toggleDraftSpansFromPrev = () => {
    const next = !editSpansFromPrev;
    setEditSpansFromPrev(next);
    if (next && editingMemo) {
      // 켜면 시작이 어떻게 계산될지 미리 보여준다
      const { start } = blockRangeOf(editingMemo, { spansFromPrev: true, backMinutes: 0 });
      setEditStartStr(hhmm(start));
      setOpenTimeWheel(w => (w === 'start' ? null : w));
    }
  };

  const toggleDraftSpansToNext = () => {
    const next = !editSpansToNext;
    setEditSpansToNext(next);
    if (next && editingMemo) {
      const { end } = blockRangeOf(editingMemo, { spansToNext: true, endMinutes: 0 });
      setEditEndStr(hhmm(end));
      setOpenTimeWheel(w => (w === 'end' ? null : w));
    }
  };

  const saveBlockEdit = async () => {
    const memo = editingMemo;
    if (!memo || !editContentStr.trim()) return;
    const init = editInitial || {};

    const dbFields = { content: editContentStr, color: editMemoColor };
    const localFields = { content: editContentStr, color: editMemoColor };

    const dateChanged = editDateStr !== init.date;
    const startChanged = editStartStr !== init.start;
    const endChanged = editEndStr !== init.end;
    const modeChanged = editMode !== init.mode;
    // 자동 잇기 체크박스도 초안이라 저장 시점에 비교한다
    const autoStartChanged = editMode === 'range' && editSpansFromPrev !== !!init.autoStart;
    const autoEndChanged = editMode === 'range' && editSpansToNext !== !!init.autoEnd;
    const timeTouched = dateChanged || startChanged || endChanged || modeChanged || autoStartChanged || autoEndChanged;
    const toMin = (str) => { const [h, m] = str.split(':').map(Number); return h * 60 + m; };
    // 시트의 날짜는 '그 밤의 날짜'다. 0~2시 시각은 그 날짜의 밤 = 다음날 새벽으로 저장한다.
    // (열 때 새벽 기록의 날짜를 전날로 보여주는 것과 짝이 맞아야 시간만 고쳐도 날짜가 안 튄다)
    const nightMin = (min) => (min < 120 ? min + 1440 : min);
    const canWriteTime = editDateStr && editStartStr && (editMode === 'moment' || editEndStr);

    if (timeTouched && canWriteTime) {
      const [y, mo, d] = editDateStr.split('-').map(Number);

      if (editMode === 'moment') {
        // 한 순간짜리는 늘린 흔적을 전부 지운다. 적은 시각 하나만 남는다.
        const startMin = nightMin(toMin(editStartStr));
        dbFields.recorded_at = new Date(y, mo - 1, d, 0, startMin, 0, 0).toISOString();
        dbFields.back_minutes = 0;
        dbFields.end_minutes = 0;
        dbFields.spans_from_prev = false;
        dbFields.spans_to_next = false;
        localFields.recordedAt = dbFields.recorded_at;
        localFields.backMinutes = 0;
        localFields.endMinutes = 0;
        localFields.spansFromPrev = false;
        localFields.spansToNext = false;
      } else {
        const startMin = nightMin(toMin(editStartStr));
        let endMin = nightMin(toMin(editEndStr));
        if (endMin < startMin) endMin += 1440; // 자정을 넘긴 구간

        // '적은 순간'은 그대로 두되, 구간 밖으로 밀려나면 안쪽으로 끌어온다.
        // 채팅창 말풍선에 찍히는 시각이 이 값이라 함부로 옮기지 않는다.
        // 새벽에 적은 순간도 같은 밤 기준(전날 0시부터 몇 분)으로 재야 하루씩 안 밀린다.
        const own = new Date(memo.recordedAt);
        const ownWas = nightMin(own.getHours() * 60 + own.getMinutes());
        const ownMin = Math.min(Math.max(ownWas, startMin), endMin);
        // 기준점이 옮겨졌으면 앞뒤 길이를 둘 다 다시 재야 한다
        const ownMoved = ownMin !== ownWas;

        if (dateChanged || ownMoved || modeChanged) {
          dbFields.recorded_at = new Date(y, mo - 1, d, 0, ownMin, 0, 0).toISOString();
          localFields.recordedAt = dbFields.recorded_at;
        }
        // 손댄 쪽만 바꾼다. 시작만 고쳤는데 자동으로 따라가던 종료까지 굳어버리면
        // 사용자가 하지도 않은 결정을 대신 내린 셈이 된다.
        if (autoStartChanged || startChanged || ownMoved || modeChanged) {
          if (editSpansFromPrev) {
            // 자동 잇기를 켠 채 저장 — 시작은 이전 기록을 따라간다
            dbFields.spans_from_prev = true;
            dbFields.back_minutes = 0;
            localFields.spansFromPrev = true;
            localFields.backMinutes = 0;
          } else {
            // 직접 정한 시각이 자동 규칙을 이긴다.
            // 켜둔 채로 두면 이전 기록을 옮길 때 방금 정한 값이 되돌아간다.
            dbFields.back_minutes = ownMin - startMin;
            dbFields.spans_from_prev = false;
            localFields.backMinutes = dbFields.back_minutes;
            localFields.spansFromPrev = false;
          }
        }
        if (autoEndChanged || endChanged || ownMoved || modeChanged) {
          if (editSpansToNext) {
            dbFields.spans_to_next = true;
            dbFields.end_minutes = 0;
            localFields.spansToNext = true;
            localFields.endMinutes = 0;
          } else {
            dbFields.end_minutes = endMin - ownMin;
            dbFields.spans_to_next = false;
            localFields.endMinutes = dbFields.end_minutes;
            localFields.spansToNext = false;
          }
        }
      }
    }

    const ok = await writeMemoFields(memo.id, dbFields, localFields);
    if (!ok) return;
    track('Memo Edited', {
      changed: 'block',
      content_changed: memo.content !== editContentStr,
      color_changed: (memo.color || 'default') !== editMemoColor,
      time_changed: timeTouched,
      date_changed: dateChanged,
      // 순간짜리를 구간으로 바꾸는 일이 실제로 얼마나 일어나는지
      mode: editMode,
      mode_changed: modeChanged,
    });
    closeBlockEditor();
  };

  const deleteFromBlockEditor = () => {
    const memo = editingMemo;
    closeBlockEditor();
    if (memo) handleDeleteWithUndo(memo);
  };

  const handleResetPasswordSubmit = async (e) => {
    e.preventDefault();
    setResetError('');
    if (!resetNewPw.trim() || !resetConfirmPw.trim()) {
      setResetError('새 비밀번호를 입력해주세요.');
      return;
    }
    if (resetNewPw !== resetConfirmPw) {
      setResetError('비밀번호가 일치하지 않습니다.');
      return;
    }
    const hasLetter = /[A-Za-z]/.test(resetNewPw);
    const hasNumber = /\d/.test(resetNewPw);
    const hasSpecial = /[^A-Za-z0-9]/.test(resetNewPw);
    const hasSpace = /\s/.test(resetNewPw);
    const isLengthValid = resetNewPw.length >= 8 && resetNewPw.length <= 16;
    if (hasSpace) {
      setResetError('비밀번호에 공백을 포함할 수 없습니다.');
      return;
    }
    if (!isLengthValid || !hasLetter || !hasNumber || !hasSpecial) {
      setResetError('영문, 숫자, 특수문자를 포함하여 8자리 이상 16자리 이하로 설정해 주세요.');
      return;
    }
    setResetSubmitting(true);
    try {
      // 재설정 링크를 클릭하면 임시 로그인된 상태이므로 바로 비밀번호 변경 가능
      const { error } = await supabase.auth.updateUser({ password: resetNewPw });
      if (error) throw error;
      setResetSuccess(true);
      setResetNewPw('');
      setResetConfirmPw('');
    } catch (error) {
      const msg = error.message || '';
      let errorMsg;
      if (msg.includes('session') || msg.includes('missing')) errorMsg = '비밀번호 재설정 링크가 만료되었습니다. 다시 요청해주세요.';
      else if (msg.includes('different from')) errorMsg = '기존과 다른 비밀번호를 입력해주세요.';
      else if (msg.includes('Password should')) errorMsg = '비밀번호 강도가 너무 약합니다.';
      else errorMsg = '비밀번호 재설정에 실패했습니다. 다시 시도해주세요.';
      setResetError(errorMsg);
    } finally {
      setResetSubmitting(false);
    }
  };

  const handlePasswordChange = async () => {
    setPasswordChangeError('');
    if (!currentPw.trim() || !newPw.trim() || !confirmNewPw.trim()) {
      setPasswordChangeError('모든 항목을 입력해주세요.');
      return;
    }
    if (newPw !== confirmNewPw) {
      setPasswordChangeError('새 비밀번호가 일치하지 않습니다.');
      return;
    }
    const hasLetter = /[A-Za-z]/.test(newPw);
    const hasNumber = /\d/.test(newPw);
    const hasSpecial = /[^A-Za-z0-9]/.test(newPw);
    const hasSpace = /\s/.test(newPw);
    const isLengthValid = newPw.length >= 8 && newPw.length <= 16;
    if (hasSpace) {
      setPasswordChangeError('비밀번호에 공백을 포함할 수 없습니다.');
      return;
    }
    if (!isLengthValid || !hasLetter || !hasNumber || !hasSpecial) {
      setPasswordChangeError('영문, 숫자, 특수문자를 포함하여 8자리 이상 16자리 이하로 설정해 주세요.');
      return;
    }
    setChangingPassword(true);
    try {
      // 현재 비밀번호 확인 (재로그인으로 검증)
      const { error: reauthError } = await supabase.auth.signInWithPassword({
        email: currentUser.email,
        password: currentPw
      });
      if (reauthError) {
        setPasswordChangeError('현재 비밀번호가 올바르지 않습니다.');
        return;
      }
      const { error } = await supabase.auth.updateUser({ password: newPw });
      if (error) throw error;
      setPasswordChangeSuccess(true);
      setCurrentPw('');
      setNewPw('');
      setConfirmNewPw('');
      setTimeout(() => {
        setShowPasswordChange(false);
        setPasswordChangeSuccess(false);
      }, 2000);
    } catch (error) {
      const msg = error.message || '';
      let errorMsg;
      if (msg.includes('different from')) errorMsg = '기존과 다른 비밀번호를 입력해주세요.';
      else if (msg.includes('Password should')) errorMsg = '비밀번호 강도가 너무 약합니다.';
      else errorMsg = '비밀번호 변경에 실패했습니다.';
      setPasswordChangeError(errorMsg);
    } finally {
      setChangingPassword(false);
    }
  };

  // 처음 구글 로그인을 누르면 동의부터. 이미 동의한 기기(또는 로그인 상태)는 바로 진행.
  const requestGoogleSignIn = () => {
    if (currentUser || localStorage.getItem(CONSENT_KEY)) { handleGoogleSignIn(); return; }
    track('Consent', { action: 'shown' });
    setShowConsent(true);
  };
  const agreeAndSignIn = () => {
    try { localStorage.setItem(CONSENT_KEY, JSON.stringify({ at: new Date().toISOString(), version: CONSENT_VERSION })); } catch { /* 무시 */ }
    track('Consent', { action: 'agreed' });
    setShowConsent(false);
    handleGoogleSignIn();
  };
  const handleGoogleSignIn = async () => {
    setSubmittingAuth(true);
    setAuthError('');
    try {
      setRememberMe(rememberMe);
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: window.location.origin }
      });
      if (error) throw error;
      // 구글 로그인 페이지로 이동되므로 이후 코드는 실행되지 않음
    } catch (error) {
      setAuthError('구글 로그인에 실패했습니다. 다시 시도해주세요.');
      setSubmittingAuth(false);
    }
  };

  const handleDeleteAccount = async () => {
    if (!currentUser) return;
    if (!window.confirm('정말 회원탈퇴를 진행하시겠습니까?\n작성하신 모든 메모가 영구적으로 삭제되며 이 작업은 복구할 수 없습니다.')) return;
    setDeletingAccount(true);
    try {
      // 계정 삭제 (메모/설정은 DB에서 자동으로 함께 삭제됨)
      const { error } = await supabase.rpc('delete_user');
      if (error) throw error;
      await supabase.auth.signOut();
      alert('회원탈퇴가 정상적으로 완료되었습니다.');
      setShowMyPage(false);
    } catch (error) {
      alert(`회원탈퇴 중 오류가 발생했습니다: ${error.message}`);
    } finally {
      setDeletingAccount(false);
    }
  };

  // ── 메모 추가 ────────────────────────────────────────────────
  // mode: 'single'(기본) | 'prev'(이전 기록부터) | 'next'(다음 기록까지)
  const handleAddMemo = async (e, mode = 'single') => {
    e?.preventDefault();
    if (!inputText.trim()) return;
    // 투어 중에도 진짜로 저장한다 — 온보딩에서 쓴 것이 곧 첫 기록이다
    const now = new Date();
    // 글 앞머리에 시각을 적으면 그 시각의 기록으로 남긴다.
    // "11시 40분 밥 먹음" → 11:40 단일, "11:30~2:30 수영함" → 구간.
    const timed = parseTimePrefix(inputText.trim(), now);
    // 보고 있는 날짜에 기록한다: 다른 날짜 페이지에서 쓰면 '그 날짜 + 지금 시각'.
    // (과거 날짜로 일부러 옮겨 와서 쓰는 데는 이유가 있다 — 오늘로 끌고 가지 않는다)
    // 예외: 자정~새벽 2시에 어제 페이지에서 쓰는 건 아직 '그 밤'을 쓰는 것이라
    // 실제 시각(오늘 새벽)으로 남긴다. 어제 화면에도 새벽 기록으로 이어 보인다.
    let recordAt = now;
    if (timed) {
      // 시각을 직접 적었으면 보고 있는 날짜의 그 시각으로. (새벽 예외보다 명시가 우선)
      recordAt = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), selectedDate.getDate());
      recordAt.setMinutes(timed.startMin);
    } else if (!isSameDay(selectedDate, now)) {
      const sameNightDawn = now.getHours() < 2 && isSameDay(selectedDate, addDays(now, -1));
      if (!sameNightDawn) {
        recordAt = new Date(
          selectedDate.getFullYear(), selectedDate.getMonth(), selectedDate.getDate(),
          now.getHours(), now.getMinutes(), now.getSeconds(), now.getMilliseconds()
        );
      }
    }
    const newMemoData = {
      user_id: currentUser?.id,
      content: timed ? timed.content : inputText,
      color: selectedColor,
      recorded_at: recordAt.toISOString(),
      spans_from_prev: !timed && mode === 'prev',
      spans_to_next: !timed && mode === 'next',
      // 구간으로 적었으면 끝 시각을 직접 정한 것과 같다
      end_minutes: timed?.kind === 'range' ? timed.durationMin : 0,
    };
    justAddedRef.current = newMemoData.recorded_at;
    // 시간표뷰: 등록하면 키보드를 내린다. 키보드가 떠 있으면 판이 눌려 방금 넣은
    // 기록이 가려지고 '오늘로' 버튼이 겹친다. 채팅뷰는 이어서 적는 흐름이라 그대로 둔다.
    if (showScheduleView) inputRef.current?.blur();
    setInputText('');
    setPromptIdx(i => (i + 1) % INPUT_PROMPTS.length);
    // 여러 줄로 자라 있던 입력칸을 한 줄로 되돌린다
    if (inputRef.current) inputRef.current.style.height = 'auto';

    // 체험 모드: 서버 대신 브라우저에 담는다
    if (isGuest) {
      const row = { ...newMemoData, id: newGuestId() };
      delete row.user_id;
      saveGuestRows([...loadGuestRows(), row]);
      const memo = rowToMemo(row);
      setMemos(prev => [...prev, memo].sort((a, b) => new Date(a.recordedAt) - new Date(b.recordedAt)));
      trackMemoCreated(row.content, {
        source: 'direct',
        gesture: mode === 'prev' ? 'from_prev' : mode === 'next' ? 'to_next' : 'single',
        // 앞머리에 시각을 적어 남긴 기록인지 (none | single | range)
        time_prefix: timed?.kind ?? 'none',
        // "온보딩 진입 시 실제로 입력했는지"를 보는 축
        during_onboarding: tour.active,
      });
      if (tour.active) afterTourSend(memo, mode);
      return;
    }

    const { data, error } = await supabase.from('memos').insert(newMemoData).select().single();
    if (error) {
      console.error('Error adding memo:', error);
      alert('메모 저장에 실패했습니다. 잠시 후 다시 시도해주세요.');
      return;
    }
    trackMemoCreated(newMemoData.content, {
      source: 'direct',
      // 짧게 탭 / 위로 끌기 / 아래로 끌기 — 제스처가 실제로 쓰이는지 보려는 값
      gesture: mode === 'prev' ? 'from_prev' : mode === 'next' ? 'to_next' : 'single',
      time_prefix: timed?.kind ?? 'none',
      during_onboarding: tour.active,
    });
    // 바로 화면에 반영 (실시간 이벤트가 오면 중복은 무시됨)
    const memo = rowToMemo(data);
    setMemos(prev => prev.some(m => m.id === memo.id) ? prev : [...prev, memo].sort((a, b) => new Date(a.recordedAt) - new Date(b.recordedAt)));
    if (tour.active) afterTourSend(memo, mode);
  };

  // 기록 하나가 만들어질 때 보내는 공통 이벤트.
  // 내용 자체는 절대 보내지 않고, 거기서 뽑은 성격만 보낸다.
  const trackMemoCreated = (content, extra) => {
    const fin = parseFinance(content);
    // 이 사람의 '첫 기록'인지. 이 이벤트가 찍힌 시각이 곧 첫 기록 시각이다.
    // 프로필(people)이 아니라 이벤트에 다는 이유: 쓰는 사람 대부분이 비로그인이고,
    // 비로그인은 프로필을 만들 수 없다(기기마다 새로 생기는 익명 id라 사람이 안 묶인다).
    // 이벤트에 달면 로그인 여부와 상관없이 다 잡히고, guest 속성으로 나눠 볼 수 있다.
    // memos는 그 사람의 전체 기록이고 이 시점엔 아직 새 기록이 안 들어가 있다.
    const isFirstMemo = memos.length === 0;
    // 요약 카드를 실제로 본 뒤에 남긴 기록인지. 카드가 다음 기록을 부르는지 보려는 값이다.
    const afterSummary = summaryViewedRef.current.has(dateKeyOf(selectedDate));
    if (afterSummary) {
      track('record_created_after_summary', { guest: isGuest, memo_count_before: memos.length, source: extra?.source ?? 'direct' });
    }
    track('Memo Created', {
      after_summary: afterSummary,
      // 온보딩(투어)을 끝내거나 건너뛴 뒤에 쓴 기록인지 — "온보딩이 첫 기록을 늘리나"를 보는 축
      onboarded: localStorage.getItem(ONBOARDING_KEY) === '1',
      // 로그인 전 체험 중에 쓴 것인지. 체험만 하고 떠나는 비율을 보려면 필요하다
      guest: isGuest,
      is_first_memo: isFirstMemo,
      // 이 기록을 쓰기 직전까지 이 사람이 갖고 있던 기록 수 = 이게 몇 번째 기록인지.
      // 이게 없으면 "사람들이 몇 개째에서 멈추나"를 Mixpanel에서 알 수 없다.
      // (이벤트 수만 세면 많이 쓰는 한 명이 전체를 가려버린다)
      memo_count_before: memos.length,
      ...extra,
      hour: new Date().getHours(),
      content_length: content.length,
      has_expense: fin?.type === 'expense',
      has_income: fin?.type === 'income',
      has_habit_keyword: habitKeywords.some(k => k?.name && !k.endedAt && content.includes(k.name)),
      color: selectedColor,
    });
    // 로그인한 사람은 프로필에도 박아둔다. 가입일과 나란히 놓고
    // "가입하고 얼마 만에 첫 기록을 썼나"를 사람 단위로 자를 때 쓴다.
    // (비로그인은 위의 is_first_memo 이벤트 쪽으로 본다)
    if (!isGuest && isFirstMemo) markFirstMemo();
  };

  // ── 할 일 ───────────────────────────────────────────────────
  // 할 일 시트를 열면 커서를 이 입력창으로 데려온다.
  // 안 그러면 뒤에 가려진 채팅 입력창에 포커스가 남아 있어서, 커서는 엉뚱한 데서
  // 깜빡이고 친 글자는 보이지 않는 채팅창으로 들어간다.
  // (할 일 버튼은 키보드를 유지하려고 일부러 포커스를 안 뺏게 해뒀다)
  const todoInputRef = useRef(null);
  const todoListRef = useRef(null);
  useEffect(() => {
    if (!showTodoSheet) return;
    const keyboardUp = document.body.classList.contains('keyboard-open');
    if (keyboardUp) todoInputRef.current?.focus();
    // 키보드가 없던 상태면 굳이 띄우지 않는다. 대신 뒤쪽 입력창의 포커스는 뗀다
    else document.activeElement?.blur?.();
  }, [showTodoSheet]);

  // 적어둔 할 일의 내용을 고친다
  const [editingTodoId, setEditingTodoId] = useState(null);
  const [editingTodoText, setEditingTodoText] = useState('');

  const startEditTodo = (todo) => {
    setEditingTodoId(todo.id);
    setEditingTodoText(todo.content);
  };

  const commitEditTodo = async (todo) => {
    const text = editingTodoText.trim();
    setEditingTodoId(null);
    if (!text || text === todo.content) return;
    setTodos(prev => prev.map(t => (t.id === todo.id ? { ...t, content: text } : t)));
    const { error } = await supabase.from('todos').update({ content: text }).eq('id', todo.id);
    if (error) {
      console.error('Error updating todo:', error);
      setTodos(prev => prev.map(t => (t.id === todo.id ? { ...t, content: todo.content } : t)));
      return;
    }
    track('Todo Action', { action: 'edited' });
  };

  const handleAddTodo = async (e) => {
    e?.preventDefault();
    const text = todoInput.trim();
    if (!text || !currentUser) return;
    setTodoInput('');
    const { data, error } = await supabase
      .from('todos')
      .insert({ user_id: currentUser.id, content: text })
      .select()
      .single();
    if (error) {
      console.error('Error adding todo:', error);
      setTodoInput(text); // 입력한 내용은 돌려준다
      return;
    }
    setTodos(prev => prev.some(t => t.id === data.id) ? prev : sortTodos([...prev, data]));
    // 방금 적은 게 목록 아래에 가려지면 '등록이 안 됐나' 싶다. 그쪽으로 보내준다
    requestAnimationFrame(() => {
      const list = todoListRef.current;
      if (list) list.scrollTop = list.scrollHeight;
    });
    track('Todo Action', { action: 'added', open_count: todos.filter(t => !t.done).length + 1 });
  };

  // silent: 기록으로 옮기면서 자동 완료되는 경우. 그때는 'moved_to_memo'로 한 번만 세야 해서 여기선 안 보낸다
  const handleToggleTodo = async (todo, { silent = false } = {}) => {
    const next = !todo.done;
    setTodos(prev => sortTodos(prev.map(t => (t.id === todo.id ? { ...t, done: next } : t))));
    const { error } = await supabase.from('todos').update({ done: next }).eq('id', todo.id);
    if (error) {
      console.error('Error toggling todo:', error);
      setTodos(prev => prev.map(t => (t.id === todo.id ? { ...t, done: todo.done } : t)));
      return;
    }
    if (!silent) track('Todo Action', { action: next ? 'completed' : 'reopened' });
  };

  const handleDeleteTodo = async (todo) => {
    setTodos(prev => prev.filter(t => t.id !== todo.id));
    const { error } = await supabase.from('todos').delete().eq('id', todo.id);
    if (error) {
      console.error('Error deleting todo:', error);
      setTodos(prev => [...prev, todo]);
      return;
    }
    track('Todo Action', { action: 'deleted', was_done: todo.done });
  };

  // 할 일을 지금 시각의 기록으로 옮긴다. 옮기면 그 할 일은 완료 처리.
  const handleTodoToMemo = async (todo) => {
    if (!currentUser) return;
    const now = new Date();
    if (!isSameDay(selectedDate, now)) goToDay(now);
    const { data, error } = await supabase
      .from('memos')
      .insert({
        user_id: currentUser.id,
        content: todo.content,
        color: selectedColor,
        recorded_at: now.toISOString(),
        spans_from_prev: false,
        spans_to_next: false,
      })
      .select()
      .single();
    if (error) {
      console.error('Error moving todo to memo:', error);
      return;
    }
    const memo = rowToMemo(data);
    setMemos(prev => prev.some(m => m.id === memo.id) ? prev : [...prev, memo].sort((a, b) => new Date(a.recordedAt) - new Date(b.recordedAt)));
    // 드래그 대신 버튼으로 타협한 동선이라, 이게 실제로 눌리는지가 이번 2주의 확인 대상
    track('Todo Action', { action: 'moved_to_memo' });
    trackMemoCreated(todo.content, { source: 'todo', gesture: 'single' });
    if (!todo.done) handleToggleTodo(todo, { silent: true });
  };

  // ── 이어서 기록 (버튼) ───────────────────────────────────────
  // 예전엔 보내기를 꾹 누른 채 위/아래로 끌어 골랐는데, 발견되지 않아 버튼으로 뺐다.
  // 입력창 위 칩에서 '이전 기록부터' 또는 '다음 기록까지'를 켜 두고 보내면 적용되고,
  // 보내고 나면 다시 단일로 돌아간다.
  // 앞머리에 적은 시각이 인식되면 그 부분에 색을 입힌다 (입력창 뒤에 깔린 거울 글자가 담당)
  const timePrefixLen = (() => {
    const m = inputText.match(PREFIX_RE);
    return m ? m[0].trimEnd().length : 0;
  })();
  // 입력창이 '활성' = 눌렀거나 글자가 있거나 투어 중. 이때만 버튼 줄이 펼쳐진다.
  const inputActive = inputFocused || !!inputText.trim() || tour.active;
  const sendButton = (
    <div className="send-wrap">
      <button
        type="button"
        className="send-btn"
        onMouseDown={e => e.preventDefault()}
        onClick={() => handleAddMemo(null)}
        disabled={!inputText.trim()}
        aria-label="보내기"
      >
        <Send size={18} />
      </button>
    </div>
  );
  const clockLabel = (ms) => {
    const d = new Date(ms);
    const h = d.getHours();
    return `${h < 12 ? '오전' : '오후'} ${h % 12 === 0 ? 12 : h % 12}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  // ── 투어 (움직이는 온보딩) ───────────────────────────────────
  // 사용자의 '진짜 입력'으로 진행한다: 첫 기록을 직접 쓰고 → 이어서('이전 기록부터' 칩) 하나 더 쓰고 →
  // 시간표에서 이어진 블록을 확인 → 샘플 3개가 얹혀 하루가 차면 → 회고 토스트 → 회고 탭 → AI 회고.
  // 여기서 쓴 두 기록은 진짜로 저장되어 첫 기록이 되고, 샘플만 끝나면 걷힌다.
  const startTour = (source) => {
    if (tour.active) return;
    const now = new Date();
    setSelectedDate(now);
    setActiveView('timeline');
    if (showScheduleView) toggleScheduleView();
    // 첫 기록은 '지금'이 아니라 몇 시간 전 일이어야 한다. 그래야 두 번째 기록(이어서, 지금까지)이
    // 그 뒤에 자연스럽게 쌓인다 — 지금 일을 먼저 쓰면 과거 기록이 위로 끼어들며 앞뒤가 꼬인다.
    // 3시간 전 시각을 입력창에 미리 적어두고, 사용자는 그 뒤에 텍스트만 잇는다.
    let prefillAt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() - 3, 0);
    if (prefillAt.getDate() !== now.getDate()) prefillAt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0); // 새벽엔 자정으로
    const h = prefillAt.getHours();
    const prefillLabel = `${h < 12 ? '오전' : '오후'} ${h % 12 === 0 ? 12 : h % 12}시`;
    setInputText(`${prefillLabel} `);
    setTour({ active: true, step: 0, aiStatus: 'idle', contIso: null, prefillLabel });
    track('Tour', { action: 'started', source, guest: isGuest });
    // 커서를 미리 적힌 시각 뒤에 (터치 기기는 키보드가 튀므로 제외)
    if (!IS_TOUCH_DEVICE) setTimeout(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }, 400);
  };
  const endTour = (action) => {
    setTour({ active: false, step: 0, aiStatus: 'idle', contIso: null });
    setInputText(''); // 미리 적어둔 시각이 남아 있으면 지운다
    // 샘플만 걷어낸다 — 사용자가 투어에서 직접 쓴 기록은 그대로 남아 첫 기록이 된다
    setMemos(prev => prev.filter(m => !String(m.id).startsWith('tour-')));
    setActiveView('timeline');
    if (showScheduleView) toggleScheduleView();
    localStorage.setItem(ONBOARDING_KEY, '1');
    track('Tour', { action, step: TOUR_STEPS[tour.step]?.key, index: tour.step, guest: isGuest });
    // 바로 써볼 수 있게 입력창에 포커스 (터치 기기는 키보드가 튀어오르므로 제외)
    if (!IS_TOUCH_DEVICE) setTimeout(() => inputRef.current?.focus(), 50);
  };
  // 샘플 기록을 하나씩 얹는다 (상태에만 — 저장소에는 안 쓴다)
  const addTourSample = (idx) => {
    const sample = makeTourSamples(new Date())[idx];
    if (!sample) return;
    setMemos(prev => prev.some(m => m.id === sample.id)
      ? prev
      : [...prev, sample].sort((a, b) => new Date(a.recordedAt) - new Date(b.recordedAt)));
  };
  // 사용자가 직접 누르며 진행한다. advance: 'button'(다음 버튼) | 'tap-target'(밝혀진 곳을 탭) |
  // 'auto'(정해진 시간 뒤 자동) | 'send'(실제로 기록을 저장하면) | 'wait'(앱 동작이 넘긴다)
  const TOUR_STEPS = [
    {
      key: 'type', target: '.input-area', place: 'above', pointer: null, advance: 'send',
      caption: `${tour.prefillLabel ?? '조금 전'}쯤엔 뭘 하고 있었나요? 적어둔 시간 뒤에 이어서 쓰고 보내보세요. 그 시각의 기록이 됩니다.`,
    },
    {
      // 이번엔 직접 적어야 하므로 입력 영역 전체를 열어두고, 탭 포인터만 '이전 기록부터' 칩 위에 앉힌다.
      key: 'cont', target: '.input-area', pointerTarget: '.link-chip--prev', place: 'above', offset: 12, pointer: 'tap', advance: 'send',
      caption: '그다음부터 지금까지는 뭘 했나요? 적은 다음, 「이전 기록부터」를 켜고 보내보세요. 앞 기록부터 지금까지 이어진 시간으로 저장돼요.',
    },
    {
      key: 'tab-schedule', target: '.bottom-tab-bar .tab-btn:nth-child(1)', place: 'above', pointer: 'tap', advance: 'tap-target',
      caption: '타임라인 탭을 눌러보세요.',
    },
    {
      // 시간표 화면을 깨끗하게 보여주되, 방금 이어서 쓴 진짜 블록만 '짠' 하고 강조한다
      key: 'schedule-look', target: tour.contIso ? `.schedule-block[data-at="${tour.contIso}"]` : '.schedule-block', place: 'below', pointer: null,
      advance: 'button', free: true, effect: 'pop',
      caption: '방금 이어서 쓴 기록이 앞 기록과 한 덩어리로 붙었어요. 하루가 이렇게 시간 위에 놓여요.',
    },
    {
      // 채팅으로 돌아와 샘플 기록이 뽕뽕뽕 얹힌다 — 하루가 차면 무엇이 생기는지 보여주기 위해
      key: 'samples', target: null, place: 'bottom', pointer: null, advance: 'auto', autoAfter: 2600, free: true,
      caption: '이렇게 하루를 몇 줄씩 남기면…',
      actions: [
        { at: 0, run: () => { if (showScheduleView) toggleScheduleView(); } },
        { at: 500, run: () => addTourSample(0) },
        { at: 1000, run: () => addTourSample(1) },
        { at: 1500, run: () => addTourSample(2) },
      ],
    },
    {
      key: 'review-toast', target: '.tour-toast', place: 'above', pointer: 'tap', advance: 'wait',
      caption: '기록이 쌓이면 회고가 열려요. 보기를 눌러보세요.',
    },
    {
      key: 'review-top', target: '.review-screen .shape', place: 'below', pointer: null, advance: 'button', free: true,
      caption: '오늘 기록한 시간과 하루의 리듬이 한눈에 보여요.',
      actions: [{ at: 50, run: () => { const el = appContainerRef.current?.querySelector('.review-screen'); if (el) el.scrollTop = 0; } }],
    },
    {
      // 회고 만들기 버튼을 직접 누르게 한다 (결과를 바로 보여주지 않는다)
      // 스크롤이 끝난 뒤에 포인터를 보여준다 — 스크롤 중 자리를 재면 포인터가 엉뚱한 곳(탭바)을 거쳐 온다
      key: 'review-btn', target: '.review-screen .day-summary--ai-gate .day-summary-btn', place: 'above', pointer: 'tap', advance: 'wait', settleMs: 450,
      caption: '오늘 회고 만들기를 눌러보세요. 회고는 구글 계정을 연동하면 쓸 수 있어요.',
      actions: [{ at: 0, run: () => appContainerRef.current?.querySelector('.review-screen .day-summary--ai-gate')?.scrollIntoView({ behavior: 'auto', block: 'center' }) }],
    },
    {
      key: 'review-ai', target: null, place: 'bottom', pointer: null, advance: 'button', free: true, final: true,
      caption: 'AI가 오늘 남긴 말에서 하루를 읽어줬어요. 이제 직접 써볼까요?',
      actions: [{ at: 50, run: () => appContainerRef.current?.querySelector('.review-screen .reflection')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }],
    },
  ];
  // 어느 단계에서 멈추는지 보려고 단계 진입마다 남긴다 (step = 단계 이름)
  const tourNext = () => setTour(t => {
    const next = Math.min(t.step + 1, TOUR_STEPS.length - 1);
    if (next !== t.step) track('Tour', { action: 'step', step: TOUR_STEPS[next]?.key, index: next, guest: isGuest });
    return { ...t, step: next };
  });
  // 투어의 '오늘 회고 만들기' — AI를 부르지 않고 잠깐 읽는 척한 뒤 예시를 보여준다
  const tourGenerate = () => {
    setTour(t => ({ ...t, aiStatus: 'loading' }));
    setTimeout(() => setTour(t => ({ ...t, aiStatus: 'ok', step: Math.min(t.step + 1, TOUR_STEPS.length - 1) })), 1400);
    track('Tour', { action: 'generate', guest: isGuest });
  };
  const tourAI = tour.aiStatus === 'ok' ? TOUR_AI : tour.aiStatus === 'loading' ? { status: 'loading' } : { status: 'idle' };
  // 밝혀진 곳을 눌렀다 — 앱이 먼저 반응하도록 잠깐 뒤에 넘어간다
  const handleTourTargetTap = () => setTimeout(tourNext, 350);
  // 투어 중 실제 저장이 일어난 뒤 호출된다 (handleAddMemo에서).
  // 'cont' 단계의 기록이면 그 시각을 담아둔다 — 시간표에서 그 블록을 강조해야 하므로.
  const afterTourSend = (memo, mode) => {
    track('Tour', { action: 'sent', gesture: mode, guest: isGuest });
    const def = TOUR_STEPS[tour.step];
    if (def?.advance !== 'send') return;
    if (def.key === 'cont') setTour(t => ({ ...t, contIso: memo.recordedAt }));
    setTimeout(tourNext, 400);
  };
  useEffect(() => {
    if (!tour.active) return;
    const def = TOUR_STEPS[tour.step];
    if (!def) return;
    const timers = (def.actions ?? []).map(a => setTimeout(a.run, a.at));
    if (def.advance === 'auto' && def.autoAfter) timers.push(setTimeout(tourNext, def.autoAfter));
    return () => timers.forEach(clearTimeout);
    // TOUR_STEPS는 렌더마다 새로 만들어지지만 내용은 같다 — step이 바뀔 때만 타이머를 다시 건다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tour.active, tour.step]);

  // ── 온보딩: 스플래시 → 투어(진짜 입력) ───────────────────────
  // 처음 온 사람: 스플래시가 끝나면 바로 투어가 시작된다. 투어의 첫 단계가
  // "지금 한 일을 적어보세요"이고, 거기 쓴 것이 진짜 첫 기록으로 저장된다.
  // 투어를 건너뛰거나 끝내면(ONBOARDING_KEY) 다시 자동으로 뜨지 않는다.
  useEffect(() => {
    if (authLoading) return;
    if (localStorage.getItem(ONBOARDING_KEY) === '1') return;
    const splashDone = localStorage.getItem(SPLASH_KEY) === '1';
    if (!currentUser && memos.length === 0 && !splashDone) {
      const id = setTimeout(() => { setShowSplash(true); track('Splash', { action: 'shown' }); }, 0);
      return () => clearTimeout(id);
    }
    // 스플래시는 봤는데 투어를 못 끝내고 나간 사람(기록 0): 다시 오면 투어부터
    if (splashDone && !currentUser && memos.length === 0) {
      const id = setTimeout(() => startTour('revisit'), 400);
      return () => clearTimeout(id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading]);


  const handleKeyDown = (e) => {
    // 229 = IME가 조합 중에 흘려보내는 키 — 진짜 키입력이 아니다
    if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      // 터치 기기의 엔터는 줄바꿈이다 — 전송은 보내기 버튼으로만 (카톡과 같다).
      // 일부 모바일 키보드가 글이 길어지면 엔터를 멋대로 흘려보내서,
      // 쓰던 내용이 저절로 등록돼버리는 일이 있었다.
      if (IS_TOUCH_DEVICE) return;
      e.preventDefault();
      handleAddMemo();
    }
  };

  // ── 습관 키워드 저장 ─────────────────────────────────────────
  const saveHabitKeywords = async (keywords) => {
    if (!currentUser) return;
    const { error } = await supabase.from('settings').upsert({
      user_id: currentUser.id,
      habit_keywords: keywords,
      updated_at: new Date().toISOString()
    });
    if (error) console.error('Error saving settings:', error);
  };

  // ── 습관 키워드 관리 모달 동작 ───────────────────────────────
  const HABIT_COLORS = ['purple', 'blue', 'green', 'pink', 'orange'];

  const openKeywordModal = () => {
    setDraftKeywords(habitKeywords.map(k => ({ ...k })));
    setDeletingKeyword(null);
    setNewKeyword('');
    setShowKeywordModal(true);
  };

  // 원래 저장되어 있던 키워드인지 (새로 추가한 건 바로 삭제 가능)
  const isExistingKeyword = (name) => habitKeywords.some(k => k.name === name && !k.endedAt);

  const addDraftKeyword = () => {
    const kw = newKeyword.trim();
    if (!kw || draftKeywords.some(k => k.name === kw && !k.endedAt)) return;
    // 같은 이름의 보관(종료) 키워드가 있으면 새 키워드로 대체
    setDraftKeywords(prev => [...prev.filter(k => k.name !== kw), { name: kw, color: newKeywordColor }]);
    setNewKeyword('');
  };

  const removeDraftKeyword = (name) => {
    setDraftKeywords(prev => prev.filter(k => k.name !== name));
    setDeletingKeyword(null);
  };

  // 기록 남기기: 키워드를 오늘까지만 적용하고 보관 (이전 달력 기록 유지)
  const archiveDraftKeyword = (name) => {
    const endedAt = format(addDays(new Date(), 1), 'yyyy-MM-dd');
    setDraftKeywords(prev => prev.map(k => (k.name === name ? { ...k, endedAt } : k)));
    setDeletingKeyword(null);
  };

  const cycleDraftColor = (name) => {
    setDraftKeywords(prev => prev.map(k =>
      k.name === name ? { ...k, color: HABIT_COLORS[(HABIT_COLORS.indexOf(k.color) + 1) % HABIT_COLORS.length] } : k
    ));
  };

  const saveKeywordModal = async () => {
    // 모달이 draft 방식(취소 가능)이라 추가·보관·삭제를 누르는 순간에는 아직 확정이 아니다.
    // 저장 버튼을 누른 이 시점에 원본과 비교해서 실제로 무슨 일이 있었는지 한 번만 보낸다.
    const wasActive = (list, name) => list.some(k => k.name === name && !k.endedAt);
    track('Habit Keyword Saved', {
      added_count: draftKeywords.filter(k => !k.endedAt && !wasActive(habitKeywords, k.name)).length,
      archived_count: draftKeywords.filter(k => k.endedAt && wasActive(habitKeywords, k.name)).length,
      deleted_count: habitKeywords.filter(k => !k.endedAt && !draftKeywords.some(d => d.name === k.name)).length,
      active_count: draftKeywords.filter(k => !k.endedAt).length,
    });
    setHabitKeywords(draftKeywords);
    await saveHabitKeywords(draftKeywords);
    setShowKeywordModal(false);
  };

  // ── 전역 touchmove 리스너: 스크롤 중 모든 터치 상태 초기화 ──────────
  useEffect(() => {
    const clearTouchState = (e) => {
      // 할 일 시트 안에서는 목록을 훑는 중이다. 여기서 포커스를 떼면 키보드가
      // 내려가고, 그만큼 공간이 넓어지면서 시트가 커져 목록이 통째로 펼쳐진다.
      // 적는 중에 아래를 훑어보는 건 정상 동작이므로 건드리지 않는다.
      if (e.target?.closest?.('.todo-sheet')) return;
      // 포커스된 요소 즉시 blur
      if (document.activeElement && document.activeElement !== document.body) {
        document.activeElement.blur();
      }
      // 포커스를 body로 강제 이동
      document.body.focus();
    };

    window.addEventListener('touchmove', clearTouchState, { passive: true });
    return () => {
      window.removeEventListener('touchmove', clearTouchState);
    };
  }, []);

  // ── 캘린더 렌더 ──────────────────────────────────────────────
  const renderCalendar = () => {
    const monthStart = startOfMonth(currentMonth);
    const monthEnd = endOfMonth(monthStart);
    const startDate = startOfWeek(monthStart);
    const endDate = endOfWeek(monthEnd);
    const weekDays = ['일', '월', '화', '수', '목', '금', '토'];
    const rows = [];
    let days = [];
    let day = startDate;

    while (day <= endDate) {
      for (let i = 0; i < 7; i++) {
        const cloneDay = day;
        const isCurrentMonth = isSameMonth(day, monthStart);
        const isSelected = isSameDay(day, selectedDate);
        const isDayToday = isToday(day);
        const hasMemos = memos.some(m => isSameDay(new Date(m.recordedAt), cloneDay));

        const createCalTouchHandler = () => {
          let touchState = { startX: 0, startY: 0, isScrolling: false, target: null };
          return {
            onTouchStart: (e) => {
              touchState.startX = e.touches[0].clientX;
              touchState.startY = e.touches[0].clientY;
              touchState.isScrolling = false;
              touchState.target = e.currentTarget;
            },
            onTouchMove: (e) => {
              const dx = Math.abs(e.touches[0].clientX - touchState.startX);
              const dy = Math.abs(e.touches[0].clientY - touchState.startY);
              if (dx > 5 || dy > 5) {
                touchState.isScrolling = true;
                if (touchState.target) {
                  touchState.target.classList.add('touch-scroll-active');
                  setTimeout(() => {
                    if (touchState.target) {
                      touchState.target.classList.remove('touch-scroll-active');
                      touchState.target = null;
                    }
                  }, 0);
                }
              }
            },
            onTouchEnd: (e) => {
              if (!touchState.isScrolling) {
                goToDay(cloneDay);
                setShowCalendar(false);
              }
            }
          };
        };

        const calHandlers = createCalTouchHandler();

        days.push(
          <div
            className={`cal-day ${!isCurrentMonth ? 'cal-disabled' : ''} ${isSelected ? 'cal-selected' : ''} ${isDayToday && !isSelected ? 'cal-today' : ''}`}
            key={day.toISOString()}
            tabIndex={-1}
            onClick={() => {
              goToDay(cloneDay);
              setShowCalendar(false);
            }}
            onTouchStart={calHandlers.onTouchStart}
            onTouchMove={calHandlers.onTouchMove}
            onTouchEnd={calHandlers.onTouchEnd}
          >
            <span>{format(day, 'd')}</span>
            {hasMemos && <div className="cal-dot" />}
          </div>
        );
        day = addDays(day, 1);
      }
      rows.push(<div className="cal-row" key={day.toISOString()}>{days}</div>);
      days = [];
    }

    return (
      <div className="calendar-container" onClick={e => e.stopPropagation()}>
        <div className="cal-header">
          <button className="cal-btn" onClick={() => setCurrentMonth(subMonths(currentMonth, 1))}><ChevronLeft size={20} /></button>
          <span className="cal-month">{format(currentMonth, 'yyyy년 M월', { locale: ko })}</span>
          <button className="cal-btn" onClick={() => setCurrentMonth(addMonths(currentMonth, 1))}><ChevronRight size={20} /></button>
        </div>
        <div className="cal-weekdays">
          {weekDays.map(w => <div key={w} className="cal-weekday">{w}</div>)}
        </div>
        <div className="cal-body">{rows}</div>
      </div>
    );
  };

  // ── 먼슬리 뷰 렌더 ───────────────────────────────────────────
  // '오늘로' 버튼이 떠 있으면 토스트는 그 위로 올라간다 (겹치면 못 누른다)
  const todayFabVisible = activeView === 'timeline' && !isToday(selectedDate);
  const toastClass = `undo-toast${todayFabVisible ? ' undo-toast--above-fab' : ''}`;
  const memoGroups = groupMemosByHour(chatMemos);
  // ── 타임블럭 뷰 렌더 ──
  // 날짜별로 판을 새로 그리지 않고, 창에 잡힌 며칠을 하나의 시간 축에 이어서 그린다.
  // 그래서 23:50에 시작해 01:20에 끝난 기록이 자정에서 끊기지 않는다.
  const renderScheduleView = () => {
    const sortedMemos = timelineMemos;

    const gridMinutes = windowMinutes;
    const gridHours = gridMinutes / 60;
    const schedules = [];

    const dayBlocks = buildDayBlocks(sortedMemos, {
      dayStartMs: windowStartMs, nowMs: nowTime.getTime(), gridMinutes,
    });

    for (const b of dayBlocks) {
      const { memo: currentMemo, startPos, endPos, ownPos, spansNext } = b;
      const startTime = new Date(windowStartMs + startPos * 60000);
      const endTime = new Date(windowStartMs + endPos * 60000);

      // 구간으로 지정한 기록은 길이와 상관없이 '시작 → 끝'으로 보여준다.
      // (30분짜리 구간이 한 순간짜리와 똑같이 보이면 구간으로 정한 의미가 없다)
      const isSpanning = isRangeMemo(currentMemo)
        || startPos < ownPos || endPos > ownPos + MIN_BLOCK_MINUTES || spansNext;

      schedules.push({
        startPos,
        endPos,
        startHour: startTime.getHours(),
        startMin: startTime.getMinutes(),
        endHour: endTime.getHours(),
        endMin: endTime.getMinutes(),
        content: currentMemo.content,
        color: currentMemo.color || 'default',
        recordedAt: currentMemo.recordedAt,
        // 앞뒤 어느 쪽으로든 늘어난 블록 (시각을 범위로 표시한다)
        isSpanning,
        // 늘어나지 않은 블록은 시간+내용을 한 줄로 표시하므로 높이를 낮게 잡는다
        isCompact: !isSpanning,
        // 편집 시트는 기록 그 자체를 다룬다 (스냅샷이 아니라 원본을 넘긴다)
        memo: currentMemo,
      });
    }

    // 겹치는 블록은 좌우로 나누지 않고 위아래로 쌓는다.
    // 대신 그 시간대의 세로 칸을 늘려서(= 시간 축을 부분적으로 확대) 자리를 만든다.
    // 예: 9~10시에 기록 3개가 몰리면 9~10시 구간만 넓어지고 블록은 차례로 쌓인다.
    const PX_PER_MIN = 1;
    // 최소 높이는 CSS의 min-height와 일치시켜야 겹치지 않는다.
    // 한 줄짜리(시간+내용 인라인, 넘치면 …으로 잘림)는 낮게, 두 줄짜리는 그대로.
    // 블록끼리의 간격은 자리(slot)에서 아래 여백을 떼는 방식으로 준다.
    // 쌓인 블록 사이에만 간격을 넣으면 시간대가 다른 이웃과 규칙이 달라져 들쭉날쭉해 보인다.
    const BLOCK_GAP_PX = 2;
    const MIN_BLOCK_PX = 48 + BLOCK_GAP_PX;
    const MIN_COMPACT_PX = 34 + BLOCK_GAP_PX;
    const minPxFor = (s) => (s.isCompact ? MIN_COMPACT_PX : MIN_BLOCK_PX);

    const ordered = [...schedules].sort((a, b) => a.startPos - b.startPos || a.endPos - b.endPos);

    // 1) 긴 블록 '안에' 완전히 들어가는 짧은 기록은 따로 뺀다.
    //    (예: 09:20~12:30 일하는 중에 11:13에 남긴 결제 기록)
    //    이런 건 겹친 게 아니라 그 시간 안에 일어난 일이므로, 아래로 밀어내면
    //    11:13 기록이 12시 넘어서 그려져 시각이 어긋난다. 위에 얹어서 제자리에 둔다.
    for (const s of ordered) {
      let host = null;
      for (const a of ordered) {
        if (a === s) continue;
        const inside = a.startPos < s.startPos && s.endPos <= a.endPos;
        const longer = (a.endPos - a.startPos) > (s.endPos - s.startPos);
        if (!inside || !longer) continue;
        // 가장 가까이 감싸는 블록을 고른다
        if (!host || (a.endPos - a.startPos) < (host.endPos - host.startPos)) host = a;
      }
      s.host = host;
    }
    const outerBlocks = ordered.filter(s => !s.host);

    // 2) 시간이 겹치는 (감싸이지 않은) 블록끼리 묶는다
    const clusters = [];
    for (const s of outerBlocks) {
      const last = clusters[clusters.length - 1];
      if (last && s.startPos < last.end) {
        last.end = Math.max(last.end, s.endPos);
        last.items.push(s);
      } else {
        clusters.push({ start: s.startPos, end: s.endPos, items: [s] });
      }
    }
    // 구간(스패닝) 블록이 낀 겹침은 위아래로 쌓으면 안 된다 — 밀린 블록이
    // 제 시각과 다른 자리에 그려진다(4:52 시작이 6시 위치에 있던 문제).
    // 이런 묶음은 옆으로 나란히 두고 각자 제 시각 자리에 놓는다.
    // 순간 기록만 몰린 묶음은 기존대로 세로로 쌓는다(칸을 나누면 글이 안 읽힌다).
    for (const c of clusters) {
      // 예외: '이전 기록부터 이어서' 쓴 구간은 앞 기록 바로 아래 이어붙인다 (옆으로 나누지 않는다).
      // 11:10 '회의 끝' 다음에 11:10→11:50 '점심'이 오면 두 블록이 위아래로 붙어야 이어 쓴 느낌이 난다.
      const onlyContinuations = c.items
        .filter(s => !s.isCompact)
        .every(s => s.memo.spansFromPrev && !(s.memo.backMinutes > 0));
      c.useColumns = c.items.length >= 2 && c.items.some(s => !s.isCompact) && !onlyContinuations;
    }

    // 3) 쌓는 데 필요한 높이가 실제 시간 길이보다 크면 그만큼 구간을 늘린다.
    //    감싸는 블록은 안쪽 기록들이 다 들어갈 만큼도 확보해야 한다.
    const innerOf = (host) => ordered.filter(s => s.host === host);
    const innerNeedPx = (host) => {
      let y = 0;
      for (const s of innerOf(host)) {
        y = Math.max(y, (s.startPos - host.startPos) * PX_PER_MIN) + minPxFor(s);
      }
      return y;
    };
    const slotPxFor = (s) => Math.max(
      minPxFor(s),
      (s.endPos - s.startPos) * PX_PER_MIN,
      innerNeedPx(s)
    );

    const expansions = [];
    for (const c of clusters) {
      // 옆으로 나누는 묶음: 구간 블록은 제 시각 자리에 그대로 두지만,
      // 순간 기록들은 열 하나에 위아래로 쌓으므로 그만큼은 시간 축을 늘려야 한다.
      // (순간 기록마다 열을 주면 4~5칸으로 쪼개져 글자가 한 자도 안 보인다)
      if (c.useColumns) {
        const compacts = c.items.filter(s => s.isCompact);
        if (compacts.length >= 1) {
          const from = compacts[0].startPos;
          const to = Math.max(compacts[compacts.length - 1].startPos, from + 5);
          // 열로 나뉘면 좁아서 시각·내용이 두 줄이 된다 — 두 줄 높이로 잡는다
          const needPx = compacts.length * MIN_BLOCK_PX;
          const naturalPx = (to - from) * PX_PER_MIN;
          if (needPx > naturalPx) expansions.push({ from, to, extra: needPx - naturalPx });
        }
        continue;
      }
      c.needPx = c.items.reduce((sum, s) => sum + slotPxFor(s), 0);
      const naturalPx = (c.end - c.start) * PX_PER_MIN;
      if (c.needPx > naturalPx) expansions.push({ from: c.start, to: c.end, extra: c.needPx - naturalPx });
    }

    // 3) 늘린 구간을 반영한 시간 → 픽셀 변환 (시간 눈금도 이걸 따라간다)
    const timeToPx = (t) => {
      let px = t * PX_PER_MIN;
      for (const e of expansions) {
        if (t >= e.to) px += e.extra;
        else if (t > e.from) px += e.extra * ((t - e.from) / (e.to - e.from));
      }
      return px;
    };
    const totalPx = timeToPx(gridMinutes);
    // 블록을 꾹 눌러 옮길 때 놓인 픽셀을 시각으로 되읽는 데 쓴다
    schedulePxMapRef.current = { timeToPx, gridMinutes };

    // 4) 묶음 안 배치 — 옆으로 나누거나(구간 겹침), 위에서부터 쌓는다(순간 몰림)
    for (const c of clusters) {
      if (c.useColumns) {
        // 위클리 뷰와 같은 열 배정: 앞 블록이 끝난 열이 있으면 재사용한다.
        // 열이 겹치는지 판정할 때는 최소 높이만큼 차지하는 시간도 포함한다
        // (짧은 구간이 최소 높이 때문에 시간보다 길게 그려지며 다음 블록을 덮는 것 방지)
        const paddedEnd = (s) => s.startPos + Math.max(slotPxFor(s) / PX_PER_MIN, s.endPos - s.startPos);
        const colEnds = [];
        const spans = c.items.filter(s => !s.isCompact);
        const compacts = c.items.filter(s => s.isCompact);
        for (const s of spans) {
          let ci = colEnds.findIndex(end => end <= s.startPos);
          if (ci === -1) { ci = colEnds.length; colEnds.push(paddedEnd(s)); }
          else colEnds[ci] = paddedEnd(s);
          s.col = ci;
        }
        // 순간 기록은 열 하나를 같이 쓰며 위에서부터 쌓는다 (시간 축은 위에서 그만큼 늘려뒀다)
        if (compacts.length) {
          const ci = colEnds.length;
          colEnds.push(Infinity);
          let y = timeToPx(compacts[0].startPos);
          for (const s of compacts) {
            s.col = ci;
            s.top = Math.max(y, timeToPx(s.startPos));
            s.height = MIN_BLOCK_PX - BLOCK_GAP_PX; // 좁은 열은 두 줄 높이
            y = s.top + MIN_BLOCK_PX;
          }
        }
        for (const s of spans) {
          s.top = timeToPx(s.startPos); // 제 시각 자리 그대로
          s.height = Math.max(timeToPx(s.endPos) - timeToPx(s.startPos), slotPxFor(s)) - BLOCK_GAP_PX;
        }
        for (const s of c.items) s.colCount = colEnds.length;
        continue;
      }
      let y = timeToPx(c.start);
      for (const s of c.items) {
        const slot = slotPxFor(s);
        s.top = y;
        s.height = slot - BLOCK_GAP_PX; // 아래 여백만큼 덜 그려서 어디서나 같은 간격이 되게
        y += slot;
      }
    }

    // 5) 감싸인 기록은 감싸는 블록 위에, 자기 시각 자리에 얹는다
    for (const host of outerBlocks) {
      const inner = innerOf(host);
      if (!inner.length) continue;
      let y = host.top;
      for (const s of inner) {
        const slot = minPxFor(s);
        // 자기 시각 자리에 두되, 앞의 안쪽 기록과 겹치면 그만큼만 내린다
        s.top = Math.max(host.top + (s.startPos - host.startPos) * PX_PER_MIN, y);
        s.height = slot - BLOCK_GAP_PX;
        s.isInner = true;
        // 감싸는 블록이 열로 나뉘어 있으면 같은 열 안에 얹는다
        s.col = host.col;
        s.colCount = host.colCount;
        y = s.top + slot;
      }
    }

    // 지금 이 순간이 창 안이면 빨간 줄을 그린다 (창 기준 분)
    const nowPos = (nowTime.getTime() - windowStartMs) / 60000;
    const nowInWindow = nowPos >= 0 && nowPos < gridMinutes;

    // 시간 눈금
    const hours = Array.from({ length: gridHours }, (_, i) => i);

    return (
      <div className="schedule-view" ref={scheduleViewRef} onScroll={handleTimelineScroll}>
        <div className="schedule-header">
          <div className="schedule-times" style={{ height: `${totalPx}px` }}>
            {[...hours, gridHours].map(hour => (
              <div
                key={hour}
                className="schedule-hour-label"
                style={{ top: `${timeToPx(hour * 60)}px` }}
              >
                {(hour % 24).toString().padStart(2, '0')}:00
              </div>
            ))}
          </div>
          <div
            className="schedule-grid"
            ref={scheduleGridRef}
            style={{ height: `${totalPx}px` }}
            onPointerDown={onScheduleGridPointerDown}
            onPointerMove={onScheduleGridPointerMove}
            onPointerUp={onScheduleGridPointerUp}
            onPointerCancel={onScheduleGridPointerCancel}
          >
            {/* 꾹 누르고 끄는 동안 고르는 구간 */}
            <div className="schedule-slot-highlight" ref={scheduleSlotHighlightRef} style={{ display: 'none' }} />
            {/* 오전(자정~12시)에만 아주 옅은 회색을 깔아 오전/오후가 한눈에 구분되게 */}
            {windowDays.map((_, i) => (
              <div
                key={`am-${i}`}
                className="schedule-am-band"
                aria-hidden="true"
                style={{
                  top: `${timeToPx(i * DAY_MINUTES)}px`,
                  height: `${timeToPx(i * DAY_MINUTES + 720) - timeToPx(i * DAY_MINUTES)}px`,
                }}
              />
            ))}
            {hours.map(hour => (
              <div key={hour} className="schedule-hour-slot" style={{ top: `${timeToPx(hour * 60)}px` }} />
            ))}
            {/* 날짜 경계 — 자정마다 한 줄. 헤더 날짜도 이 위치를 보고 따라온다 */}
            {windowDays.map((day, i) => (
              <div
                key={`day-${i}`}
                className={`schedule-day-line${i === 0 ? ' schedule-day-line--first' : ''}`}
                data-day-index={i}
                style={{ top: `${timeToPx(i * DAY_MINUTES)}px` }}
              >
                <span>{format(day, 'M월 d일 (E)', { locale: ko })}</span>
              </div>
            ))}
            {/* 현재 시간 빨간 줄 */}
            {nowInWindow && (
              <div className="schedule-now-line" style={{ top: `${timeToPx(nowPos)}px` }} />
            )}
            {/* 블록을 끌고 있는 동안 놓일 시각을 보여주는 배지 (드래그 핸들러가 직접 채운다) */}
            <div className="schedule-drag-badge" ref={scheduleBadgeRef} style={{ display: 'none' }} />
            {/* 아직 등록 전 — 입력창에 잡힌 시간 영역을 미리 띠로 보여준다 */}
            {pendingSpan && (() => {
              const dayOff = ((pendingSpan.dayMs ?? selectedDayStartMs) - windowStartMs) / 60000;
              const a = dayOff + pendingSpan.start;
              const b = dayOff + (pendingSpan.end ?? pendingSpan.start + 30);
              const top = timeToPx(a);
              const label = pendingSpan.end != null
                ? `${clockLabel(windowStartMs + a * 60000)} → ${clockLabel(windowStartMs + b * 60000)}`
                : clockLabel(windowStartMs + a * 60000);
              return (
                <div
                  className="schedule-pending-band"
                  style={{ top: `${top}px`, height: `${timeToPx(b) - top}px` }}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={openBandEditor}
                  title="시각 조정"
                >
                  <span className="schedule-pending-label">{label}</span>
                </div>
              );
            })()}
            <div className="schedule-blocks-layer">
            {schedules.map((schedule, idx) => {
              // 습관 키워드 포함 시 키워드 색으로 (직접 고른 색이 있으면 그대로)
              const habitMatch = schedule.color === 'default'
                ? habitMatchFor(schedule.content, schedule.recordedAt)
                : null;
              const bgColor = habitMatch
                ? `var(--habit-${habitMatch.color})`
                : (COLOR_PALETTE.find(c => c.id === schedule.color)?.bg || '#f9f9fb');
              const borderColor = habitMatch
                ? (HABIT_BORDER[habitMatch.color] || '#e8e8f0')
                : (COLOR_BORDER[schedule.color] || '#e8e8f0');

              // 늘어난 블록은 '시작 → 끝'으로 범위를 보여준다.
              // (끝나고 적은 기록은 끝 시각이 곧 내가 적은 시각이라, 이게 없으면 화면에서 사라진다)
              const pad = n => n.toString().padStart(2, '0');
              const timeLabel = schedule.isSpanning
                ? `${pad(schedule.startHour)}:${pad(schedule.startMin)} → ${pad(schedule.endHour)}:${pad(schedule.endMin)}`
                : `${pad(schedule.startHour)}:${pad(schedule.startMin)}`;
              const isCompact = schedule.isCompact;

              return (
                <div
                  key={idx}
                  className={`schedule-block${isCompact ? ' schedule-block--compact' : ''}${schedule.isInner ? ' schedule-block--inner' : ''}${schedule.colCount > 1 ? ' schedule-block--narrow' : ''}`}
                  data-at={schedule.memo.recordedAt}
                  onClick={() => openBlockEditor(schedule.memo)}
                  // 꾹 누르면(0.45초) 이동 모드 — 파란 테두리가 생기고 끌어서 시각을 옮긴다
                  onPointerDown={(e) => onScheduleBlockPointerDown(e, schedule)}
                  onPointerMove={onScheduleBlockPointerMove}
                  onPointerUp={onScheduleBlockPointerUp}
                  onPointerCancel={onScheduleBlockPointerCancel}
                  onClickCapture={(e) => {
                    if (scheduleSuppressClickRef.current) {
                      e.preventDefault();
                      e.stopPropagation();
                      scheduleSuppressClickRef.current = false;
                    }
                  }}
                  style={{
                    top: `${schedule.top}px`,
                    height: `${schedule.height}px`,
                    backgroundColor: bgColor,
                    borderColor: borderColor,
                    cursor: 'pointer',
                    justifyContent: 'flex-start',
                    paddingTop: '6px',
                    // 구간이 부분적으로 겹치면 옆으로 나눠 각자 제 시각 자리에 둔다
                    ...(schedule.colCount > 1 ? {
                      left: `calc(${(schedule.col / schedule.colCount) * 100}% + ${schedule.isInner ? 12 : 0}px)`,
                      right: 'auto',
                      width: `calc(${100 / schedule.colCount}% - ${schedule.isInner ? 14 : 3}px)`,
                    } : null),
                  }}
                >
                  <div className="schedule-block-time">{timeLabel}</div>
                  <div className="schedule-block-content">{schedule.content}</div>
                </div>
              );
            })}
            </div>
          </div>
        </div>
      </div>
    );
  };

  // ── 비밀번호 재설정 페이지 (이메일 링크로 접근) ───────────────
  if (isRecovery) {
    return (
      <div className="app-container auth-wrapper">
        <div className="auth-card">
          <div className="auth-logo">
            <span className="auth-logo-icon">🔑</span>
            <h2>새 비밀번호 설정</h2>
            <p>새로운 비밀번호를 입력해주세요</p>
          </div>
          {resetSuccess ? (
            <div style={{ padding: '20px', textAlign: 'center', backgroundColor: '#f0fdf4', borderRadius: '12px', marginBottom: '20px' }}>
              <p style={{ fontSize: '0.95rem', color: '#166534', fontWeight: '600', marginBottom: '8px' }}>
                ✓ 비밀번호가 변경되었습니다
              </p>
              <p style={{ fontSize: '0.85rem', color: '#166534', margin: 0 }}>
                새 비밀번호로 로그인할 수 있습니다.
              </p>
              <button
                type="button"
                className="btn-save auth-submit-btn"
                onClick={async () => {
                  // 재설정 링크의 임시 세션을 끊고 새 비밀번호로 다시 로그인하게 한다
                  await supabase.auth.signOut();
                  window.location.href = '/';
                }}
                style={{ marginTop: '16px' }}
              >
                로그인 페이지로 이동
              </button>
            </div>
          ) : (
            <form onSubmit={handleResetPasswordSubmit} className="auth-form">
              <div className="form-group">
                <label>새 비밀번호</label>
                <input
                  type="password"
                  placeholder="8~16자 (영문, 숫자, 특수문자)"
                  value={resetNewPw}
                  onChange={e => setResetNewPw(e.target.value)}
                  className="input-field auth-input"
                />
              </div>
              <div className="form-group">
                <label>새 비밀번호 확인</label>
                <input
                  type="password"
                  placeholder="비밀번호 재입력"
                  value={resetConfirmPw}
                  onChange={e => setResetConfirmPw(e.target.value)}
                  className="input-field auth-input"
                />
              </div>
              {resetError && <div className="auth-error-message">{resetError}</div>}
              <button type="submit" className="btn-save auth-submit-btn" disabled={resetSubmitting}>
                {resetSubmitting ? <span className="spinner-small" /> : '비밀번호 변경하기'}
              </button>
            </form>
          )}
        </div>
      </div>
    );
  }

  // ── 로딩 ─────────────────────────────────────────────────────
  if (authLoading) {
    return (
      <div className="app-container" style={{ justifyContent: 'center', alignItems: 'center' }}>
        <div className="spinner" />
      </div>
    );
  }

  // ── 이메일 인증 안내 화면 (회원가입 직후) ─────────────────────
  if (!currentUser && authView === 'emailVerification') {
    return (
      <div className="app-container auth-wrapper">
        <div className="auth-card">
          <div className="auth-logo">
            <span className="auth-logo-icon">📧</span>
            <h2>이메일 인증</h2>
            <p>가입한 이메일로 인증 링크가 발송되었습니다</p>
          </div>
          <div style={{ padding: '20px', textAlign: 'center', backgroundColor: '#f9f9fb', borderRadius: '12px', marginBottom: '20px' }}>
            <p style={{ fontSize: '0.95rem', color: '#666', marginBottom: '8px' }}>
              <strong>{authEmail}</strong>
            </p>
            <p style={{ fontSize: '0.85rem', color: '#999', margin: 0 }}>
              받은편지함 또는 스팸함을 확인하고 인증 링크를 클릭해주세요.<br />
              링크를 클릭하면 자동으로 로그인됩니다.
            </p>
          </div>
          {authError && <div className="auth-error-message">{authError}</div>}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <button
              type="button"
              className="btn-cancel"
              onClick={handleResendVerificationEmail}
              disabled={submittingAuth}
            >
              {submittingAuth ? <span className="spinner-small" /> : '인증 메일 재발송'}
            </button>
            <button
              type="button"
              className="btn-cancel"
              onClick={() => { setAuthView('login'); setAuthEmail(''); setAuthError(''); }}
            >
              로그인으로 돌아가기
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── 로그인 화면 ───────────────────────────────────────────────
  // 앱을 켜자마자 로그인부터 시키면 써보지도 않고 나간다.
  // 그래서 로그인 화면은 사용자가 부를 때만 띄우고, 기본은 체험 모드로 앱을 보여준다.
  if (!currentUser && showLogin) {
    // 비밀번호 찾기 화면
    if (authView === 'forgotPassword') {
      return (
        <div className="app-container auth-wrapper">
        {/* 로그인 화면은 따로 그려지므로 동의 시트도 여기서 한 번 더 */}
        {showConsent && (
          <ConsentSheet onAgree={agreeAndSignIn} onClose={() => { track('Consent', { action: 'closed' }); setShowConsent(false); }} />
        )}
          <div className="auth-card">
            <div className="auth-logo">
              <span className="auth-logo-icon">🔑</span>
              <h2>비밀번호 찾기</h2>
              <p>가입하신 이메일로 재설정 링크를 보내드립니다</p>
            </div>
            {forgotEmailSent ? (
              <div style={{ padding: '20px', textAlign: 'center', backgroundColor: '#f0fdf4', borderRadius: '12px', marginBottom: '20px' }}>
                <p style={{ fontSize: '0.95rem', color: '#166534', fontWeight: '600', marginBottom: '8px' }}>
                  ✓ 이메일 발송 완료
                </p>
                <p style={{ fontSize: '0.85rem', color: '#166534', margin: 0 }}>
                  비밀번호 재설정 링크를 이메일로 보냈습니다.<br />
                  링크를 클릭하여 새로운 비밀번호를 설정해주세요.
                </p>
              </div>
            ) : (
              <form onSubmit={handleForgotPassword} className="auth-form">
                <div className="form-group">
                  <label>이메일</label>
                  <input
                    type="text"
                    placeholder="example@email.com"
                    value={forgotEmail}
                    onChange={e => setForgotEmail(e.target.value)}
                    className="input-field auth-input"
                  />
                </div>
                {forgotEmailError && <div className="auth-error-message">{forgotEmailError}</div>}
                <button type="submit" className="btn-save auth-submit-btn" disabled={submittingAuth}>
                  {submittingAuth ? <span className="spinner-small" /> : '재설정 링크 받기'}
                </button>
              </form>
            )}
            <button
              type="button"
              className="btn-cancel"
              onClick={() => { setAuthView('login'); setForgotEmail(''); setForgotEmailSent(false); setForgotEmailError(''); }}
              style={{ marginTop: '12px' }}
            >
              로그인으로 돌아가기
            </button>
          </div>
        </div>
      );
    }

    // 일반 로그인/회원가입 화면
    // 이메일 입력칸은 그 경로가 열려 있을 때만 보여준다.
    const showEmailFields = authView === 'login' ? EMAIL_LOGIN_ENABLED : EMAIL_SIGNUP_ENABLED;
    // 둘 다 닫혀 있으면 로그인/회원가입을 나눌 이유가 없다 — 탭도 없애고 구글 버튼만 남긴다.
    const emailAuthOpen = EMAIL_LOGIN_ENABLED || EMAIL_SIGNUP_ENABLED;
    // 자동 로그인은 구글 로그인에도 그대로 적용된다(세션 저장 위치를 정하는 값).
    // 이메일 칸이 없어지면 이 체크박스만 붕 뜨므로, 그때는 구글 버튼 아래로 내린다.
    const rememberMeCheckbox = (
      <div className="auth-remember-container">
        <label className="auth-remember-label">
          <input
            type="checkbox"
            checked={rememberMe}
            onChange={e => setRememberMeState(e.target.checked)}
            className="auth-remember-checkbox"
          />
          자동 로그인
        </label>
      </div>
    );
    return (
      <div className="app-container auth-wrapper">
        {showConsent && (
          <ConsentSheet onAgree={agreeAndSignIn} onClose={() => { track('Consent', { action: 'closed' }); setShowConsent(false); }} />
        )}
        {/* 하단 '로그인' 탭으로 들어온 사람이 나가는 길을 못 찾고 당황했다.
            '나중에 하기'는 눈에 안 띄어서, 익숙한 자리(좌상단)에 뒤로가기를 둔다. */}
        <button
          type="button"
          className="auth-back-btn"
          aria-label="뒤로가기"
          onClick={() => { setShowLogin(false); setAuthError(''); }}
        >
          ←
        </button>
        <div className="auth-card">
          <div className="auth-logo">
            <span className="auth-logo-icon">🕒</span>
            <h2>타임메모</h2>
            <p>오늘 하루를 시간 단위로 꼼꼼하게 기록하세요</p>
          </div>
          {emailAuthOpen && (
          <div className="auth-tabs">
            <button type="button" className={`auth-tab ${authView === 'login' ? 'active' : ''}`} onClick={() => { setAuthView('login'); setAuthError(''); }}>로그인</button>
            <button type="button" className={`auth-tab ${authView === 'signup' ? 'active' : ''}`} onClick={() => { setAuthView('signup'); setAuthError(''); }}>회원가입</button>
          </div>
          )}
          <form onSubmit={handleAuthSubmit} className="auth-form">
            {showEmailFields && (
            <div className="form-group">
              <label>이메일</label>
              <input type="text" placeholder="example@email.com" value={authEmail} onChange={e => setAuthEmail(e.target.value)} className="input-field auth-input" />
              {authView === 'signup' && authError && authError.includes('이메일') && (
                <div style={{ fontSize: '0.85rem', color: '#e53e3e', marginTop: '4px' }}>
                  올바른 이메일 형식으로 입력해 주세요.
                </div>
              )}
            </div>
            )}
            {showEmailFields && (
            <div className="form-group">
              <label>비밀번호</label>
              <input type="password" placeholder={authView === 'signup' ? '8~16자 (영문, 숫자, 특수문자)' : '비밀번호 입력'} value={authPassword} onChange={e => setAuthPassword(e.target.value)} className="input-field auth-input" />
              {authView === 'signup' && authError && (authError.includes('비밀번호') || authError.includes('공백')) && (
                <div style={{ fontSize: '0.85rem', color: '#e53e3e', marginTop: '4px' }}>
                  영문, 숫자, 특수문자를 포함하여 8자리 이상 16자리 이하로 설정해 주세요.
                </div>
              )}
            </div>
            )}
            {authView === 'signup' && showEmailFields && (
              <div className="form-group animate-fade-in">
                <label>비밀번호 확인</label>
                <input type="password" placeholder="비밀번호 재입력" value={authConfirmPassword} onChange={e => setAuthConfirmPassword(e.target.value)} className="input-field auth-input" />
                {authError && authError.includes('일치') && (
                  <div style={{ fontSize: '0.85rem', color: '#e53e3e', marginTop: '4px' }}>
                    비밀번호가 일치하지 않습니다.
                  </div>
                )}
              </div>
            )}
            {authView === 'login' && EMAIL_LOGIN_ENABLED && rememberMeCheckbox}
            {authError && (authView === 'login' || (!authError.includes('이메일') && !authError.includes('비밀번호') && !authError.includes('공백') && !authError.includes('일치'))) && (
              <div className="auth-error-message">{authError}</div>
            )}
            {showEmailFields && (
            <button type="submit" className="btn-save auth-submit-btn" disabled={submittingAuth}>
              {submittingAuth ? <span className="spinner-small" /> : (authView === 'signup' ? '회원가입하기' : '로그인하기')}
            </button>
            )}
            {/* 구글은 가입 절차가 따로 없어 로그인/회원가입 양쪽에 둔다 */}
            {showEmailFields && <div className="auth-divider"><span>또는</span></div>}
            <button type="button" className="google-signin-btn" onClick={requestGoogleSignIn} disabled={submittingAuth}>
              <svg viewBox="0 0 24 24" width="18" height="18" style={{ marginRight: '10px' }}>
                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l3.66-2.85z" />
                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.85c.87-2.6 3.3-4.53 6.16-4.53z" />
              </svg>
              {authView === 'signup' || !emailAuthOpen ? '구글로 시작하기' : '구글로 로그인'}
            </button>
            {!emailAuthOpen && rememberMeCheckbox}
            {(authView === 'signup' || !emailAuthOpen) && (
              <p className="auth-google-hint">
                구글 계정으로 바로 시작할 수 있어요. 따로 가입할 필요 없습니다.
              </p>
            )}
            {authView === 'login' && EMAIL_LOGIN_ENABLED && (
              <div style={{ textAlign: 'center', marginTop: '16px', paddingTop: '16px', borderTop: '1px solid #e5e5e5' }}>
                <button
                  type="button"
                  onClick={() => { setAuthView('forgotPassword'); setAuthError(''); }}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: '#0066cc',
                    cursor: 'pointer',
                    fontSize: '0.9rem',
                    textDecoration: 'none',
                    padding: 0
                  }}
                >
                  비밀번호를 잊으셨나요?
                </button>
              </div>
            )}
          </form>
          {/* 체험하던 사람이 막다른 길에 갇히지 않게 되돌아갈 문을 둔다 */}
          <button
            type="button"
            onClick={() => { setShowLogin(false); setAuthError(''); }}
            style={{ display: 'block', margin: '18px auto 0', background: 'none', border: 'none', color: '#888', fontSize: '0.875rem', cursor: 'pointer' }}
          >
            나중에 하기
          </button>
          {/* 처음 들어온 사람이 가입 전에 확인할 수 있어야 해서 로그인 화면에 둔다 */}
          <p style={{ textAlign: 'center', marginTop: '14px', fontSize: '0.8rem', color: '#999' }}>
            <a href="/terms.html" target="_blank" rel="noopener noreferrer" style={{ color: '#999' }}>
              이용약관
            </a>
            <span style={{ margin: '0 8px' }}>·</span>
            <a href="/privacy.html" target="_blank" rel="noopener noreferrer" style={{ color: '#999' }}>
              개인정보처리방침
            </a>
          </p>
          {/* 비로그인 사용자용 의견·문의 창구 — 마이페이지가 없으니 여기 둔다 */}
          <div style={{ marginTop: '18px', paddingTop: '18px', borderTop: '1px solid #eee' }}>
            <p style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.85rem', fontWeight: 600, color: '#555', margin: '0 0 8px' }}>
              <MessageSquare size={15} style={{ color: 'var(--primary-color)' }} />
              의견 보내기
            </p>
            <FeedbackCard user={null} />
          </div>
          {/* 체험 중에는 마이페이지를 못 보므로 여기에도 둔다 (지금 어느 코드인지 확인용) */}
          <p className="build-stamp">
            {format(new Date(__BUILD_TIME__), 'yyyy.MM.dd HH:mm')} 배포 · {__BUILD_COMMIT__}
          </p>
        </div>
      </div>
    );
  }

  // ── 메인 화면 ────────────────────────────────────────────────
  return (
    <div className="app-container" ref={appContainerRef}>
      {/* 기록을 계정으로 옮기는 동안에만 띄운다.
          체험 중 로그인 유도 배너는 지금 단계에서 필요 없어 뺐다 —
          하단 탭의 '로그인'과 기록이 없을 때의 안내로 충분하다. */}
      {migratingGuest && (
        <div style={{
          padding: '8px 14px', backgroundColor: '#eef1ff', color: '#414a8a',
          fontSize: '0.8rem', lineHeight: 1.4, flexShrink: 0,
        }}>
          써두신 기록을 계정으로 옮기는 중이에요…
        </div>
      )}
      {/* Header — 날짜 한 줄 + 요일 띠. 타임라인과 회고가 같은 모양을 쓴다 */}
      {activeView !== 'settings' && (
        <header className={`header header--week${showScheduleView && (inputFocused || slotPick) ? ' header--recording' : ''}`}>
          <div className="header-row">
            <div
              className="header-title-container"
              onClick={() => {
                if (activeView !== 'timeline') return;
                setCurrentMonth(selectedDate); setShowCalendar(true);
              }}
            >
              {activeView === 'timeline' && showScheduleView ? (
                /* 타임블럭은 스크롤로 자정을 넘나들므로 두 날짜가 겹치며 바뀐다.
                   흐리기(opacity)는 스크롤 핸들러가 DOM에 직접 쓴다 */
                <div className="header-date-stack" ref={headerStackRef}>
                  {windowDays.map((day, i) => (
                    <h1
                      key={i}
                      data-day-label={i}
                      style={{ opacity: isSameDay(day, selectedDate) ? 1 : 0 }}
                    >
                      {format(day, 'M월 d일 (E)', { locale: ko })}
                    </h1>
                  ))}
                </div>
              ) : (
                <h1>{format(headerDate, 'M월 d일 (E)', { locale: ko })}</h1>
              )}
            </div>
          </div>
          <WeekStrip
            selected={headerDate}
            onPick={activeView === 'review' ? pickReviewDay : goToDay}
            maxDate={activeView === 'review' ? todayReviewDate : null}
            marked={memoDayKeys}
          />
        </header>
      )}

      {/* Main Content */}
      <div className="main-content">
        {/* 스크롤하다 오늘에서 멀어지면 돌아갈 길을 띄운다.
            헤더 화살표로 하루씩 되짚어 올라가게 두면 안 된다. */}
        {activeView === 'timeline' && !isToday(selectedDate) && (
          <button
            type="button"
            className="today-fab"
            onClick={() => goToDay(new Date())}
          >
            오늘로
          </button>
        )}
        {activeView === 'timeline' ? (
          /* ── 타임라인 뷰 ── */
          showScheduleView ? (
            renderScheduleView()
          ) : (
          /* 채팅창은 헤더에 뜬 날짜 하루만 보여준다.
             (자정~새벽 2시 기록만 전날 화면에도 흐리게 얹는다 — 그건 원래 그 밤의 끝이다) */
          <div
            className="timeline"
            ref={timelineRef}
            onPointerDown={handleChatBlankPointerDown}
            onPointerMove={handleChatBlankPointerMove}
            onPointerUp={handleChatBlankPointerEnd}
            onPointerCancel={handleChatBlankPointerEnd}
          >
            {chatMemos.length === 0 ? (
              <div className="empty-state">
                <Inbox size={48} strokeWidth={1} />
                <p>
                  {isToday(selectedDate) ? '오늘의' : `${format(selectedDate, 'M월 d일')}의`} 기록이 없습니다.<br />
                  아래에서 첫 메모를 남겨보세요!
                </p>
                {/* 로그인이 풀린 채로 돌아온 사람은 여기서 텅 빈 화면을 만난다.
                    기록은 서버에 멀쩡히 있는데 사라진 줄 알고 떠나므로, 돌아갈 길을 여기 둔다.
                    체험 기록이 하나라도 있으면 굳이 안 띄운다 — 지금 쓰고 있는 사람에겐 방해다. */}
                {isGuest && memos.length === 0 && (
                  <button
                    type="button"
                    onClick={() => setShowLogin(true)}
                    style={{
                      marginTop: '18px', background: 'none', border: 'none', padding: 0,
                      color: 'var(--primary-color)', fontSize: '0.875rem', cursor: 'pointer',
                    }}
                  >
                    이미 쓰던 계정이 있나요? 로그인
                  </button>
                )}
              </div>
            ) : (
              memoGroups.map((group, groupIdx) => (
                <div
                  key={groupIdx}
                  className="memo-group"
                  style={{ marginTop: groupIdx > 0 ? '10px' : '0' }}
                >
                  {group.map(memo => (
                    <React.Fragment key={memo.id}>
                      {/* 꾹 눌러 옮기는 중, 여기 떨어뜨리면 이 기록 앞에 놓인다 */}
                      {draggingMemoId && reorderDrop === String(memo.id) && (
                        <div className="drop-indicator" aria-hidden="true" />
                      )}
                      <MemoItem
                        memo={memo}
                        onEdit={openBlockEditor}
                        onDeleteWithUndo={handleDeleteWithUndo}
                        habitKeywords={habitKeywords}
                        dimmed={!isSameDay(new Date(memo.recordedAt), selectedDate)}
                        duration={chatDurations[memo.id]}
                        reorder={memoReorder}
                      />
                    </React.Fragment>
                  ))}
                </div>
              ))
            )}
            {draggingMemoId && reorderDrop === 'end' && (
              <div className="drop-indicator" aria-hidden="true" />
            )}
            {/* 바닥 여백 — 이 빈 곳에서 좌우로 밀면 날짜가 넘어간다 */}
            {chatMemos.length > 0 && <div className="timeline-bottom-space" aria-hidden="true" />}
          </div>
          )
        ) : activeView === 'review' ? (
          /* ── 회고 탭 ── */
          <ReviewScreen
            facts={todayFacts}
            todayMemos={todayMemos}
            dayLabel={todayLabel}
            isToday={reviewIsToday}
            onSwipeDay={(delta) => pickReviewDay(addDays(reviewDay, delta))}
            week={weekFacts}
            now={nowTime}
            ai={tour.active ? tourAI : summaryForScreen}
            locked={isGuest && !tour.active}
            busy={tour.active ? tour.aiStatus === 'loading' : summaryBusy}
            usesLeft={tour.active ? SUMMARY_DAILY_LIMIT : summaryUsesLeft}
            habitKeywords={habitKeywords}
            dayRabbits={dayRabbits}
            onPickDay={pickReviewDay}
            viewKey={reviewKey}
            onViewed={handleSummaryViewed}
            onWeekViewed={handleWeekViewed}
            onGenerate={tour.active ? tourGenerate : generateSummary}
            onGoTimeline={() => setActiveView('timeline')}
            onLoginClick={() => {
              track('Summary Login Click', { memo_count: todayFacts?.count ?? 0 });
              requestGoogleSignIn();
            }}
          />
        ) : (
          /* ── 마이페이지 ── */
          <div style={{ flex: 1, overflowY: 'auto', backgroundColor: '#f5f5f5' }}>

            <div style={{
              maxWidth: '480px',
              margin: '0 auto',
              padding: '20px',
              display: 'flex',
              flexDirection: 'column',
              gap: '16px'
            }}>

              {currentUser && (
                <div style={{
                  backgroundColor: 'white',
                  padding: '20px',
                  borderRadius: '12px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '12px'
                }}>
                  <h2 style={{ fontSize: '1.1rem', fontWeight: '700', marginBottom: '8px' }}>프로필</h2>
                  <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                    <div style={{
                      width: '48px',
                      height: '48px',
                      borderRadius: '50%',
                      backgroundColor: '#f0f0f0',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center'
                    }}>
                      {currentUser.user_metadata?.avatar_url ? (
                        <img src={currentUser.user_metadata.avatar_url} alt="프로필" style={{ width: '100%', height: '100%', borderRadius: '50%' }} />
                      ) : (
                        <User size={24} color="#999" />
                      )}
                    </div>
                    <div>
                      <p style={{ fontSize: '0.9rem', color: '#666', margin: '0' }}>{currentUser.email}</p>
                      <p style={{ fontSize: '0.75rem', color: '#999', margin: '4px 0 0' }}>
                        {currentUser.app_metadata?.provider === 'google' ? '구글 로그인' : '이메일 가입'}
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {/* 습관 키워드 설정 */}
              <div className="mypage-card">
                <div className="card-header-icon">
                  <Tag size={18} style={{ color: 'var(--primary-color)' }} />
                  <h3>먼슬리 습관 키워드</h3>
                </div>
                <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '12px', lineHeight: 1.5 }}>
                  메모에 아래 단어가 포함되면 달력에 자동으로 표시됩니다.
                </p>
                <div className="keyword-list">
                  {habitKeywords.filter(k => !k.endedAt).map(kw => (
                    <div key={kw.name} className="keyword-chip" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <div style={{ width: '12px', height: '12px', borderRadius: '50%', backgroundColor: `var(--habit-${kw.color})`, flexShrink: 0 }} />
                      <span>{kw.name}</span>
                    </div>
                  ))}
                  {habitKeywords.filter(k => !k.endedAt).length === 0 && (
                    <span style={{ fontSize: '0.8rem', color: '#aaa' }}>등록된 키워드가 없습니다</span>
                  )}
                </div>
                <button className="btn-save" style={{ marginTop: '12px', width: '100%' }} onClick={openKeywordModal}>
                  키워드 관리
                </button>
              </div>

              {/* 앱 사용법 다시 보기 */}
              <div className="mypage-card">
                <div className="card-header-icon">
                  <HelpCircle size={18} style={{ color: 'var(--primary-color)' }} />
                  <h3>앱 사용법</h3>
                </div>
                <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '12px', lineHeight: 1.5 }}>
                  처음 안내에서 보여드린 사용법을 다시 볼 수 있어요.
                </p>
                <button
                  className="btn-cancel"
                  style={{ width: '100%' }}
                  onClick={() => startTour('mypage')}
                >
                  사용법 다시 보기
                </button>
              </div>

              {/* 의견 보내기 — 내용은 feedback 테이블로, 앱에서는 못 읽음 */}
              <div className="mypage-card">
                <div className="card-header-icon">
                  <MessageSquare size={18} style={{ color: 'var(--primary-color)' }} />
                  <h3>의견 보내기</h3>
                </div>
                <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '12px', lineHeight: 1.5 }}>
                  써보시면서 느낀 점을 들려주세요. 다음 업데이트에 큰 도움이 됩니다.
                </p>
                <FeedbackCard user={currentUser} />
              </div>

              {/* 받은 의견 — 관리자 계정에서만 보임 (서버 함수도 이메일을 확인함) */}
              {currentUser?.email === ADMIN_EMAIL && (
                <div className="mypage-card">
                  <div className="card-header-icon">
                    <MessageSquare size={18} style={{ color: 'var(--primary-color)' }} />
                    <h3>받은 의견</h3>
                  </div>
                  <AdminFeedbackList />
                </div>
              )}

              {/* Billing Card */}
              <div className="mypage-card billing-card">
                <div className="card-header-icon">
                  <CreditCard size={18} className="billing-icon" />
                  <h3>멤버십 &amp; 결제 관리</h3>
                </div>
                <div className="membership-status">
                  <span className="status-label">현재 플랜</span>
                  <span className="status-value active-plan">일반 회원 (Free Plan)</span>
                </div>
                <p className="billing-description">
                  프리미엄 요금제로 업그레이드하시면 무제한 메모 백업, 테마 커스터마이징, 고급 통계 기능을 이용할 수 있습니다.
                </p>
                <button className="btn-save upgrade-btn" onClick={() => alert('프리미엄 플랜 결제 기능은 준비 중입니다. 조금만 기다려주세요!')}>
                  프리미엄 요금제로 업그레이드
                </button>
                <button className="btn-cancel billing-history-btn" onClick={() => alert('결제 내역이 없습니다.')}>
                  결제 내역 조회
                </button>
              </div>

              {/* 계정 및 보안 */}
              <div className="mypage-card danger-zone-card">
                <div className="card-header-icon">
                  <ShieldAlert size={18} className="danger-icon" />
                  <h3>계정 및 보안</h3>
                </div>
                <div className="danger-zone-actions">
                  {currentUser.app_metadata?.provider === 'email' && (
                    <button className="btn-cancel logout-action-btn" onClick={() => setShowPasswordChange(true)}>
                      비밀번호 변경
                    </button>
                  )}
                  <button className="btn-cancel logout-action-btn" onClick={async () => { if (window.confirm('로그아웃 하시겠습니까?')) { await supabase.auth.signOut(); setActiveView('timeline'); } }}>
                    로그아웃
                  </button>
                  <button className="btn-cancel delete-account-btn" onClick={handleDeleteAccount} disabled={deletingAccount}>
                    {deletingAccount ? '회원탈퇴 진행 중...' : '회원탈퇴'}
                  </button>
                </div>
                {/* 이 화면이 언제 배포된 코드로 돌고 있는지.
                    폰(특히 홈 화면에 추가한 웹앱)은 한 번 띄운 화면을 계속 붙잡고 있어서,
                    "고쳤다는데 왜 그대로냐"가 옛 코드 때문인지 진짜 버그인지 구분이 안 됐다. */}
                <p className="build-stamp">
                  {format(new Date(__BUILD_TIME__), 'yyyy.MM.dd HH:mm')} 배포 · {__BUILD_COMMIT__}
                </p>
              </div>
            </div>
          </div>
        )}

        {/* 토스트 — '오늘로' 버튼과 같은 기준(콘텐츠 영역) 안에 띄운다.
            기본 자리는 버튼 자리, 버튼이 떠 있으면 그 위로 (겹치면 못 누른다) */}
        {undoToast && (
          <div className={toastClass}>
            <span>메모가 삭제되었습니다</span>
            <button className="undo-btn" onClick={handleUndo}>취소</button>
          </div>
        )}
        {moveUndoToast && (
          <div className={toastClass}>
            <span>기록을 옮겼어요</span>
            <button className="undo-btn" onClick={undoMoveAfterConfirm}>되돌리기</button>
          </div>
        )}
        {/* 회고 안내 — 되돌리기 토스트가 떠 있으면 그쪽이 우선 (같은 자리라 겹친다) */}
        {reviewToast && !undoToast && !moveUndoToast && (
          <div className={toastClass}>
            <span>오늘의 회고를 확인해보세요</span>
            <button className="undo-btn" onClick={openReviewFromToast}>보기</button>
          </div>
        )}
        {/* 투어의 회고 토스트 — 기록이 쌓이면 이 토스트가 뜬다는 걸 그대로 보여주고, 눌러야 넘어간다 */}
        {tour.active && TOUR_STEPS[tour.step]?.key === 'review-toast' && (
          <div className="undo-toast tour-toast">
            <span>오늘의 회고를 확인해보세요</span>
            <button
              className="undo-btn"
              onClick={() => { setActiveView('review'); setTimeout(tourNext, 350); }}
            >
              보기
            </button>
          </div>
        )}
      </div>

      {/* 기록이 이 기기에만 있다는 안내.
          몇 줄 써서 아까워질 때쯤(3개) 한 번만 뜨고, 닫으면 다시 안 뜬다.
          겁주지 않는다 — 사실 한 줄과 남기는 방법만 준다. */}
      {activeView === 'timeline' && showSaveNotice && (
        <div className="save-notice">
          <p className="save-notice-text">
            지금 기록은 이 기기에만 있어요.
            {isIOSDevice && !inStandaloneApp
              ? ' 사파리는 한동안 안 들어오면 정리하니, 공유 버튼에서 ‘홈 화면에 추가’를 하면 그대로 남아요.'
              : ' 로그인하면 어느 기기에서나 그대로 남아요.'}
          </p>
          <div className="save-notice-actions">
            <button
              type="button"
              className="save-notice-btn save-notice-btn--primary"
              onClick={() => { dismissSaveNotice('login'); setShowLogin(true); }}
            >
              로그인하고 보관
            </button>
            <button
              type="button"
              className="save-notice-btn"
              onClick={() => dismissSaveNotice('dismissed')}
            >
              나중에
            </button>
          </div>
        </div>
      )}

      {/* Input Area (타임라인 뷰에서만) */}
      {activeView === 'timeline' && (
        <div className={`input-area${inputActive ? ' input-area--active' : ''}`}>
          {/* 대기 중엔 [입력창][보내기] 한 줄. 활성화되면 글자가 위, 버튼이 아래 한 줄 */}
          <div className="input-row">
          {/* 글자만 — 뒤에 깔린 거울이 앞머리 시각에 색을 입힌다 */}
          <div className="input-box">
            <div className="input-mirror input-text-metrics" aria-hidden="true">
              {timePrefixLen > 0 && <span className="time-mark">{inputText.slice(0, timePrefixLen)}</span>}
              {inputText.slice(timePrefixLen)}{'\n'}
            </div>
            {/* 앞머리 시각 위에 얹는 투명 버튼 — 눌러서 시간 조정 시트를 연다.
                시각 부분만 덮어 뒤쪽 본문 타이핑은 방해하지 않는다. */}
            {showScheduleView && pendingSpan && timePrefixLen > 0 && (
              <button
                type="button"
                className="input-time-hit input-text-metrics"
                aria-label="시간 조정"
                onMouseDown={e => e.preventDefault()}
                onClick={openBandEditor}
              >{inputText.slice(0, timePrefixLen)}</button>
            )}
            {/* 여러 줄을 쓸 수 있는 textarea. 모바일 엔터는 줄바꿈, 전송은 버튼.
                (PC는 엔터로 저장, Shift+엔터로 줄바꿈) */}
            <textarea
              ref={inputRef}
              rows={1}
              className="input-field input-field--chat input-text-metrics"
              // 첫 기록 전에는 온보딩 문구로 — 여기 적는 것이 곧 첫 기록이다
              placeholder={memos.length === 0
                ? '지금 한 일을 적어보세요'
                : (IS_TOUCH_DEVICE ? INPUT_PROMPTS[promptIdx] : `${INPUT_PROMPTS[promptIdx]} (엔터로 저장)`)}
              value={inputText}
              onChange={e => {
                setInputText(e.target.value);
                // 줄 수만큼 자라고, 너무 길면 안에서 스크롤
                e.target.style.height = 'auto';
                e.target.style.height = `${Math.min(e.target.scrollHeight, 110)}px`;
              }}
              onScroll={e => { const m = e.target.previousSibling; if (m) m.scrollTop = e.target.scrollTop; }}
              onFocus={() => setInputFocused(true)}
              onBlur={() => setInputFocused(false)}
              onKeyDown={handleKeyDown}
              autoFocus={!IS_TOUCH_DEVICE}
            />
          </div>
          {!inputActive && sendButton}
          </div>

          {/* 활성화되면 버튼이 아래 한 줄에: 색 · 이어서 · 보내기 */}
          {inputActive && (
          <div className="input-tools">
            <div className="color-picker-wrapper">
              {/* 빈 동그라미만 있으면 할 일 체크로 오해받는다 — 팔레트 아이콘을 넣어
                  '색을 고르는 버튼'임이 보이게 한다 */}
              <button
                type="button"
                className="color-trigger-btn"
                style={{
                  backgroundColor: COLOR_PALETTE.find(c => c.id === selectedColor)?.bg || '#f9f9fb',
                  borderColor: COLOR_BORDER[selectedColor] || '#ddd'
                }}
                onMouseDown={e => e.preventDefault()}
                onClick={() => setShowColorPicker(p => !p)}
                title="메모 색상 선택"
                aria-label="메모 색상 선택"
              >
                <Palette size={15} strokeWidth={2.2} />
              </button>
              {showColorPicker && (
                <div className="color-palette-popup">
                  {COLOR_PALETTE.map(c => (
                    <button
                      key={c.id}
                      className={`color-swatch ${selectedColor === c.id ? 'selected' : ''}`}
                      style={{ backgroundColor: c.bg, borderColor: COLOR_BORDER[c.id] }}
                      onMouseDown={e => e.preventDefault()}
                      onClick={() => { setSelectedColor(c.id); setShowColorPicker(false); }}
                      title={c.label}
                    />
                  ))}
                </div>
              )}
            </div>

            {/* 누르면 그 방식으로 바로 저장된다 (보내기를 또 누를 필요 없음) */}
            <button
              type="button"
              className="link-chip link-chip--prev"
              onMouseDown={e => e.preventDefault()}
              onClick={() => handleAddMemo(null, 'prev')}
              disabled={!inputText.trim()}
            >
              ↑ 이전 기록부터
            </button>
            <button
              type="button"
              className="link-chip link-chip--next"
              onMouseDown={e => e.preventDefault()}
              onClick={() => handleAddMemo(null, 'next')}
              disabled={!inputText.trim()}
            >
              ↓ 다음 기록까지
            </button>

            {sendButton}
          </div>
          )}
        </div>
      )}

      {/* 하단 탭바 */}
      <nav className="bottom-tab-bar">
        <button
          className={`tab-btn ${activeView === 'timeline' ? 'active' : ''}`}
          onClick={() => {
            // 이미 타임라인이면 한 번 더 누를 때 채팅형 ↔ 시간대별 전환
            // (다른 탭에서 오면 첫 탭은 이동, 두 번째 탭부터 전환된다)
            if (activeView === 'timeline') toggleScheduleView();
            else setActiveView('timeline');
          }}
        >
          <Clock size={20} />
          <span>타임라인</span>
        </button>
        <button
          className={`tab-btn ${activeView === 'review' ? 'active' : ''}`}
          onClick={() => setActiveView('review')}
        >
          <Sparkles size={20} />
          <span>회고</span>
        </button>
        <button
          className={`tab-btn ${activeView === 'settings' ? 'active' : ''}`}
          onClick={() => {
            // 마이페이지는 계정 화면이라 체험 중에는 보여줄 게 없다
            if (isGuest) { setShowLogin(true); return; }
            setActiveView('settings');
          }}
        >
          <User size={20} />
          <span>{isGuest ? '로그인' : '마이페이지'}</span>
        </button>
      </nav>


      {/* 잡힌 시간대 조정 — 드래그 핸들 + 고급선택 휠 */}
      {rangeSheet && (
        <TimeRangeSheet
          init={rangeSheet}
          onDone={applyRangeSheet}
          onCancel={() => setRangeSheet(null)}
        />
      )}

      {/* 시간표 빈 자리를 누른 직후: 휠로 시각을 맞춘 뒤 입력창으로 간다 */}
      {slotPick && (
        <div className="block-sheet-overlay block-sheet-overlay--peek" onClick={() => { setSlotPick(null); setInputText(prev => prev.replace(PREFIX_RE, '')); }}>
          <div className="block-sheet move-confirm-sheet" onClick={e => e.stopPropagation()}>
            <div className="block-sheet-handle" />
            <div className="block-sheet-head">
              <h3>{slotPick.isRange ? '언제부터 언제까지 한 일인가요?' : '몇 시에 한 일인가요?'}</h3>
            </div>
            <p className="move-confirm-prev">{format(new Date(slotPick.dayMs), 'M월 d일 (E)', { locale: ko })}</p>
            {slotPick.isRange && (
              <div className="block-time-row">
                <button
                  type="button"
                  className={`block-input block-time-btn${slotPick.wheel === 'start' ? ' open' : ''}`}
                  onClick={() => setSlotPick(sp => (sp ? { ...sp, wheel: 'start' } : sp))}
                >
                  {timeLabel12(slotPick.draftStart)}
                </button>
                <span className="block-time-sep">→</span>
                <button
                  type="button"
                  className={`block-input block-time-btn${slotPick.wheel === 'end' ? ' open' : ''}`}
                  onClick={() => setSlotPick(sp => (sp ? { ...sp, wheel: 'end' } : sp))}
                >
                  {timeLabel12(slotPick.draftEnd)}
                </button>
              </div>
            )}
            <TimeWheelPicker
              value={slotPick.isRange && slotPick.wheel === 'end' ? slotPick.draftEnd : slotPick.draftStart}
              onChange={v => setSlotPick(sp => {
                if (!sp) return sp;
                return sp.isRange && sp.wheel === 'end' ? { ...sp, draftEnd: v } : { ...sp, draftStart: v };
              })}
            />
            {slotPick.isRange && (() => {
              const toMin = (str) => { const [h, mi] = str.split(':').map(Number); return h * 60 + mi; };
              const startMin = toMin(slotPick.draftStart);
              let endMin = toMin(slotPick.draftEnd);
              const crossed = endMin <= startMin;
              if (crossed) endMin += 1440;
              const dur = formatDuration(endMin - startMin);
              return (
                <p className="move-confirm-range">
                  {timeLabel12(slotPick.draftStart)} → {timeLabel12(slotPick.draftEnd)}
                  {crossed ? ' (다음날)' : ''}{dur ? ` · ${dur}` : ''}
                </p>
              );
            })()}
            <div className="block-sheet-actions">
              <button className="btn-cancel" onClick={() => { setSlotPick(null); setInputText(prev => prev.replace(PREFIX_RE, '')); }}>취소</button>
              <button className="btn-save" onClick={confirmSlotPick}>이 시각으로 쓰기</button>
            </div>
          </div>
        </div>
      )}

      {/* 꾹 눌러 옮긴 직후: 휠로 시각을 확인/수정해야 옮기기가 끝난다.
          바깥을 누르면 시간을 정하지 않겠다는 뜻 — 되돌리기와 같다 */}
      {moveConfirm && (
        <div className="block-sheet-overlay" onClick={undoMove}>
          <div className="block-sheet move-confirm-sheet" onClick={e => e.stopPropagation()}>
            <div className="block-sheet-handle" />
            <div className="block-sheet-head">
              <h3>{moveConfirm.isRange ? '언제부터 언제까지로 옮길까요?' : '몇 시 기록으로 옮길까요?'}</h3>
            </div>
            {/* 옮기기 전 시각 — 되돌리기를 누르면 여기로 돌아간다 */}
            <p className="move-confirm-prev">기존 · {moveConfirm.prevLabel}</p>
            {moveConfirm.isRange && (
              /* 구간은 시작·종료를 각각 고친다 — 누른 칸이 아래 휠에 열린다 */
              <div className="block-time-row">
                <button
                  type="button"
                  className={`block-input block-time-btn${moveConfirm.wheel === 'start' ? ' open' : ''}`}
                  onClick={() => setMoveConfirm(m => (m ? { ...m, wheel: 'start' } : m))}
                >
                  {timeLabel12(moveConfirm.draftStart)}
                </button>
                <span className="block-time-sep">→</span>
                <button
                  type="button"
                  className={`block-input block-time-btn${moveConfirm.wheel === 'end' ? ' open' : ''}`}
                  onClick={() => setMoveConfirm(m => (m ? { ...m, wheel: 'end' } : m))}
                >
                  {timeLabel12(moveConfirm.draftEnd)}
                </button>
              </div>
            )}
            <TimeWheelPicker
              value={moveConfirm.isRange && moveConfirm.wheel === 'end' ? moveConfirm.draftEnd : moveConfirm.draftStart}
              onChange={v => setMoveConfirm(m => {
                if (!m) return m;
                return m.isRange && m.wheel === 'end' ? { ...m, draftEnd: v } : { ...m, draftStart: v };
              })}
            />
            {/* 구간 기록: 옮겨질 구간 전체와 길이. 종료가 시작보다 이르면 다음날로 이어진다 */}
            {moveConfirm.isRange && (() => {
              const toMin = (s) => { const [h, mi] = s.split(':').map(Number); return h * 60 + mi; };
              const startMin = toMin(moveConfirm.draftStart);
              let endMin = toMin(moveConfirm.draftEnd);
              const crossed = endMin < startMin;
              if (crossed) endMin += 1440;
              const dur = formatDuration(endMin - startMin);
              return (
                <p className="move-confirm-range">
                  {timeLabel12(moveConfirm.draftStart)} → {timeLabel12(moveConfirm.draftEnd)}
                  {crossed ? ' (다음날)' : ''}{dur ? ` · ${dur}` : ''}
                </p>
              );
            })()}
            <div className="block-sheet-actions">
              <button className="btn-cancel" onClick={undoMove}>되돌리기</button>
              <button className="btn-save" onClick={confirmMove}>이 시각으로 옮기기</button>
            </div>
          </div>
        </div>
      )}

      {/* 할 일 시트 — 화면을 옮기지 않고 아래에서 올라온다 */}
      {showTodoSheet && (
        <div className="todo-backdrop" onClick={() => setShowTodoSheet(false)}>
          <div className="todo-sheet" onClick={e => e.stopPropagation()}>
            <div className="todo-sheet-handle" />
            <div className="todo-sheet-head">
              <h3>할 일</h3>
              <button className="todo-close-btn" onClick={() => setShowTodoSheet(false)} title="닫기">
                <X size={18} />
              </button>
            </div>

            <form className="todo-add-row" onSubmit={handleAddTodo}>
              <input
                ref={todoInputRef}
                type="text"
                className="todo-add-input"
                placeholder="할 일을 적어두세요"
                value={todoInput}
                onChange={e => setTodoInput(e.target.value)}
              />
              <button type="submit" className="todo-add-btn" disabled={!todoInput.trim()} title="추가">
                <Plus size={18} />
              </button>
            </form>

            <div className="todo-list" ref={todoListRef}>
              {todos.length === 0 ? (
                <p className="todo-empty">적어두면 여기에 남아있어요.</p>
              ) : (
                groupTodosByDay(todos).map(group => (
                <div key={group.date.toDateString()} className="todo-day">
                  <div className="todo-day-label"><span>{todoDayLabel(group.date)}</span></div>
                  {group.items.map(todo => (
                  <div key={todo.id} className={`todo-item${todo.done ? ' todo-item--done' : ''}`}>
                    <button
                      className={`todo-check${todo.done ? ' checked' : ''}`}
                      onClick={() => handleToggleTodo(todo)}
                      title={todo.done ? '되돌리기' : '완료'}
                    />
                    {editingTodoId === todo.id ? (
                      <input
                        className="todo-text todo-text-edit"
                        value={editingTodoText}
                        autoFocus
                        onChange={e => setEditingTodoText(e.target.value)}
                        onBlur={() => commitEditTodo(todo)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
                          if (e.key === 'Escape') { setEditingTodoId(null); }
                        }}
                      />
                    ) : (
                      /* 적어둔 걸 눌러서 바로 고친다. 완료한 건 고칠 일이 없으니 그대로 둔다 */
                      <span
                        className="todo-text"
                        onClick={() => { if (!todo.done) startEditTodo(todo); }}
                      >
                        {todo.content}
                      </span>
                    )}
                    <button
                      className="todo-move-btn"
                      onClick={() => handleTodoToMemo(todo)}
                      title="지금 기록으로 옮기기"
                    >
                      <CornerDownLeft size={16} />
                    </button>
                    <button className="todo-del-btn" onClick={() => handleDeleteTodo(todo)} title="삭제">
                      <X size={15} />
                    </button>
                  </div>
                  ))}
                </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* Calendar Modal */}
      {showCalendar && (
        <div className="modal-overlay" onClick={() => setShowCalendar(false)}>
          {renderCalendar()}
        </div>
      )}

      {/* 습관 키워드 관리 모달 */}
      {showKeywordModal && (
        <div className="modal-overlay" onClick={() => setShowKeywordModal(false)}>
          <div className="modal-content" onClick={e => e.stopPropagation()} style={{ maxHeight: '80vh', overflowY: 'auto' }}>
            <h3 className="modal-title">습관 키워드 관리</h3>

            {/* 등록된 키워드 목록 */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '16px' }}>
              {draftKeywords.filter(k => !k.endedAt).map(kw => (
                deletingKeyword === kw.name ? (
                  <div key={kw.name} style={{ backgroundColor: '#fff5f5', borderRadius: '10px', padding: '10px 12px' }}>
                    <p style={{ fontSize: '0.85rem', margin: '0 0 8px', color: '#333' }}>
                      '{kw.name}' 삭제 — 이전 기록은 어떻게 할까요?
                    </p>
                    <div style={{ display: 'flex', gap: '6px' }}>
                      <button className="btn-cancel" style={{ flex: 1, fontSize: '0.78rem', padding: '8px 4px' }} onClick={() => archiveDraftKeyword(kw.name)}>
                        기록 남기기
                      </button>
                      <button className="btn-cancel" style={{ flex: 1, fontSize: '0.78rem', padding: '8px 4px', color: '#e53e3e' }} onClick={() => removeDraftKeyword(kw.name)}>
                        모두 삭제
                      </button>
                      <button className="btn-cancel" style={{ flex: 1, fontSize: '0.78rem', padding: '8px 4px' }} onClick={() => setDeletingKeyword(null)}>
                        취소
                      </button>
                    </div>
                  </div>
                ) : (
                  <div key={kw.name} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 12px', backgroundColor: '#f9f9fb', borderRadius: '10px' }}>
                    <button
                      onClick={() => cycleDraftColor(kw.name)}
                      title="색상 변경 (누를 때마다 바뀜)"
                      style={{ width: '20px', height: '20px', borderRadius: '50%', backgroundColor: `var(--habit-${kw.color})`, border: '1px solid rgba(0,0,0,0.1)', cursor: 'pointer', padding: 0, flexShrink: 0 }}
                    />
                    <span style={{ flex: 1, fontSize: '0.9rem' }}>{kw.name}</span>
                    <button
                      onClick={() => { if (isExistingKeyword(kw.name)) { setDeletingKeyword(kw.name); } else { removeDraftKeyword(kw.name); } }}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px', color: '#999' }}
                      aria-label="삭제"
                    >
                      <X size={16} />
                    </button>
                  </div>
                )
              ))}
              {draftKeywords.filter(k => !k.endedAt).length === 0 && (
                <span style={{ fontSize: '0.85rem', color: '#aaa', textAlign: 'center', padding: '8px 0' }}>등록된 키워드가 없습니다</span>
              )}
            </div>

            {/* 기록 보관 중인 키워드 */}
            {draftKeywords.some(k => k.endedAt) && (
              <div style={{ marginBottom: '16px' }}>
                <p style={{ fontSize: '0.75rem', color: '#999', margin: '0 0 6px' }}>기록 보관 중 (이전 날짜 기록에만 표시됨)</p>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                  {draftKeywords.filter(k => k.endedAt).map(kw => (
                    <div key={kw.name} style={{ display: 'flex', alignItems: 'center', gap: '4px', padding: '4px 8px', backgroundColor: '#f0f0f0', borderRadius: '8px', fontSize: '0.8rem', color: '#888' }}>
                      <div style={{ width: '10px', height: '10px', borderRadius: '50%', backgroundColor: `var(--habit-${kw.color})`, opacity: 0.6 }} />
                      <span>{kw.name}</span>
                      <button
                        onClick={() => removeDraftKeyword(kw.name)}
                        title="기록까지 완전 삭제"
                        style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '1px', color: '#aaa' }}
                      >
                        <X size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 새 키워드 추가 */}
            <div style={{ borderTop: '1px solid #f0f0f0', paddingTop: '14px', marginBottom: '16px', width: '100%' }}>
              <div style={{ display: 'flex', gap: '6px', marginBottom: '8px' }}>
                {HABIT_COLORS.map(color => (
                  <button
                    key={color}
                    onClick={() => setNewKeywordColor(color)}
                    style={{ width: '24px', height: '24px', borderRadius: '50%', backgroundColor: `var(--habit-${color})`, border: newKeywordColor === color ? '2px solid #333' : '1px solid rgba(0,0,0,0.1)', cursor: 'pointer', padding: 0 }}
                  />
                ))}
              </div>
              <div style={{ display: 'flex', gap: '6px' }}>
                <input
                  type="text"
                  className="input-field"
                  placeholder="새 키워드"
                  value={newKeyword}
                  onChange={e => setNewKeyword(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addDraftKeyword(); } }}
                  style={{ flex: 1, borderRadius: '8px', fontSize: '0.9rem', padding: '8px 12px' }}
                />
                <button className="btn-save" onClick={addDraftKeyword} disabled={!newKeyword.trim()} style={{ width: '60px', padding: '8px 0' }}>
                  추가
                </button>
              </div>
            </div>

            <div className="modal-actions">
              <button className="btn-cancel" onClick={() => setShowKeywordModal(false)}>취소</button>
              <button className="btn-save" onClick={saveKeywordModal}>저장</button>
            </div>
          </div>
        </div>
      )}

      {/* 비밀번호 변경 모달 */}
      {showPasswordChange && (
        <div className="modal-overlay" onClick={() => { setShowPasswordChange(false); setPasswordChangeError(''); setPasswordChangeSuccess(false); }}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <h3 className="modal-title">비밀번호 변경</h3>
            {passwordChangeSuccess ? (
              <div style={{ padding: '20px', textAlign: 'center', backgroundColor: '#f0fdf4', borderRadius: '12px', marginBottom: '20px' }}>
                <p style={{ fontSize: '0.95rem', color: '#166534', fontWeight: '600', margin: 0 }}>
                  ✓ 비밀번호가 변경되었습니다
                </p>
              </div>
            ) : (
              <>
                <div style={{ width: '100%' }}>
                  <div className="form-group" style={{ marginBottom: '12px' }}>
                    <label style={{ fontSize: '0.9rem', fontWeight: '600' }}>현재 비밀번호</label>
                    <input
                      type="password"
                      className="input-field"
                      placeholder="현재 비밀번호 입력"
                      value={currentPw}
                      onChange={e => setCurrentPw(e.target.value)}
                      style={{ borderRadius: '8px', fontSize: '0.9rem', padding: '8px 12px' }}
                      autoComplete="off"
                    />
                  </div>
                  <div className="form-group" style={{ marginBottom: '12px' }}>
                    <label style={{ fontSize: '0.9rem', fontWeight: '600' }}>새 비밀번호</label>
                    <input
                      type="password"
                      className="input-field"
                      placeholder="8~16자 (영문, 숫자, 특수문자)"
                      value={newPw}
                      onChange={e => setNewPw(e.target.value)}
                      style={{ borderRadius: '8px', fontSize: '0.9rem', padding: '8px 12px' }}
                      autoComplete="off"
                    />
                  </div>
                  <div className="form-group" style={{ marginBottom: '12px' }}>
                    <label style={{ fontSize: '0.9rem', fontWeight: '600' }}>새 비밀번호 확인</label>
                    <input
                      type="password"
                      className="input-field"
                      placeholder="새 비밀번호 재입력"
                      value={confirmNewPw}
                      onChange={e => setConfirmNewPw(e.target.value)}
                      style={{ borderRadius: '8px', fontSize: '0.9rem', padding: '8px 12px' }}
                      autoComplete="off"
                    />
                  </div>
                </div>
                {passwordChangeError && <div className="auth-error-message" style={{ marginBottom: '12px' }}>{passwordChangeError}</div>}
              </>
            )}
            <div className="modal-actions" style={{ flexDirection: 'column', gap: '8px' }}>
              {!passwordChangeSuccess && (
                <div style={{ display: 'flex', gap: '12px', width: '100%' }}>
                  <button className="btn-cancel" onClick={() => { setShowPasswordChange(false); setPasswordChangeError(''); }} style={{ flex: 1 }}>취소</button>
                  <button className="btn-save" onClick={handlePasswordChange} disabled={changingPassword} style={{ flex: 1 }}>
                    {changingPassword ? '변경 중...' : '변경하기'}
                  </button>
                </div>
              )}
              {passwordChangeSuccess && (
                <button className="btn-save" onClick={() => { setShowPasswordChange(false); setPasswordChangeError(''); setPasswordChangeSuccess(false); }} style={{ width: '100%' }}>
                  닫기
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 기록 편집 시트 — 채팅창과 타임블럭이 같은 것을 쓴다.
          어느 화면 어느 자리를 눌러도 여기서 내용·시간·색상·삭제를 다 할 수 있다 */}
      {editingMemo && (
        <div className="block-sheet-overlay" onClick={closeBlockEditor}>
          <div className="block-sheet" onClick={e => e.stopPropagation()}>
            <div className="block-sheet-handle" />
            <div className="block-sheet-head">
              <h3>기록 수정</h3>
              <button className="block-sheet-close" onClick={closeBlockEditor} title="닫기">
                <X size={18} />
              </button>
            </div>

            <div className="block-sheet-body">
              <div className="block-field">
                <span className="block-field-label">내용</span>
                <textarea
                  className="block-textarea"
                  value={editContentStr}
                  onChange={e => setEditContentStr(e.target.value)}
                  rows={3}
                />
              </div>

              <div className="block-field">
                <div className="block-field-head">
                  <span className="block-field-label">시간</span>
                  {/* 그냥 적어둔 한 줄과, 얼마나 걸렸는지가 있는 일은 다르다.
                      전부 구간으로 물으면 메모할 때마다 쓸데없는 결정을 하게 된다 */}
                  <div className="block-mode-toggle">
                    <button
                      type="button"
                      className={editMode === 'moment' ? 'active' : ''}
                      onClick={() => switchEditMode('moment')}
                    >
                      한 순간
                    </button>
                    <button
                      type="button"
                      className={editMode === 'range' ? 'active' : ''}
                      onClick={() => switchEditMode('range')}
                    >
                      구간
                    </button>
                  </div>
                </div>
                <input
                  type="date"
                  className="block-input block-input--date"
                  value={editDateStr}
                  onChange={e => setEditDateStr(e.target.value)}
                />
                {/* 기기 기본 time 입력은 갤럭시에서 시계 다이얼이 떠서 불편했다.
                    어느 기기에서나 똑같도록 앱이 직접 그리는 휠로 고른다 */}
                <div className="block-time-row">
                  <button
                    type="button"
                    className={`block-input block-time-btn${openTimeWheel === 'start' ? ' open' : ''}`}
                    onClick={() => setOpenTimeWheel(w => (w === 'start' ? null : 'start'))}
                    /* 자동으로 잇는 중에는 시작이 이전 기록을 따라가므로 직접 못 고친다 */
                    disabled={editMode === 'range' && editSpansFromPrev}
                  >
                    {timeLabel12(editStartStr)}
                  </button>
                  {editMode === 'range' && (
                    <>
                      <span className="block-time-sep">→</span>
                      <button
                        type="button"
                        className={`block-input block-time-btn${openTimeWheel === 'end' ? ' open' : ''}`}
                        onClick={() => setOpenTimeWheel(w => (w === 'end' ? null : 'end'))}
                        /* 자동으로 잇는 중에는 끝 시각이 다음 기록을 따라가므로 직접 못 고친다 */
                        disabled={editSpansToNext}
                      >
                        {timeLabel12(editEndStr)}
                      </button>
                    </>
                  )}
                </div>
                {openTimeWheel === 'start' && !(editMode === 'range' && editSpansFromPrev) && (
                  <TimeWheelPicker value={editStartStr} onChange={setEditStartStr} />
                )}
                {openTimeWheel === 'end' && editMode === 'range' && !editSpansToNext && (
                  <TimeWheelPicker value={editEndStr} onChange={setEditEndStr} />
                )}
                {/* 하루의 밤은 새벽 2시까지 — 새벽 시각은 이 날짜의 밤으로 저장된다 */}
                {(editStartStr < '02:00' || (editMode === 'range' && editEndStr < '02:00')) && (
                  <small className="block-dawn-hint">
                    새벽 0~2시 시각은 이 날짜의 밤(다음날 새벽)으로 저장돼요.
                  </small>
                )}
                {editMode === 'range' && (
                  <label className="block-auto-toggle">
                    <input
                      type="checkbox"
                      checked={editSpansFromPrev}
                      onChange={toggleDraftSpansFromPrev}
                    />
                    <span className="block-auto-toggle-text">
                      <strong>이전 기록부터 이어서 표시</strong>
                      <small>끝나고 적은 기록일 때. 이전 기록 시각부터 이 기록까지 한 덩어리가 됩니다.</small>
                    </span>
                  </label>
                )}
                {editMode === 'range' && (
                  <label className="block-auto-toggle">
                    <input
                      type="checkbox"
                      checked={editSpansToNext}
                      onChange={toggleDraftSpansToNext}
                    />
                    <span className="block-auto-toggle-text">
                      <strong>다음 기록까지 자동으로 잇기</strong>
                      <small>마지막 기록이면 지금 이 순간까지 진행 중으로 그려집니다.</small>
                    </span>
                  </label>
                )}
              </div>

              <div className="block-field">
                <span className="block-field-label">색상</span>
                <div className="block-color-row">
                  {COLOR_PALETTE.map(c => (
                    <button
                      key={c.id}
                      type="button"
                      className={`block-color-swatch ${editMemoColor === c.id ? 'selected' : ''}`}
                      style={{ backgroundColor: c.bg, borderColor: COLOR_BORDER[c.id] }}
                      onClick={() => setEditMemoColor(c.id)}
                      title={c.label}
                    />
                  ))}
                </div>
              </div>
            </div>

            <div className="block-sheet-actions">
              <button className="block-delete-btn" onClick={deleteFromBlockEditor}>삭제</button>
              <button className="btn-cancel" onClick={closeBlockEditor}>취소</button>
              <button className="btn-save" onClick={saveBlockEdit}>저장</button>
            </div>
          </div>
        </div>
      )}

      {showConsent && (
        <ConsentSheet onAgree={agreeAndSignIn} onClose={() => { track('Consent', { action: 'closed' }); setShowConsent(false); }} />
      )}
      {/* 스플래시 — 처음 온 사람에게 브랜드 한 번만 보여주고 바로 투어로. */}
      {showSplash && (
        <Splash
          onDone={() => {
            localStorage.setItem(SPLASH_KEY, '1');
            track('Splash', { action: 'entered' });
            setShowSplash(false);
            // 홈에 들어서자마자 투어 시작 — 첫 단계가 "지금 한 일을 적어보세요"다
            startTour('splash');
          }}
        />
      )}
      {tour.active && TOUR_STEPS[tour.step] && (
        <TourOverlay
          step={TOUR_STEPS[tour.step]}
          index={tour.step}
          containerRef={appContainerRef}
          onTargetTap={handleTourTargetTap}
          onNext={tourNext}
          onFinish={() => endTour('completed')}
          onSkip={() => endTour('skipped')}
        />
      )}

    </div>
  );
}

export default App;
