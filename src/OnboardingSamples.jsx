// 온보딩(카드 슬라이드·페이지 팁)에서 보여주는 예시 UI 조각.
//
// 이미지 파일 대신 실제 화면 클래스를 그대로 써서 렌더한다 — 에셋이 필요 없고,
// 디자인이 바뀌면 예시도 같이 바뀐다. 전부 정적(눌러도 아무 일 없음).
import { rabbitById } from './rabbits';
import { TalkCurveBlock } from './ReviewScreen';

const SAMPLE_MEMOS = [
  { time: '오전 9:10', text: '운동', dur: '1h 33m' },
  { time: '오후 2:25', text: '저녁은 팀원들과 회식. 곱창전골 먹고 노래방까지' },
  { time: '오후 7:10', text: '미팅 자료 준비 완료. 요구사항 정리 완료', dur: '1h 15m' },
];

// 입력창에 "9시 30분 카페가서 독서함"이라고 적은 모습 (실제 입력 영역과 같은 구성)
export function SampleInput() {
  return (
    <div className="ob-input" aria-hidden="true">
      <div className="ob-input-row">
        <div className="ob-input-box"><span className="ob-input-time">9시 30분</span> 카페가서 독서함</div>
        <span className="ob-input-send">➤</span>
      </div>
      <div className="ob-input-chips"><span>🎨</span><span>↑ 이전 기록부터</span><span>↓ 다음 기록까지</span></div>
    </div>
  );
}

// 팁 하나에 붙는 예시 한 줄 — "시간과 함께" 적은 모습
export function SampleChatOne() {
  return (
    <div className="ob-sample ob-sample--chat ob-sample--one" aria-hidden="true">
      <div className="memo-item">
        <div className="memo-time-container"><span className="memo-time">오전 9:30</span></div>
        <div className="memo-content">밥 먹고 출근</div>
      </div>
      <div className="ob-sample-typed">← "9시 30분 밥 먹고 출근"이라고 적으면 이렇게 남아요</div>
    </div>
  );
}

