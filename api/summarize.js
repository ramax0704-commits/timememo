// 오늘의 회고(시간 배분 분류 + 회고 글)를 만드는 서버리스 함수.
//
// 브라우저가 Claude를 직접 부르면 API 키가 노출되므로 여기서만 부른다 (PRD 방침).
// 입력: {
//   date: 'yyyy-MM-dd',
//   records: [{ time: 'HH:mm', text }],          — 당일 기록의 시각과 본문만, 시간순
//   facts: { count, spanMinutes, peakHour, streak, recordDays },  — 계산값 (AI가 지어내지 않게 준다)
//   fixedCategories: string[],                   — 4일차 이상이면 사용자 고정 세트. 없으면 []
//   knownCategories: [{ name, examples: [] }],   — 지금까지 쓰인 카테고리와 예시 (사용자가 고친 결과 포함)
// }
// 출력 (고정 스키마, 아니면 502): {
//   categories: [{ name, recordIndexes }],
//   headline, narrative,
//   thoughtFlow: [{ stage, text }], loops: [{ from, to }],
//   energyWords: { up: [], down: [] }, keywords: []
// }
//
// ANTHROPIC_API_KEY가 없으면(아직 키를 안 넣은 상태) 샘플을 돌려준다 (mock: true).
// 키 발급: https://console.anthropic.com → API Keys. Vercel 프로젝트 환경변수에
// ANTHROPIC_API_KEY 로 넣고 다시 배포하면 그때부터 실제 회고가 나간다.
import { mockDaySummary } from '../src/summaryMock.js';
import { RABBITS, RABBIT_IDS } from '../src/rabbits.js';

// 새 의존성을 안 쓰기로 해서 공식 SDK(@anthropic-ai/sdk) 대신 fetch로 직접 부른다.
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
// 모델은 환경변수로 바꿀 수 있다 (Vercel → SUMMARIZE_MODEL). 기본은 Sonnet 5 (8/24 비교: Opus와 근소한 차이, 비용 ~20% 절감).
// 품질을 올리려면 'claude-opus-5', 더 줄이려면 'claude-haiku-4-5'(지어내는 문장이 늘어 비추).
const MODEL = process.env.SUMMARIZE_MODEL || 'claude-sonnet-5';
// 프리뷰(비프로덕션)에서만: 요청에 model을 실어 보내면 그 모델로 돌린다 — 모델 비교용.
// 프로덕션은 누구나 부를 수 있는 주소라 요청으로 모델을 고르게 두면 안 된다.
const IS_PROD = process.env.VERCEL_ENV === 'production';
// 하루에 서비스 전체가 부를 수 있는 횟수. 사용자가 갑자기 늘어도 요금이 폭주하지 않게 하는 안전핀.
// Vercel 환경변수 SUMMARIZE_DAILY_CAP 으로 조정. (Sonnet 5 기준 1회 ≈ 25원 → 60회 ≈ 1,500원/일)
const DAILY_CAP = Number(process.env.SUMMARIZE_DAILY_CAP) || 60;

