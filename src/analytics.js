// 기본 진입점('mixpanel-browser')은 세션 다시보기용 rrweb 녹화 엔진까지 통째로 안고 있어
// 번들이 400kB 넘게 불어난다. 녹화를 안 쓰므로 그게 빠진 core 빌드를 직접 가리킨다.
// (세션 다시보기를 켤 일이 생기면 'mixpanel-browser/dist/mixpanel-with-async-recorder.cjs.js'로
//  바꾸면 녹화 엔진을 필요할 때만 따로 내려받는다)
import mixpanel from 'mixpanel-browser/dist/mixpanel-core.cjs.js';

const token = import.meta.env.VITE_MIXPANEL_TOKEN;

// 토큰이 없으면 조용히 꺼둔다.
// Supabase와 달리 분석 도구는 없어도 앱이 돌아가야 하므로 alert를 띄우지 않는다.
export const analyticsEnabled = Boolean(token);

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

    // 로컬 개발 중일 때만 콘솔에 전송 내역을 찍어준다
    debug: import.meta.env.DEV,
  });
}

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

export default mixpanel;
