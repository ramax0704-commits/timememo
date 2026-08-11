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
  parseISO,
  parse
} from 'date-fns';
import { ko } from 'date-fns/locale';
import { Send, Calendar, ChevronLeft, ChevronRight, Inbox, User, CreditCard, ShieldAlert, X, Trash2, Clock, LayoutGrid, Tag, Plus } from 'lucide-react';
import { supabase, setRememberMe, getRememberMe } from './supabase';

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
    // 시작 시각을 직접 고쳤을 때의 소요 시간(분). 이전 기록부터 대신 이 값이 쓰인다
    backMinutes: row.back_minutes ?? 0,
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
        <div
          className="memo-time-container"
          onClick={() => onEdit(memo, 'time')}
          title="시간 수정하기"
        >
          <span className="memo-time">{format(new Date(memo.recordedAt), 'aa h:mm', { locale: ko })}</span>
        </div>
        <div
          className="memo-content"
          style={{ backgroundColor: colorBg, borderColor: colorBorder, cursor: 'pointer' }}
          onClick={() => onEdit(memo, 'content')}
          title="내용 수정 및 삭제"
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
  const [memos, setMemos] = useState([]);
  const [selectedDate, setSelectedDate] = useState(new Date());
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

  // Modal States
  const [editingMemoId, setEditingMemoId] = useState(null);
  const [editTimeStr, setEditTimeStr] = useState('');
  const [editDateStr, setEditDateStr] = useState('');
  const [editingContentMemo, setEditingContentMemo] = useState(null);
  const [editContentStr, setEditContentStr] = useState('');
  const [editMemoColor, setEditMemoColor] = useState('default');
  const [showCalendar, setShowCalendar] = useState(false);
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [showScheduleView, setShowScheduleView] = useState(false);
  const [selectedSchedule, setSelectedSchedule] = useState(null);
  const [editStartHour, setEditStartHour] = useState('');
  const [editStartMin, setEditStartMin] = useState('');
  const [editEndHour, setEditEndHour] = useState('');
  const [editEndMin, setEditEndMin] = useState('');
  const [adjustStartHour, setAdjustStartHour] = useState('');
  const [adjustStartMin, setAdjustStartMin] = useState('');

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

  // ── 위클리 뷰 열 때 선택한 날짜(가로)와 현재 시간(세로)으로 스크롤 ─
  const weeklyRef = useRef(null);
  useEffect(() => {
    if (activeView !== 'weekly' || !weeklyRef.current) return;
    const container = weeklyRef.current;
    // 가로: 선택한 날짜 컬럼으로 (컬럼 너비 170px = CSS와 일치해야 함)
    const dayIndex = Math.round((new Date(selectedDate.getFullYear(), selectedDate.getMonth(), selectedDate.getDate()).getTime() - startOfWeek(selectedDate).getTime()) / 86400000);
    container.scrollLeft = Math.max(0, dayIndex * 170 - 20);
    // 세로: 오늘이면 현재 시간, 아니면 오전 8시 근처로
    const now = new Date();
    const targetMin = isToday(selectedDate) ? now.getHours() * 60 + now.getMinutes() : 8 * 60;
    container.scrollTop = Math.max(0, 60 + targetMin - container.clientHeight / 3);
  }, [activeView, selectedDate]);

  // ── 위클리 터치 스크롤: 축 고정 + 관성 (직접 처리로 헤더와 완전 동기화) ─
  useEffect(() => {
    if (activeView !== 'weekly' || !weeklyRef.current) return;
    const el = weeklyRef.current;
    let sx = 0, sy = 0, sl = 0, st = 0, locked = null;
    let lastX = 0, lastY = 0, lastT = 0, vx = 0, vy = 0, raf = null;

    const stopMomentum = () => { if (raf) cancelAnimationFrame(raf); raf = null; };

    const onStart = (e) => {
      stopMomentum();
      const t = e.touches[0];
      sx = lastX = t.clientX;
      sy = lastY = t.clientY;
      sl = el.scrollLeft;
      st = el.scrollTop;
      locked = null;
      vx = vy = 0;
      lastT = e.timeStamp;
    };

    const onMove = (e) => {
      e.preventDefault(); // 브라우저 기본 스크롤 차단 — 아래에서 축 고정으로 직접 스크롤
      const t = e.touches[0];
      const dx = t.clientX - sx;
      const dy = t.clientY - sy;
      if (!locked) {
        if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
        locked = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      }
      const dt = Math.max(1, e.timeStamp - lastT);
      if (locked === 'x') {
        el.scrollLeft = sl - dx;
        vx = (t.clientX - lastX) / dt;
      } else {
        el.scrollTop = st - dy;
        vy = (t.clientY - lastY) / dt;
      }
      lastX = t.clientX;
      lastY = t.clientY;
      lastT = e.timeStamp;
    };

    const onEnd = () => {
      const axis = locked;
      let v = axis === 'x' ? vx : vy;
      locked = null;
      if (!axis || Math.abs(v) < 0.1) return;
      // 관성 스크롤
      const step = () => {
        v *= 0.95;
        if (Math.abs(v) < 0.02) { raf = null; return; }
        if (axis === 'x') el.scrollLeft -= v * 16;
        else el.scrollTop -= v * 16;
        raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
    };

    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd, { passive: true });
    return () => {
      stopMomentum();
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
    };
  }, [activeView]);

  // ── 스케줄(타임로그) 뷰 열 때 현재 시간 위치로 자동 스크롤 ───
  const scheduleViewRef = useRef(null);
  useEffect(() => {
    if (!showScheduleView || !scheduleViewRef.current) return;
    const container = scheduleViewRef.current;
    const now = new Date();
    let targetMin;
    if (isToday(selectedDate)) {
      targetMin = now.getHours() * 60 + now.getMinutes();
    } else {
      // 과거 날짜는 그 날의 첫 메모 위치로
      const dayMemos = memos.filter(m => isSameDay(new Date(m.recordedAt), selectedDate));
      if (dayMemos.length > 0) {
        const first = dayMemos.reduce((a, b) => (new Date(a.recordedAt) < new Date(b.recordedAt) ? a : b));
        const d = new Date(first.recordedAt);
        targetMin = d.getHours() * 60 + d.getMinutes();
      } else {
        targetMin = 8 * 60;
      }
    }
    // 그리드는 1분=1px, 위 여백 20px. 대상 시간이 화면 위에서 1/3 지점에 오도록
    container.scrollTop = Math.max(0, 20 + targetMin - container.clientHeight / 3);
  }, [showScheduleView, selectedDate]);

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
          // 오늘을 보고 있었는데 날짜가 바뀌면 새 날짜로
          if (!isSameDay(prev, now)) {
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
      setAuthLoading(false);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      // 재설정 링크 클릭 시 임시 로그인되므로, 홈이 아니라 새 비밀번호 화면을 띄운다
      if (event === 'PASSWORD_RECOVERY') setIsRecovery(true);
      setCurrentUser(session?.user ?? null);
      if (!session?.user) setMemos([]);
      setAuthLoading(false);
    });
    return () => subscription.unsubscribe();
  }, []);

  // ── 메모 불러오기 + 실시간 동기화 ────────────────────────────
  const userId = currentUser?.id;
  useEffect(() => {
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

  // ── 입력 포커스 (터치 기기에서는 키보드가 멋대로 안 뜨게 제외) ─
  useEffect(() => {
    if (currentUser && activeView === 'timeline' && !IS_TOUCH_DEVICE) {
      inputRef.current?.focus();
    }
  }, [selectedDate, currentUser, activeView]);

  // ── 새 메모 추가 시에만 맨 아래 스크롤 ──────────────────────
  const prevMemoCount = useRef(0);
  useEffect(() => {
    const currentCount = memos.filter(m => isSameDay(new Date(m.recordedAt), selectedDate)).length;
    const prevCount = prevMemoCount.current;

    if (currentCount > prevCount && scrollPositionRef.current === null) {
      // 새 메모 추가된 경우에만 스크롤 다운
      if (timelineRef.current) {
        timelineRef.current.scrollTop = timelineRef.current.scrollHeight;
      }
    } else if (scrollPositionRef.current !== null) {
      // 삭제 후 위치 복원
      if (timelineRef.current) {
        timelineRef.current.scrollTop = scrollPositionRef.current;
      }
      scrollPositionRef.current = null;
    }
    prevMemoCount.current = currentCount;
  }, [memos, selectedDate]);

  // ── 날짜 변경 시 맨 아래로 ──────────────────────────────────
  useEffect(() => {
    prevMemoCount.current = 0;
    if (timelineRef.current) {
      timelineRef.current.scrollTop = timelineRef.current.scrollHeight;
    }
  }, [selectedDate]);

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

  // 다음날 자정~새벽 2시 메모: 전날 화면에도 흐리게 함께 표시
  const dayStartMs = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), selectedDate.getDate()).getTime();
  const minutesFromDayStart = (iso) => (new Date(iso).getTime() - dayStartMs) / 60000;
  const lateNightMemos = memos.filter(m => {
    const min = minutesFromDayStart(m.recordedAt);
    return min >= 1440 && min < 1440 + 120; // 다음날 00:00 ~ 01:59
  });
  const timelineMemos = [...displayedMemos, ...lateNightMemos];

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
    if (!currentUser) return;

    // 스크롤 위치 저장
    scrollPositionRef.current = timelineRef.current?.scrollTop ?? null;

    // 기존 Undo 취소
    if (undoToast?.timer) clearTimeout(undoToast.timer);

    // 낙관적 삭제 (로컬에서 먼저 제거)
    setMemos(prev => prev.filter(m => m.id !== memo.id));

    const timer = setTimeout(async () => {
      // 5초 후 실제 삭제
      const { error } = await supabase.from('memos').delete().eq('id', memo.id);
      if (error) {
        console.error('Error deleting memo:', error);
        setMemos(prev => [...prev, memo].sort((a, b) => new Date(a.recordedAt) - new Date(b.recordedAt)));
      }
      setUndoToast(null);
    }, 5000);

    setUndoToast({ memo, timer });
  }, [currentUser, undoToast]);

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

  // '이전 기록부터'/직접 지정 상태에 따른 블록 시작 시각 (분 단위, 자정 기준)
  const derivedStartMinutes = (schedule) => {
    const own = schedule.ownHour * 60 + schedule.ownMin;
    if (schedule.backMinutes > 0) return own - schedule.backMinutes;
    if (schedule.spansFromPrev) {
      return schedule.prevHour !== null ? schedule.prevHour * 60 + schedule.prevMin : own - 30;
    }
    return own;
  };

  const openScheduleDetail = (schedule) => {
    setSelectedSchedule(schedule);
    // 입력칸은 열 때 한 번만 채운다. (매번 다시 채우면 지우는 도중 값이 되살아난다)
    setEditStartHour(String(schedule.ownHour));
    setEditStartMin(String(schedule.ownMin));
    setEditEndHour(schedule.nextHour !== null ? String(schedule.nextHour) : '');
    setEditEndMin(schedule.nextMin !== null ? String(schedule.nextMin) : '');
    const s = derivedStartMinutes(schedule);
    setAdjustStartHour(String(Math.floor(((s % 1440) + 1440) % 1440 / 60)));
    setAdjustStartMin(String(((s % 60) + 60) % 60));
  };

  const closeScheduleDetail = () => {
    setSelectedSchedule(null);
    setEditStartHour('');
    setEditStartMin('');
    setEditEndHour('');
    setEditEndMin('');
    setAdjustStartHour('');
    setAdjustStartMin('');
  };

  // 다음 기록까지 이을지 토글 (스위치는 즉시 저장)
  const handleToggleSpans = async (schedule) => {
    const next = !schedule.spansToNext;
    const { error } = await supabase
      .from('memos')
      .update({ spans_to_next: next })
      .eq('id', schedule.startMemoId);
    if (error) {
      console.error('Error toggling spans_to_next:', error);
      alert('변경에 실패했습니다. 잠시 후 다시 시도해주세요.');
      return;
    }
    setMemos(prev => prev.map(m => m.id === schedule.startMemoId ? { ...m, spansToNext: next } : m));
    setSelectedSchedule(s => s && s.startMemoId === schedule.startMemoId
      ? { ...s, spansToNext: next }
      : s);
  };

  const writeMemoFields = async (memoId, dbFields, localFields) => {
    const { error } = await supabase.from('memos').update(dbFields).eq('id', memoId);
    if (error) {
      console.error('Error updating memo:', error);
      alert('변경에 실패했습니다. 잠시 후 다시 시도해주세요.');
      return false;
    }
    setMemos(prev => prev.map(m => m.id === memoId ? { ...m, ...localFields } : m));
    setSelectedSchedule(s => s && s.startMemoId === memoId ? { ...s, ...localFields } : s);
    return true;
  };

  // '이전 기록부터 이어서 표시' 토글.
  // forceReset이면 직접 고친 시작 시각을 버리고 다시 이전 기록에 맞춘다.
  const handleToggleFromPrev = async (schedule, forceReset = false) => {
    const isOn = schedule.spansFromPrev || schedule.backMinutes > 0;
    const turningOn = forceReset ? true : !isOn;
    const ok = await writeMemoFields(
      schedule.startMemoId,
      { spans_from_prev: turningOn, back_minutes: 0 },
      { spansFromPrev: turningOn, backMinutes: 0 }
    );
    if (!ok) return;
    // 켜면 시작 시각 칸이 이전 기록 시각을 가리켜야 한다 (블록 스냅샷은 아직 옛 값이라 직접 계산)
    const s = derivedStartMinutes({ ...schedule, spansFromPrev: turningOn, backMinutes: 0 });
    setAdjustStartHour(String(Math.floor(((s % 1440) + 1440) % 1440 / 60)));
    setAdjustStartMin(String(((s % 60) + 60) % 60));
  };

  // 시작 시각을 직접 고치면 '이 기록 시각에서 몇 분 전'으로 환산해 저장한다.
  // (이전 기록을 따라가지 않고 고정되도록)
  const commitStartAdjust = async (schedule) => {
    // 비워둔 채 벗어나면 원래 값으로 되돌린다 (지우는 중일 수 있으므로 저장하지 않음)
    const restore = () => {
      const s = derivedStartMinutes(schedule);
      setAdjustStartHour(String(Math.floor(((s % 1440) + 1440) % 1440 / 60)));
      setAdjustStartMin(String(((s % 60) + 60) % 60));
    };
    if (adjustStartHour === '' || adjustStartMin === '') return restore();
    const h = Math.max(0, Math.min(23, parseInt(adjustStartHour)));
    const m = Math.max(0, Math.min(59, parseInt(adjustStartMin)));
    if (isNaN(h) || isNaN(m)) return restore();
    setAdjustStartHour(String(h));
    setAdjustStartMin(String(m));

    const ownMinutes = schedule.ownHour * 60 + schedule.ownMin;
    let startMinutes = h * 60 + m;
    if (startMinutes > ownMinutes) startMinutes -= 1440; // 전날로 넘어간 경우
    const back = Math.max(0, Math.min(1440, ownMinutes - startMinutes));
    if (back === 0) {
      await writeMemoFields(schedule.startMemoId,
        { spans_from_prev: false, back_minutes: 0 },
        { spansFromPrev: false, backMinutes: 0 });
      return;
    }
    await writeMemoFields(schedule.startMemoId,
      { spans_from_prev: false, back_minutes: back },
      { spansFromPrev: false, backMinutes: back });
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
  const handleAddMemo = async (e) => {
    e?.preventDefault();
    if (!inputText.trim() || !currentUser) return;
    const now = new Date();
    // 자정이 지났으면 selectedDate 업데이트
    if (!isSameDay(selectedDate, now)) {
      setSelectedDate(now);
    }
    // 항상 현재 시간과 날짜로 기록
    const newMemoData = {
      user_id: currentUser.id,
      content: inputText,
      color: selectedColor,
      recorded_at: now.toISOString()
    };
    setInputText('');
    const { data, error } = await supabase.from('memos').insert(newMemoData).select().single();
    if (error) {
      console.error('Error adding memo:', error);
      alert('메모 저장에 실패했습니다. 잠시 후 다시 시도해주세요.');
      return;
    }
    // 바로 화면에 반영 (실시간 이벤트가 오면 중복은 무시됨)
    const memo = rowToMemo(data);
    setMemos(prev => prev.some(m => m.id === memo.id) ? prev : [...prev, memo].sort((a, b) => new Date(a.recordedAt) - new Date(b.recordedAt)));
  };

  const handleKeyDown = (e) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleAddMemo();
    }
  };

  // ── 시간 수정 ────────────────────────────────────────────────
  const openTimeEditor = (memo) => {
    setEditingMemoId(memo.id);
    const d = new Date(memo.recordedAt);
    setEditTimeStr(`${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`);
    setEditDateStr(format(d, 'yyyy-MM-dd'));
  };

  const saveTimeEdit = async () => {
    if (!editTimeStr || !editDateStr || !currentUser) return;
    const [hours, mins] = editTimeStr.split(':');
    const memoToEdit = memos.find(m => m.id === editingMemoId);
    if (memoToEdit) {
      const [year, month, day] = editDateStr.split('-');
      const newDate = new Date(`${year}-${month}-${day}T${hours}:${mins}:00`);
      const { error } = await supabase.from('memos').update({ recorded_at: newDate.toISOString() }).eq('id', editingMemoId);
      if (error) {
        console.error('Error updating time:', error);
      } else {
        setMemos(prev => prev.map(m => m.id === editingMemoId ? { ...m, recordedAt: newDate.toISOString() } : m)
          .sort((a, b) => new Date(a.recordedAt) - new Date(b.recordedAt)));
      }
    }
    setEditingMemoId(null);
    setEditTimeStr('');
    setEditDateStr('');
  };

  // ── 내용 수정 ────────────────────────────────────────────────
  const openContentEditor = (memo) => {
    setEditingContentMemo(memo);
    setEditContentStr(memo.content);
    setEditMemoColor(memo.color || 'default');
  };

  const saveContentEdit = async () => {
    if (!editContentStr.trim() || !editingContentMemo || !currentUser) return;
    const { error } = await supabase.from('memos')
      .update({ content: editContentStr, color: editMemoColor })
      .eq('id', editingContentMemo.id);
    if (error) {
      console.error('Error updating content:', error);
    } else {
      setMemos(prev => prev.map(m => m.id === editingContentMemo.id ? { ...m, content: editContentStr, color: editMemoColor } : m));
    }
    setEditingContentMemo(null);
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
                setSelectedDate(cloneDay);
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
              setSelectedDate(cloneDay);
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
              if (!touchState.isScrolling && isCurrentMonth) {
                setSelectedDate(cloneDay);
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
                setSelectedDate(cloneDay);
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

    return (
      <div className="monthly-view">
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
          <div className="monthly-day-panel-title">{format(selectedDate, 'M월 d일 (E)', { locale: ko })}</div>
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
                          onClick={() => openContentEditor(memo)}
                          title="메모 수정"
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
                {dayData && (dayData.income > 0 || dayData.expense > 0) && (
                  <div style={{ display: 'flex', gap: '16px', marginTop: '10px', paddingTop: '10px', borderTop: '1px solid #f0f0f0', fontSize: '0.85rem' }}>
                    {dayData.income > 0 && <span style={{ color: '#2563eb', fontWeight: '600' }}>수입 +{dayData.income.toLocaleString()}</span>}
                    {dayData.expense > 0 && <span style={{ color: '#dc2626', fontWeight: '600' }}>지출 -{dayData.expense.toLocaleString()}</span>}
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
  const weekStart = startOfWeek(selectedDate);
  const weekTitle = `${format(weekStart, 'M월 d일', { locale: ko })} ~ ${format(endOfWeek(selectedDate), 'M월 d일', { locale: ko })}`;
  const memoGroups = groupMemosByHour(timelineMemos);

  // ── 위클리 뷰 렌더 (시간 그리드) ─────────────────────────────
  // 가로 스크롤(.weekly-hscroll)과 세로 스크롤(.weekly-vscroll)을 분리해
  // 대각선 스크롤이 발생하지 않고, 날짜 헤더는 상단에 고정됨
  const WEEKLY_GRID_MINUTES = 26 * 60; // 다음날 새벽 02:00까지

  const renderWeeklyView = () => {
    const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
    const hours = Array.from({ length: 26 }, (_, i) => i);

    return (
      <div className="weekly-container" ref={weeklyRef}>
        <div className="weekly-grid-wrap">
          {/* 좌측 시간 라벨 (가로 스크롤 시 고정) */}
          <div className="weekly-hours-col">
            <div className="weekly-corner" />
            <div style={{ height: '5px' }} />
            {hours.map(h => (
              <div key={h} className="weekly-hour-label" style={h >= 24 ? { opacity: 0.4 } : undefined}>
                {(h % 24).toString().padStart(2, '0')}:00
              </div>
            ))}
            <div className="weekly-hour-label" style={{ height: 0, opacity: 0.4 }}>02:00</div>
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

                  const blocks = [];
                  for (let i = 0; i < windowMemos.length; i++) {
                    const cur = windowMemos[i];
                    const next = windowMemos[i + 1];
                    const startPos = posOf(cur.recordedAt);
                    let endPos = next
                      ? posOf(next.recordedAt)
                      : (nowInDay > startPos && nowInDay < WEEKLY_GRID_MINUTES ? nowInDay : startPos);
                    let isSingle = false;
                    const dawnCutoff = startPos < 120 ? 120 : (startPos >= 1440 ? WEEKLY_GRID_MINUTES : null);
                    if (dawnCutoff !== null && endPos > dawnCutoff) {
                      endPos = startPos;
                      isSingle = true;
                    }
                    endPos = Math.min(endPos, WEEKLY_GRID_MINUTES);
                    blocks.push({ memo: cur, startPos, endPos, isLast: !next, isSingle, isCarry: startPos >= 1440 });
                  }

                  return (
                    <div key={day.toISOString()} className={`weekly-day-col ${isDayToday ? 'weekly-day-today' : ''}`}>
                      <div
                        className="weekly-day-header"
                        onClick={() => { setSelectedDate(day); setActiveView('timeline'); }}
                        title="타임라인으로 이동"
                      >
                        <span className="weekly-day-date">{format(day, 'd')}</span>
                        <span className="weekly-day-name">{format(day, 'E', { locale: ko })}</span>
                      </div>
                      <div className={`weekly-day-grid ${isDayToday ? 'weekly-day-grid-today' : ''}`}>
                        {isDayToday && nowInDay >= 0 && nowInDay < WEEKLY_GRID_MINUTES && (
                          <div className="schedule-now-line" style={{ top: `${(nowInDay / WEEKLY_GRID_MINUTES) * 100}%`, left: '2px' }} />
                        )}
                        {blocks.map(b => {
                          const duration = b.endPos - b.startPos;
                          const memo = b.memo;
                          const habitMatch = (memo.color || 'default') === 'default' ? habitMatchFor(memo.content, memo.recordedAt) : null;
                          const bg = habitMatch
                            ? `var(--habit-${habitMatch.color})`
                            : (COLOR_PALETTE.find(c => c.id === (memo.color || 'default'))?.bg || '#f9f9fb');
                          const border = habitMatch
                            ? (HABIT_BORDER[habitMatch.color] || '#e8e8f0')
                            : (COLOR_BORDER[memo.color || 'default'] || '#e8e8f0');
                          const showTime = duration >= 60;
                          const showContent = duration >= 30 || b.isLast || b.isSingle;
                          return (
                            <div
                              key={memo.id}
                              className="weekly-block"
                              onClick={() => openContentEditor(memo)}
                              style={{
                                top: `${(b.startPos / WEEKLY_GRID_MINUTES) * 100}%`,
                                height: `${(duration / WEEKLY_GRID_MINUTES) * 100}%`,
                                backgroundColor: bg,
                                borderColor: border,
                                opacity: b.isCarry ? 0.45 : 1,
                                minHeight: (showTime || showContent) ? '38px' : 'auto'
                              }}
                            >
                              {showTime && <div className="weekly-block-time">{format(new Date(memo.recordedAt), 'HH:mm')}</div>}
                              {showContent && <div className="weekly-block-content">{memo.content}</div>}
                            </div>
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

  // ── 스케줄 뷰 렌더 ──
  const renderScheduleView = () => {
    const sortedMemos = [...timelineMemos].sort((a, b) => new Date(a.recordedAt) - new Date(b.recordedAt));
    if (sortedMemos.length === 0) return null;

    const isViewingToday = isToday(selectedDate);
    // 그리드는 항상 26시간 (다음날 새벽 02:00까지)
    const gridHours = 26;
    const gridMinutes = gridHours * 60;
    const schedules = [];

    // 기본은 30분짜리 짧은 블록.
    // '다음 기록까지 이어서 표시'(spansToNext)를 켠 기록만 다음 기록까지 길게 늘어난다.
    // 자동으로 이어 붙이면 실제보다 오래 한 것처럼 보여 부담을 주기 때문에 선택제로 둔다.
    const MIN_BLOCK_MINUTES = 30;

    for (let i = 0; i < sortedMemos.length; i++) {
      const currentMemo = sortedMemos[i];
      const prevMemo = sortedMemos[i - 1];
      const nextMemo = sortedMemos[i + 1];
      const spansNext = !!currentMemo.spansToNext;
      const spansPrev = !!currentMemo.spansFromPrev;
      const backMin = Math.max(0, currentMemo.backMinutes || 0);

      const ownTime = new Date(currentMemo.recordedAt);
      const ownPos = minutesFromDayStart(currentMemo.recordedAt);
      const prevPos = prevMemo ? minutesFromDayStart(prevMemo.recordedAt) : null;
      const nextPos = nextMemo ? minutesFromDayStart(nextMemo.recordedAt) : null;

      // 시작 — 끝나고 남긴 기록은 이전 기록 시각부터.
      // 시작 시각을 직접 고쳤으면(backMinutes) 그 값이 우선한다.
      const startsEarlier = spansPrev || backMin > 0;
      let startPos = ownPos;
      if (backMin > 0) {
        startPos = ownPos - backMin;
      } else if (spansPrev) {
        startPos = prevPos !== null ? prevPos : ownPos - MIN_BLOCK_MINUTES;
      }
      if (startsEarlier) {
        // 새벽(00:00~01:59) 기록은 밤의 마지막으로 보고 그 너머까지 거슬러 올라가지 않는다
        if (ownPos >= 120 && startPos < 120) startPos = 120;
        if (startPos > ownPos) startPos = ownPos;
      }

      // 끝 — '다음 기록까지'를 켜면 다음 기록 시각(없으면 지금)까지 늘어난다
      let endPos;
      if (spansNext) {
        if (nextPos !== null) {
          endPos = nextPos;
        } else {
          // 마지막 기록이면 지금까지 진행 중으로 표시
          const nowPosInDay = (nowTime.getTime() - dayStartMs) / 60000;
          endPos = (nowPosInDay > ownPos && nowPosInDay < gridMinutes)
            ? nowPosInDay
            : ownPos + MIN_BLOCK_MINUTES;
        }
        // 새벽 기록이 새벽 2시를 넘겨 이어지지 않게 자른다
        const dawnCutoff = ownPos < 120 ? 120 : (ownPos >= 1440 && ownPos < 1560 ? 1560 : null);
        if (dawnCutoff !== null && endPos > dawnCutoff) endPos = dawnCutoff;
      } else if (startsEarlier) {
        endPos = ownPos; // 끝나고 남긴 기록이므로 이 기록 시각에서 끝난다
      } else {
        // 다음 기록이 30분 안에 있으면 겹치지 않게 거기까지만
        endPos = ownPos + MIN_BLOCK_MINUTES;
        if (nextPos !== null && nextPos > ownPos) endPos = Math.min(endPos, nextPos);
      }

      if (endPos < startPos) endPos = startPos;
      startPos = Math.max(startPos, 0);
      endPos = Math.min(endPos, gridMinutes);
      const startTime = new Date(dayStartMs + startPos * 60000);
      const endTime = new Date(dayStartMs + endPos * 60000);

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
        isCarry: ownPos >= 1440, // 다음날 새벽 메모 (흐리게 표시)
        spansToNext: spansNext,
        spansFromPrev: spansPrev,
        backMinutes: backMin,
        // 앞뒤 어느 쪽으로든 늘어난 블록 (시각을 범위로 표시한다)
        isSpanning: startsEarlier || spansNext,
        // 늘어나지 않은 블록은 시간+내용을 한 줄로 표시하므로 높이를 낮게 잡는다
        isCompact: !(startsEarlier || spansNext),
        // 이 기록 자체의 시간 (블록 시작과 다를 수 있어 따로 보관)
        ownHour: ownTime.getHours(),
        ownMin: ownTime.getMinutes(),
        // 이전 기록 시각 — '이전 기록부터'를 켜면 여기가 블록 시작이 된다
        prevHour: prevMemo ? new Date(prevMemo.recordedAt).getHours() : null,
        prevMin: prevMemo ? new Date(prevMemo.recordedAt).getMinutes() : null,
        nextHour: nextMemo ? new Date(nextMemo.recordedAt).getHours() : null,
        nextMin: nextMemo ? new Date(nextMemo.recordedAt).getMinutes() : null,
        startMemoId: currentMemo.id,
        nextMemoId: nextMemo ? nextMemo.id : null
      });
    }

    // 겹치는 블록은 좌우로 나누지 않고 위아래로 쌓는다.
    // 대신 그 시간대의 세로 칸을 늘려서(= 시간 축을 부분적으로 확대) 자리를 만든다.
    // 예: 9~10시에 기록 3개가 몰리면 9~10시 구간만 넓어지고 블록은 차례로 쌓인다.
    const PX_PER_MIN = 1;
    // 최소 높이는 CSS의 min-height와 일치시켜야 겹치지 않는다.
    // 한 줄짜리(시간+내용 인라인, 넘치면 …으로 잘림)는 낮게, 두 줄짜리는 그대로.
    const MIN_BLOCK_PX = 48;
    const MIN_COMPACT_PX = 34;
    const BLOCK_GAP_PX = 4;
    const minPxFor = (s) => (s.isCompact ? MIN_COMPACT_PX : MIN_BLOCK_PX);

    // 1) 시간이 겹치는 블록끼리 묶는다
    const ordered = [...schedules].sort((a, b) => a.startPos - b.startPos || a.endPos - b.endPos);
    const clusters = [];
    for (const s of ordered) {
      const last = clusters[clusters.length - 1];
      if (last && s.startPos < last.end) {
        last.end = Math.max(last.end, s.endPos);
        last.items.push(s);
      } else {
        clusters.push({ start: s.startPos, end: s.endPos, items: [s] });
      }
    }

    // 2) 쌓는 데 필요한 높이가 실제 시간 길이보다 크면 그만큼 구간을 늘린다
    const expansions = [];
    for (const c of clusters) {
      c.needPx = c.items.reduce(
        (sum, s) => sum + Math.max(minPxFor(s), (s.endPos - s.startPos) * PX_PER_MIN), 0
      ) + BLOCK_GAP_PX * (c.items.length - 1);
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
        s.top = y;
        s.height = Math.max(minPxFor(s), (s.endPos - s.startPos) * PX_PER_MIN);
        y += s.height + BLOCK_GAP_PX;
      }
    }

    // 현재 시간 위치 (0~1440분)
    const nowPos = nowTime.getHours() * 60 + nowTime.getMinutes();

    // 시간 눈금
    const hours = Array.from({ length: gridHours }, (_, i) => i);

    return (
      <div className="schedule-view" ref={scheduleViewRef}>
        <div className="schedule-header">
          <div className="schedule-times" style={{ height: `${totalPx}px` }}>
            {[...hours, gridHours].map(hour => (
              <div
                key={hour}
                className="schedule-hour-label"
                style={{ top: `${timeToPx(hour * 60)}px`, opacity: hour >= 24 ? 0.4 : undefined }}
              >
                {(hour % 24).toString().padStart(2, '0')}:00
              </div>
            ))}
          </div>
          <div className="schedule-grid" style={{ height: `${totalPx}px` }}>
            {hours.map(hour => (
              <div key={hour} className="schedule-hour-slot" style={{ top: `${timeToPx(hour * 60)}px` }} />
            ))}
            {/* 현재 시간 빨간 줄 (오늘만) */}
            {isViewingToday && (
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
                  className={`schedule-block${isCompact ? ' schedule-block--compact' : ''}`}
                  onClick={() => openScheduleDetail(schedule)}
                  style={{
                    top: `${schedule.top}px`,
                    height: `${schedule.height}px`,
                    backgroundColor: bgColor,
                    borderColor: borderColor,
                    opacity: schedule.isCarry ? 0.45 : 1,
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
  if (!currentUser) {
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
    return (
      <div className="app-container auth-wrapper">
        <div className="auth-card">
          <div className="auth-logo">
            <span className="auth-logo-icon">🕒</span>
            <h2>타임메모</h2>
            <p>오늘 하루를 시간 단위로 꼼꼼하게 기록하세요</p>
          </div>
          <div className="auth-tabs">
            <button type="button" className={`auth-tab ${authView === 'login' ? 'active' : ''}`} onClick={() => { setAuthView('login'); setAuthError(''); }}>로그인</button>
            <button type="button" className={`auth-tab ${authView === 'signup' ? 'active' : ''}`} onClick={() => { setAuthView('signup'); setAuthError(''); }}>회원가입</button>
          </div>
          <form onSubmit={handleAuthSubmit} className="auth-form">
            <div className="form-group">
              <label>이메일</label>
              <input type="text" placeholder="example@email.com" value={authEmail} onChange={e => setAuthEmail(e.target.value)} className="input-field auth-input" />
              {authView === 'signup' && authError && authError.includes('이메일') && (
                <div style={{ fontSize: '0.85rem', color: '#e53e3e', marginTop: '4px' }}>
                  올바른 이메일 형식으로 입력해 주세요.
                </div>
              )}
            </div>
            <div className="form-group">
              <label>비밀번호</label>
              <input type="password" placeholder={authView === 'signup' ? '8~16자 (영문, 숫자, 특수문자)' : '비밀번호 입력'} value={authPassword} onChange={e => setAuthPassword(e.target.value)} className="input-field auth-input" />
              {authView === 'signup' && authError && (authError.includes('비밀번호') || authError.includes('공백')) && (
                <div style={{ fontSize: '0.85rem', color: '#e53e3e', marginTop: '4px' }}>
                  영문, 숫자, 특수문자를 포함하여 8자리 이상 16자리 이하로 설정해 주세요.
                </div>
              )}
            </div>
            {authView === 'signup' && (
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
            {authView === 'login' && (
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
            )}
            {authError && (authView === 'login' || (!authError.includes('이메일') && !authError.includes('비밀번호') && !authError.includes('공백') && !authError.includes('일치'))) && (
              <div className="auth-error-message">{authError}</div>
            )}
            <button type="submit" className="btn-save auth-submit-btn" disabled={submittingAuth}>
              {submittingAuth ? <span className="spinner-small" /> : (authView === 'signup' ? '회원가입하기' : '로그인하기')}
            </button>
            {authView === 'login' && (
              <>
                <div className="auth-divider"><span>또는</span></div>
                <button type="button" className="google-signin-btn" onClick={handleGoogleSignIn} disabled={submittingAuth}>
                  <svg viewBox="0 0 24 24" width="18" height="18" style={{ marginRight: '10px' }}>
                    <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
                    <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                    <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l3.66-2.85z" />
                    <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.85c.87-2.6 3.3-4.53 6.16-4.53z" />
                  </svg>
                  구글로 로그인
                </button>
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
              </>
            )}
          </form>
        </div>
      </div>
    );
  }

  // ── 메인 화면 ────────────────────────────────────────────────
  return (
    <div className="app-container">
      {/* Header */}
      {activeView !== 'settings' && (
        <header className="header">
          {(activeView === 'timeline' || activeView === 'weekly') && (
            <button
              className="header-nav-btn"
              onClick={() => setSelectedDate(addDays(selectedDate, activeView === 'weekly' ? -7 : -1))}
              title={activeView === 'weekly' ? '이전주' : '이전날'}
            >
              <ChevronLeft size={20} />
            </button>
          )}
          <div className="header-title-container" onClick={() => { setCurrentMonth(selectedDate); setShowCalendar(true); }}>
            <Calendar size={20} className="header-icon" />
            <h1>{activeView === 'monthly' ? format(currentMonth, 'yyyy년 M월', { locale: ko }) : activeView === 'weekly' ? weekTitle : headerTitle}</h1>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            {activeView === 'timeline' && (
              <>
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
                <button className="header-nav-btn" onClick={() => setSelectedDate(addDays(selectedDate, 1))} title="다음날">
                  <ChevronRight size={20} />
                </button>
              </>
            )}
            {activeView === 'weekly' && (
              <button className="header-nav-btn" onClick={() => setSelectedDate(addDays(selectedDate, 7))} title="다음주">
                <ChevronRight size={20} />
              </button>
            )}
          </div>
        </header>
      )}

      {/* Main Content */}
      <div className="main-content">
        {activeView === 'timeline' ? (
          /* ── 타임라인 뷰 ── */
          showScheduleView && timelineMemos.length > 0 ? (
            renderScheduleView()
          ) : (
          <div className="timeline" ref={timelineRef}>
            {timelineMemos.length === 0 ? (
              <div className="empty-state">
                <Inbox size={48} strokeWidth={1} />
                <p>
                  {isToday(selectedDate) ? '오늘의' : `${format(selectedDate, 'M월 d일')}의`} 기록이 없습니다.<br />
                  아래에서 첫 메모를 남겨보세요!
                </p>
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
                      onEdit={(m, type) => type === 'time' ? openTimeEditor(m) : openContentEditor(m)}
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
              </div>
            </div>
          </div>
        )}
      </div>

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
          <button className="send-btn" onClick={handleAddMemo} disabled={!inputText.trim()}>
            <Send size={18} />
          </button>
        </div>
      )}

      {/* 스케줄 상세 바텀시트 */}
      {selectedSchedule && showScheduleView && (
        <div className="schedule-detail-overlay" onClick={closeScheduleDetail}>
          <div className="schedule-detail-sheet" onClick={e => e.stopPropagation()}>
            <div className="schedule-detail-header">
              <h3>{selectedSchedule.content}</h3>
              <button className="schedule-detail-close" onClick={closeScheduleDetail}>×</button>
            </div>
            <div className="schedule-detail-time-edit">
              <div className="time-input-group">
                <label>기록 시간</label>
                <div className="time-input-row">
                  <input
                    type="number"
                    inputMode="numeric"
                    min="0"
                    max="23"
                    value={editStartHour}
                    onChange={e => setEditStartHour(e.target.value)}
                    className="time-input"
                    placeholder="시"
                  />
                  <span>:</span>
                  <input
                    type="number"
                    inputMode="numeric"
                    min="0"
                    max="59"
                    value={editStartMin}
                    onChange={e => setEditStartMin(e.target.value)}
                    className="time-input"
                    placeholder="분"
                  />
                </div>
              </div>
              {selectedSchedule.spansToNext && selectedSchedule.nextMemoId && (
              <div className="time-input-group">
                <label>다음 기록 시간</label>
                <div className="time-input-row">
                  <input
                    type="number"
                    inputMode="numeric"
                    min="0"
                    max="23"
                    value={editEndHour}
                    onChange={e => setEditEndHour(e.target.value)}
                    className="time-input"
                    placeholder="시"
                  />
                  <span>:</span>
                  <input
                    type="number"
                    inputMode="numeric"
                    min="0"
                    max="59"
                    value={editEndMin}
                    onChange={e => setEditEndMin(e.target.value)}
                    className="time-input"
                    placeholder="분"
                  />
                </div>
              </div>
              )}
            </div>
            <label className="schedule-span-toggle">
              <input
                type="checkbox"
                checked={!!selectedSchedule.spansFromPrev || selectedSchedule.backMinutes > 0}
                onChange={() => handleToggleFromPrev(selectedSchedule)}
              />
              <span className="schedule-span-toggle-text">
                <strong>이전 기록부터 이어서 표시</strong>
                <small>끝나고 적은 기록일 때. 이전 기록 시각부터 이 기록 시각까지 하나의 블록이 됩니다.</small>
              </span>
            </label>
            {(selectedSchedule.spansFromPrev || selectedSchedule.backMinutes > 0) && (
            <div className="schedule-start-adjust">
              <span className="schedule-start-adjust-label">시작 시각</span>
              <input
                type="number"
                inputMode="numeric"
                min="0"
                max="23"
                className="time-input"
                value={adjustStartHour}
                onChange={e => setAdjustStartHour(e.target.value)}
                onBlur={() => commitStartAdjust(selectedSchedule)}
                onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
              />
              <span>:</span>
              <input
                type="number"
                inputMode="numeric"
                min="0"
                max="59"
                className="time-input"
                value={adjustStartMin}
                onChange={e => setAdjustStartMin(e.target.value)}
                onBlur={() => commitStartAdjust(selectedSchedule)}
                onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
              />
              {selectedSchedule.backMinutes > 0 && (
                <button
                  type="button"
                  className="schedule-start-reset"
                  onClick={() => handleToggleFromPrev(selectedSchedule, true)}
                >
                  이전 기록에 맞추기
                </button>
              )}
            </div>
            )}
            <label className="schedule-span-toggle">
              <input
                type="checkbox"
                checked={!!selectedSchedule.spansToNext}
                onChange={() => handleToggleSpans(selectedSchedule)}
              />
              <span className="schedule-span-toggle-text">
                <strong>다음 기록까지 이어서 표시</strong>
                <small>
                  {selectedSchedule.nextMemoId
                    ? '시작할 때 남긴 기록일 때. 이 기록 시각부터 다음 기록 시각까지 하나의 블록이 됩니다.'
                    : '켜면 지금 이 순간까지 진행 중인 것으로 그려집니다.'}
                </small>
              </span>
            </label>
            <div className="schedule-detail-time-edit">
              <div className="schedule-detail-actions">
                <button className="btn-cancel" onClick={closeScheduleDetail}>취소</button>
                <button className="btn-save" onClick={async () => {
                  // 각 칸은 해당 기록의 시각을 직접 고친다
                  const edits = [
                    { memoId: selectedSchedule.startMemoId, h: editStartHour, m: editStartMin,
                      fallbackH: selectedSchedule.ownHour, fallbackM: selectedSchedule.ownMin },
                    { memoId: (selectedSchedule.spansToNext && selectedSchedule.nextMemoId) || null,
                      h: editEndHour, m: editEndMin,
                      fallbackH: selectedSchedule.nextHour, fallbackM: selectedSchedule.nextMin },
                  ];
                  const updates = [];
                  for (const e of edits) {
                    if (!e.memoId) continue;
                    const memo = memos.find(m => m.id === e.memoId);
                    if (!memo) continue;
                    // 비워둔 칸은 원래 값을 그대로 쓴다
                    const h = e.h === '' || isNaN(parseInt(e.h)) ? e.fallbackH : parseInt(e.h);
                    const m = e.m === '' || isNaN(parseInt(e.m)) ? e.fallbackM : parseInt(e.m);
                    const t = new Date(memo.recordedAt);
                    t.setHours(Math.max(0, Math.min(23, h)));
                    t.setMinutes(Math.max(0, Math.min(59, m)));
                    updates.push({ id: memo.id, time: t.toISOString() });
                  }
                  for (const u of updates) {
                    const { error } = await supabase.from('memos').update({ recorded_at: u.time }).eq('id', u.id);
                    if (!error) {
                      setMemos(prev => prev.map(m => m.id === u.id ? { ...m, recordedAt: u.time } : m)
                        .sort((a, b) => new Date(a.recordedAt) - new Date(b.recordedAt)));
                    }
                  }
                  closeScheduleDetail();
                }}>저장</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 하단 탭바 */}
      <nav className="bottom-tab-bar">
        <button
          className={`tab-btn ${activeView === 'timeline' ? 'active' : ''}`}
          onClick={() => setActiveView('timeline')}
        >
          <Clock size={20} />
          <span>타임라인</span>
        </button>
        <button
          className={`tab-btn ${activeView === 'weekly' ? 'active' : ''}`}
          onClick={() => setActiveView('weekly')}
        >
          <Calendar size={20} />
          <span>위클리</span>
        </button>
        <button
          className={`tab-btn ${activeView === 'monthly' ? 'active' : ''}`}
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
          onClick={() => { setPreviousView(activeView); setActiveView('settings'); }}
        >
          <User size={20} />
          <span>마이페이지</span>
        </button>
      </nav>

      {/* Undo Toast */}
      {undoToast && (
        <div className="undo-toast">
          <span>메모가 삭제되었습니다</span>
          <button className="undo-btn" onClick={handleUndo}>취소</button>
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

      {/* Time Editor Modal */}
      {editingMemoId && (
        <div className="modal-overlay" onClick={() => setEditingMemoId(null)}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <h3 className="modal-title">날짜 & 시간 수정</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginBottom: '20px' }}>
              <div>
                <label style={{ fontSize: '0.9rem', fontWeight: '600', display: 'block', marginBottom: '6px' }}>날짜</label>
                <input
                  type="date"
                  className="input-field"
                  value={editDateStr}
                  onChange={e => setEditDateStr(e.target.value)}
                  style={{ borderRadius: '8px', padding: '8px 12px', fontSize: '0.9rem' }}
                />
              </div>
              <div>
                <label style={{ fontSize: '0.9rem', fontWeight: '600', display: 'block', marginBottom: '6px' }}>시간</label>
                <input
                  type="time"
                  className="input-field"
                  value={editTimeStr}
                  onChange={e => setEditTimeStr(e.target.value)}
                  style={{ borderRadius: '8px', padding: '8px 12px', fontSize: '0.9rem' }}
                />
              </div>
            </div>
            <div className="modal-actions">
              <button className="btn-cancel" onClick={() => { setEditingMemoId(null); setEditTimeStr(''); setEditDateStr(''); }}>취소</button>
              <button className="btn-save" onClick={saveTimeEdit}>저장</button>
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

      {/* Content Editor Modal */}
      {editingContentMemo && (
        <div className="modal-overlay" onClick={() => setEditingContentMemo(null)}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <h3 className="modal-title">메모 수정</h3>
            <div className="time-input-container" style={{ width: '100%' }}>
              <textarea
                className="input-field"
                style={{ width: '100%', minHeight: '100px', borderRadius: '12px', resize: 'none' }}
                value={editContentStr}
                onChange={e => setEditContentStr(e.target.value)}
              />
            </div>

            {/* Color Picker */}
            <div style={{ marginBottom: '20px' }}>
              <span style={{ fontSize: '0.85rem', color: '#666', marginBottom: '6px', display: 'block' }}>색상 선택</span>
              <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-start', alignItems: 'center', flexWrap: 'wrap' }}>
                {COLOR_PALETTE.map(c => (
                  <button
                    key={c.id}
                    style={{
                      width: '32px',
                      height: '32px',
                      borderRadius: '50%',
                      border: `${editMemoColor === c.id ? '4px' : '2px'} solid ${COLOR_BORDER[c.id]}`,
                      backgroundColor: c.bg,
                      cursor: 'pointer',
                      padding: 0,
                      transition: 'border 0.15s, box-shadow 0.15s',
                      boxShadow: editMemoColor === c.id ? `0 0 0 2px white, 0 0 8px ${COLOR_BORDER[c.id]}` : 'none'
                    }}
                    onClick={() => setEditMemoColor(c.id)}
                    title={c.label}
                    onMouseEnter={(e) => e.target.style.transform = 'scale(1.05)'}
                    onMouseLeave={(e) => e.target.style.transform = 'scale(1)'}
                  />
                ))}
              </div>
            </div>

            <div className="modal-actions" style={{ flexDirection: 'column', gap: '8px' }}>
              <div style={{ display: 'flex', gap: '12px', width: '100%' }}>
                <button className="btn-cancel" onClick={() => setEditingContentMemo(null)}>취소</button>
                <button className="btn-save" onClick={saveContentEdit}>저장</button>
              </div>
              <button
                className="btn-cancel"
                style={{ color: '#e53e3e', backgroundColor: '#fff5f5', width: '100%' }}
                onClick={() => { handleDeleteWithUndo(editingContentMemo); setEditingContentMemo(null); }}
              >
                메모 삭제
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

export default App;
