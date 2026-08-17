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
import { Send, Calendar, ChevronLeft, ChevronRight, Inbox, User, CreditCard, ShieldAlert, X, Trash2, Clock, LayoutGrid, Tag, Plus, ListChecks, CornerDownLeft } from 'lucide-react';
import { supabase, setRememberMe, getRememberMe } from './supabase';
import { track, identifyUser, resetUser, markFirstMemo } from './analytics';
import { loadGuestRows, saveGuestRows, clearGuestRows, newGuestId } from './guestStore';

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

// 습관 키워드 색상 (배경은 --habit-* CSS 변수, 테두리는 한 톤 진하게)
const HABIT_BORDER = {
  purple: '#d8b4fe',
  blue:   '#93c5fd',
  green:  '#86efac',
  pink:   '#f9a8d4',
  orange: '#fdba74',
};

// 체험 모드에서 브라우저에 담아둔 기록을 화면에 쓸 모양으로 꺼낸다
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
function buildMonthlyData(memos, habitKeywords) {
  const result = {}; // key: 'YYYY-MM-DD'

  memos.forEach(memo => {
    const dateKey = format(new Date(memo.recordedAt), 'yyyy-MM-dd');
    if (!result[dateKey]) result[dateKey] = { income: 0, expense: 0, habits: [] };

    // 가계부
    const fin = parseFinance(memo.content);
    if (fin) {
      if (fin.type === 'income') result[dateKey].income += fin.amount;
      else result[dateKey].expense += fin.amount;
    }

    // 습관 키워드 (보관된 키워드는 종료일 이전 기록에만 적용)
    habitKeywords.forEach(kwObj => {
      if (
        kwObj?.name &&
        memo.content.includes(kwObj.name) &&
        (!kwObj.endedAt || dateKey < kwObj.endedAt) &&
        !result[dateKey].habits.find(h => h.name === kwObj.name)
      ) {
        result[dateKey].habits.push(kwObj);
      }
    });
  });

  return result;
}

// ── 스와이프 훅 ───────────────────────────────────────────────
function useSwipe(onSwipeLeft, onSwipeRight, threshold = 60) {
  const startX = useRef(null);
  const startY = useRef(null);

  const onTouchStart = (e) => {
    startX.current = e.touches[0].clientX;
    startY.current = e.touches[0].clientY;
  };

  const onTouchEnd = (e) => {
    if (startX.current === null) return;
    const dx = e.changedTouches[0].clientX - startX.current;
    const dy = Math.abs(e.changedTouches[0].clientY - startY.current);
    if (dy > 40) return; // 세로 스크롤 무시
    if (dx < -threshold) onSwipeLeft?.();
    else if (dx > threshold) onSwipeRight?.();
    startX.current = null;
  };

  return { onTouchStart, onTouchEnd };
}

