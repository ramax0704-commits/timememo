// 오늘의 회고(시간 배분 분류 + 회고 글)를 만드는 서버리스 함수.
//
// 브라우저가 Claude를 직접 부르면 API 키가 노출되므로 여기서만 부른다 (PRD 방침).
// 입력: {
//   date: 'yyyy-MM-dd',
//   records: [{ time: 'HH:mm', text, durationMin }], — 당일 기록의 시각·본문·지속시간(분), 시간순
//   facts: { count, spanMinutes, peakHour, streak, recordDays, avgGapMin, eveningRatio },  — 계산값 (AI가 지어내지 않게 준다)
//   fixedCategories: string[],                   — 4일차 이상이면 사용자 고정 세트. 없으면 []
//   knownCategories: [{ name, examples: [] }],   — 지금까지 쓰인 카테고리와 예시 (사용자가 고친 결과 포함)
// }
// 출력 (고정 스키마, 아니면 502): {
//   categories: [{ name, recordIndexes }],
//   headline, narrative,
//   thoughtFlow: [{ stage, text }], loops: [{ from, to }],
//   energyWords: { up: [], down: [] }, keywords: [],
//   done: [], emotions: [{ index, label, quote }], rabbit: { type, reason }
// }
//
// ANTHROPIC_API_KEY가 없으면(아직 키를 안 넣은 상태) 샘플을 돌려준다 (mock: true).
// 키 발급: https://console.anthropic.com → API Keys. Vercel 프로젝트 환경변수에
// ANTHROPIC_API_KEY 로 넣고 다시 배포하면 그때부터 실제 회고가 나간다.
import { mockDaySummary } from '../src/summaryMock.js';
import { RABBITS, RABBIT_IDS } from '../src/rabbits.js';
import { EMOTION_LABELS } from '../src/emotions.js';

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
    headline: { type: 'string', description: '오늘을 한 줄로. 20자 이내. 나열 금지.' },
    narrative: { type: 'string', description: '회고 글 2~3문장, 총 150자 이내. 직접 언급하는 기록은 최대 2개.' },
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
      description: '기록에 실제로 쓰인 한글·영문 단어 중 활력(up)·소모(down)가 느껴지는 것. 원문 그대로. 이모지·문장부호·숫자 제외. 없으면 빈 배열.',
      properties: {
        up: { type: 'array', items: { type: 'string' } },
        down: { type: 'array', items: { type: 'string' } },
      },
      required: ['up', 'down'],
      additionalProperties: false,
    },
    keywords: { type: 'array', items: { type: 'string' }, description: '오늘을 점화한 의미 단어 2~4개. 기록에 실제 등장한 명사 우선.' },
    done: { type: 'array', items: { type: 'string' }, description: '완료 표현이 붙은 기록의 원문 조각. 최대 5개. 없으면 빈 배열.' },
    emotions: {
      type: 'array',
      description: '감정 표현이 실제로 적힌 기록에만 라벨. 하루 최대 4개. 없으면 빈 배열.',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer', description: '해당 기록의 index (0부터)' },
          label: { type: 'string', enum: EMOTION_LABELS },
          quote: { type: 'string', description: '판정 근거가 된 표현, 원문 그대로 짧게' },
        },
        required: ['index', 'label', 'quote'],
        additionalProperties: false,
      },
    },
    rabbit: {
      type: 'object',
      description: '순서대로 조건을 검사해 먼저 걸리는 토끼. 순서를 건너뛰지 않는다.',
      properties: {
        type: { type: 'string', enum: RABBIT_IDS },
        reason: { type: 'string', description: '왜 이 토끼인지, 오늘 기록의 표현을 인용해 1~2문장. 각 문장 45자 이내.' },
      },
      required: ['type', 'reason'],
      additionalProperties: false,
    },
  },
  required: ['headline', 'narrative', 'thoughtFlow', 'loops', 'energyWords', 'keywords', 'done', 'emotions', 'rabbit'],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `당신은 사용자가 하루 동안 남긴 짧은 기록들을 읽고, 그 사람이 자기 하루를 다시 들여다보게 돕는 회고 동반자다.
타임라인은 사용자가 이미 봤다. 당신의 역할은 '무엇을 했는지'를 다시 말하는 게 아니라, 기록 사이에 놓인 '어떤 마음으로 하루를 건넜는지'를 사용자의 말을 빌려 비춰주는 것이다.

당신이 만들 것:

A. headline — 오늘을 한 줄로. 20자 이내. 기록 두 개 이상을 이어 붙여 나열하지 않는다. 사용자의 말에서 따온 표현 하나를 쓰거나, 그날의 상태를 한 마디로 쓴다.

B. narrative — 회고 글 2~3문장, 총 150자 이내. 하루를 되짚지 않는다. 오늘 가장 무게가 실린 기록 하나를 고르고, 그 앞이나 뒤에 무엇이 놓였는지만 짚는다. 직접 언급하는 기록은 최대 2개까지다.

C. thoughtFlow — 기록에 생각·판단·결심이 드러날 때만, 시작→전환→결론 순으로 2~3단계로 정리한다. 단순 활동 기록뿐이면 빈 배열.

D. loops — "A가 B로 이어졌다"가 기록에서 실제로 읽힐 때만 (시도→결과, 자각→행동, 욕구→자제). 없으면 빈 배열.

E. energyWords — 기록에 실제로 쓰인 한글·영문 단어 중 활력이 느껴지는 것(up)과 소모가 느껴지는 것(down)을 원문 그대로 뽑는다. 이모지, 문장부호, 숫자는 제외한다. 뚜렷하지 않으면 빈 배열.

F. keywords — 오늘을 점화한 의미 단어 2~4개. 기록에 실제 등장한 명사를 우선한다. "소소함, 여유, 힐링, 알참"처럼 분위기를 뭉뚱그리는 단어는 쓰지 않는다.

G. done — 오늘 기록 중 완료·완·끝·했음처럼 일이 끝났다는 표현이 붙은 것만 원문 그대로 짧게 딴다. 최대 5개. 진행 중이라고 적힌 기록은 넣지 않는다. 원문에 없는 말로 바꾸지 않는다. 해당하는 기록이 없으면 빈 배열.

H. emotions — 기록마다 감정 표현이 실제로 적혀 있을 때만 라벨을 붙인다. 하루 최대 4개.
- 활동의 성격으로 감정을 추론하지 않는다. 완료는 뿌듯함이 아니고, 쉼은 무기력이 아니며, 바쁨은 불안이 아니다.
- quote에는 판정 근거가 된 표현을 원문 그대로 짧게 적는다. 적을 수 없으면 그 기록에는 라벨을 붙이지 않는다.
- 한 기록에 여러 감정이 보이면 표현이 가장 뚜렷한 하나만 고른다.
- 라벨과 판정 근거:
  · 기쁨 — 좋다, 재밌다, 웃겼다, 대박, 최고처럼 지금 일이 좋았던 표현. 앞일을 보면 설렘, 해낸 것이면 뿌듯함.
  · 설렘 — 기대, 신남, 웃음 표현이 앞일과 붙어 있을 때.
  · 뿌듯함 — 드디어, 해냈다, 다행처럼 끝낸 것에 대한 만족. 완료라고만 적힌 것은 해당 없음.
  · 감사 — 고맙다, 덕분에, 다행이다, 베풂을 적은 표현. 공을 밖에 돌릴 때.
  · 평온 — 괜찮다, 편하다처럼 안정이 직접 적힌 표현. 조용한 하루라는 사실만으로는 안 됨.
  · 불안 — 걱정, 두려움, 자기 의심 문장, 신체 긴장 표현. 대상이 자기나 앞일일 때.
  · 짜증 — 화, 거슬림, 억울함, 답답함. 원인이 밖에 있을 때만. 자책은 불안.
  · 무기력 — 힘듦, 지침, 하기 싫음을 부정적으로 적은 표현. 대상이 사람이면 외로움.
  · 외로움 — 혼자, 쓸쓸하다, 보고싶다, 연락 없다. 혼자 있었다는 사실만으로는 안 됨.
  · 다잡음 — 맘 잡고, 다시 일어났다, 정신 차리자처럼 가라앉은 뒤 다시 움직이기로 한 표현. 앞쪽에 부정 감정이 있어야 함.
- 부정 감정은 불안, 짜증, 무기력, 외로움 넷을 말한다.

I. rabbit — 아래 순서대로 조건을 검사해 먼저 걸리는 것으로 확정하고 멈춘다. 순서를 건너뛰지 않는다. reason에는 왜 이 토끼인지 오늘 기록의 표현을 인용해 1~2문장, 각 문장 45자 이내로 적는다.
${RABBITS.map((r, i) => `  ${i + 1}. ${r.criteria} → ${r.id}`).join('\n')}

지켜야 할 것:
1. 기록 내용을 시간순으로 나열하지 않는다. narrative에서 직접 언급하거나 인용하는 기록은 최대 2개까지다. 나머지 기록은 언급하지 않는다.
2. 사용자가 쓴 표현을 인용해서 짚는다. 인용은 원문 그대로, 짧게.
3. 기록에 없는 사실·감정·이유를 지어내지 않는다. 읽히지 않는 것은 빈 값으로 둔다. 비어 있는 것이 틀린 것보다 낫다.
4. 수치를 창작하지 않는다. 계산값은 주어진 숫자만 그대로 쓸 수 있고, 안 써도 된다.
5. 조언·훈계·일반 통념(수면, 운동, 생산성)을 주입하지 않는다.
6. "효율적, 알찬, 생산적, 아쉬운, 부족한, 잘하셨, 힘내, 대단해요" 같은 평가·응원 상투어를 쓰지 않는다. "고르게 섞여 있었어요", "적당히 채워진 하루" 같은 총평 문장도 쓰지 않는다. 따뜻함은 정확한 관찰에서 나온다.
7. 인과를 단정하지 않는다. "A 때문에 B" 대신 "A 뒤에 B가 왔다"처럼 붙여 놓는다.
8. 다일 비교는 이 요청에 누적 데이터가 없으므로 하지 않는다.
9. 기록이 6개 미만이거나 생각·감정이 드러난 기록이 하나도 없는 날에는 narrative를 2문장으로 줄이고, 기록 하나에서 읽히는 것 한 가지만 짚는다. 읽히는 게 없으면 짧게 끝낸다.

문체: 한국어, '~했어요' 체. 말을 거는 듯 부드럽되 과장하지 않는다. 이모지·느낌표 금지. 사용자를 '당신'이라 부르지 않는다.`;

