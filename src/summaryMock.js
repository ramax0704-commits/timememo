// AI 키가 없을 때 쓰는 샘플 회고.
//
// 브라우저(로컬 개발에서 /api가 없을 때)와 서버리스(ANTHROPIC_API_KEY가 없을 때)가 같은 걸 쓴다.
// 기록에서 기계적으로 뽑은 값이라 '회고'라기엔 얕지만, 화면이 어떻게 보일지 확인하는 데는 충분하다.
// 실제 키를 넣으면 이 파일은 호출되지 않는다.
//
// 출력 모양은 실제 AI와 같다:
// { categories, headline, narrative, thoughtFlow, loops, energyWords: { up, down }, keywords }

// 흔한 활동 단서 → 카테고리. 샘플이 너무 엉뚱하면 화면 판단이 안 되므로 이 정도는 묶어준다.
const ACTIVITY_HINTS = [
  ['식사', ['아침', '점심', '저녁', '밥', '먹', '식사', '야식', '간식', '커피', '카페']],
  ['운동', ['운동', '헬스', '산책', '러닝', '달리기', '요가', '수영', '자전거', '스트레칭']],
  ['업무', ['회의', '기획', '작성', '보고', '업무', '출근', '퇴근', '미팅', '공유', '제출', '발표', '메일']],
  ['공부', ['공부', '독서', '강의', '책', '수업', '과제', '스터디']],
  ['휴식', ['넷플릭스', '유튜브', '쉬', '낮잠', '게임', '드라마', '영화', '휴식']],
  ['이동', ['이동', '버스', '지하철', '택시', '운전', '출발', '도착']],
];
const UP_WORDS = ['완료', '끝', '마무리', '해냈', '좋았', '즐겁', '재밌', '설레', '상쾌', '뿌듯', '시작', '드디어', '성공', '기분 좋'];
const DOWN_WORDS = ['피곤', '지쳤', '힘들', '졸려', '늦', '못 했', '못했', '미뤘', '걱정', '불안', '답답', '짜증', '멍'];
const MEANING_WORDS = [['정리', ['정리', '청소', '비우']], ['회복', ['쉬', '산책', '낮잠', '휴식']], ['몰입', ['집중', '작성', '작업', '몰입']], ['꾸준함', ['운동', '독서', '루틴', '매일']], ['연결', ['회의', '친구', '만나', '통화', '가족']], ['시작', ['시작', '첫', '처음']]];

function firstNoun(text) {
  const tokens = text
    .replace(/https?:\/\/\S+/g, ' ')
    .split(/[\s,.!?/()\-~·:;"'#]+/)
    .map(t => t.replace(/(했음|했다|했어요|했어|한다|하기|하는|함|했|됨)$/u, '').replace(/(에서|으로|까지|부터|은|는|이|가|을|를|에|로|와|과|도|만|의)$/u, ''))
    .filter(t => t.length >= 2 && t.length <= 5 && !/^\d+$/.test(t));
  return tokens[0] || null;
}

const pad2 = (n) => String(n).padStart(2, '0');

export function mockDaySummary(records, { fixedCategories = [], facts = {} } = {}) {
  // 분류: 고정 세트가 있으면 이름이 본문에 들어간 것만 넣고, 없으면 활동 단서 → 첫 명사 순으로 묶는다
  const buckets = new Map();
  records.forEach((r, i) => {
    const hint = ACTIVITY_HINTS.find(([, words]) => words.some(w => r.text.includes(w)));
    const name = fixedCategories.length
      ? (fixedCategories.find(c => r.text.includes(c)) || null)
      : (hint ? hint[0] : firstNoun(r.text));
    if (!name) return;
    if (!buckets.has(name)) buckets.set(name, []);
    buckets.get(name).push(i);
  });
  const categories = [...buckets.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 5)
    .map(([name, recordIndexes]) => ({ name, recordIndexes }));

  const all = records.map(r => r.text).join(' ');
  const up = UP_WORDS.filter(w => all.includes(w)).slice(0, 5);
  const down = DOWN_WORDS.filter(w => all.includes(w)).slice(0, 5);
  const keywords = MEANING_WORDS.filter(([, ws]) => ws.some(w => all.includes(w))).map(([k]) => k).slice(0, 4);

  const top = categories[0]?.name;
  const headline = top ? `${top}에 기울어진 하루` : `기록 ${records.length}개의 하루`;

  const parts = [];
  if (facts.peakHour != null) parts.push(`오늘 기록은 ${pad2(facts.peakHour)}시 언저리에 가장 많이 모였어요.`);
  if (top && categories[0].recordIndexes.length >= 2) parts.push(`'${top}' 쪽 기록이 ${categories[0].recordIndexes.length}개로 하루의 중심에 있었어요.`);
  if (up.length) parts.push(`'${up[0]}' 같은 말이 기록에 남아 있었어요.`);
  if (down.length) parts.push(`한편 '${down[0]}'이라는 말도 함께 있었어요.`);
  if (facts.streak >= 2) parts.push(`${facts.streak}일째 이어서 남기고 있어요.`);
  if (parts.length < 3) parts.push('짧은 기록이라도 하루의 모양은 남았어요.');

  return {
    categories,
    headline,
    narrative: parts.slice(0, 5).join(' '),
    thoughtFlow: [],
    loops: [],
    energyWords: { up, down },
    keywords,
  };
}
