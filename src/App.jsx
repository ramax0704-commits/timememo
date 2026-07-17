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
import { db, auth } from './firebase';
import { collection, onSnapshot, addDoc, updateDoc, deleteDoc, doc, serverTimestamp, query, orderBy, getDocs, setDoc, getDoc } from 'firebase/firestore';
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  GoogleAuthProvider,
  signInWithPopup,
  setPersistence,
  browserLocalPersistence,
  browserSessionPersistence,
  sendEmailVerification,
  sendPasswordResetEmail,
  confirmPasswordReset,
  updatePassword,
  reauthenticateWithCredential,
  EmailAuthProvider,
  sendSignInLinkToEmail,
  isSignInWithEmailLink,
  signInWithEmailLink,
  fetchSignInMethodsForEmail
} from 'firebase/auth';

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

    // 습관 키워드
    habitKeywords.forEach(kwObj => {
      if (kwObj?.name && memo.content.includes(kwObj.name) && !result[dateKey].habits.find(h => h.name === kwObj.name)) {
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
function MemoItem({ memo, onEdit, onDeleteWithUndo, isTouchDevice }) {
  const [swiped, setSwiped] = useState(false);
  const colorBg = COLOR_PALETTE.find(c => c.id === (memo.color || 'default'))?.bg || '#f9f9fb';
  const colorBorder = COLOR_BORDER[memo.color || 'default'] || '#e8e8f0';

  const swipe = useSwipe(
    () => setSwiped(true),
    () => setSwiped(false),
    50
  );

  return (
    <div
      className={`memo-swipe-wrapper ${swiped ? 'swiped' : ''}`}
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
  // URL 파라미터 (비밀번호 재설정 페이지)
  const urlParams = new URLSearchParams(window.location.search);
  const [resetOobCode] = useState(urlParams.get('oobCode'));
  const [urlMode] = useState(urlParams.get('mode'));

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
  const [rememberMe, setRememberMe] = useState(true);
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

  // 이메일 링크 로그인 상태
  const [emailLinkProcessing, setEmailLinkProcessing] = useState(false);
  const [emailLinkError, setEmailLinkError] = useState('');
  const [needPasswordSetup, setNeedPasswordSetup] = useState(false);
  const [setupNewPw, setSetupNewPw] = useState('');
  const [setupNewPwConfirm, setSetupNewPwConfirm] = useState('');
  const [settingupPassword, setSettingupPassword] = useState(false);

  // Modal States
  const [editingMemoId, setEditingMemoId] = useState(null);
  const [editTimeStr, setEditTimeStr] = useState('');
  const [editDateStr, setEditDateStr] = useState('');
  const [editingContentMemo, setEditingContentMemo] = useState(null);
  const [editContentStr, setEditContentStr] = useState('');
  const [editMemoColor, setEditMemoColor] = useState('default');
  const [showCalendar, setShowCalendar] = useState(false);
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [selectedDayModal, setSelectedDayModal] = useState(null);
  const [showScheduleView, setShowScheduleView] = useState(false);
  const [selectedSchedule, setSelectedSchedule] = useState(null);
  const [editStartHour, setEditStartHour] = useState('');
  const [editStartMin, setEditStartMin] = useState('');
  const [editEndHour, setEditEndHour] = useState('');
  const [editEndMin, setEditEndMin] = useState('');

  // Undo Toast
  const [undoToast, setUndoToast] = useState(null); // { memo, timer }

  // Settings (habit keywords)
  const [habitKeywords, setHabitKeywords] = useState([]);
  const [newKeyword, setNewKeyword] = useState('');
  const [newKeywordColor, setNewKeywordColor] = useState('purple');
  const [showKeywordColorPicker, setShowKeywordColorPicker] = useState(false);
  const [editingKeywordName, setEditingKeywordName] = useState(null);
  const [showEditKeywordColorPicker, setShowEditKeywordColorPicker] = useState(false);
  const colorButtonRef = useRef(null);
  const editColorButtonRef = useRef(null);
  const [colorPickerPos, setColorPickerPos] = useState({});

  const timelineRef = useRef(null);
  const inputRef = useRef(null);
  const scrollPositionRef = useRef(null);
  const [isCalendarScrolling, setIsCalendarScrolling] = useState(false);
  const calendarScrollTimeoutRef = useRef(null);

  // ── 이메일 링크 로그인 처리 (회원가입 링크 클릭 시) ────────────────
  useEffect(() => {
    if (!isSignInWithEmailLink(auth, window.location.href)) return;

    setEmailLinkProcessing(true);
    const email = localStorage.getItem('emailForSignIn');

    if (!email) {
      setEmailLinkProcessing(false);
      setEmailLinkError('이메일 정보를 찾을 수 없습니다. 다시 회원가입해주세요.');
      return;
    }

    signInWithEmailLink(auth, email, window.location.href)
      .then(async (result) => {
        const pw = sessionStorage.getItem('pendingSignupPassword');
        if (pw) {
          try {
            await updatePassword(result.user, pw);
            sessionStorage.removeItem('pendingSignupPassword');
            setAuthView('login');
          } catch (error) {
            setNeedPasswordSetup(true);
          }
        } else {
          setNeedPasswordSetup(true);
        }
        localStorage.removeItem('emailForSignIn');
        window.history.replaceState({}, '', '/');
        setEmailLinkProcessing(false);
      })
      .catch((error) => {
        setEmailLinkProcessing(false);
        let errorMsg = '인증 링크가 만료되었거나 유효하지 않습니다. 다시 시도해주세요.';
        if (error.code === 'auth/invalid-email') errorMsg = '유효하지 않은 이메일입니다.';
        setEmailLinkError(errorMsg);
      });
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
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setCurrentUser(user);
      if (!user) {
        setMemos([]);
      } else if (user.providerData[0]?.providerId === 'password' && !user.emailVerified) {
        setAuthView('emailVerification');
      }
      setAuthLoading(false);
    });
    return () => unsubscribe();
  }, []);

  // ── Firestore 메모 구독 ──────────────────────────────────────
  useEffect(() => {
    if (!currentUser) return;
    const q = query(
      collection(db, 'users', currentUser.uid, 'memos'),
      orderBy('recordedAt', 'asc')
    );
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const memosData = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
      setMemos(memosData);
    }, (error) => {
      console.error('Error fetching memos:', error);
    });
    return () => unsubscribe();
  }, [currentUser]);

  // ── Settings 불러오기 ────────────────────────────────────────
  useEffect(() => {
    if (!currentUser) return;
    const loadSettings = async () => {
      try {
        const settingsDoc = await getDoc(doc(db, 'users', currentUser.uid, 'settings', 'preferences'));
        console.log('Settings doc exists:', settingsDoc.exists());
        console.log('Settings data:', settingsDoc.data());
        if (settingsDoc.exists()) {
          const data = settingsDoc.data();
          if (data.habitKeywords && Array.isArray(data.habitKeywords)) {
            console.log('Loaded habitKeywords:', data.habitKeywords);
            setHabitKeywords(data.habitKeywords);
          }
        }
      } catch (e) {
        console.error('Error loading settings:', e);
      }
    };
    loadSettings();
  }, [currentUser]);

  // ── 입력 포커스 ──────────────────────────────────────────────
  useEffect(() => {
    if (currentUser && activeView === 'timeline') {
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
  const monthlyData = buildMonthlyData(memos, habitKeywords);

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
      // 5초 후 실제 Firestore 삭제
      try {
        await deleteDoc(doc(db, 'users', currentUser.uid, 'memos', memo.id));
      } catch (error) {
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
      const persistence = rememberMe ? browserLocalPersistence : browserSessionPersistence;
      await setPersistence(auth, persistence);
      if (authView === 'signup') {
        // 1. 이미 가입된 이메일인지 확인
        const signInMethods = await fetchSignInMethodsForEmail(auth, authEmail);
        if (signInMethods.length > 0) {
          setAuthError('이미 가입된 이메일입니다.');
          setSubmittingAuth(false);
          return;
        }
        // 2. 이메일 링크로 로그인 링크 발송 (계정 생성 안 함)
        await sendSignInLinkToEmail(auth, authEmail, {
          url: 'https://timememo-23a3c.web.app',
          handleCodeInApp: true
        });
        // 3. 클라이언트 저장소에 저장
        localStorage.setItem('emailForSignIn', authEmail);
        sessionStorage.setItem('pendingSignupPassword', authPassword);
        // 4. 인증 메일 발송됨 화면으로
        setAuthView('emailVerification');
      } else {
        await signInWithEmailAndPassword(auth, authEmail, authPassword);
      }
      setAuthEmail('');
      setAuthPassword('');
      setAuthConfirmPassword('');
    } catch (error) {
      console.error('회원가입 에러:', error.code, error.message, error);
      let errorMsg;
      switch (error.code) {
        case 'auth/invalid-email': errorMsg = '유효하지 않은 이메일 형식입니다.'; break;
        case 'auth/user-disabled': errorMsg = '비활성화된 계정입니다.'; break;
        case 'auth/user-not-found':
        case 'auth/wrong-password':
        case 'auth/invalid-credential': errorMsg = '이메일 또는 비밀번호가 올바르지 않습니다.'; break;
        case 'auth/email-already-in-use': errorMsg = '이미 사용 중인 이메일입니다.'; break;
        case 'auth/weak-password': errorMsg = '비밀번호 강도가 너무 약합니다. (최소 8자리)'; break;
        case 'auth/too-many-requests': errorMsg = '너무 많은 요청을 보냈습니다. 나중에 다시 시도해주세요.'; break;
        default: errorMsg = error.message || '인증에 실패했습니다. 다시 시도해주세요.';
      }
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
      await sendPasswordResetEmail(auth, forgotEmail);
      setForgotEmailSent(true);
      setForgotEmail('');
    } catch (error) {
      let errorMsg;
      switch (error.code) {
        case 'auth/invalid-email': errorMsg = '유효하지 않은 이메일 형식입니다.'; break;
        case 'auth/user-not-found': errorMsg = '등록되지 않은 이메일입니다.'; break;
        default: errorMsg = '비밀번호 재설정 이메일 발송에 실패했습니다.';
      }
      setForgotEmailError(errorMsg);
    } finally {
      setSubmittingAuth(false);
    }
  };

  const handleVerifyEmail = async () => {
    if (!currentUser) return;
    setSubmittingAuth(true);
    try {
      await currentUser.reload();
      if (currentUser.emailVerified) {
        setAuthView('login');
      } else {
        setAuthError('아직 이메일이 인증되지 않았습니다. 받은편지함을 확인해주세요.');
      }
    } catch (error) {
      setAuthError('인증 상태 확인에 실패했습니다.');
    } finally {
      setSubmittingAuth(false);
    }
  };

  const handleResendVerificationEmail = async () => {
    if (!currentUser) return;
    setSubmittingAuth(true);
    try {
      await sendEmailVerification(currentUser);
      setAuthError('');
      alert('인증 이메일이 재발송되었습니다.');
    } catch (error) {
      setAuthError('인증 이메일 발송에 실패했습니다.');
    } finally {
      setSubmittingAuth(false);
    }
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
      await confirmPasswordReset(auth, resetOobCode, resetNewPw);
      setResetSuccess(true);
      setResetNewPw('');
      setResetConfirmPw('');
    } catch (error) {
      let errorMsg;
      switch (error.code) {
        case 'auth/expired-action-code': errorMsg = '비밀번호 재설정 링크가 만료되었습니다. 다시 요청해주세요.'; break;
        case 'auth/invalid-action-code': errorMsg = '유효하지 않은 링크입니다.'; break;
        case 'auth/user-disabled': errorMsg = '비활성화된 계정입니다.'; break;
        case 'auth/user-not-found': errorMsg = '계정을 찾을 수 없습니다.'; break;
        case 'auth/weak-password': errorMsg = '비밀번호 강도가 너무 약합니다.'; break;
        default: errorMsg = '비밀번호 재설정에 실패했습니다. 다시 시도해주세요.';
      }
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
      const credential = EmailAuthProvider.credential(currentUser.email, currentPw);
      await reauthenticateWithCredential(currentUser, credential);
      await updatePassword(currentUser, newPw);
      setPasswordChangeSuccess(true);
      setCurrentPw('');
      setNewPw('');
      setConfirmNewPw('');
      setTimeout(() => {
        setShowPasswordChange(false);
        setPasswordChangeSuccess(false);
      }, 2000);
    } catch (error) {
      let errorMsg;
      switch (error.code) {
        case 'auth/wrong-password': errorMsg = '현재 비밀번호가 올바르지 않습니다.'; break;
        case 'auth/weak-password': errorMsg = '비밀번호 강도가 너무 약합니다.'; break;
        default: errorMsg = '비밀번호 변경에 실패했습니다.';
      }
      setPasswordChangeError(errorMsg);
    } finally {
      setChangingPassword(false);
    }
  };

  const handleSetupPassword = async () => {
    if (!setupNewPw.trim() || !setupNewPwConfirm.trim()) {
      alert('비밀번호를 입력해주세요.');
      return;
    }
    if (setupNewPw !== setupNewPwConfirm) {
      alert('비밀번호가 일치하지 않습니다.');
      return;
    }
    const hasLetter = /[A-Za-z]/.test(setupNewPw);
    const hasNumber = /\d/.test(setupNewPw);
    const hasSpecial = /[^A-Za-z0-9]/.test(setupNewPw);
    const hasSpace = /\s/.test(setupNewPw);
    const isLengthValid = setupNewPw.length >= 8 && setupNewPw.length <= 16;
    if (hasSpace) {
      alert('비밀번호에 공백을 포함할 수 없습니다.');
      return;
    }
    if (!isLengthValid || !hasLetter || !hasNumber || !hasSpecial) {
      alert('영문, 숫자, 특수문자를 포함하여 8자리 이상 16자리 이하로 설정해 주세요.');
      return;
    }
    setSettingupPassword(true);
    try {
      await updatePassword(currentUser, setupNewPw);
      setNeedPasswordSetup(false);
      setSetupNewPw('');
      setSetupNewPwConfirm('');
    } catch (error) {
      alert('비밀번호 설정에 실패했습니다. 다시 시도해주세요.');
    } finally {
      setSettingupPassword(false);
    }
  };

  const handleGoogleSignIn = async () => {
    const provider = new GoogleAuthProvider();
    setSubmittingAuth(true);
    setAuthError('');
    try {
      const persistence = rememberMe ? browserLocalPersistence : browserSessionPersistence;
      await setPersistence(auth, persistence);
      await signInWithPopup(auth, provider);
    } catch (error) {
      let errorMsg = '구글 로그인에 실패했습니다. 다시 시도해주세요.';
      if (error.code === 'auth/popup-closed-by-user') errorMsg = '구글 로그인 팝업이 닫혔습니다.';
      else if (error.code === 'auth/blocked-by-popup-toggler') errorMsg = '브라우저 팝업 차단을 해제하고 다시 시도해주세요.';
      setAuthError(errorMsg);
    } finally {
      setSubmittingAuth(false);
    }
  };

  const handleDeleteAccount = async () => {
    if (!currentUser) return;
    if (!window.confirm('정말 회원탈퇴를 진행하시겠습니까?\n작성하신 모든 메모가 영구적으로 삭제되며 이 작업은 복구할 수 없습니다.')) return;
    setDeletingAccount(true);
    try {
      const q = query(collection(db, 'users', currentUser.uid, 'memos'));
      const querySnapshot = await getDocs(q);
      await Promise.all(querySnapshot.docs.map(d => deleteDoc(doc(db, 'users', currentUser.uid, 'memos', d.id))));
      await currentUser.delete();
      alert('회원탈퇴가 정상적으로 완료되었습니다.');
      setShowMyPage(false);
    } catch (error) {
      if (error.code === 'auth/requires-recent-login') {
        alert('보안상 회원탈퇴를 진행하려면 최근에 로그인한 세션이 필요합니다.\n로그아웃 후 다시 로그인하셔서 탈퇴를 시도해 주세요.');
      } else {
        alert(`회원탈퇴 중 오류가 발생했습니다: ${error.message}`);
      }
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
      content: inputText,
      color: selectedColor,
      recordedAt: now.toISOString(),
      createdAt: serverTimestamp()
    };
    setInputText('');
    try {
      await addDoc(collection(db, 'users', currentUser.uid, 'memos'), newMemoData);
    } catch (error) {
      console.error('Error adding document:', error);
      alert('메모 저장에 실패했습니다. Firestore 설정을 확인해주세요.');
    }
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
      console.log('🔄 Saving new date:', editDateStr, hours, mins, newDate.toISOString());
      try {
        await updateDoc(doc(db, 'users', currentUser.uid, 'memos', editingMemoId), {
          recordedAt: newDate.toISOString()
        });
        console.log('✅ Successfully updated!');
      } catch (error) {
        console.error('❌ Error updating time:', error);
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
    try {
      await updateDoc(doc(db, 'users', currentUser.uid, 'memos', editingContentMemo.id), {
        content: editContentStr,
        color: editMemoColor
      });
    } catch (error) {
      console.error('Error updating content:', error);
    }
    setEditingContentMemo(null);
  };

  // ── 습관 키워드 저장 ─────────────────────────────────────────
  const saveHabitKeywords = async (keywords) => {
    if (!currentUser) return;
    try {
      console.log('Saving habitKeywords:', keywords);
      await setDoc(doc(db, 'users', currentUser.uid, 'settings', 'preferences'), {
        habitKeywords: keywords
      }, { merge: true });
      console.log('Saved successfully');
    } catch (e) {
      console.error('Error saving settings:', e);
    }
  };

  const addHabitKeyword = async () => {
    const kw = newKeyword.trim();
    console.log('Adding keyword:', kw, 'color:', newKeywordColor);
    if (!kw || habitKeywords.some(k => k.name === kw)) {
      console.log('Keyword already exists or empty');
      return;
    }
    const updated = [...habitKeywords, { name: kw, color: newKeywordColor }];
    console.log('Updated habitKeywords:', updated);
    setHabitKeywords(updated);
    await saveHabitKeywords(updated);
    setNewKeyword('');
    setNewKeywordColor('purple');
  };

  const removeHabitKeyword = (kwName) => {
    const updated = habitKeywords.filter(k => k.name !== kwName);
    setHabitKeywords(updated);
    saveHabitKeywords(updated);
  };

  const updateKeywordColor = (kwName, newColor) => {
    const updated = habitKeywords.map(k =>
      k.name === kwName ? { ...k, color: newColor } : k
    );
    setHabitKeywords(updated);
    saveHabitKeywords(updated);
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
                setSelectedDayModal(cloneDay);
              }
            }
          };
        };

        const handlers = createTouchHandler();

        days.push(
          <div
            key={day.toISOString()}
            className={`monthly-cell ${!isCurrentMonth ? 'monthly-cell-disabled' : ''} ${isDayToday ? 'monthly-cell-today' : ''}`}
            tabIndex={-1}
            onClick={(e) => {
              if (isCurrentMonth) {
                setSelectedDayModal(cloneDay);
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

        {/* 습관 키워드 힌트 */}
        {habitKeywords.length > 0 && (
          <div className="monthly-keywords-hint">
            <Tag size={12} />
            <span>습관: {habitKeywords.map(k => k.name).join(', ')}</span>
          </div>
        )}
      </div>
    );
  };

  const dateFormatted = format(selectedDate, 'M월 d일 (E)', { locale: ko });
  const headerTitle = isToday(selectedDate) ? `${dateFormatted} - 오늘` : dateFormatted;
  const memoGroups = groupMemosByHour(displayedMemos);

  // ── 스케줄 뷰 렌더 ──
  const renderScheduleView = () => {
    const sortedMemos = [...displayedMemos].sort((a, b) => new Date(a.recordedAt) - new Date(b.recordedAt));
    console.log('📋 메모 목록:');
    sortedMemos.forEach((m, i) => console.log(`  ${i}: ${m.content?.substring(0, 20)} | 시간: ${m.recordedAt}`));
    if (sortedMemos.length === 0) return null;

    const schedules = [];

    for (let i = 0; i < sortedMemos.length - 1; i++) {
      const currentMemo = sortedMemos[i];
      const nextMemo = sortedMemos[i + 1];

      const startTime = new Date(currentMemo.recordedAt);
      const endTime = new Date(nextMemo.recordedAt);
      const content = nextMemo.content;
      const color = nextMemo.color || 'default';

      schedules.push({
        startHour: startTime.getHours(),
        startMin: startTime.getMinutes(),
        endHour: endTime.getHours(),
        endMin: endTime.getMinutes(),
        content,
        color,
        startMemoId: currentMemo.id,
        endMemoId: nextMemo.id
      });
    }

    // 시간 눈금 (0~23시)
    const hours = Array.from({ length: 24 }, (_, i) => i);

    return (
      <div className="schedule-view">
        <div className="schedule-header">
          <div className="schedule-times">
            {hours.map(hour => (
              <div key={hour} className="schedule-hour-label">
                {hour.toString().padStart(2, '0')}:00
              </div>
            ))}
          </div>
          <div className="schedule-grid">
            {hours.map(hour => (
              <div key={hour} className="schedule-hour-slot" />
            ))}
            {schedules.map((schedule, idx) => {
              const startPos = schedule.startHour * 60 + schedule.startMin;
              const endPos = schedule.endHour * 60 + schedule.endMin;
              const duration = endPos - startPos;
              const bgColor = COLOR_PALETTE.find(c => c.id === schedule.color)?.bg || '#f9f9fb';
              const borderColor = COLOR_BORDER[schedule.color] || '#e8e8f0';

              // 시간 길이에 따른 표시 결정
              let showTime = false;
              let showContent = false;
              if (duration >= 60) {
                showTime = true;
                showContent = true;
              } else if (duration >= 30) {
                showContent = true;
              }

              return (
                <div
                  key={idx}
                  className="schedule-block"
                  onClick={() => setSelectedSchedule(schedule)}
                  style={{
                    top: `${(startPos / (24 * 60)) * 100}%`,
                    height: `${(duration / (24 * 60)) * 100}%`,
                    backgroundColor: bgColor,
                    borderColor: borderColor,
                    minHeight: (showTime || showContent) ? '40px' : 'auto',
                    cursor: 'pointer',
                    justifyContent: (showTime || showContent) ? 'flex-start' : 'center',
                    paddingTop: (showTime || showContent) ? '6px' : '0'
                  }}
                >
                  {showTime && (
                    <div className="schedule-block-time">
                      {schedule.startHour.toString().padStart(2, '0')}:{schedule.startMin.toString().padStart(2, '0')}
                    </div>
                  )}
                  {showContent && (
                    <div className="schedule-block-content">{schedule.content}</div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  };

  // ── 이메일 링크 로그인 처리 중 ────────────────────────────────
  if (emailLinkProcessing) {
    return (
      <div className="app-container" style={{ justifyContent: 'center', alignItems: 'center' }}>
        <div style={{ textAlign: 'center' }}>
          <div className="spinner" style={{ marginBottom: '20px' }} />
          <p style={{ fontSize: '1rem', color: '#666' }}>회원가입을 처리 중입니다...</p>
        </div>
      </div>
    );
  }

  // ── 이메일 링크 오류 ──────────────────────────────────────────
  if (emailLinkError) {
    return (
      <div className="app-container auth-wrapper">
        <div className="auth-card">
          <div className="auth-logo">
            <span className="auth-logo-icon">❌</span>
            <h2>인증 오류</h2>
            <p>{emailLinkError}</p>
          </div>
          <button
            type="button"
            className="btn-save auth-submit-btn"
            onClick={() => {
              setEmailLinkError('');
              setAuthView('signup');
            }}
            style={{ marginTop: '20px' }}
          >
            다시 회원가입하기
          </button>
        </div>
      </div>
    );
  }

  // ── 비밀번호 설정 화면 (이메일 링크 로그인 후) ─────────────────
  if (currentUser && needPasswordSetup) {
    return (
      <div className="app-container auth-wrapper">
        <div className="auth-card">
          <div className="auth-logo">
            <span className="auth-logo-icon">🔐</span>
            <h2>비밀번호 설정</h2>
            <p>계정을 완성하기 위해 비밀번호를 설정해주세요</p>
          </div>
          <form onSubmit={(e) => { e.preventDefault(); handleSetupPassword(); }} className="auth-form">
            <div className="form-group">
              <label>비밀번호</label>
              <input
                type="password"
                placeholder="8~16자 (영문, 숫자, 특수문자)"
                value={setupNewPw}
                onChange={e => setSetupNewPw(e.target.value)}
                className="input-field auth-input"
              />
            </div>
            <div className="form-group">
              <label>비밀번호 확인</label>
              <input
                type="password"
                placeholder="비밀번호 재입력"
                value={setupNewPwConfirm}
                onChange={e => setSetupNewPwConfirm(e.target.value)}
                className="input-field auth-input"
              />
            </div>
            <button type="submit" className="btn-save auth-submit-btn" disabled={settingupPassword}>
              {settingupPassword ? <span className="spinner-small" /> : '비밀번호 설정 완료'}
            </button>
          </form>
        </div>
      </div>
    );
  }

  // ── 비밀번호 재설정 페이지 (URL 파라미터로 접근) ───────────────
  if (urlMode === 'resetPassword' && resetOobCode) {
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
                onClick={() => window.location.href = '/'}
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

  // ── 이메일 인증 화면 (로그인됨 + 이메일 미인증 + 이메일/비밀번호 로그인) ─────
  if (currentUser && !currentUser.emailVerified && currentUser.providerData[0]?.providerId === 'password') {
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
              <strong>{currentUser.email}</strong>
            </p>
            <p style={{ fontSize: '0.85rem', color: '#999', margin: 0 }}>
              받은편지함 또는 스팸함을 확인하고 인증 링크를 클릭해주세요.
            </p>
          </div>
          {authError && <div className="auth-error-message">{authError}</div>}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <button
              type="button"
              className="btn-save auth-submit-btn"
              onClick={handleVerifyEmail}
              disabled={submittingAuth}
            >
              {submittingAuth ? <span className="spinner-small" /> : '인증 완료했어요'}
            </button>
            <button
              type="button"
              className="btn-cancel"
              onClick={handleResendVerificationEmail}
              disabled={submittingAuth}
            >
              인증 메일 재발송
            </button>
            <button
              type="button"
              className="btn-cancel"
              onClick={async () => { await signOut(auth); setAuthView('login'); }}
            >
              로그아웃
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
                  <input type="checkbox" checked={rememberMe} onChange={e => setRememberMe(e.target.checked)} className="auth-remember-checkbox" />
                  로그인 상태 유지
                </label>
              </div>
            )}
            {authError && !authError.includes('이메일') && !authError.includes('비밀번호') && !authError.includes('공백') && !authError.includes('일치') && (
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
          {activeView === 'timeline' && (
            <button className="header-nav-btn" onClick={() => setSelectedDate(addDays(selectedDate, -1))} title="이전날">
              <ChevronLeft size={20} />
            </button>
          )}
          <div className="header-title-container" onClick={() => { setCurrentMonth(selectedDate); setShowCalendar(true); }}>
            <Calendar size={20} className="header-icon" />
            <h1>{activeView === 'monthly' ? format(currentMonth, 'yyyy년 M월', { locale: ko }) : headerTitle}</h1>
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
          </div>
        </header>
      )}

      {/* Main Content */}
      <div className="main-content">
        {activeView === 'timeline' ? (
          /* ── 타임라인 뷰 ── */
          showScheduleView && displayedMemos.length > 0 ? (
            renderScheduleView()
          ) : (
          <div className="timeline" ref={timelineRef}>
            {displayedMemos.length === 0 ? (
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
                    />
                  ))}
                </div>
              ))
            )}
          </div>
          )
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
                      {currentUser.photoURL ? (
                        <img src={currentUser.photoURL} alt="프로필" style={{ width: '100%', height: '100%', borderRadius: '50%' }} />
                      ) : (
                        <User size={24} color="#999" />
                      )}
                    </div>
                    <div>
                      <p style={{ fontSize: '0.9rem', color: '#666', margin: '0' }}>{currentUser.email}</p>
                      <p style={{ fontSize: '0.75rem', color: '#999', margin: '4px 0 0' }}>
                        {currentUser.providerData[0]?.providerId === 'google.com' ? '구글 로그인' : '이메일 가입'}
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
                  메모에 아래 단어가 포함되면 먼슬리 달력에 자동으로 표시됩니다.
                </p>
                <div className="keyword-list">
                  {habitKeywords.map(kw => (
                    <div key={kw.name} className="keyword-chip" style={{ display: 'flex', alignItems: 'center', gap: '6px', position: 'relative' }}>
                      <button
                        ref={editingKeywordName === kw.name ? editColorButtonRef : null}
                        onClick={() => {
                          setEditingKeywordName(editingKeywordName === kw.name ? null : kw.name);
                          setShowEditKeywordColorPicker(!showEditKeywordColorPicker);
                        }}
                        style={{
                          width: '16px',
                          height: '16px',
                          borderRadius: '50%',
                          backgroundColor: `var(--habit-${kw.color})`,
                          border: editingKeywordName === kw.name ? '2px solid #4a72ff' : 'none',
                          cursor: 'pointer',
                          padding: 0,
                          flexShrink: 0
                        }}
                        title="색상 변경"
                      />
                      <span>{kw.name}</span>
                      <button
                        onClick={() => removeHabitKeyword(kw.name)}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px', color: '#999' }}
                      >
                        <X size={12} />
                      </button>

                      {/* 색상 선택 팝업 */}
                      {editingKeywordName === kw.name && showEditKeywordColorPicker && (
                        <div style={{
                          position: 'absolute',
                          bottom: '100%',
                          left: '-10px',
                          backgroundColor: 'white',
                          borderRadius: '12px',
                          padding: '8px',
                          display: 'flex',
                          gap: '6px',
                          boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
                          zIndex: 100,
                          marginBottom: '4px'
                        }}>
                          {['purple', 'blue', 'green', 'pink', 'orange'].map(color => (
                            <button
                              key={color}
                              onClick={() => {
                                updateKeywordColor(kw.name, color);
                                setEditingKeywordName(null);
                                setShowEditKeywordColorPicker(false);
                              }}
                              style={{
                                width: '20px',
                                height: '20px',
                                borderRadius: '50%',
                                backgroundColor: `var(--habit-${color})`,
                                border: kw.color === color ? '2px solid #333' : 'none',
                                cursor: 'pointer',
                                padding: 0
                              }}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                  {habitKeywords.length === 0 && (
                    <span style={{ fontSize: '0.8rem', color: '#aaa' }}>등록된 키워드가 없습니다</span>
                  )}
                </div>

                {/* 타임라인처럼 좌우 배치: 좌측 컬러 버튼, 우측 입력 */}
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '12px', position: 'relative', overflow: 'visible' }}>
                  {/* 좌측: 컬러 버튼 (토글식) */}
                  <div style={{ position: 'relative', flexShrink: 0 }}>
                    <button
                      ref={colorButtonRef}
                      onClick={() => {
                        if (!showKeywordColorPicker && colorButtonRef.current) {
                          const rect = colorButtonRef.current.getBoundingClientRect();
                          setColorPickerPos({
                            top: rect.top - 50,
                            left: rect.left - 20
                          });
                        }
                        setShowKeywordColorPicker(!showKeywordColorPicker);
                      }}
                      style={{
                        width: '32px',
                        height: '32px',
                        borderRadius: '50%',
                        backgroundColor: COLOR_PALETTE.find(c => c.id === newKeywordColor)?.bg || '#f9f9fb',
                        border: `2px solid ${COLOR_BORDER[newKeywordColor] || '#ddd'}`,
                        cursor: 'pointer',
                        padding: 0
                      }}
                    />
                    {/* 컬러 팝업 - 타임라인 스타일 */}
                    {showKeywordColorPicker && (
                      <div style={{
                        position: 'fixed',
                        top: `${colorPickerPos.top}px`,
                        left: `${colorPickerPos.left}px`,
                        backgroundColor: 'white',
                        borderRadius: '16px',
                        padding: '10px',
                        display: 'flex',
                        gap: '8px',
                        boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
                        zIndex: 50,
                        whiteSpace: 'nowrap'
                      }}>
                        {COLOR_PALETTE.filter(c => c.id !== 'default' && c.id !== 'yellow').map(c => (
                          <button
                            key={c.id}
                            className={`color-swatch ${newKeywordColor === c.id ? 'selected' : ''}`}
                            onClick={() => {
                              setNewKeywordColor(c.id);
                              setShowKeywordColorPicker(false);
                            }}
                            style={{
                              width: '28px',
                              height: '28px',
                              backgroundColor: c.bg,
                              borderColor: COLOR_BORDER[c.id],
                              padding: 0
                            }}
                          />
                        ))}
                      </div>
                    )}
                  </div>

                  {/* 우측: 입력 및 버튼 */}
                  <div style={{ flex: 1, display: 'flex', gap: '6px' }}>
                    <input
                      type="text"
                      className="input-field"
                      placeholder="키워드 추가"
                      value={newKeyword}
                      onChange={e => setNewKeyword(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addHabitKeyword(); } }}
                      style={{ borderRadius: '8px', fontSize: '0.85rem', padding: '8px 12px', flex: 1 }}
                    />
                    <button className="btn-save keyword-add-btn" onClick={addHabitKeyword} disabled={!newKeyword.trim()} style={{ width: '36px', height: '32px', padding: 0, backgroundColor: '#7090ff' }}>
                      <Plus size={14} />
                    </button>
                  </div>
                </div>
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
                  {currentUser.providerData[0]?.providerId === 'password' && (
                    <button className="btn-cancel logout-action-btn" onClick={() => setShowPasswordChange(true)}>
                      비밀번호 변경
                    </button>
                  )}
                  <button className="btn-cancel logout-action-btn" onClick={async () => { if (window.confirm('로그아웃 하시겠습니까?')) { await signOut(auth); setActiveView('timeline'); } }}>
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
            autoFocus
          />
          <button className="send-btn" onClick={handleAddMemo} disabled={!inputText.trim()}>
            <Send size={18} />
          </button>
        </div>
      )}

      {/* 스케줄 상세 바텀시트 */}
      {selectedSchedule && showScheduleView && (
        <div className="schedule-detail-overlay" onClick={() => setSelectedSchedule(null)}>
          <div className="schedule-detail-sheet" onClick={e => e.stopPropagation()}>
            <div className="schedule-detail-header">
              <h3>{selectedSchedule.content}</h3>
              <button className="schedule-detail-close" onClick={() => setSelectedSchedule(null)}>×</button>
            </div>
            <div className="schedule-detail-time-edit">
              <div className="time-input-group">
                <label>시작 시간</label>
                <div className="time-input-row">
                  <input
                    type="number"
                    min="0"
                    max="23"
                    value={editStartHour || selectedSchedule.startHour}
                    onChange={e => setEditStartHour(parseInt(e.target.value))}
                    className="time-input"
                    placeholder="시"
                  />
                  <span>:</span>
                  <input
                    type="number"
                    min="0"
                    max="59"
                    value={editStartMin || selectedSchedule.startMin}
                    onChange={e => setEditStartMin(parseInt(e.target.value))}
                    className="time-input"
                    placeholder="분"
                  />
                </div>
              </div>
              <div className="time-input-group">
                <label>종료 시간</label>
                <div className="time-input-row">
                  <input
                    type="number"
                    min="0"
                    max="23"
                    value={editEndHour || selectedSchedule.endHour}
                    onChange={e => setEditEndHour(parseInt(e.target.value))}
                    className="time-input"
                    placeholder="시"
                  />
                  <span>:</span>
                  <input
                    type="number"
                    min="0"
                    max="59"
                    value={editEndMin || selectedSchedule.endMin}
                    onChange={e => setEditEndMin(parseInt(e.target.value))}
                    className="time-input"
                    placeholder="분"
                  />
                </div>
              </div>
              <div className="schedule-detail-actions">
                <button className="btn-save" onClick={async () => {
                  const startMemo = memos.find(m => m.id === selectedSchedule.startMemoId);
                  if (startMemo) {
                    const newStartTime = new Date(startMemo.recordedAt);
                    newStartTime.setHours(editStartHour !== '' ? editStartHour : selectedSchedule.startHour);
                    newStartTime.setMinutes(editStartMin !== '' ? editStartMin : selectedSchedule.startMin);
                    await updateDoc(doc(db, 'memos', startMemo.id), { recordedAt: newStartTime });
                  }
                  setSelectedSchedule(null);
                  setEditStartHour('');
                  setEditStartMin('');
                  setEditEndHour('');
                  setEditEndMin('');
                }}>저장</button>
                <button className="btn-cancel" onClick={() => {
                  setSelectedSchedule(null);
                  setEditStartHour('');
                  setEditStartMin('');
                  setEditEndHour('');
                  setEditEndMin('');
                }}>취소</button>
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

      {/* Day Detail Modal */}
      {selectedDayModal && (
        <div className="modal-overlay" onClick={() => setSelectedDayModal(null)}>
          <div className="modal-content" onClick={e => e.stopPropagation()} style={{ maxWidth: '420px', maxHeight: '80vh', overflowY: 'auto', position: 'relative' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <h3 className="modal-title" style={{ margin: 0 }}>{format(selectedDayModal, 'M월 d일 (E)', { locale: ko })}</h3>
              <button
                onClick={() => setSelectedDayModal(null)}
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: '1.5rem',
                  color: '#999',
                  padding: '0 4px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center'
                }}
              >
                <X size={20} />
              </button>
            </div>

            {(() => {
              const dateKey = format(selectedDayModal, 'yyyy-MM-dd');
              const dayData = monthlyData[dateKey];
              const dayMemos = memos.filter(m => isSameDay(new Date(m.recordedAt), selectedDayModal));

              return (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0' }}>
                  {/* 습관 & 메모 섹션 (그룹화) */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', marginBottom: '24px' }}>
                    {dayData && dayData.habits.map(habit => {
                      const relatedMemos = dayMemos.filter(m => m.content.includes(habit.name));
                      const textColors = { purple: '#6b21a8', blue: '#1e40af', green: '#15803d', pink: '#be185d', orange: '#9a3412' };

                      return (
                        <div key={habit.name}>
                          {/* 습관 태그 */}
                          <div style={{ marginBottom: '8px' }}>
                            <span
                              style={{
                                backgroundColor: `var(--habit-${habit.color})`,
                                color: textColors[habit.color] || '#000',
                                padding: '4px 12px',
                                borderRadius: '12px',
                                fontSize: '0.8rem',
                                fontWeight: '600',
                                display: 'inline-block'
                              }}
                            >
                              {habit.name}
                            </span>
                          </div>

                          {/* 관련 메모 */}
                          {relatedMemos.length > 0 && (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                              {relatedMemos.map(memo => (
                                <div
                                  key={memo.id}
                                  style={{
                                    backgroundColor: COLOR_PALETTE.find(c => c.id === (memo.color || 'default'))?.bg || '#f9f9fb',
                                    padding: '10px 12px',
                                    borderRadius: '8px',
                                    fontSize: '0.85rem',
                                    lineHeight: '1.4',
                                    color: '#333'
                                  }}
                                >
                                  <div style={{ fontSize: '0.7rem', color: '#999', marginBottom: '4px' }}>
                                    {format(new Date(memo.recordedAt), 'aa h:mm', { locale: ko })}
                                  </div>
                                  <div>{memo.content}</div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}

                    {dayData && dayData.habits.length === 0 && dayMemos.length === 0 && (
                      <div style={{ textAlign: 'center', color: '#999', fontSize: '0.9rem', padding: '20px 0' }}>
                        기록된 습관이 없습니다.
                      </div>
                    )}
                  </div>

                  {/* 수입/지출 섹션 */}
                  {dayData && (dayData.income > 0 || dayData.expense > 0) && (
                    <div style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '8px',
                      paddingTop: '16px',
                      borderTop: '1px solid #f0f0f0'
                    }}>
                      {dayData.income > 0 && (
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.9rem' }}>
                          <span style={{ color: '#666' }}>수입</span>
                          <span style={{ color: '#2563eb', fontWeight: '600' }}>+{dayData.income.toLocaleString()}</span>
                        </div>
                      )}
                      {dayData.expense > 0 && (
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.9rem' }}>
                          <span style={{ color: '#666' }}>지출</span>
                          <span style={{ color: '#dc2626', fontWeight: '600' }}>-{dayData.expense.toLocaleString()}</span>
                        </div>
                      )}
                    </div>
                  )}

                  {(!dayData || (dayData.income === 0 && dayData.expense === 0 && dayData.habits.length === 0)) && dayMemos.length === 0 && (
                    <div style={{ textAlign: 'center', color: '#999', fontSize: '0.9rem', padding: '20px 0' }}>
                      이 날짜에 기록된 내용이 없습니다.
                    </div>
                  )}

                  <button
                    className="btn-save"
                    onClick={() => setSelectedDayModal(null)}
                    style={{ marginTop: '24px' }}
                  >
                    닫기
                  </button>
                </div>
              );
            })()}
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

      {/* My Page Modal */}
      {showMyPage && currentUser && (
        <div className="modal-overlay mypage-overlay" onClick={() => setShowMyPage(false)}>
          <div className="mypage-content" onClick={e => e.stopPropagation()}>
            <div className="mypage-header">
              <h2>마이페이지</h2>
              <button className="mypage-close-btn" onClick={() => setShowMyPage(false)}><X size={20} /></button>
            </div>
            <div className="mypage-scrollable">
              {/* Profile Card */}
              <div className="mypage-card profile-card">
                <div className="profile-avatar">
                  {currentUser.photoURL ? (
                    <img src={currentUser.photoURL} alt="Avatar" className="user-photo" />
                  ) : (
                    <div className="avatar-placeholder"><User size={28} /></div>
                  )}
                </div>
                <div className="profile-info">
                  <span className="profile-email">{currentUser.email}</span>
                  <span className="profile-provider-badge">
                    {currentUser.providerData[0]?.providerId === 'google.com' ? '구글 로그인 계정' : '이메일 가입 계정'}
                  </span>
                </div>
              </div>

              {/* 습관 키워드 설정 */}
              <div className="mypage-card">
                <div className="card-header-icon">
                  <Tag size={18} style={{ color: 'var(--primary-color)' }} />
                  <h3>먼슬리 습관 키워드</h3>
                </div>
                <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '12px', lineHeight: 1.5 }}>
                  메모에 아래 단어가 포함되면 먼슬리 달력에 자동으로 표시됩니다.
                </p>
                <div className="keyword-list">
                  {habitKeywords.map(kw => (
                    <div key={kw.name} className="keyword-chip" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <div style={{ width: '12px', height: '12px', borderRadius: '50%', backgroundColor: `var(--habit-${kw.color})`, flexShrink: 0 }} />
                      <span>{kw.name}</span>
                      <button
                        onClick={() => removeHabitKeyword(kw.name)}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px', color: '#999' }}
                      >
                        <X size={12} />
                      </button>
                    </div>
                  ))}
                  {habitKeywords.length === 0 && (
                    <span style={{ fontSize: '0.8rem', color: '#aaa' }}>등록된 키워드가 없습니다</span>
                  )}
                </div>
                <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-end' }}>
                  {/* 좌측: 컬러 선택 */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    <span style={{ fontSize: '0.8rem', color: '#666' }}>컬러</span>
                    <div style={{ display: 'flex', gap: '6px' }}>
                      {['purple', 'blue', 'green', 'pink', 'orange'].map(color => (
                        <button
                          key={color}
                          onClick={() => setNewKeywordColor(color)}
                          style={{
                            width: '28px',
                            height: '28px',
                            borderRadius: '50%',
                            backgroundColor: `var(--habit-${color})`,
                            border: newKeywordColor === color ? '3px solid #333' : '2px solid #ccc',
                            cursor: 'pointer',
                            transition: 'border 0.2s',
                            padding: 0
                          }}
                        />
                      ))}
                    </div>
                  </div>

                  {/* 우측: 입력 및 버튼 */}
                  <div style={{ flex: 1, display: 'flex', gap: '8px' }}>
                    <input
                      type="text"
                      className="input-field"
                      placeholder="키워드 추가"
                      value={newKeyword}
                      onChange={e => setNewKeyword(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addHabitKeyword(); } }}
                      style={{ borderRadius: '10px', fontSize: '0.9rem', padding: '10px 14px', flex: 1 }}
                    />
                    <button className="btn-save keyword-add-btn" onClick={addHabitKeyword} style={{ width: '44px' }}>
                      <Plus size={16} />
                    </button>
                  </div>
                </div>
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

              {/* Danger Zone */}
              <div className="mypage-card danger-zone-card">
                <div className="card-header-icon">
                  <ShieldAlert size={18} className="danger-icon" />
                  <h3>계정 및 보안</h3>
                </div>
                <div className="danger-zone-actions">
                  <button className="btn-cancel logout-action-btn" onClick={async () => { if (window.confirm('로그아웃 하시겠습니까?')) { await signOut(auth); setShowMyPage(false); } }}>
                    로그아웃
                  </button>
                  <button className="btn-cancel delete-account-btn" onClick={handleDeleteAccount} disabled={deletingAccount}>
                    {deletingAccount ? '회원탈퇴 진행 중...' : '회원탈퇴'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