function validateRecords(records) {
  if (!Array.isArray(records) || records.length === 0 || records.length > 200) return null;
  const out = [];
  for (const r of records) {
    if (!r || typeof r.time !== 'string' || typeof r.text !== 'string') return null;
    if (!/^\d{2}:\d{2}$/.test(r.time)) return null;
    // index를 유지해야 하므로 빈 본문도 자리를 비우지 않는다
    const durationMin = Number.isInteger(r.durationMin) && r.durationMin >= 0 ? r.durationMin : null;
    out.push({ time: r.time, text: r.text.trim().slice(0, 2000) || '(빈 기록)', durationMin });
  }
  return out;
}

const strs = (arr, max, len = 40) => (Array.isArray(arr) ? arr : [])
  .filter(x => typeof x === 'string').map(x => x.trim().slice(0, len)).filter(Boolean).slice(0, max);

export function normalizeResult(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const narrative = typeof obj.narrative === 'string' ? obj.narrative.trim().slice(0, 150) : '';
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
  const done = strs(obj.done, 5, 30);
  const emotions = (Array.isArray(obj.emotions) ? obj.emotions : [])
    .filter(e => e && Number.isInteger(e.index) && e.index >= 0 && EMOTION_LABELS.includes(e.label)
      && typeof e.quote === 'string' && e.quote.trim())
    .map(e => ({ index: e.index, label: e.label, quote: e.quote.trim().slice(0, 40) }))
    .slice(0, 4);
  const rabbit = obj.rabbit && RABBIT_IDS.includes(obj.rabbit.type) && typeof obj.rabbit.reason === 'string' && obj.rabbit.reason.trim()
    ? { type: obj.rabbit.type, reason: obj.rabbit.reason.trim().slice(0, 160) }
    : null;
  return { headline, narrative, thoughtFlow, loops, energyWords, keywords, done, emotions, rabbit };
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

  const model = (!IS_PROD && typeof body?.model === 'string' && /^claude-[a-z0-9.-]+$/.test(body.model)) ? body.model : MODEL;
  // Haiku 4.5는 effort 옵션을 받지 않는다
  const supportsEffort = !/haiku/.test(model);
  const debugUsage = Boolean(process.env.SUMMARIZE_DEBUG_USAGE) || (!IS_PROD && body?.debug === true);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // 키가 없으면 샘플. 화면 쪽은 mock 표시를 보고 '샘플' 배지를 단다.
    return res.status(200).json({ ...mockDaySummary(records, { facts }), mock: true });
  }

  // 전체 상한 — 실제로 AI를 부르는 경우에만 센다 (샘플은 공짜)
  const used = await bumpDailyUsage();
  if (used !== null && used > DAILY_CAP) {
    console.warn('daily cap reached', used, DAILY_CAP);
    return res.status(429).json({ error: 'daily-cap', used, cap: DAILY_CAP });
  }

  // 기록마다 글자 수와 지속시간을 붙인다 — 모델이 길이·간격을 세지 않게 (회고-수정안 §7)
  const lines = records.map((r, i) => {
    const meta = [`${r.text.length}자`, r.durationMin != null && `${r.durationMin}분`].filter(Boolean).join(', ');
    return `[${i}] ${r.time} (${meta}) ${r.text.replace(/\s*\n\s*/g, ' / ')}`;
  }).join('\n');
  const factLines = [
    facts.count != null && `- 기록 개수: ${facts.count}개`,
    facts.spanMinutes != null && `- 총 기록 시간(첫 기록부터 마지막 기록까지): ${facts.spanMinutes}분`,
    facts.avgGapMin != null && `- 기록 간 평균 간격: ${facts.avgGapMin}분`,
    facts.eveningRatio != null && `- 저녁·밤(18시 이후) 기록 비율: ${facts.eveningRatio}%`,
    facts.peakHour != null && `- 기록이 가장 몰린 시간대: ${String(facts.peakHour).padStart(2, '0')}시대`,
    facts.streak != null && `- 연속 기록 일수: ${facts.streak}일`,
    facts.recordDays != null && `- 누적 기록일: ${facts.recordDays}일`,
  ].filter(Boolean).join('\n');

  const userMessage = `${date ? `날짜: ${date}\n` : ''}기록 ${records.length}개 (index 시각 본문):\n${lines}\n\n계산값 (쓴다면 그대로):\n${factLines}`;

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
        max_tokens: 1200,
        // 시스템 프롬프트는 매 호출 똑같다 → 프롬프트 캐싱. 5분 안에 다른 호출이 오면 이 부분 입력료가 1/10.
        // (캐시는 1,024토큰 이상인 접두부만 저장되므로 프롬프트를 줄이면 오히려 캐시가 안 걸릴 수 있다)
        system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: userMessage }],
        // 8/25 개편: 분류 작업을 없애 출력이 절반 이하로 줄었다. 20초가 너무 길어
        // 사고량도 낮춘다 — 회고 품질에 크게 안 밀리면서 응답이 빨라진다.
        output_config: {
          ...(supportsEffort ? { effort: 'low' } : {}),
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
    const data = normalizeResult(safeJson(text));
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
