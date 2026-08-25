// 기본 진입점('mixpanel-browser')은 세션 다시보기용 rrweb 녹화 엔진까지 통째로 안고 있어
// 번들이 400kB 넘게 불어난다. 녹화를 안 쓰므로 그게 빠진 core 빌드를 직접 가리킨다.
// (세션 다시보기를 켤 일이 생기면 'mixpanel-browser/dist/mixpanel-with-async-recorder.cjs.js'로
//  바꾸면 녹화 엔진을 필요할 때만 따로 내려받는다)
import mixpanel from 'mixpanel-browser/dist/mixpanel-core.cjs.js';

const token = import.meta.env.VITE_MIXPANEL_TOKEN;

// 토큰이 없으면 조용히 꺼둔다.
// Supabase와 달리 분석 도구는 없어도 앱이 돌아가야 하므로 alert를 띄우지 않는다.
// 로컬 개발(npm run dev) 중에는 아예 보내지 않는다 — 개발하며 누른 클릭이
// 전부 실제 사용자 행동으로 집계돼 지표를 오염시키는 걸 8/20 분석에서 확인했다.
export const analyticsEnabled = Boolean(token) && !import.meta.env.DEV;

// 테스트 전용 계정. 이 계정으로 한 번이라도 로그인한 기기는
// 이후 로그아웃해도 영구히 집계에서 뺀다 (opt-out이 기기 로컬에 저장됨).
// 본인 실사용 계정(ramax)은 사용자 결정으로 집계에 포함한다 — 로컬 개발 오염은
// 위의 DEV 차단이 막고, 실사용 행동은 진짜 사용으로 보기로 함 (2026-08-20).
const INTERNAL_USER_IDS = new Set([
  '9f4963ae-5285-4ff0-b918-4f86c920c6f2', // 미섬촌장 (테스트 전용)
]);

if (analyticsEnabled) {
  mixpanel.init(token, {
    // 클릭·페이지뷰를 Mixpanel이 알아서 주워담는다
    autocapture: true,

    // 세션 다시보기(화면 녹화)는 끈 상태. 0 = 녹화 안 함
    // 켜려면 이 값을 10(=10%)이나 100(=전부)으로 올리면 된다.
    // 참고: 켜더라도 Mixpanel은 기본값으로 화면의 모든 글자와 입력값을 가려서 녹화한다
    // (record_mask_all_text / record_mask_all_inputs 가 기본 true)
    record_sessions_percent: 0,

    // 개인 기록 앱이라 IP 기반 위치 수집은 받지 않는다
    ip: false,

    // 기기 id를 쿠키가 아니라 localStorage에 보관한다.
    // 사파리(ITP)가 스크립트로 만든 쿠키를 7일이면 지워서, 일주일 넘어 재방문한
    // 사람이 새 기기로 쪼개졌다 — 8/25 온보딩 퍼널 조사에서 확인 (스플래시를 본
    // 옛 id와 투어를 돈 새 id가 이어지지 않아 퍼널이 0%로 나왔다).
    // 앱 자체 키(온보딩 완료 등)도 localStorage라 수명이 같아진다.
    persistence: 'localStorage',

    // 로컬 개발 중일 때만 콘솔에 전송 내역을 찍어준다
    debug: import.meta.env.DEV,
  });
  // 프리뷰(timememo-preview 등)에서 테스트한 이벤트가 실사용 지표에 섞이지 않게,
  // 모든 이벤트에 환경을 달아 보낸다. 리포트에서 env ≠ preview로 거른다.
  // (프리뷰에서도 전송은 한다 — 배포 전 계측 검증이 가능해야 하므로 끄지 않는다)
  try {
    mixpanel.register({ env: window.location.hostname === 'timememo-hazel.vercel.app' ? 'production' : 'preview' });
  } catch { /* 무시 */ }
}

// 절대 보내지 않는 것: 메모 내용, 할 일 내용, 키워드 이름, 이메일.
// 개인 기록 앱이라 '무엇을 썼는지'는 남기지 않고 '무엇을 했는지'만 남긴다.
// 길이·개수·참/거짓처럼 되돌릴 수 없는 형태로만 보낸다.

