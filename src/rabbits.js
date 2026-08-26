// 오늘의 토끼 — 하루 기록을 21종 토끼에 매핑한다. (회고-수정안.md §5)
//
// 토끼는 자유 선택이 아니라 고정된 순서 검사로 판정한다. 배열 순서가 곧 검사 순서이며,
// criteria는 "이 조건에 먼저 걸리면 확정"이라는 판정 조건이다 (AI 프롬프트에 그대로 들어간다).
// name/desc/trivia는 화면 문구. 서버(api/summarize.js)와 화면이 같이 쓴다.
//
// 이미지는 계열별로 하나씩만 있어서 같은 계열끼리 재사용한다. moondance는 hare 이미지를 임시로 쓴다.
const IMG = {
  fighter: '/rabbits/fighter.jpg',
  arctic: '/rabbits/arctic.jpg',
  burrow: '/rabbits/burrow.jpg',
  clock: '/rabbits/clock.jpg',
  race: '/rabbits/race.jpg',
  hare: '/rabbits/hare.jpg',
  moon: '/rabbits/moon.jpg',
  lop: '/rabbits/lop.jpg',
};

export const RABBITS = [
  // ── 북극토끼 계열 ──
  {
    id: 'fighter', family: 'arctic', image: IMG.fighter,
    name: '전투토끼',
    desc: '부딪히고 소모하며 에너지를 쓴 하루예요.',
    trivia: '순한 토끼도 물러설 수 없을 땐 뒷발로 서서 앞발을 씁니다. 오늘은 그런 자리가 있었나 봐요.',
    criteria: '부정 감정 2건 이상 + 갈등·부딪힘 표현',
  },
  {
    id: 'arctic_rise', family: 'arctic', image: IMG.arctic,
    name: '다시 일어선 북극토끼',
    desc: '주저앉을 뻔했지만 다시 몸을 일으킨 하루예요.',
    trivia: '눈에 파묻혀도 앞발로 헤치고 다시 걸어 나옵니다. 오늘 다시 일어난 그 순간이 하루를 바꿨어요.',
    criteria: '부정 감정 2건 이상 + 다잡음 라벨',
  },
  {
    id: 'arctic_alert', family: 'arctic', image: IMG.arctic,
    name: '경계 중인 북극토끼',
    desc: '사소한 것에도 날이 서 있던 하루예요.',
    trivia: '위험을 느끼면 귀를 눕히고 사방을 살피며 시간을 보냅니다. 예민한 건 지키는 중이라는 뜻이에요.',
    criteria: '부정 감정 2건 이상 + 짜증 라벨',
  },
  {
    id: 'arctic_firm', family: 'arctic', image: IMG.arctic,
    name: '단단한 북극토끼',
    desc: '힘든 상황을 단단하게 버텨낸, 고요하지만 강한 하루예요.',
    trivia: '눈보라가 오면 다리를 접고 몸을 웅크린 채 그 자리에서 견딥니다. 조용히 버텨낸 하루처럼 보여요.',
    criteria: '부정 감정 2건 이상 + 완료 기록 있음',
  },

  // ── 굴토끼 계열 ──
  {
    id: 'burrow_deep', family: 'burrow', image: IMG.burrow,
    name: '땅굴 판 굴토끼',
    desc: '마음이 안으로 파고든 채 하루가 닫혔어요.',
    trivia: '굴토끼도 가끔은 굴 가장 안쪽에 혼자 머뭅니다. 오늘 판 굴이 내일 나오는 길이 되기도 해요.',
    criteria: '부정 감정이 하루 끝까지 올라오지 않음',
  },
  {
    id: 'burrow_wit', family: 'burrow', image: IMG.burrow,
    name: '별주부 토끼',
    desc: '막힌 자리에서 다른 길을 찾아낸 하루예요.',
    trivia: '용궁에 끌려간 토끼는 기지를 발휘해 뭍으로 돌아왔습니다. 막다른 곳에서도 길은 나오더라고요.',
    criteria: '막힘 뒤에 해결·우회가 이어짐',
  },
  {
    id: 'burrow_together', family: 'burrow', image: IMG.burrow,
    name: '함께한 굴토끼',
    desc: '사람들 사이에서 에너지를 주고받은 하루예요.',
    trivia: '서로의 굴을 이어 붙이며 살아서 혼자 있는 시간이 길지 않아요. 오늘은 그 온기가 있던 날이네요.',
    criteria: '사람 이름·모임·회식 표현',
  },
  {
    id: 'burrow_team', family: 'burrow', image: IMG.burrow,
    name: '손발 맞춘 굴토끼',
    desc: '누군가와 맞춰가며 일을 굴린 하루예요.',
    trivia: '각자 다른 입구를 맡아 굴 하나를 완성합니다. 혼자 다 하지 않아도 되는 날이었네요.',
    criteria: '협업·회의·같이 한 일',
  },

  // ── 산토끼 계열 ──
  {
    id: 'clock', family: 'hare', image: IMG.clock,
    name: '시계토끼',
    desc: '시간에 쫓기듯 이어 달린 하루예요.',
    trivia: '회중시계를 들여다보며 늦었다고 되뇌던 그 토끼처럼, 오늘은 종일 바쁘게 움직인 하루였네요.',
    criteria: '기록 간격이 촘촘하고 일정이 연달아 이어짐',
  },
  {
    id: 'race', family: 'hare', image: IMG.race,
    name: '경주토끼',
    desc: '서두르지 않고 속도를 늦춘 하루예요.',
    trivia: '거북이와 겨루던 토끼는 앞서 있다며 한숨 자고 갔습니다. 가끔은 그렇게 쉬어가도 괜찮아요.',
    criteria: '하려던 일이 있었는데 쉼·미룸이 끼어들어 늦게 시작',
  },
  {
    id: 'moondance', family: 'hare', image: IMG.hare,
    name: '달 밤의 댄스파티',
    desc: '밤이 깊을수록 신이 났던 하루예요.',
    trivia: '달 밝은 밤이면 들판에 나와 서로 앞발을 맞대고 껑충거립니다. 사람들은 그 모습을 토끼들의 춤이라고 불렀어요.',
    criteria: '기쁨 라벨 + 기록이 저녁·밤에 몰림',
  },
  {
    id: 'hare_thrift', family: 'hare', image: IMG.hare,
    name: '아껴 쓴 산토끼',
    desc: '쓸 곳과 아낄 곳을 가려 쓴 하루예요.',
    trivia: '먹을 만큼만 뜯고 나머지는 그대로 두고 갑니다. 남겨두는 것도 하나의 기술이에요.',
    criteria: '금액·할인·절약 표현',
  },
  {
    id: 'hare_night', family: 'hare', image: IMG.hare,
    name: '밤을 걷는 산토끼',
    desc: '해가 진 뒤에 움직임이 살아난 하루예요.',
    trivia: '초저녁부터 새벽까지 움직이는 야행성이에요. 낮이 조용했다고 안 움직인 건 아니었어요.',
    criteria: '기록이 저녁·밤 시간대에 몰림',
  },
  {
    id: 'hare_run', family: 'hare', image: IMG.hare,
    name: '뛰어다닌 산토끼',
    desc: '활력이 넘치게 움직인 하루예요.',
    trivia: '굴을 파는 대신 넓은 들판을 뛰어다니며 지냅니다. 오늘은 에너지가 밖으로 향한 날이네요.',
    criteria: '이동·외출 기록 2건 이상',
  },

  // ── 옥토끼 계열 ──
  {
    id: 'moon_full', family: 'moon', image: IMG.moon,
    name: '풍족한 옥토끼',
    desc: '쌓아온 것이 결과로 돌아온 하루예요.',
    trivia: '매일 찧은 것들은 어딘가에 차곡차곡 모입니다. 오늘 돌아온 것도 그렇게 모인 거예요.',
    criteria: '월급·입금·정산·합격·통과·계약처럼 들어온 것을 적은 기록',
  },
  {
    id: 'moon_proud', family: 'moon', image: IMG.moon,
    name: '뿌듯한 옥토끼',
    desc: '해낸 것이 스스로에게 남은 하루예요.',
    trivia: '밤새 찧은 쌀이 아침이면 떡 한 접시가 되어 있어요. 오늘 해낸 것도 어딘가에 모양을 남겼을 거예요.',
    criteria: '뿌듯함 라벨',
  },
  {
    id: 'moon_steady', family: 'moon', image: IMG.moon,
    name: '꾸준한 옥토끼',
    desc: '기복 없이 할 일을 이어간 하루예요.',
    trivia: '매일 같은 자리에서 같은 방아를 찧습니다. 쌓이는 건 대개 그런 날들이에요.',
    criteria: '완료 기록 2건 이상 + 부정 감정 없음',
  },

  // ── 롭이어토끼 계열 ──
  {
    id: 'lop_love', family: 'lop', image: IMG.lop,
    name: '사랑이 넘치는 롭이어토끼',
    desc: '마음이 밖으로 향해 있던 하루예요.',
    trivia: '사람이 다가오면 피하지 않고 곁을 내어줍니다. 오늘 건넨 마음도 그렇게 닿았을 거예요.',
    criteria: '감사 라벨',
  },
  {
    id: 'lop_quiet', family: 'lop', image: IMG.lop,
    name: '고요했던 롭이어토끼',
    desc: '곁이 조용했던 하루예요.',
    trivia: '늘어진 귀 때문에 소리가 조금 늦게 닿습니다. 오늘은 그 조용함이 길게 느껴졌나 봐요.',
    criteria: '외로움 라벨',
  },
  {
    id: 'lop_full', family: 'lop', image: IMG.lop,
    name: '배부른 롭이어토끼',
    desc: '먹는 것으로 채운 하루예요.',
    trivia: '토끼는 하루 종일 무언가를 씹고 있어야 합니다. 계속 먹는 게 그들에겐 정상이에요.',
    criteria: '먹은 기록 2건 이상',
  },
  {
    id: 'lop_rest', family: 'lop', image: IMG.lop,
    name: '푹 쉰 롭이어토끼',
    desc: '쉬는 데 시간을 내어준 하루예요.',
    trivia: '서늘하고 조용한 자리를 찾아 몸을 길게 늘입니다. 오늘 찾은 자리도 그런 곳이었겠죠.',
    criteria: '독서·영화·드라마·OTT·요가·산책·힐링·쉼·회복·낮잠 중 하나 이상',
  },
  {
    id: 'lop', family: 'lop', image: IMG.lop,
    name: '롭이어토끼',
    desc: '크게 기울지 않고 지나간 하루예요.',
    trivia: '늘어진 귀는 하루아침에 생긴 게 아니라 아주 오랜 시간이 만든 모습입니다. 눈에 띄지 않는 날들이 그렇게 쌓여요.',
    criteria: '그 외',
  },
];

export const RABBIT_IDS = RABBITS.map(r => r.id);

// 8종 시절에 저장된 옛 id(day_rabbits, 로컬 캐시)를 새 id로 읽는다. 데이터는 그대로 두고 조회만 매핑.
const LEGACY_IDS = { moon: 'moon_steady', arctic: 'arctic_firm', burrow: 'burrow_together', hare: 'hare_run' };

export const rabbitById = (id) => {
  const key = LEGACY_IDS[id] || id;
  return RABBITS.find(r => r.id === key) || null;
};
