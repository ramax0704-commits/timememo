// 처음 온 사람이 링크를 열었을 때 맨 먼저 보는 화면.
//
// 바로 투어가 시작되면 당황스럽다. 무슨 앱인지 한 줄로 말하고, 구글로 시작할지
// 로그인 없이 써볼지 고르게 한 뒤에 투어로 넘어간다.
// 가운데에는 채팅 기록이 하나씩 쌓이는 모습을 끝없이 보여준다 — 이 앱이 뭔지 말보다 먼저 보이게.
import { useEffect, useState } from 'react';

const SAMPLES = [
  ['08:40', '아침 스트레칭하고 커피'],
  ['09:30', '카페에서 기획서 초안 작성'],
  ['11:10', '기획서 1차 완료, 드디어 끝'],
  ['13:20', '점심 먹고 산책. 햇빛 좋았다'],
  ['15:00', '팀 회의, 다음 주 일정 정리'],
  ['18:30', '헬스장 가서 운동'],
  ['20:10', '저녁 먹고 책 조금'],
];
const VISIBLE = 3;      // 동시에 보이는 말풍선 수
const ROW = 46;         // 한 줄 높이(px) — 말풍선은 한 줄짜리
const TICK_MS = 1500;

function ChatLoop() {
  // 최근 것부터 0,1,2… 인덱스. 3개를 넘긴 것은 위로 밀려나며 사라진다.
  const [items, setItems] = useState(() => [{ id: 0, sample: SAMPLES[0] }]);
  useEffect(() => {
    let n = 1;
    const id = setInterval(() => {
      setItems(prev => [{ id: n, sample: SAMPLES[n % SAMPLES.length] }, ...prev].slice(0, VISIBLE + 1));
      n += 1;
    }, TICK_MS);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="splash-chat" style={{ height: ROW * VISIBLE }} aria-hidden="true">
      {items.map((it, i) => (
        <div
          key={it.id}
          className={`splash-chat-row${i >= VISIBLE ? ' splash-chat-row--out' : ''}`}
          style={{ transform: `translateY(${-i * ROW}px)` }}
        >
          <span className="splash-chat-time">{it.sample[0]}</span>
          <span className="splash-chat-bubble">{it.sample[1]}</span>
        </div>
      ))}
    </div>
  );
}

export default function Splash({ onGoogle, onGuest }) {
  return (
    <div className="splash" role="dialog" aria-label="타임메모 시작">
      <div className="splash-body">
        <div className="splash-brand">타임메모</div>
        <h1 className="splash-title">
          순간의 기록을 모아 간편하게<br />하루 일기를 작성해보세요
        </h1>
        <p className="splash-desc">지금 하는 일을 한 줄씩 보내면, 하루가 시간 위에 놓이고 회고가 남아요.</p>
        <ChatLoop />
      </div>
      <div className="splash-actions">
        <button type="button" className="splash-btn splash-btn--google" onClick={onGoogle}>
          <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
            <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.5l6.7-6.7C35.6 2.5 30.2 0 24 0 14.6 0 6.5 5.4 2.6 13.3l7.8 6C12.3 13.6 17.7 9.5 24 9.5z" />
            <path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8c4.4-4 7.1-10 7.1-17.5z" />
            <path fill="#FBBC05" d="M10.4 28.7c-.5-1.5-.8-3-.8-4.7s.3-3.2.8-4.7l-7.8-6C1 16.3 0 20 0 24s1 7.7 2.6 10.7l7.8-6z" />
            <path fill="#34A853" d="M24 48c6.2 0 11.5-2 15.4-5.6l-7.5-5.8c-2.1 1.4-4.8 2.3-7.9 2.3-6.3 0-11.7-4.1-13.6-9.8l-7.8 6C6.5 42.6 14.6 48 24 48z" />
          </svg>
          구글로 로그인하기
        </button>
        <button type="button" className="splash-btn splash-btn--guest" onClick={onGuest}>
          로그인 없이 이용하기
        </button>
      </div>
    </div>
  );
}
