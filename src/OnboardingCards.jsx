// 스플래시 뒤에 나오는 카드 슬라이드 온보딩 (3장).
//
// 예전엔 스플래시가 끝나면 바로 "지금 한 일을 적어보세요"로 들어갔는데,
// 앱이 뭘 해주는지 모른 채 입력부터 시키니 따라오지 않았다.
// 카드 한 장에 한 문장: 한 줄 남기면 → 오늘 회고 / 한 주 → 요일별 한 줄 / 한 달 → 토끼 달력.
// 그림은 이미지가 아니라 실제 화면 조각(OnboardingSamples)을 렌더한다.
import { useRef, useState } from 'react';
import { SampleChat, SampleRabbitCompact, SampleWeekList, SampleMonthly } from './OnboardingSamples';

const CARDS = [
  {
    key: 'today',
    title: '한 줄씩 남기면',
    line: '오늘 회고가 만들어져요',
    art: (
      <div className="ob-card-art">
        <SampleChat />
        <div className="ob-arrow" aria-hidden="true">↓</div>
        <SampleRabbitCompact type="burrow_together" />
      </div>
    ),
  },
  {
    key: 'week',
    title: '한 주가 지나면',
    line: '요일별로 하루가 한 줄씩 정리돼요',
    art: <div className="ob-card-art"><SampleWeekList /></div>,
  },
  {
    key: 'month',
    title: '한 달이 쌓이면',
    line: '매일의 토끼가 달력에 모여요',
    art: <div className="ob-card-art"><SampleMonthly compact /></div>,
  },
];

export default function OnboardingCards({ cards = CARDS, doneLabel = '시작하기', onDone, onSkip }) {
  const CARDS_ = cards;
  const [idx, setIdx] = useState(0);
  const touch = useRef(null);
  const last = idx === CARDS_.length - 1;

  const go = (n) => setIdx(Math.max(0, Math.min(CARDS_.length - 1, n)));
  const onPointerDown = (e) => { touch.current = { x: e.clientX, y: e.clientY }; };
  const onPointerUp = (e) => {
    const t = touch.current; touch.current = null;
    if (!t) return;
    const dx = e.clientX - t.x, dy = e.clientY - t.y;
    if (Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(dy) * 1.2) return;
    go(dx < 0 ? idx + 1 : idx - 1);
  };

  return (
    <div className="ob" role="dialog" aria-label="타임메모 소개">
      <button type="button" className="ob-skip" onClick={onSkip}>건너뛰기</button>
      <div className="ob-track" onPointerDown={onPointerDown} onPointerUp={onPointerUp} onPointerCancel={() => { touch.current = null; }}>
        <div className="ob-slides" style={{ transform: `translateX(-${idx * 100}%)` }}>
          {CARDS_.map(c => (
            <section key={c.key} className="ob-card">
              {c.art}
              <h2 className="ob-title">{c.title}</h2>
              <p className="ob-line">{c.line}</p>
            </section>
          ))}
        </div>
      </div>
      <div className="ob-foot">
        <div className="ob-dots" aria-hidden="true">
          {CARDS_.map((c, i) => <span key={c.key} className={`ob-dot${i === idx ? ' ob-dot--on' : ''}`} />)}
        </div>
        <button type="button" className="ob-next" onClick={() => (last ? onDone() : go(idx + 1))}>
          {last ? doneLabel : '다음'}
        </button>
      </div>
    </div>
  );
}