// Supabase의 bump_ai_usage()로 오늘 호출 수를 1 올리고 현재 값을 받는다.
// 세지 못하면(네트워크·미적용) 막지 않고 통과시킨다 — 카운터 장애로 회고가 죽으면 안 된다.
async function bumpDailyUsage() {
  const url = process.env.VITE_SUPABASE_URL;
  const key = process.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  try {
    const r = await fetch(`${url}/rest/v1/rpc/bump_ai_usage`, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!r.ok) { console.error('bump_ai_usage failed', r.status); return null; }
    const n = await r.json();
    return typeof n === 'number' ? n : null;
  } catch (e) {
    console.error('bump_ai_usage error', e);
    return null;
  }
}

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    categories: {
      type: 'array',
      description: '당일 기록을 묶은 활동 카테고리 3~5개. 근거가 불충분한 기록은 어디에도 넣지 않는다.',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '2~5자 명사형 카테고리 이름' },
          recordIndexes: { type: 'array', items: { type: 'integer' }, description: '이 카테고리에 속한 기록의 index (0부터)' },
        },
        required: ['name', 'recordIndexes'],
        additionalProperties: false,
      },
    },
    headline: { type: 'string', description: '오늘을 한 줄로. 20자 이내. 사용자의 말에서 따온 표현이면 더 좋다.' },
    narrative: { type: 'string', description: '회고 글 3~5문장. 관찰에서 출발해 사용자 자신도 몰랐을 패턴이나 마음을 짚는다. 각 문장 45자 이내.' },
    thoughtFlow: {
      type: 'array',
      description: '사고의 흐름. 기록에 생각·판단·결심이 드러날 때만 시작→전환→결론 순으로 2~3단계. 없으면 빈 배열.',
      items: {
        type: 'object',
        properties: {
          stage: { type: 'string', enum: ['시작', '전환', '결론'] },
          text: { type: 'string', description: '그 단계의 생각을 사용자의 말을 살려 한 문장으로' },
        },
        required: ['stage', 'text'],
        additionalProperties: false,
      },
    },
    loops: {
      type: 'array',
      description: '시도→결과 또는 자각→행동 루프. 기록에서 A가 B로 이어진 것이 읽힐 때만. 없으면 빈 배열.',
      items: {
        type: 'object',
        properties: {
          from: { type: 'string', description: '계기·시도·자각 (짧게)' },
          to: { type: 'string', description: '그 결과·행동·결심 (짧게)' },
        },
        required: ['from', 'to'],
        additionalProperties: false,
      },
    },
    energyWords: {
      type: 'object',
      description: '기록에 실제로 쓰인 단어 중 활력이 느껴지는 것(up)과 소모가 느껴지는 것(down). 원문 그대로. 없으면 빈 배열.',
      properties: {
        up: { type: 'array', items: { type: 'string' } },
        down: { type: 'array', items: { type: 'string' } },
      },
      required: ['up', 'down'],
      additionalProperties: false,
    },
    keywords: { type: 'array', items: { type: 'string' }, description: '오늘을 점화한 의미 단어 2~4개. 1~3자 명사.' },
    rabbit: {
      type: 'object',
      description: '오늘과 가장 닮은 토끼 하나. 활동보다 상태·감정 근거를 우선한다.',
      properties: {
        type: { type: 'string', enum: RABBIT_IDS },
        reason: { type: 'string', description: '왜 이 토끼인지, 오늘 기록의 표현을 인용해 1~2문장. 각 문장 45자 이내.' },
      },
      required: ['type', 'reason'],
      additionalProperties: false,
    },
    segmentStates: {
      type: 'array',
      description: '기록이 있는 시간대마다 그때의 상태를 한 구절로. 활동 나열이 아니라 상태·기분.',
      items: {
        type: 'object',
        properties: {
          segment: { type: 'string', enum: ['새벽', '오전', '점심', '오후', '저녁', '밤'] },
          state: { type: 'string', description: '그 시간대의 상태 한 구절, 6~20자. 예: "집중이 붙었어요", "지쳐서 늘어졌어요"' },
        },
        required: ['segment', 'state'],
        additionalProperties: false,
      },
    },
  },
  required: ['categories', 'headline', 'narrative', 'thoughtFlow', 'loops', 'energyWords', 'keywords', 'rabbit', 'segmentStates'],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `당신은 사용자가 하루 동안 남긴 짧은 기록들을 읽고, 그 사람이 자기 하루를 다시 들여다보게 돕는 회고 동반자다.
타임라인은 사용자가 이미 봤다. 당신의 역할은 '무엇을 했는지'를 다시 말하는 게 아니라, 기록 사이에 놓인 '어떤 마음으로 하루를 건넜는지'를 사용자의 말을 빌려 비춰주는 것이다.

당신이 만들 것:
A. categories — 당일 기록을 3~5개 활동 카테고리로 묶는다. 이름은 2~5자 명사형. 근거가 약한 기록은 억지로 넣지 말고 제외한다.
B. headline — 오늘을 한 줄로. 사용자의 말에서 따온 표현이면 더 좋다. 20자 이내.
C. narrative — 회고 글 3~5문장. 관찰에서 출발해서, 사용자 자신도 미처 이름 붙이지 못했을 패턴이나 마음을 한 번 짚어준다. 하루의 끝에서 읽고 "아, 그랬구나" 하고 스스로를 조금 더 이해하게 되는 글.
D. thoughtFlow — 기록에 생각·판단·결심이 드러날 때만, 시작→전환→결론 순으로 사고의 흐름을 2~3단계로 정리한다. 단순 활동 기록뿐이면 빈 배열.
E. loops — "A가 B로 이어졌다"가 기록에서 실제로 읽힐 때만 (시도→결과, 자각→행동, 욕구→자제). 없으면 빈 배열.
F. energyWords — 기록에 실제로 쓰인 단어 중 활력이 느껴지는 것(up)과 소모가 느껴지는 것(down)을 원문 그대로 뽑는다. 없으면 빈 배열.
G. keywords — 오늘을 점화한 의미 단어 2~4개 (예: 회복, 정리, 꾸준함). 1~3자 명사.
H. rabbit — 아래 8가지 토끼 중 오늘과 가장 닮은 하나를 고른다. 기준이 팽팽하면 활동보다 상태·감정 쪽 근거를 우선한다. reason에는 오늘 기록의 표현을 인용해 왜 이 토끼인지 적는다:
${RABBITS.map(r => `- ${r.id} (${r.name}): ${r.criteria}`).join('\n')}
I. segmentStates — 기록이 있는 시간대(새벽 02~05시, 오전 05~12시, 점심 12~14시, 오후 14~18시, 저녁 18~24시, 밤 00~02시)마다 그때의 '상태'를 한 구절로 적는다. 무엇을 했는지가 아니라 어떤 상태였는지다 (예: "시동을 거는 중", "집중이 붙었어요", "지쳐서 늘어졌어요"). 기록에서 상태가 읽히지 않으면 활동의 결을 담담히 옮긴다. 기록이 없는 시간대는 넣지 않는다.

지켜야 할 것:
1. 기록 내용을 시간순으로 나열하지 않는다. 사용자는 이미 봤다.
2. 사용자가 쓴 표현을 인용해서 짚는다. 인용은 원문 그대로, 짧게.
3. 기록에 없는 사실·감정·이유를 지어내지 않는다. 읽히지 않는 것은 빈 값으로 둔다. 비어 있는 것이 틀린 것보다 낫다.
4. 수치를 창작하지 않는다. 계산값(총 기록 시간, 몰린 시간대, 연속 일수)은 주어진 숫자만 그대로 쓸 수 있고, 안 써도 된다.
5. 조언·훈계·일반 통념(수면, 운동, 생산성)을 주입하지 않는다. 사용자 데이터에 없는 것은 말하지 않는다.
6. "효율적, 알찬, 생산적, 아쉬운, 부족한, 잘하셨, 힘내, 대단해요" 같은 평가·응원 상투어를 쓰지 않는다. 따뜻함은 정확한 관찰에서 나온다.
7. 인과를 단정하지 않는다 ("A 때문에 B"). 대신 "A 뒤에 B가 왔다", "A와 B가 나란히 있다"처럼 붙여 놓는다.
8. 다일 비교는 이 요청에 누적 데이터가 없으므로 하지 않는다.
9. 고정 카테고리 세트가 주어지면 새 이름을 만들지 말고 그 이름에만 매핑한다. 맞는 것이 없으면 제외한다.
10. 고정 세트가 없고 '지금까지 쓰인 카테고리'가 주어지면 같은 활동에는 같은 이름을 다시 쓴다.

문체: 한국어, '~했어요' 체. 말을 거는 듯 부드럽되 과장하지 않는다. 이모지·느낌표 금지. 사용자를 '당신'이라 부르지 않는다 (주어 생략).`;

