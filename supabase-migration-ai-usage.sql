-- AI 회고 전체 호출 수 상한 (2026-08-24)
--
-- 사용자 수가 갑자기 늘어도 API 요금이 폭주하지 않게, 하루에 서비스 전체가 부를 수 있는
-- 횟수를 서버(api/summarize.js)에서 센다. 브라우저에 있는 '1인 하루 2회'는 기기에만 저장돼
-- 우회할 수 있으므로, 진짜 잠금은 이쪽이다.
--
-- ai_usage: 날짜별 호출 수. 앱에서는 직접 읽고 쓸 수 없고(RLS, 정책 없음)
-- bump_ai_usage() 함수로만 1 올리고 현재 값을 받아간다 (security definer).
set default_transaction_read_only = off;

create table if not exists public.ai_usage (
  day date primary key,
  count integer not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.ai_usage enable row level security;

create or replace function public.bump_ai_usage()
returns integer
language sql
security definer
set search_path = ''
as $$
  insert into public.ai_usage (day, count)
  values ((now() at time zone 'Asia/Seoul')::date, 1)
  on conflict (day) do update set count = public.ai_usage.count + 1, updated_at = now()
  returning count;
$$;

-- 익명 키(anon)와 로그인 키(authenticated) 모두 함수만 부를 수 있다
grant execute on function public.bump_ai_usage() to anon, authenticated;