export function SampleChat() {
  return (
    <div className="ob-sample ob-sample--chat" aria-hidden="true">
      {SAMPLE_MEMOS.map((m, i) => (
        <div key={i} className="memo-item">
          <div className="memo-time-container"><span className="memo-time">{m.time}</span></div>
          <div className="memo-content">
            {m.text}
            {m.dur && <span className="memo-duration">{m.dur}</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

export function SampleRabbitCompact({ type = 'arctic_firm' }) {
  const info = rabbitById(type);
  if (!info) return null;
  return (
    <div className="rabbit-hero rabbit-hero--compact ob-static" aria-hidden="true">
      <img className={`rabbit-photo rabbit-photo--compact${info.art ? ' rabbit-img--art' : ''}`} src={info.image} alt="" />
      <span className="rabbit-hero-text">
        <span className="rabbit-label">오늘의 토끼</span>
        <span className="rabbit-name rabbit-name--compact">{info.name}</span>
        <span className="rabbit-desc rabbit-desc--compact">{info.desc}</span>
      </span>
    </div>
  );
}

// 회고를 만들면 나오는 결과 — 토끼 축약형 + 제목 + 회고 글 + 끝낸 일
export function SampleReview() {
  return (
    <div className="ob-sample ob-sample--review" aria-hidden="true">
      <SampleRabbitCompact type="arctic_firm" />
      <h2 className="reflection-headline">자료 정리 끝내고 회식으로</h2>
      <p className="day-summary-narrative reflection-narrative">
        미팅 자료 준비하고 회의 준비 완료라 적은 뒤, 저녁엔 팀원들과 곱창전골에 노래방까지 이어졌어요.
      </p>
      <div className="reflection-section">
        <div className="reflection-label">오늘 끝낸 일</div>
        <ul className="done-list">
          <li className="done-item">미팅 자료 준비 완료</li>
          <li className="done-item">요구사항 정리 완료</li>
        </ul>
      </div>
    </div>
  );
}

// 회고 전문 — 기록을 넣으면 무엇이 나오는지 한 번에 보여준다 (실제 결과 화면과 같은 블록 구성)
export function SampleReviewFull() {
  return (
    <div className="ob-sample ob-sample--review" aria-hidden="true">
      <SampleRabbitCompact type="burrow_together" />
      <h2 className="reflection-headline">자료 정리 끝내고 회식으로</h2>
      <p className="day-summary-narrative reflection-narrative">
        미팅 자료 준비하고 회의 준비 완료라 적은 뒤, 저녁엔 팀원들과 곱창전골에 노래방까지 이어졌어요. 낮의 정리가 끝나고 나서야 저녁 자리가 시작된 하루였어요.
      </p>
      <div className="reflection-section">
        <div className="reflection-label">사고의 흐름</div>
        <ol className="flow-list">
          <li className="flow-item"><span className="flow-stage">시작</span><span className="flow-text">밥먹고 뒹굴거리다 운동으로 몸을 일으켰어요.</span></li>
          <li className="flow-item"><span className="flow-stage">전환</span><span className="flow-text">팀원들과 회식하며 오랜만에 웃었어요.</span></li>
          <li className="flow-item"><span className="flow-stage">결론</span><span className="flow-text">미팅 자료는 완료했지만 내일 UT가 걱정됐어요.</span></li>
        </ol>
      </div>
      <div className="reflection-section">
        <div className="reflection-label">시도 → 결과</div>
        <ul className="loop-list">
          <li className="loop-item"><span className="loop-from">미팅 자료 정리</span><span className="loop-arrow">→</span><span className="loop-to">회의 준비 완료</span></li>
        </ul>
      </div>
      <div className="reflection-section">
        <div className="reflection-label">오늘 끝낸 일</div>
        <ul className="done-list">
          <li className="done-item">미팅 자료 준비 완료</li>
          <li className="done-item">요구사항 정리 완료</li>
        </ul>
      </div>
      <div className="reflection-section">
        <div className="reflection-label">에너지 단어</div>
        <div className="energy-rows">
          <div className="energy-row"><span className="energy-tag energy-tag--up">활력</span><span>운동 · 웃었다 · 완료</span></div>
          <div className="energy-row"><span className="energy-tag energy-tag--down">소모</span><span>뒹굴거렸다 · 걱정된다</span></div>
        </div>
      </div>
      <div className="reflection-section">
        <div className="reflection-label">오늘을 점화한 단어</div>
        <div className="day-summary-chips">
          {['미팅 자료', '회식', '노래방'].map(k => <span key={k} className="day-summary-chip day-summary-chip--meaning">{k}</span>)}
        </div>
      </div>
    </div>
  );
}

const SAMPLE_WEEK = [
  { dow: '월', num: '24', type: 'arctic_rise', text: '불안 속에서도 맘 잡고 일어난 날' },
  { dow: '화', num: '25', type: 'burrow_together', text: '자료 정리 끝내고 회식으로' },
  { dow: '수', num: '26', type: 'lop_rest', text: '레전드로 누워있다가 새벽까지 작업' },
  { dow: '목', num: '27', type: null, text: '긴 회의 · 오후 일' },
];

export function SampleWeekList() {
  return (
    <ul className="wk-days ob-sample ob-sample--week" aria-hidden="true">
      {SAMPLE_WEEK.map(d => {
        const info = d.type ? rabbitById(d.type) : null;
        return (
          <li key={d.num} className="wk-day">
            <div className="wk-day-btn ob-static">
              <span className="wk-day-date"><span className="wk-day-dow">{d.dow}</span><span className="wk-day-num">{d.num}</span></span>
              {info
                ? <img className={`wk-day-rabbit${info.art ? ' rabbit-img--art' : ''}`} src={info.image} alt="" />
                : <span className="wk-day-rabbit wk-day-rabbit--none" />}
              <span className={`wk-day-text${info ? ' wk-day-text--headline' : ''}`}>{d.text}</span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

// 먼슬리 달력 — 8월, 토끼 몇 마리 채워진 모습
const SAMPLE_MONTH_RABBITS = { 18: 'moon_steady', 20: 'lop_rest', 21: 'hare_run', 24: 'arctic_rise', 25: 'burrow_together', 26: 'lop_rest', 27: 'arctic_firm' };
export function SampleMonthly({ compact = false }) {
  // 2026-08-01은 토요일. compact면 토끼가 채워진 뒤쪽 3주(9~31일)만 보여준다
  const start = compact ? 9 : 1;
  const firstDow = compact ? 0 : 6;
  const cells = [...Array(firstDow).fill(null), ...Array.from({ length: 31 - start + 1 }, (_, i) => start + i)];
  return (
    <div className={`ob-sample ob-sample--monthly${compact ? ' ob-sample--monthly-compact' : ''}`} aria-hidden="true">
      <div className="monthly-grid">
        {['일', '월', '화', '수', '목', '금', '토'].map(w => <span key={w} className="monthly-dow">{w}</span>)}
        {cells.map((d, i) => {
          if (d === null) return <span key={`e${i}`} />;
          const info = rabbitById(SAMPLE_MONTH_RABBITS[d]);
          return (
            <div key={d} className={`monthly-cell ob-static${info ? ' monthly-cell--filled' : ''}`}>
              <span className="monthly-daynum">{d}</span>
              {info?.image && <img className={`monthly-rabbit${info.art ? ' rabbit-img--art' : ''}`} src={info.image} alt="" />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// '할 말이 많았던 때' 곡선 — 실제 컴포넌트에 예시 기록을 넣는다
const SAMPLE_CURVE_MEMOS = [
  { id: 's1', recordedAt: '2026-08-25T00:10:00.000Z', content: '운동' },
  { id: 's2', recordedAt: '2026-08-25T02:17:00.000Z', content: '들어와서 씻고 누움' },
  { id: 's3', recordedAt: '2026-08-25T05:25:00.000Z', content: '저녁은 팀원들과 회식함. 곱창전골 먹고 2차로 노래방갔다. 오랜만에 웃었다' },
  { id: 's4', recordedAt: '2026-08-25T06:18:00.000Z', content: '미팅 자료 정리 완료' },
  { id: 's5', recordedAt: '2026-08-25T10:10:00.000Z', content: '미팅 자료 준비하고 회의 준비 완료. 요구사항 정리 완료. 내일 UT 걱정된다' },
];
export function SampleCurve() {
  return (
    <div className="ob-sample ob-sample--curve" aria-hidden="true">
      <TalkCurveBlock memos={SAMPLE_CURVE_MEMOS} now={null} emotions={[{ index: 2, label: '기쁨', quote: '오랜만에 웃었다' }, { index: 4, label: '불안', quote: '내일 UT 걱정된다' }]} dayLabel={null} />
    </div>
  );
}

// 이번 주 습관 — 체크 두 줄
export function SampleHabits() {
  const rows = [
    { name: '운동', color: 'green', on: [1, 1, 0, 1, 0] },
    { name: '독서', color: 'purple', on: [0, 1, 1, 0, 1] },
  ];
  return (
    <div className="ob-sample ob-sample--habits day-summary" aria-hidden="true">
      <div className="habit-week">
        <div className="habit-week-row habit-week-row--head">
          <span className="habit-week-name" />
          {['월', '화', '수', '목', '금'].map(d => <span key={d} className="habit-week-day">{d}</span>)}
        </div>
        {rows.map(r => (
          <div key={r.name} className="habit-week-row">
            <span className="habit-week-name"><span className="habit-week-dot" style={{ backgroundColor: `var(--habit-${r.color})` }} />{r.name}</span>
            {r.on.map((v, i) => <span key={i} className={`habit-week-cell${v ? ' habit-week-cell--on' : ''}`}>{v ? '✓' : ''}</span>)}
          </div>
        ))}
      </div>
    </div>
  );
}

// 시간표에서 꾹 누른 채 끄는 모습 — 손가락 점이 블록을 잡고 아래로 내렸다 올라온다 (CSS 애니메이션)
export function SampleDragDemo() {
  return (
    <div className="ob-demo" aria-hidden="true">
      <div className="ob-demo-grid">
        {['10:00', '11:00', '12:00', '13:00'].map(t => <div key={t} className="ob-demo-line"><span>{t}</span></div>)}
        <div className="ob-demo-block">
          <div className="ob-demo-block-time">10:30 → 12:00</div>
          회의
        </div>
        <div className="ob-demo-finger" />
      </div>
    </div>
  );
}

// 토끼 카드(펼친 모습) 미니 — 축약형을 탭하면 이게 뜬다는 걸 보여준다
export function SampleRabbitCardMini({ type = 'burrow_together' }) {
  const info = rabbitById(type);
  if (!info) return null;
  return (
    <div className="ob-rabbit-card" aria-hidden="true">
      <span className="rabbit-label">오늘의 토끼 · 8월 25일</span>
      <img className={`ob-rabbit-card-photo${info.art ? ' rabbit-img--art' : ''}`} src={info.image} alt="" />
      <div className="ob-rabbit-card-name">{info.name}</div>
      <div className="ob-rabbit-card-desc">{info.desc}</div>
      <div className="ob-rabbit-card-reason">저녁엔 팀원들과 회식했다. 곱창전골 먹고 노래방까지 가서 오랜만에 웃었다.</div>
    </div>
  );
}

// 회고 글 부분만 (토끼 없이)
export function SampleReviewBody() {
  return (
    <div className="ob-sample ob-sample--review" aria-hidden="true">
      <h2 className="reflection-headline">자료 정리 끝내고 회식으로</h2>
      <p className="day-summary-narrative reflection-narrative">
        미팅 자료 준비하고 회의 준비 완료라 적은 뒤, 저녁엔 팀원들과 곱창전골에 노래방까지 이어졌어요.
      </p>
      <div className="reflection-section">
        <div className="reflection-label">사고의 흐름</div>
        <ol className="flow-list">
          <li className="flow-item"><span className="flow-stage">시작</span><span className="flow-text">밥먹고 뒹굴거리다 운동으로 몸을 일으켰어요.</span></li>
          <li className="flow-item"><span className="flow-stage">전환</span><span className="flow-text">팀원들과 회식하며 오랜만에 웃었어요.</span></li>
          <li className="flow-item"><span className="flow-stage">결론</span><span className="flow-text">미팅 자료는 완료했지만 내일 UT가 걱정됐어요.</span></li>
        </ol>
      </div>
      <div className="reflection-section">
        <div className="reflection-label">오늘 끝낸 일</div>
        <ul className="done-list"><li className="done-item">미팅 자료 준비 완료</li><li className="done-item">요구사항 정리 완료</li></ul>
      </div>
      <div className="reflection-section">
        <div className="reflection-label">에너지 단어</div>
        <div className="energy-rows">
          <div className="energy-row"><span className="energy-tag energy-tag--up">활력</span><span>운동 · 웃었다 · 완료</span></div>
          <div className="energy-row"><span className="energy-tag energy-tag--down">소모</span><span>뒹굴거렸다 · 걱정된다</span></div>
        </div>
      </div>
    </div>
  );
}

// 회고 탭 첫 진입 카드 — 처음 소개 카드와 같은 형식
export const REVIEW_CARDS = [
  {
    key: 'rabbit', title: '회고를 만들면', line: '오늘의 토끼가 뽑혀요. 탭하면 카드로 펼쳐져요',
    art: (
      <div className="ob-card-art ob-card-art--tall">
        <SampleRabbitCompact type="burrow_together" />
        <div className="ob-arrow">↓ 탭</div>
        <SampleRabbitCardMini type="burrow_together" />
      </div>
    ),
  },
  { key: 'body', title: '하루를 이렇게 읽어줘요', line: '회고 글 · 사고의 흐름 · 끝낸 일 · 에너지 단어', art: <div className="ob-card-art ob-card-art--tall"><SampleReviewBody /></div> },
  { key: 'curve', title: '할 말이 많았던 때', line: '기록이 길었던 시간이 곡선으로 보여요', art: <div className="ob-card-art"><SampleCurve /></div> },
];
export const WEEK_CARDS = [
  { key: 'days', title: '요일별로 한 줄', line: '회고 제목이나 그날의 핵심 기록이 쌓여요', art: <div className="ob-card-art"><SampleWeekList /></div> },
  { key: 'habit', title: '습관 체크', line: '키워드를 등록하면 그 단어가 든 날에 체크돼요', art: <div className="ob-card-art"><SampleHabits /></div> },
  { key: 'curve', title: '이번 주 할 말이 많았던 때', line: '하루하루 곡선이 겹쳐 한 주의 리듬이 보여요', art: <div className="ob-card-art"><SampleCurve /></div> },
];
export const MONTHLY_CARDS = [
  { key: 'rabbits', title: '한 달의 토끼', line: '회고를 만든 날마다 토끼가 달력에 남아요', art: <div className="ob-card-art"><SampleMonthly compact /></div> },
];