function validateRecords(records) {
  if (!Array.isArray(records) || records.length === 0 || records.length > 200) return null;
  const out = [];
  for (const r of records) {
    if (!r || typeof r.time !== 'string' || typeof r.text !== 'string') return null;
    if (!/^\d{2}:\d{2}$/.test(r.time)) return null;
    // index를 유지해야 하므로 빈 본문도 자리를 비우지 않는다
    out.push({ time: r.time, text: r.text.trim().slice(0, 2000) || '(빈 기록)' });
  }
  return out;
}

const strs = (arr, max, len = 40) => (Array.isArray(arr) ? arr : [])
  .filter(x => typeof x === 'string').map(x => x.trim().slice(0, len)).filter(Boolean).slice(0, max);

export function normalizeResult(obj, recordCount) {
  if (!obj || typeof obj !== 'object') return null;
  const seen = new Set();
  const categories = (Array.isArray(obj.categories) ? obj.categories : [])
    .map(c => {
      const name = typeof c?.name === 'string' ? c.name.trim().replace(/^#/, '').slice(0, 12) : '';
      const recordIndexes = Array.isArray(c?.recordIndexes)
        ? [...new Set(c.recordIndexes.filter(i => Number.isInteger(i) && i >= 0 && i < recordCount && !seen.has(i)))]
        : [];
      recordIndexes.forEach(i => seen.add(i));
      return { name, recordIndexes };
    })
    .filter(c => c.name && c.recordIndexes.length > 0)
    .slice(0, 6);
  const narrative = typeof obj.narrative === 'string' ? obj.narrative.trim() : '';
  if (!narrative) return null;
  const headline = typeof obj.headline === 'string' ? obj.headline.trim().slice(0, 40) : '';
  const thoughtFlow = (Array.isArray(obj.thoughtFlow) ? obj.thoughtFlow : [])
    .filter(s => s && ['시작', '전환', '결론'].includes(s.stage) && typeof s.text === 'string' && s.text.trim())
    .map(s => ({ stage: s.stage, text: s.text.trim().slice(0, 80) }))
    .slice(0, 3);
  const loops = (Array.isArray(obj.loops) ? obj.loops : [])
    .filter(l => l && typeof l.from === 'string' && typeof l.to === 'string' && l.from.trim() && l.to.trim())
    .map(l => ({ from: l.from.trim().slice(0, 40), to: l.to.trim().slice(0, 40) }))
    .slice(0, 4);
  const energyWords = {
    up: strs(obj.energyWords?.up, 6, 16),
    down: strs(obj.energyWords?.down, 6, 16),
  };
  const keywords = strs(obj.keywords, 4, 8);
  const rabbit = obj.rabbit && RABBIT_IDS.includes(obj.rabbit.type) && typeof obj.rabbit.reason === 'string' && obj.rabbit.reason.trim()
    ? { type: obj.rabbit.type, reason: obj.rabbit.reason.trim().slice(0, 160) }
    : null;
  const SEGMENT_NAMES = ['새벽', '오전', '점심', '오후', '저녁', '밤'];
  const segSeen = new Set();
  const segmentStates = (Array.isArray(obj.segmentStates) ? obj.segmentStates : [])
    .filter(s => s && SEGMENT_NAMES.includes(s.segment) && typeof s.state === 'string' && s.state.trim() && !segSeen.has(s.segment) && segSeen.add(s.segment))
    .map(s => ({ segment: s.segment, state: s.state.trim().slice(0, 40) }))
    .slice(0, 6);
  return { categories, headline, narrative, thoughtFlow, loops, energyWords, keywords, rabbit, segmentStates };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method-not-allowed' });
  }

  const body = typeof req.body === 'string' ? safeJson(req.body) : req.body;
  const records = validateRecords(body?.records);
  if (!records) return res.status(400).json({ error: 'bad-records' });
  const date = typeof body?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : null;
  const facts = body?.facts && typeof body.facts === 'object' ? body.facts : {};
  const fixedCategories = strs(body?.fixedCategories, 5, 12);
  const knownCategories = (Array.isArray(body?.knownCategories) ? body.knownCategories : [])
    .filter(k => k && typeof k.name === 'string')
    .slice(0, 8)
    .map(k => ({ name: k.name.trim().slice(0, 12), examples: strs(k.examples, 3, 40) }));

  const model = (!IS_PROD && typeof body?.model === 'string' && /^claude-[a-z0-9.-]+$/.test(body.model)) ? body.model : MODEL;
  // Haiku 4.5는 effort 옵션을 받지 않는다
  const supportsEffort = !/haiku/.test(model);
  const debugUsage = Boolean(process.env.SUMMARIZE_DEBUG_USAGE) || (!IS_PROD && body?.debug === true);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // 키가 없으면 샘플. 화면 쪽은 mock 표시를 보고 '샘플' 배지를 단다.
    return res.status(200).json({ ...mockDaySummary(records, { fixedCategories, facts }), mock: true });
  }

  // 전체 상한 — 실제로 AI를 부르는 경우에만 센다 (샘플은 공짜)
  const used = await bumpDailyUsage();
  if (used !== null && used > DAILY_CAP) {
    console.warn('daily cap reached', used, DAILY_CAP);
    return res.status(429).json({ error: 'daily-cap', used, cap: DAILY_CAP });
  }

  const lines = records.map((r, i) => `[${i}] ${r.time} ${r.text.replace(/\s*\n\s*/g, ' / ')}`).join('\n');
  const factLines = [
    facts.count != null && `- 기록 개수: ${facts.count}개`,
    facts.spanMinutes != null && `- 총 기록 시간(첫 기록부터 마지막 기록까지): ${facts.spanMinutes}분`,
    facts.peakHour != null && `- 기록이 가장 몰린 시간대: ${String(facts.peakHour).padStart(2, '0')}시대`,
    facts.streak != null && `- 연속 기록 일수: ${facts.streak}일`,
    facts.recordDays != null && `- 누적 기록일: ${facts.recordDays}일`,
  ].filter(Boolean).join('\n');

  const categoryBlock = fixedCategories.length
    ? `고정 카테고리 세트 (이 이름에만 매핑, 새 이름 금지): ${fixedCategories.join(', ')}`
    : knownCategories.length
      ? `지금까지 쓰인 카테고리와 예시 (같은 활동이면 같은 이름을 써라):\n${knownCategories.map(k => `- ${k.name}: ${k.examples.join(' / ')}`).join('\n')}`
      : '카테고리 세트 없음 (오늘 기록만 보고 3~5개를 새로 만든다)';

  const userMessage = `${date ? `날짜: ${date}\n` : ''}기록 ${records.length}개 (index 시각 본문):\n${lines}\n\n계산값 (쓴다면 그대로):\n${factLines}\n\n${categoryBlock}`;

  try {
    const r = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 2000,
        // 시스템 프롬프트는 매 호출 똑같다 → 프롬프트 캐싱. 5분 안에 다른 호출이 오면 이 부분 입력료가 1/10.
        // (캐시는 1,024토큰 이상인 접두부만 저장되므로 프롬프트를 줄이면 오히려 캐시가 안 걸릴 수 있다)
        system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: userMessage }],
        // 기록을 읽고 마음을 짚는 일이라 조금은 생각하게 둔다
        output_config: {
          ...(supportsEffort ? { effort: 'medium' } : {}),
          format: { type: 'json_schema', schema: OUTPUT_SCHEMA },
        },
      }),
    });

    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      console.error('anthropic error', r.status, detail.slice(0, 300));
      return res.status(502).json({ error: 'upstream', status: r.status });
    }

    const msg = await r.json();
    if (msg.stop_reason === 'refusal' || msg.stop_reason === 'max_tokens') {
      return res.status(502).json({ error: `stop:${msg.stop_reason}` });
    }
    const text = (msg.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    const data = normalizeResult(safeJson(text), records.length);
    if (!data) return res.status(502).json({ error: 'schema-mismatch' });
    // 개발·비교용: 토큰 사용량은 브라우저에 보낼 필요가 없으니 평소엔 빼고, 환경변수로 켤 때만 붙인다
    if (debugUsage) data._usage = { model: msg.model, ...msg.usage };
    return res.status(200).json(data);
  } catch (e) {
    console.error('summarize failed', e);
    return res.status(502).json({ error: 'failed' });
  }
}

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
