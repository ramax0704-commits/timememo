// 채팅창 위에 붙는 얇은 띠 — "오늘 지금까지의 모양".
//
// 기록이 하나라도 있으면 보인다. 마무리가 아니라 '아직 채워지는 중'이라는 톤이라
// 다음 기록을 부르고, 누르면 회고 탭으로 간다. 채팅창 안에는 아무것도 얹지 않는다.
// 작은 리듬 곡선은 회고 탭의 곡선과 같은 데이터(0~24시)를 축소한 것이다.
import { ChevronRight } from 'lucide-react';
import { formatAgo } from './daySummary';

const W = 100;
const H = 24;

function miniPath(points) {
  if (!points || points.length < 2) return '';
  const pts = points.map(p => [(p.t / 1440) * W, H - 2 - p.y * (H - 5)]);
  let d = `M ${pts[0][0]} ${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i - 1] ?? pts[i];
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[i + 1];
    const [x3, y3] = pts[i + 2] ?? pts[i + 1];
    d += ` C ${(x1 + (x2 - x0) / 6).toFixed(1)} ${(y1 + (y2 - y0) / 6).toFixed(1)}, ${(x2 - (x3 - x1) / 6).toFixed(1)} ${(y2 - (y3 - y1) / 6).toFixed(1)}, ${x2.toFixed(1)} ${y2.toFixed(1)}`;
  }
  return d;
}

export default function DayShapeStrip({ facts, now, onClick }) {
  if (!facts) return null;
  const { count, lastAt, curve } = facts;
  const line = curve?.hasData ? miniPath(curve.points) : '';

  return (
    <button type="button" className="day-strip" onClick={onClick} aria-label="오늘의 모양 보기">
      <svg className="day-strip-curve" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
        {line && <path d={`${line} L ${W} ${H} L 0 ${H} Z`} className="day-strip-curve-fill" />}
        {line && <path d={line} className="day-strip-curve-line" vectorEffect="non-scaling-stroke" />}
      </svg>
      <div className="day-strip-text">
        <strong>오늘 기록 {count}개</strong>
        <span>마지막 {formatAgo(lastAt, now)}</span>
      </div>
      <ChevronRight size={16} className="day-strip-chevron" />
    </button>
  );
}
