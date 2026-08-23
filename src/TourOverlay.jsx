// 직접 눌러보는 온보딩(투어)의 '보이는 부분'.
//
// 딤은 없다. 누를 곳만 컬러 그림자로 빛나고, 말풍선이 그 바로 옆에 붙어 "이걸 하라"고 말한다.
// 사용자가 실제로 그곳을 탭/드래그하면 앱이 평소대로 동작하고, 투어는 다음 단계로 넘어간다.
// 화면을 깨끗하게 보여주는 단계(free)는 아무것도 막지 않고 말풍선과 [다음]만 둔다.
//
// props
//   step: {
//     key, target(selector|null), caption, pointer: 'tap' | 'drag-up' | null,
//     advance: 'tap-target' | 'send' | 'button' | 'auto',
//     place: 'above' | 'below' | 'bottom',   — 말풍선 자리 (대상 위 / 대상 아래 / 화면 아래쪽)
//     free?: boolean (아무것도 막지 않음), offset?: number (말풍선을 더 띄울 px), effect?: 'pop', final?: boolean
//     advance 'wait' = 투어 밖(앱 동작)이 단계를 넘긴다
//   }
//   index(포인터 애니메이션 리셋용), containerRef(.app-container), onTargetTap, onNext, onFinish
//   settleMs?: 이 시간 전에 잰 자리는 쓰지 않는다 (스크롤이 끝난 뒤에 포인터를 보여준다)
import { useEffect, useLayoutEffect, useState } from 'react';

const BUBBLE_MAX_W = 320;
const EDGE = 12;

function rectIn(container, el) {
  if (!container || !el) return null;
  const c = container.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  // 대상의 모서리 모양을 그대로 따라간다 (둥근 버튼은 둥글게, 각진 탭은 각지게)
  const radius = parseFloat(getComputedStyle(el).borderRadius) || 0;
  return { left: r.left - c.left, top: r.top - c.top, width: r.width, height: r.height, radius };
}

