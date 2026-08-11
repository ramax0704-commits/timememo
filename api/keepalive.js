// Supabase 무료 플랜은 7일간 요청이 없으면 프로젝트를 자동 정지시킨다.
// (2026-08-11에 실제로 정지돼 서비스 전체가 먹통이 된 적 있음)
// vercel.json의 cron이 하루 한 번 이 함수를 호출해 "사용 중" 상태를 유지한다.
export default async function handler(req, res) {
  const url = process.env.VITE_SUPABASE_URL;
  const key = process.env.VITE_SUPABASE_ANON_KEY;
  const checkedAt = new Date().toISOString();

  if (!url || !key) {
    return res.status(500).json({ ok: false, reason: 'env-missing', checkedAt });
  }

  try {
    // RLS 때문에 익명 키로는 빈 배열이 오지만, 요청 자체가 활동으로 집계되므로 충분하다
    const r = await fetch(`${url}/rest/v1/memos?select=id&limit=1`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    return res.status(r.ok ? 200 : 502).json({
      ok: r.ok,
      status: r.status,
      checkedAt,
    });
  } catch (e) {
    return res.status(502).json({ ok: false, reason: String(e), checkedAt });
  }
}