// ── 메모 아이템 컴포넌트 ──────────────────────────────────────
function MemoItem({ memo, onEdit, onDeleteWithUndo, isTouchDevice, habitKeywords, dimmed }) {
  const [swiped, setSwiped] = useState(false);

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

  const swipe = useSwipe(
    () => setSwiped(true),
    () => setSwiped(false),
    50
  );

  return (
    <div
      className={`memo-swipe-wrapper ${swiped ? 'swiped' : ''}`}
      style={dimmed ? { opacity: 0.45 } : undefined}
      {...swipe}
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
          <span className="memo-time">{format(new Date(memo.recordedAt), 'aa h:mm', { locale: ko })}</span>
        </div>
        <div
          className="memo-content"
          style={{ backgroundColor: colorBg, borderColor: colorBorder, cursor: 'pointer' }}
          onClick={() => onEdit(memo)}
          title="기록 수정하기"
        >
          {memo.content.split('\n').map((line, i, arr) => (
            <React.Fragment key={i}>
              {line}
              {i !== arr.length - 1 && <br />}
            </React.Fragment>
          ))}
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

// 타임블럭은 날짜를 끊지 않고 이어서 스크롤한다.
// 한 번에 그려두는 날짜 수 — 이보다 멀리 가려면 헤더 화살표나 달력을 쓴다.
//
// 예전에는 2일치만 깔아두고 위 끝에 닿을 때마다 3일씩 더 깔았다. 그런데 앞에
// 날짜를 붙이면 보던 자리가 그만큼 밀려서 스크롤을 되돌려줘야 하는데,
// iOS는 관성으로 미끄러지는 중에 스크롤 위치를 바꿔도 무시하고 원래 가려던
// 자리로 계속 간다. 그래서 되돌리기가 먹히지 않고 헤더 날짜가 며칠씩 튀었다.
// 처음부터 다 깔아두면 도중에 앞에 붙일 일이 없어 되돌릴 것도 없다.
const TIMELINE_DAYS_BEFORE = 7;
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
      startPos = prevPos !== null ? prevPos : ownPos - MIN_BLOCK_MINUTES;
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
        endPos = nextPos;
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
  const [selectedDate, setSelectedDate] = useState(new Date());
  // 타임블럭이 이어서 그려둔 날짜 창의 기준일. selectedDate가 창을 벗어날 때만 따라온다.
  // (헤더 날짜는 스크롤을 따라 계속 바뀌는데, 그때마다 창을 다시 잡으면 화면이 튄다)
  const [anchorDate, setAnchorDate] = useState(new Date());
  const [inputText, setInputText] = useState('');
  const [selectedColor, setSelectedColor] = useState('default');
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [activeView, setActiveView] = useState('timeline'); // 'timeline' | 'monthly' | 'settings'
  const [previousView, setPreviousView] = useState('timeline');

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
  // 열었을 때의 시각 값. 사용자가 시간을 건드리지 않았으면 저장할 때 시간 관련
  // 필드를 아예 손대지 않는다 (자동으로 이어지던 설정이 조용히 고정값으로 굳는 걸 막는다)
  const [editInitial, setEditInitial] = useState(null);
  const [showCalendar, setShowCalendar] = useState(false);
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [showScheduleView, setShowScheduleView] = useState(false);
  // 할 일 리스트 (날짜에 묶지 않는다 — 이월도 독촉도 없음)
  const [todos, setTodos] = useState([]);
  const [showTodoSheet, setShowTodoSheet] = useState(false);
  const [todoInput, setTodoInput] = useState('');

  // Undo Toast
  const [undoToast, setUndoToast] = useState(null); // { memo, timer }

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
  const [isCalendarScrolling, setIsCalendarScrolling] = useState(false);
  const calendarScrollTimeoutRef = useRef(null);

  // ── 현재 시간 (스케줄 뷰 빨간 줄 등) 1분마다 갱신 ─────────────
  const [nowTime, setNowTime] = useState(new Date());
  useEffect(() => {
    const interval = setInterval(() => setNowTime(new Date()), 60000);
    return () => clearInterval(interval);
  }, []);

  // 위클리는 스크롤이 없어(7일 × 하루 전체가 한 화면) 자동 스크롤/터치 처리도 필요 없다

  // ── 먼슬리는 항상 달력부터 보이게 (스크롤 위치가 남아 기록 목록이 먼저 보이던 문제) ─
  const monthlyRef = useRef(null);
  useEffect(() => {
    if (activeView !== 'monthly' || !monthlyRef.current) return;
    monthlyRef.current.scrollTop = 0;
  }, [activeView]);

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
    // 위클리·먼슬리는 트래킹하지 않는다. 지금 보려는 건 타임라인이 어떻게 쓰이는지다.
    // previous_screen에도 안 남기려고 lastScreenRef까지 건드리지 않고 그냥 나간다
    // (그래서 타임라인 → 위클리 → 타임라인은 같은 화면에 머문 것으로 취급된다)
    if (activeView === 'weekly' || activeView === 'monthly') return;
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
      const { data, error } = await supabase
        .from('memos')
        .select('*')
        .order('recorded_at', { ascending: true });
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
  }, [userId]);

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

    const sortTodos = (list) =>
      [...list].sort((a, b) => {
        // 완료한 건 아래로, 그 안에서는 만든 순서대로
        if (a.done !== b.done) return a.done ? 1 : -1;
        return new Date(a.created_at) - new Date(b.created_at);
      });

    const fetchTodos = async () => {
      const { data, error } = await supabase.from('todos').select('*');
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
  }, [userId]);

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
    const el = timelineRef.current;
    const prevCount = prevMemoCount.current;
    prevMemoCount.current = memos.length;
    if (!el) return;
    if (scrollPositionRef.current !== null) {
      el.scrollTop = scrollPositionRef.current; // 삭제 후 위치 복원
      scrollPositionRef.current = null;
      return;
    }
    if (memos.length > prevCount) el.scrollTop = el.scrollHeight;
  }, [memos]);

  // ── 모바일 Visual Viewport ───────────────────────────────────
  useEffect(() => {
    const handleResize = () => {
      if (window.visualViewport) {
        document.documentElement.style.setProperty('--vh', `${window.visualViewport.height}px`);
        window.scrollTo(0, 0);
      }
    };
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', handleResize);
      window.visualViewport.addEventListener('scroll', handleResize);
      handleResize();
    }
    return () => {
      if (window.visualViewport) {
        window.visualViewport.removeEventListener('resize', handleResize);
        window.visualViewport.removeEventListener('scroll', handleResize);
      }
    };
  }, []);


  const displayedMemos = memos.filter(m => isSameDay(new Date(m.recordedAt), selectedDate));

  // 다음날 자정~새벽 2시 메모: 전날 채팅창에도 흐리게 함께 표시
  const selectedDayStartMs = new Date(
    selectedDate.getFullYear(), selectedDate.getMonth(), selectedDate.getDate()
  ).getTime();
  const lateNightMemos = memos.filter(m => {
    const min = (new Date(m.recordedAt).getTime() - selectedDayStartMs) / 60000;
    return min >= DAY_MINUTES && min < DAY_MINUTES + 120; // 다음날 00:00 ~ 01:59
  });
  // 채팅창은 고른 날짜 하루만 보여준다. 헤더 날짜와 화면 내용이 어긋나면 안 된다.
  const chatMemos = [...displayedMemos, ...lateNightMemos];

  // 기록이 이 기기에만 있다는 안내를 지금 띄울 때인지.
  //
  // 홈 화면 앱에서도 띄운다. 사파리의 7일 삭제만 비켜갈 뿐, 기록이 이 기기
  // 하나에만 있다는 건 똑같다 — 앱을 지우거나 폰을 바꾸면 사라지고 다른
  // 기기에서는 못 본다. 홈 화면 앱에는 '홈 화면에 추가' 안내만 뺀다(이미 했으니).
  const inStandaloneApp = isStandaloneApp();
  const showSaveNotice =
    isGuest && memos.length >= SAVE_NOTICE_AFTER && !saveNoticeDismissed;

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
  const syncHeaderToScroll = (el) => {
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
    if (dayGap > 1 && movedPx < (dayGap - 1) * DAY_MINUTES) return;

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

  // 고른 날짜로 실제로 옮기는 곳
  useEffect(() => {
    if (navSeq === 0 || activeView !== 'timeline') return;
    const idx = windowDays.findIndex(d => isSameDay(d, selectedDate));
    if (idx < 0) return;
    const el = timelineScrollerEl();
    // 오늘로 갈 때는 그 날 00시가 아니라 지금 시각이 보여야 한다
    const nowLine = isToday(selectedDate) ? el?.querySelector('.schedule-now-line') : null;
    const target = nowLine || el?.querySelector(`[data-day-index="${idx}"]`);
    if (!target) return;
    const delta = target.getBoundingClientRect().top - el.getBoundingClientRect().top;
    el.scrollTop = Math.max(0, el.scrollTop + delta - (nowLine ? el.clientHeight / 3 : 0));
    scrollDayRef.current = idx;
    paintHeaderDay(idx, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navSeq]);

  // 타임라인을 열거나 화면을 바꿀 때 한 번 자리를 잡아준다.
  // 오늘이면 지금 시각, 아니면 그 날 머리로.
  const autoScrollKeyRef = useRef('');
  useEffect(() => {
    if (activeView !== 'timeline') { autoScrollKeyRef.current = ''; return; }
    const key = `${showScheduleView}|${memos.length > 0}|${format(effectiveAnchor, 'yyyy-MM-dd')}`;
    if (autoScrollKeyRef.current === key) return;
    const el = timelineScrollerEl();
    if (!el) return;
    const idx = windowDays.findIndex(d => isSameDay(d, selectedDate));
    const nowLine = isToday(selectedDate) ? el.querySelector('.schedule-now-line') : null;
    const target = nowLine || el.querySelector(`[data-day-index="${Math.max(0, idx)}"]`);
    if (!target) return;
    autoScrollKeyRef.current = key;
    const delta = target.getBoundingClientRect().top - el.getBoundingClientRect().top;
    // 지금 시각은 화면 위 1/3 지점에 두어야 앞뒤가 같이 보인다
    el.scrollTop = Math.max(0, el.scrollTop + delta - (nowLine ? el.clientHeight / 3 : 0));
    if (idx >= 0) { scrollDayRef.current = idx; paintHeaderDay(idx, 0); }
  });

  const monthlyData = buildMonthlyData(memos, habitKeywords);

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
    const snapshot = {
      date: format(new Date(memo.recordedAt), 'yyyy-MM-dd'),
      start: startStr,
      end: hhmm(end),
      mode: range ? 'range' : 'moment',
    };
    setEditingMemo(memo);
    setEditContentStr(memo.content);
    setEditMemoColor(memo.color || 'default');
    setEditDateStr(snapshot.date);
    setEditStartStr(snapshot.start);
    setEditEndStr(snapshot.end);
    setEditMode(snapshot.mode);
    setEditInitial(snapshot);
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
    setEditMode(mode);
  };

  const closeBlockEditor = () => {
    setEditingMemo(null);
    setEditInitial(null);
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

  // '다음 기록까지 자동으로 잇기' 토글 (마지막 기록이면 지금까지).
  // 종료 시각을 직접 정하는 것과 배타적이라, 켜면 직접 정한 값을 비운다.
  // '이전 기록부터 자동으로 잇기' 토글.
  // 시작 시각을 직접 정하는 것과 배타적이라, 켜면 직접 정한 값을 비운다.
  const toggleSpansFromPrev = async () => {
    const memo = editingMemo;
    if (!memo) return;
    const turningOn = !isAutoStart(memo);
    const patch = { spansFromPrev: turningOn, backMinutes: 0 };
    const ok = await writeMemoFields(
      memo.id,
      { spans_from_prev: turningOn, back_minutes: 0 },
      patch,
    );
    if (!ok) return;
    track('Memo Edited', { changed: 'block', block_option: 'spans_from_prev', turned_on: turningOn });
    // 자동으로 다시 계산된 구간을 입력칸에 반영한다
    const { start, end } = blockRangeOf(memo, patch);
    setEditStartStr(hhmm(start));
    setEditEndStr(hhmm(end));
    setEditInitial(prev => ({ ...prev, start: hhmm(start), end: hhmm(end) }));
  };

  const toggleSpansToNext = async () => {
    const memo = editingMemo;
    if (!memo) return;
    const turningOn = !isAutoEnd(memo);
    const patch = { spansToNext: turningOn, endMinutes: 0 };
    const ok = await writeMemoFields(
      memo.id,
      { spans_to_next: turningOn, end_minutes: 0 },
      patch,
    );
    if (!ok) return;
    track('Memo Edited', { changed: 'block', block_option: 'spans_to_next', turned_on: turningOn });
    // 자동으로 다시 계산된 구간을 입력칸에 반영한다
    const { start, end } = blockRangeOf(memo, patch);
    setEditStartStr(hhmm(start));
    setEditEndStr(hhmm(end));
    setEditInitial(prev => ({ ...prev, start: hhmm(start), end: hhmm(end) }));
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
    const timeTouched = dateChanged || startChanged || endChanged || modeChanged;
    const toMin = (str) => { const [h, m] = str.split(':').map(Number); return h * 60 + m; };
    const canWriteTime = editDateStr && editStartStr && (editMode === 'moment' || editEndStr);

    if (timeTouched && canWriteTime) {
      const [y, mo, d] = editDateStr.split('-').map(Number);

      if (editMode === 'moment') {
        // 한 순간짜리는 늘린 흔적을 전부 지운다. 적은 시각 하나만 남는다.
        const startMin = toMin(editStartStr);
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
        const startMin = toMin(editStartStr);
        let endMin = toMin(editEndStr);
        if (endMin < startMin) endMin += 1440; // 자정을 넘긴 구간

        // '적은 순간'은 그대로 두되, 구간 밖으로 밀려나면 안쪽으로 끌어온다.
        // 채팅창 말풍선에 찍히는 시각이 이 값이라 함부로 옮기지 않는다.
        const own = new Date(memo.recordedAt);
        const ownWas = own.getHours() * 60 + own.getMinutes();
        const ownMin = Math.min(Math.max(ownWas, startMin), endMin);
        // 기준점이 옮겨졌으면 앞뒤 길이를 둘 다 다시 재야 한다
        const ownMoved = ownMin !== ownWas;

        if (dateChanged || ownMoved || modeChanged) {
          dbFields.recorded_at = new Date(y, mo - 1, d, 0, ownMin, 0, 0).toISOString();
          localFields.recordedAt = dbFields.recorded_at;
        }
        // 손댄 쪽만 바꾼다. 시작만 고쳤는데 자동으로 따라가던 종료까지 굳어버리면
        // 사용자가 하지도 않은 결정을 대신 내린 셈이 된다.
        if (startChanged || ownMoved || modeChanged) {
          // 직접 정한 시각이 자동 규칙을 이긴다.
          // 켜둔 채로 두면 이전 기록을 옮길 때 방금 정한 값이 되돌아간다.
          dbFields.back_minutes = ownMin - startMin;
          dbFields.spans_from_prev = false;
          localFields.backMinutes = dbFields.back_minutes;
          localFields.spansFromPrev = false;
        }
        if (endChanged || ownMoved || modeChanged) {
          dbFields.end_minutes = endMin - ownMin;
          dbFields.spans_to_next = false;
          localFields.endMinutes = dbFields.end_minutes;
          localFields.spansToNext = false;
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
    const now = new Date();
    // 자정이 지났으면 오늘로 옮긴다
    if (!isSameDay(selectedDate, now)) goToDay(now);
    // 항상 현재 시간과 날짜로 기록
    const newMemoData = {
      user_id: currentUser?.id,
      content: inputText,
      color: selectedColor,
      recorded_at: now.toISOString(),
      spans_from_prev: mode === 'prev',
      spans_to_next: mode === 'next',
    };
    setInputText('');

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
      });
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
    });
    // 바로 화면에 반영 (실시간 이벤트가 오면 중복은 무시됨)
    const memo = rowToMemo(data);
    setMemos(prev => prev.some(m => m.id === memo.id) ? prev : [...prev, memo].sort((a, b) => new Date(a.recordedAt) - new Date(b.recordedAt)));
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
    track('Memo Created', {
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
    setTodos(prev => prev.some(t => t.id === data.id) ? prev : [...prev, data]);
    track('Todo Action', { action: 'added', open_count: todos.filter(t => !t.done).length + 1 });
  };

  // silent: 기록으로 옮기면서 자동 완료되는 경우. 그때는 'moved_to_memo'로 한 번만 세야 해서 여기선 안 보낸다
  const handleToggleTodo = async (todo, { silent = false } = {}) => {
    const next = !todo.done;
    setTodos(prev => prev.map(t => (t.id === todo.id ? { ...t, done: next } : t)));
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

  // ── 전송 버튼 제스처 ─────────────────────────────────────────
  // 짧게 누르면 단일 기록, 누른 채 위로 올리면 '이전 기록부터',
  // 아래로 내리면 '다음 기록까지'로 저장한다.
  const SEND_DRAG_THRESHOLD = 24;
  const sendDragRef = useRef(null);
  const [sendMode, setSendMode] = useState(null); // 누르고 있는 동안의 선택 표시

  const modeFromDy = (dy) => {
    if (dy <= -SEND_DRAG_THRESHOLD) return 'prev';
    if (dy >= SEND_DRAG_THRESHOLD) return 'next';
    return 'single';
  };

  const onSendPointerDown = (e) => {
    if (!inputText.trim()) return;
    sendDragRef.current = { startY: e.clientY, mode: 'single' };
    setSendMode('single');
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  const onSendPointerMove = (e) => {
    if (!sendDragRef.current) return;
    const mode = modeFromDy(e.clientY - sendDragRef.current.startY);
    if (mode !== sendDragRef.current.mode) {
      sendDragRef.current.mode = mode;
      setSendMode(mode);
    }
  };

  const onSendPointerUp = () => {
    const drag = sendDragRef.current;
    sendDragRef.current = null;
    setSendMode(null);
    if (drag) handleAddMemo(null, drag.mode);
  };

  const onSendPointerCancel = () => {
    sendDragRef.current = null;
    setSendMode(null);
  };

  const handleKeyDown = (e) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Enter' && !e.shiftKey) {
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

  // ── 달력 스크롤 핸들러 ──────────────────────────────────────────
  const handleCalendarScroll = () => {
    setIsCalendarScrolling(true);
    if (calendarScrollTimeoutRef.current) {
      clearTimeout(calendarScrollTimeoutRef.current);
    }
    calendarScrollTimeoutRef.current = setTimeout(() => {
      setIsCalendarScrolling(false);
    }, 200);
  };

  // ── 전역 touchmove 리스너: 스크롤 중 모든 터치 상태 초기화 ──────────
  useEffect(() => {
    const clearTouchState = () => {
      // 포커스된 요소 즉시 blur
      if (document.activeElement && document.activeElement !== document.body) {
        document.activeElement.blur();
      }
      // 포커스를 body로 강제 이동
      document.body.focus();

      setIsCalendarScrolling(true);
      if (calendarScrollTimeoutRef.current) {
        clearTimeout(calendarScrollTimeoutRef.current);
      }
      calendarScrollTimeoutRef.current = setTimeout(() => {
        setIsCalendarScrolling(false);
      }, 200);
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
  const renderMonthlyView = () => {
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
        const dateKey = format(day, 'yyyy-MM-dd');
        const dayData = monthlyData[dateKey];

        const createTouchHandler = () => {
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
              // goToDay를 써야 타임블럭이 깔아둔 창까지 그 날짜로 옮겨간다.
              // setSelectedDate만 하면 화면이 보는 날짜와 창이 어긋나서,
              // 타임라인으로 넘어가 살짝만 스크롤해도 창 안의 날짜로 튕긴다.
              if (!touchState.isScrolling && isCurrentMonth) {
                goToDay(cloneDay);
              }
            }
          };
        };

        const handlers = createTouchHandler();

        days.push(
          <div
            key={day.toISOString()}
            className={`monthly-cell ${!isCurrentMonth ? 'monthly-cell-disabled' : ''} ${isDayToday ? 'monthly-cell-today' : ''} ${isSelected && isCurrentMonth ? 'monthly-cell-selected' : ''}`}
            tabIndex={-1}
            onClick={(e) => {
              if (isCurrentMonth) {
                goToDay(cloneDay);
              }
            }}
            onTouchStart={handlers.onTouchStart}
            onTouchMove={handlers.onTouchMove}
            onTouchEnd={handlers.onTouchEnd}
          >
            <span className="monthly-cell-date">{format(day, 'd')}</span>
            {isCurrentMonth && dayData && (
              <div className="monthly-cell-data">
                {dayData.habits.map(h => {
                  const textColors = { purple: '#6b21a8', blue: '#1e40af', green: '#15803d', pink: '#be185d', orange: '#9a3412' };
                  return (
                    <span key={h.name} className="monthly-habit" style={{ backgroundColor: `var(--habit-${h.color})`, color: textColors[h.color] || '#000' }}>{h.name}</span>
                  );
                })}
                {(dayData.income > 0 || dayData.expense > 0) && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '1px', marginTop: 'auto' }}>
                    {dayData.income > 0 && (
                      <span className="monthly-income">+{dayData.income.toLocaleString()}</span>
                    )}
                    {dayData.expense > 0 && (
                      <span className="monthly-expense">-{dayData.expense.toLocaleString()}</span>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        );
        day = addDays(day, 1);
      }
      rows.push(<div className="monthly-row" key={day.toISOString()}>{days}</div>);
      days = [];
    }

    // 월간 합계
    const monthKey = format(currentMonth, 'yyyy-MM');
    let totalIncome = 0, totalExpense = 0;
    Object.entries(monthlyData).forEach(([dateKey, data]) => {
      if (dateKey.startsWith(monthKey)) {
        totalIncome += data.income;
        totalExpense += data.expense;
      }
    });

    // mp-no-track = Mixpanel autocapture가 이 안의 클릭을 줍지 않는다 (먼슬리는 트래킹 안 함)
    return (
      <div className="monthly-view mp-no-track">
        {/* 먼슬리 헤더 */}
        <div className="monthly-nav">
          <button className="cal-btn" onClick={() => setCurrentMonth(subMonths(currentMonth, 1))}><ChevronLeft size={20} /></button>
          <span className="monthly-nav-title">{format(currentMonth, 'yyyy년 M월', { locale: ko })}</span>
          <button className="cal-btn" onClick={() => setCurrentMonth(addMonths(currentMonth, 1))}><ChevronRight size={20} /></button>
        </div>

        {/* 요일 헤더 */}
        <div className="monthly-weekdays">
          {weekDays.map(w => <div key={w} className="monthly-weekday">{w}</div>)}
        </div>

        {/* 달력 */}
        <div className="monthly-grid">{rows}</div>

        {/* 선택한 날짜의 기록 (하단 패널) */}
        <div className="monthly-day-panel">
          {/* 날짜는 왼쪽, 수입/지출은 같은 줄 오른쪽 */}
          <div className="monthly-day-panel-head">
            <span className="monthly-day-panel-title">{format(selectedDate, 'M월 d일 (E)', { locale: ko })}</span>
            {(() => {
              const d = monthlyData[format(selectedDate, 'yyyy-MM-dd')];
              if (!d || (d.income <= 0 && d.expense <= 0)) return null;
              return (
                <span className="monthly-day-panel-money">
                  {d.income > 0 && <span className="monthly-income">+{d.income.toLocaleString()}</span>}
                  {d.expense > 0 && <span className="monthly-expense">-{d.expense.toLocaleString()}</span>}
                </span>
              );
            })()}
          </div>
          {(() => {
            const dateKey = format(selectedDate, 'yyyy-MM-dd');
            const dayData = monthlyData[dateKey];
            const textColors = { purple: '#6b21a8', blue: '#1e40af', green: '#15803d', pink: '#be185d', orange: '#9a3412' };
            return (
              <>
                {dayData && dayData.habits.length > 0 && (
                  <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '10px' }}>
                    {dayData.habits.map(h => (
                      <span
                        key={h.name}
                        style={{
                          backgroundColor: `var(--habit-${h.color})`,
                          color: textColors[h.color] || '#000',
                          padding: '3px 10px',
                          borderRadius: '10px',
                          fontSize: '0.75rem',
                          fontWeight: '600'
                        }}
                      >
                        {h.name}
                      </span>
                    ))}
                  </div>
                )}
                {displayedMemos.length === 0 ? (
                  <div style={{ textAlign: 'center', color: '#aaa', fontSize: '0.85rem', padding: '16px 0' }}>
                    이 날짜에 기록된 내용이 없습니다.
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    {displayedMemos.map(memo => {
                      const habitMatch = (memo.color || 'default') === 'default' ? habitMatchFor(memo.content, memo.recordedAt) : null;
                      const bg = habitMatch
                        ? `var(--habit-${habitMatch.color})`
                        : (COLOR_PALETTE.find(c => c.id === (memo.color || 'default'))?.bg || '#f9f9fb');
                      return (
                        <div
                          key={memo.id}
                          style={{ backgroundColor: bg, padding: '8px 12px', borderRadius: '8px', fontSize: '0.85rem', lineHeight: 1.4, cursor: 'pointer' }}
                          onClick={() => openBlockEditor(memo)}
                          title="기록 수정"
                        >
                          <span style={{ fontSize: '0.7rem', color: '#999', marginRight: '8px' }}>
                            {format(new Date(memo.recordedAt), 'aa h:mm', { locale: ko })}
                          </span>
                          {memo.content}
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            );
          })()}
        </div>
      </div>
    );
  };

  const dateFormatted = format(selectedDate, 'M월 d일 (E)', { locale: ko });
  const headerTitle = isToday(selectedDate) ? `${dateFormatted} - 오늘` : dateFormatted;
  const memoGroups = groupMemosByHour(chatMemos);
  const weekStart = startOfWeek(selectedDate);
  const weekTitle = `${format(weekStart, 'M월 d일', { locale: ko })} ~ ${format(endOfWeek(selectedDate), 'M월 d일', { locale: ko })}`;

  // ── 위클리 뷰 렌더 (한 주의 '모양'을 보는 곳) ────────────────
  // 글자를 읽는 곳이 아니라 리듬을 보는 곳이다. 색 띠만 그리므로 하루 칸이 좁아도 되고,
  // 7일 × 하루 전체가 스크롤 없이 한 화면에 들어간다. 내용이 궁금하면 탭해서 그 날로 간다.
  const WEEKLY_GRID_MINUTES = 26 * 60; // 다음날 새벽 02:00까지

  const renderWeeklyView = () => {
    const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));

    // 기록이 있는 시간대만 보여준다 (새벽 빈 구간을 매번 볼 이유가 없다)
    let minPos = 7 * 60;
    let maxPos = 23 * 60;
    for (const m of memos) {
      for (const day of days) {
        const ds = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
        const p = (new Date(m.recordedAt).getTime() - ds) / 60000;
        if (p >= 0 && p < WEEKLY_GRID_MINUTES) {
          minPos = Math.min(minPos, Math.floor(p / 60) * 60);
          maxPos = Math.max(maxPos, Math.ceil(p / 60) * 60);
        }
      }
    }
    const rangeStart = Math.max(0, minPos - 60);
    const rangeEnd = Math.min(WEEKLY_GRID_MINUTES, maxPos + 60);
    const rangeMin = Math.max(60, rangeEnd - rangeStart);
    const pct = (pos) => ((pos - rangeStart) / rangeMin) * 100;
    // 눈금은 2시간마다 (칸이 좁아 매시간은 빽빽하다)
    const labelHours = [];
    for (let h = Math.ceil(rangeStart / 120) * 2; h * 60 <= rangeEnd; h += 2) labelHours.push(h);

    // mp-no-track = Mixpanel autocapture가 이 안의 클릭을 줍지 않는다 (위클리는 트래킹 안 함)
    return (
      <div className="weekly-container mp-no-track">
        <div className="weekly-board">
          {/* 좌측 시간 눈금 */}
          <div className="weekly-hours-col">
            <div className="weekly-day-header weekly-corner" />
            <div className="weekly-hours-track">
              {labelHours.map(h => (
                <div
                  key={h}
                  className="weekly-hour-label"
                  style={{ top: `${pct(h * 60)}%`, opacity: h >= 24 ? 0.4 : undefined }}
                >
                  {(h % 24).toString().padStart(2, '0')}시
                </div>
              ))}
            </div>
          </div>

          {days.map(day => {
            const isDayToday = isToday(day);
            const dayStartTime = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
            const posOf = (iso) => (new Date(iso).getTime() - dayStartTime) / 60000;
            const nowInDay = (nowTime.getTime() - dayStartTime) / 60000;

            // 해당 날짜 00:00 ~ 다음날 02:00 사이의 메모 (다음날 새벽은 흐리게)
            const windowMemos = memos
              .filter(m => { const p = posOf(m.recordedAt); return p >= 0 && p < WEEKLY_GRID_MINUTES; })
              .sort((a, b) => new Date(a.recordedAt) - new Date(b.recordedAt));

            // 스케줄 뷰와 똑같은 규칙으로 구간을 만든다
            const blocks = buildDayBlocks(windowMemos, {
              dayStartMs: dayStartTime,
              nowMs: nowTime.getTime(),
              gridMinutes: WEEKLY_GRID_MINUTES,
              clampDawn: true, // 하루가 한 칸이라 새벽에서 끊어야 한다
            });

            // 겹치는 띠는 좌우로 나눈다 (글자가 없으므로 좁아도 읽힌다)
            const ordered = [...blocks].sort((a, b) => a.startPos - b.startPos || a.endPos - b.endPos);
            let group = [];
            let groupEnd = -Infinity;
            const closeGroup = () => {
              if (!group.length) return;
              const colEnds = [];
              for (const s of group) {
                let ci = colEnds.findIndex(end => end <= s.startPos);
                if (ci === -1) { ci = colEnds.length; colEnds.push(s.endPos); }
                else colEnds[ci] = s.endPos;
                s.col = ci;
              }
              for (const s of group) s.colCount = colEnds.length;
              group = [];
            };
            for (const s of ordered) {
              if (s.startPos >= groupEnd) { closeGroup(); groupEnd = s.endPos; }
              else groupEnd = Math.max(groupEnd, s.endPos);
              group.push(s);
            }
            closeGroup();

            return (
              <div
                key={day.toISOString()}
                className={`weekly-day-col ${isDayToday ? 'weekly-day-today' : ''}`}
                onClick={() => { goToDay(day); setActiveView('timeline'); setShowScheduleView(true); }}
                title={`${format(day, 'M월 d일', { locale: ko })} 자세히 보기`}
              >
                <div className="weekly-day-header">
                  <span className="weekly-day-date">{format(day, 'd')}</span>
                  <span className="weekly-day-name">{format(day, 'E', { locale: ko })}</span>
                </div>
                <div className={`weekly-day-grid ${isDayToday ? 'weekly-day-grid-today' : ''}`}>
                  {labelHours.map(h => (
                    <div key={h} className="weekly-hour-line" style={{ top: `${pct(h * 60)}%` }} />
                  ))}
                  {isDayToday && nowInDay >= rangeStart && nowInDay <= rangeEnd && (
                    <div className="weekly-now-line" style={{ top: `${pct(nowInDay)}%` }} />
                  )}
                  {blocks.map(b => {
                    const memo = b.memo;
                    const habitMatch = (memo.color || 'default') === 'default' ? habitMatchFor(memo.content, memo.recordedAt) : null;
                    const bg = habitMatch
                      ? `var(--habit-${habitMatch.color})`
                      : (COLOR_PALETTE.find(c => c.id === (memo.color || 'default'))?.bg || '#ececf2');
                    const border = habitMatch
                      ? (HABIT_BORDER[habitMatch.color] || '#d8d8e4')
                      : (COLOR_BORDER[memo.color || 'default'] || '#d8d8e4');
                    const colCount = b.colCount || 1;
                    const col = b.col || 0;
                    return (
                      <div
                        key={memo.id}
                        className="weekly-band"
                        style={{
                          top: `${pct(b.startPos)}%`,
                          height: `${Math.max(0, pct(b.endPos) - pct(b.startPos))}%`,
                          left: `${(col / colCount) * 100}%`,
                          width: `calc(${100 / colCount}% - 1px)`,
                          backgroundColor: bg,
                          borderColor: border,
                          opacity: b.isCarry ? 0.45 : 1,
                        }}
                      />
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

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

    // 4) 각 묶음 안에서 블록을 위에서부터 차례로 쌓는다
    for (const c of clusters) {
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
          <div className="schedule-grid" style={{ height: `${totalPx}px` }}>
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
                  className={`schedule-block${isCompact ? ' schedule-block--compact' : ''}${schedule.isInner ? ' schedule-block--inner' : ''}`}
                  onClick={() => openBlockEditor(schedule.memo)}
                  style={{
                    top: `${schedule.top}px`,
                    height: `${schedule.height}px`,
                    backgroundColor: bgColor,
                    borderColor: borderColor,
                    cursor: 'pointer',
                    justifyContent: 'flex-start',
                    paddingTop: '6px'
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
            <button type="button" className="google-signin-btn" onClick={handleGoogleSignIn} disabled={submittingAuth}>
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
            <a href="/privacy.html" target="_blank" rel="noopener noreferrer" style={{ color: '#999' }}>
              개인정보처리방침
            </a>
          </p>
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
    <div className="app-container">
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
      {/* Header */}
      {activeView !== 'settings' && (
        <header className="header">
          {(activeView === 'timeline' || activeView === 'weekly') && (
            <button
              className="header-nav-btn"
              onClick={() => goToDay(addDays(selectedDate, activeView === 'weekly' ? -7 : -1))}
              title={activeView === 'weekly' ? '이전주' : '이전날'}
            >
              <ChevronLeft size={20} />
            </button>
          )}
          <div className="header-title-container" onClick={() => { setCurrentMonth(selectedDate); setShowCalendar(true); }}>
            <Calendar size={20} className="header-icon" />
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
                    {isToday(day)
                      ? `${format(day, 'M월 d일 (E)', { locale: ko })} - 오늘`
                      : format(day, 'M월 d일 (E)', { locale: ko })}
                  </h1>
                ))}
              </div>
            ) : (
              <h1>
                {activeView === 'monthly' ? format(currentMonth, 'yyyy년 M월', { locale: ko })
                  : activeView === 'weekly' ? weekTitle
                  : headerTitle}
              </h1>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            {activeView === 'timeline' && (
              <>
                <button
                  className={`header-nav-btn ${showTodoSheet ? 'active' : ''}`}
                  // 할 일은 체험 범위 밖이다. 눌리면 막지 말고 로그인으로 안내한다
                  onClick={() => isGuest ? setShowLogin(true) : setShowTodoSheet(v => !v)}
                  title="할 일"
                  style={{
                    backgroundColor: showTodoSheet ? 'var(--primary-color)' : 'transparent',
                    color: showTodoSheet ? 'white' : 'var(--text-muted)',
                    transition: 'all 0.2s'
                  }}
                >
                  <ListChecks size={20} />
                </button>
                <button
                  className={`header-nav-btn ${showScheduleView ? 'active' : ''}`}
                  onClick={() => setShowScheduleView(!showScheduleView)}
                  title="일정 보기"
                  style={{
                    backgroundColor: showScheduleView ? 'var(--primary-color)' : 'transparent',
                    color: showScheduleView ? 'white' : 'var(--text-muted)',
                    transition: 'all 0.2s'
                  }}
                >
                  <LayoutGrid size={20} />
                </button>
                <button className="header-nav-btn" onClick={() => goToDay(addDays(selectedDate, 1))} title="다음날">
                  <ChevronRight size={20} />
                </button>
              </>
            )}
            {activeView === 'weekly' && (
              <button className="header-nav-btn" onClick={() => goToDay(addDays(selectedDate, 7))} title="다음주">
                <ChevronRight size={20} />
              </button>
            )}
          </div>
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
          <div className="timeline" ref={timelineRef}>
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
                    <MemoItem
                      key={memo.id}
                      memo={memo}
                      onEdit={openBlockEditor}
                      onDeleteWithUndo={handleDeleteWithUndo}
                      habitKeywords={habitKeywords}
                      dimmed={!isSameDay(new Date(memo.recordedAt), selectedDate)}
                    />
                  ))}
                </div>
              ))
            )}
          </div>
          )
        ) : activeView === 'weekly' ? (
          /* ── 위클리 뷰 ── */
          renderWeeklyView()
        ) : activeView === 'monthly' ? (
          /* ── 먼슬리 뷰 ── */
          <div
            className="monthly-container"
            ref={monthlyRef}
            onScroll={handleCalendarScroll}
            style={{ pointerEvents: isCalendarScrolling ? 'none' : 'auto' }}
          >
            {renderMonthlyView()}
          </div>
        ) : (
          /* ── 마이페이지 ── */
          <div style={{ flex: 1, overflowY: 'auto', backgroundColor: '#f5f5f5' }}>
            {/* 헤더 */}
            <div style={{
              backgroundColor: 'white',
              borderBottom: '1px solid #e5e5e5',
              padding: '12px 16px',
              display: 'flex',
              alignItems: 'center',
              gap: '12px'
            }}>
              <button
                onClick={() => setActiveView(previousView)}
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  padding: '6px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#999',
                  fontSize: '1.2rem'
                }}
              >
                ←
              </button>
              <h1 style={{ fontSize: '1.1rem', fontWeight: '700', margin: 0, flex: 1 }}>마이페이지</h1>
            </div>

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
      </div>

      {/* 키보드가 올라와 있을 때만 뜨는 툴바.
          할 일은 헤더 구석에 있어서 쓰려면 손을 위로 올려야 했다.
          쓰는 중에 손가락이 닿는 자리인 입력창 바로 위에 둔다.
          (iOS Safari가 그리는 ^ ∨ ✓ 바는 웹에서 손댈 수 없어, 그 아래에 우리 툴바를 붙인다) */}
      {activeView === 'timeline' && (
        <div className="input-toolbar">
          <button
            type="button"
            className="input-toolbar-btn"
            // 할 일은 체험 범위 밖이다. 눌리면 막지 말고 로그인으로 안내한다
            onMouseDown={e => e.preventDefault()} // 눌러도 입력 포커스를 뺏지 않는다
            onClick={() => isGuest ? setShowLogin(true) : setShowTodoSheet(true)}
          >
            <ListChecks size={16} />
            <span>할 일</span>
          </button>
        </div>
      )}

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
        <div className="input-area">
          {/* 컬러 팔레트 */}
          <div className="color-picker-wrapper">
            <button
              className="color-trigger-btn"
              style={{
                backgroundColor: COLOR_PALETTE.find(c => c.id === selectedColor)?.bg || '#f9f9fb',
                borderColor: COLOR_BORDER[selectedColor] || '#ddd'
              }}
              onClick={() => setShowColorPicker(p => !p)}
              title="메모 색상 선택"
            />
            {showColorPicker && (
              <div className="color-palette-popup">
                {COLOR_PALETTE.map(c => (
                  <button
                    key={c.id}
                    className={`color-swatch ${selectedColor === c.id ? 'selected' : ''}`}
                    style={{ backgroundColor: c.bg, borderColor: COLOR_BORDER[c.id] }}
                    onClick={() => { setSelectedColor(c.id); setShowColorPicker(false); }}
                    title={c.label}
                  />
                ))}
              </div>
            )}
          </div>

          <input
            ref={inputRef}
            type="text"
            className="input-field"
            placeholder="메모를 입력하세요... (엔터로 저장)"
            value={inputText}
            onChange={e => setInputText(e.target.value)}
            onKeyDown={handleKeyDown}
            autoFocus={!IS_TOUCH_DEVICE}
          />
          <div className="send-wrap">
            {sendMode && (
              <div className="send-hint">
                <span className={`send-hint-item ${sendMode === 'prev' ? 'active' : ''}`}>↑ 이전 기록부터</span>
                <span className={`send-hint-item ${sendMode === 'single' ? 'active' : ''}`}>단일 기록</span>
                <span className={`send-hint-item ${sendMode === 'next' ? 'active' : ''}`}>↓ 다음 기록까지</span>
              </div>
            )}
            <button
              className={`send-btn${sendMode && sendMode !== 'single' ? ' send-btn--dragging' : ''}`}
              onPointerDown={onSendPointerDown}
              onPointerMove={onSendPointerMove}
              onPointerUp={onSendPointerUp}
              onPointerCancel={onSendPointerCancel}
              disabled={!inputText.trim()}
            >
              <Send size={18} />
            </button>
          </div>
        </div>
      )}

      {/* 하단 탭바 */}
      <nav className="bottom-tab-bar">
        <button
          className={`tab-btn ${activeView === 'timeline' ? 'active' : ''}`}
          onClick={() => {
            // 이미 타임라인이면 한 번 더 누를 때 채팅형 ↔ 시간대별 전환
            // (다른 탭에서 오면 첫 탭은 이동, 두 번째 탭부터 전환된다)
            if (activeView === 'timeline') setShowScheduleView(v => !v);
            else setActiveView('timeline');
          }}
        >
          <Clock size={20} />
          <span>타임라인</span>
        </button>
        {/* 위클리·먼슬리 탭은 autocapture에서도 빼둔다 (mp-no-track) */}
        <button
          className={`tab-btn mp-no-track ${activeView === 'weekly' ? 'active' : ''}`}
          onClick={() => setActiveView('weekly')}
        >
          <Calendar size={20} />
          <span>위클리</span>
        </button>
        <button
          className={`tab-btn mp-no-track ${activeView === 'monthly' ? 'active' : ''}`}
          onClick={() => {
            setActiveView('monthly');
            setCurrentMonth(new Date());
            setSelectedDate(new Date());
          }}
        >
          <LayoutGrid size={20} />
          <span>먼슬리</span>
        </button>
        <button
          className={`tab-btn ${activeView === 'settings' ? 'active' : ''}`}
          onClick={() => {
            // 마이페이지는 계정 화면이라 체험 중에는 보여줄 게 없다
            if (isGuest) { setShowLogin(true); return; }
            setPreviousView(activeView);
            setActiveView('settings');
          }}
        >
          <User size={20} />
          <span>{isGuest ? '로그인' : '마이페이지'}</span>
        </button>
      </nav>

      {/* Undo Toast */}
      {undoToast && (
        <div className="undo-toast">
          <span>메모가 삭제되었습니다</span>
          <button className="undo-btn" onClick={handleUndo}>취소</button>
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

            <div className="todo-list">
              {todos.length === 0 ? (
                <p className="todo-empty">적어두면 여기에 남아있어요.</p>
              ) : (
                todos.map(todo => (
                  <div key={todo.id} className={`todo-item${todo.done ? ' todo-item--done' : ''}`}>
                    <button
                      className={`todo-check${todo.done ? ' checked' : ''}`}
                      onClick={() => handleToggleTodo(todo)}
                      title={todo.done ? '되돌리기' : '완료'}
                    />
                    <span className="todo-text">{todo.content}</span>
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
                <div className="block-time-row">
                  <input
                    type="time"
                    className="block-input"
                    value={editStartStr}
                    onChange={e => setEditStartStr(e.target.value)}
                    /* 자동으로 잇는 중에는 시작이 이전 기록을 따라가므로 직접 못 고친다 */
                    disabled={editMode === 'range' && isAutoStart(editingMemo)}
                  />
                  {editMode === 'range' && (
                    <>
                      <span className="block-time-sep">→</span>
                      <input
                        type="time"
                        className="block-input"
                        value={editEndStr}
                        onChange={e => setEditEndStr(e.target.value)}
                        /* 자동으로 잇는 중에는 끝 시각이 다음 기록을 따라가므로 직접 못 고친다 */
                        disabled={isAutoEnd(editingMemo)}
                      />
                    </>
                  )}
                </div>
                {editMode === 'range' && (
                  <label className="block-auto-toggle">
                    <input
                      type="checkbox"
                      checked={isAutoStart(editingMemo)}
                      onChange={toggleSpansFromPrev}
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
                      checked={isAutoEnd(editingMemo)}
                      onChange={toggleSpansToNext}
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

    </div>
  );
}

export default App;
