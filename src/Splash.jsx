// 처음 온 사람이 링크를 열었을 때 맨 먼저 보는 화면.
//
// 버튼도 선택지도 없다 — 브랜드와 한 줄만 보여주고 홈으로 들여보낸다.
// 로그인은 여기서 묻지 않는다. 기록이 아까워질 때쯤(3개) 보관 안내가 따로 뜬다.
import { useEffect, useState } from 'react';

const SHOW_MS = 2200;   // 문구를 읽을 만큼만
const FADE_MS = 400;    // 사라지는 시간 (CSS transition과 맞춘다)

export default function Splash({ onDone }) {
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    const t1 = setTimeout(() => setLeaving(true), SHOW_MS);
    const t2 = setTimeout(onDone, SHOW_MS + FADE_MS);
    return () => { clearTimeout(t1); clearTimeout(t2); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className={`splash${leaving ? ' splash--leaving' : ''}`} role="dialog" aria-label="타임메모 시작">
      <div className="splash-body">
        <h1 className="splash-title">
          순간의 기록을 모아<br />오늘의 일기로
        </h1>
        <div className="splash-brand">타임메모</div>
      </div>
    </div>
  );
}