export default function TourOverlay({ step, index, containerRef, onTargetTap, onNext, onFinish }) {
  const [rect, setRect] = useState(null);

  // 대상 요소의 자리를 잰다. 화면이 바뀐 직후(탭 전환·스크롤)에도 맞도록 잠깐 뒤 몇 번 더 잰다.
  // settleMs가 있는 단계는 그 시간이 지나기 전 값은 '아직 자리 잡는 중'으로 표시해 포인터를 숨긴다.
  useLayoutEffect(() => {
    const startedAt = Date.now();
    const settle = step.settleMs ?? 0;
    const measure = () => {
      const el = step.target ? containerRef.current?.querySelector(step.target) : null;
      const r = rectIn(containerRef.current, el);
      setRect(r ? { ...r, settled: Date.now() - startedAt >= settle } : null);
    };
    measure();
    const timers = [200, 600, 1200, settle + 60].map(ms => setTimeout(measure, ms));
    window.addEventListener('resize', measure);
    return () => { timers.forEach(clearTimeout); window.removeEventListener('resize', measure); };
  }, [step, containerRef]);

  // 사용자가 밝혀진 곳을 실제로 눌렀는지 — 캡처 단계에서 듣고, 앱의 원래 동작은 그대로 둔다
  useEffect(() => {
    if (step.advance !== 'tap-target' || !step.target) return;
    const root = containerRef.current;
    if (!root) return;
    const onClick = (e) => {
      if (e.target?.closest?.(step.target)) onTargetTap?.();
    };
    root.addEventListener('click', onClick, true);
    return () => root.removeEventListener('click', onClick, true);
  }, [step, containerRef, onTargetTap]);

  const W = containerRef.current?.clientWidth ?? 0;
  const H = containerRef.current?.clientHeight ?? 0;
  const pad = 4;
  const spot = rect && rect.settled
    ? { left: rect.left - pad, top: rect.top - pad, width: rect.width + pad * 2, height: rect.height + pad * 2, radius: rect.radius + pad }
    : null;
  const pointerStyle = spot ? { left: spot.left + spot.width / 2, top: spot.top + spot.height / 2 } : null;

  // 대상 말고는 못 누르게, 구멍 둘레를 네 장(투명)으로 막는다. free 단계는 아무것도 막지 않는다.
  const blocks = step.free
    ? []
    : spot
      ? [
        { left: 0, top: 0, width: W, height: Math.max(0, spot.top) },
        { left: 0, top: spot.top + spot.height, width: W, height: Math.max(0, H - spot.top - spot.height) },
        { left: 0, top: spot.top, width: Math.max(0, spot.left), height: spot.height },
        { left: spot.left + spot.width, top: spot.top, width: Math.max(0, W - spot.left - spot.width), height: spot.height },
      ]
      : [{ left: 0, top: 0, width: W, height: H }];

  // 말풍선 자리: 대상 가운데를 향해 꼬리를 두고, 화면 밖으로 나가지 않게 좌우를 잡는다
  const bubbleW = Math.min(BUBBLE_MAX_W, W - EDGE * 2);
  let bubbleStyle;
  let tail = null; // 'down' | 'up' | null
  let tailX = bubbleW / 2;
  const place = step.place ?? (spot ? 'above' : 'bottom');
  if (spot && (place === 'above' || place === 'below')) {
    const cx = spot.left + spot.width / 2;
    const left = Math.max(EDGE, Math.min(cx - bubbleW / 2, W - EDGE - bubbleW));
    tailX = cx - left;
    if (place === 'above') {
      bubbleStyle = { left, width: bubbleW, bottom: H - spot.top + 10 + (step.offset ?? 0) };
      tail = 'down';
    } else {
      bubbleStyle = { left, width: bubbleW, top: spot.top + spot.height + 10 };
      tail = 'up';
    }
  } else {
    // 대상이 없으면 탭바 위쪽에 가운데로
    bubbleStyle = { left: (W - bubbleW) / 2, width: bubbleW, bottom: 96 };
  }

  // 대상이 있는 단계인데 아직 자리를 못 쟀거나(스크롤 중) 자리 잡히기 전이면 아무것도 보여주지 않는다.
  // (기본 자리에 먼저 떴다가 옮겨가면 "엉뚱한 데로 갔다 온다"로 보인다)
  const ready = !step.target || (rect && rect.settled);
  if (!ready) {
    return (
      <div className="tour" aria-live="polite">
        {!step.free && <div className="tour-block" style={{ left: 0, top: 0, width: W, height: H }} />}
      </div>
    );
  }

  return (
    <div className="tour" aria-live="polite">
      {blocks.map((b, i) => <div key={i} className="tour-block" style={b} />)}
      {spot && (
        <div
          key={`spot-${index}`}
          className={`tour-spot${step.free ? '' : ' tour-spot--dim'}${step.effect === 'pop' ? ' tour-spot--pop' : ''}`}
          style={{ left: spot.left, top: spot.top, width: spot.width, height: spot.height, borderRadius: spot.radius }}
        />
      )}

      {pointerStyle && step.pointer && (
        <div key={index} className={`tour-pointer tour-pointer--${step.pointer}`} style={pointerStyle} aria-hidden="true" />
      )}

      <div
        className={`tour-bubble${tail ? ` tour-bubble--tail-${tail}` : ''}${step.final ? ' tour-bubble--final' : ''}`}
        style={{ ...bubbleStyle, '--tail-x': `${tailX}px` }}
      >
        <p>{step.caption}</p>
        {(step.final || step.advance === 'button') && (
          <div className="tour-bubble-foot">
            {step.final ? (
              <button type="button" className="tour-btn" onClick={onFinish}>직접 써볼게요</button>
            ) : (
              <button type="button" className="tour-btn tour-btn--small" onClick={onNext}>다음</button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