// 앱 어디서든 이걸로 이벤트를 보낸다.
// 토큰이 없거나 초기화 전이어도 그냥 넘어가도록 감싸둠 — 분석 때문에 앱이 죽으면 안 된다
export function track(event, props) {
  if (!analyticsEnabled) return;
  try {
    mixpanel.track(event, props);
  } catch {
    // 광고 차단기 등으로 전송이 막혀도 무시
  }
}

// 같은 사람이 폰과 노트북에서 써도 한 명으로 묶어준다.
// 이게 없으면 기기마다 딴 사람으로 잡혀서 재방문·이탈을 아예 측정할 수 없다.
export function identifyUser(user) {
  if (!analyticsEnabled || !user?.id) return;
  try {
    // 내부 계정이면 이 기기를 통째로 집계 제외. identify보다 먼저 해야
    // 이번 세션 이벤트도 안 나간다.
    if (INTERNAL_USER_IDS.has(user.id)) {
      mixpanel.opt_out_tracking();
      return;
    }
    mixpanel.identify(user.id);
    // 이메일은 보내지 않는다. 가입일과 로그인 수단만 있으면 코호트 분석은 충분하다.
    mixpanel.people.set({
      가입일: user.created_at,
      로그인수단: user.app_metadata?.provider || 'email',
    });
  } catch {
    // 무시
  }
}

// 이 사람이 '처음으로' 기록을 남긴 시각. set_once라 두 번째부터는 무시된다.
// 가입일(identifyUser에서 넣음)과 짝지으면 "가입하고 얼마 만에 첫 기록을 썼나"가
// 사람별로 나오고, Mixpanel에서 그 값으로 코호트를 자를 수 있다.
//
// 로그인한 사람에게만 남긴다. 체험 중에는 distinct_id가 기기마다 새로 생기는
// 익명값이라, 여기 프로필을 만들면 같은 사람이 여러 명으로 쌓이고 지워지지도 않는다.
export function markFirstMemo() {
  if (!analyticsEnabled) return;
  try {
    mixpanel.people.set_once({ '첫 기록 시각': new Date().toISOString() });
  } catch {
    // 무시
  }
}

// 로그아웃 시 호출. 다음 사람의 행동이 앞사람에게 붙는 걸 막는다.
export function resetUser() {
  if (!analyticsEnabled) return;
  try {
    mixpanel.reset();
  } catch {
    // 무시
  }
}

// ── 마지막 방문 일자 ─────────────────────────────────────────
// 재방문(특히 '첫 기록 다음날 다시 왔나')을 Mixpanel 밖에서도 셀 수 있게 기기에 남긴다.
// 날짜만 저장한다 (yyyy-MM-dd, 기기 로컬 기준). 분석이 꺼져 있어도 기록은 해둔다.
const LAST_VISIT_KEY = 'timememo-last-visit';

function localDateKey(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function noteVisit() {
  const today = localDateKey(new Date());
  let last = null;
  try {
    last = localStorage.getItem(LAST_VISIT_KEY);
    localStorage.setItem(LAST_VISIT_KEY, today);
  } catch {
    // 저장이 막힌 환경이면 첫 방문처럼 취급한다
  }
  let daysSince = null;
  if (last && /^\d{4}-\d{2}-\d{2}$/.test(last)) {
    const [y, m, d] = last.split('-').map(Number);
    const [ty, tm, td] = today.split('-').map(Number);
    daysSince = Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(y, m - 1, d)) / 86400000);
  }
  return {
    last_visit_date: last,
    // null = 이 기기에서 처음. 0 = 오늘 이미 왔었음. 1 = 어제 왔음(다음날 재방문).
    days_since_last_visit: daysSince,
    is_return_visit: daysSince !== null && daysSince >= 1,
    is_next_day_return: daysSince === 1,
  };
}

// 앱이 한 번 열릴 때마다 1회. '마지막 접속일'과 재방문율은 Mixpanel이 이 이벤트로 계산한다.
// 여기에 기기 로컬로 센 마지막 방문 일자를 함께 싣는다 (비로그인도 같은 기기면 잡힌다).
const visit = noteVisit();
if (analyticsEnabled) {
  track('App Opened', visit);
}

export default mixpanel;
