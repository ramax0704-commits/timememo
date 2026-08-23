-- 받은 의견을 관리자(ramax0704@gmail.com) 계정에서만 앱 안에서 읽을 수 있게 한다 (2026-08-25)
--
-- feedback 테이블에는 읽기 정책이 없다(그대로 둔다). 대신 security definer 함수 하나가
-- 호출자의 로그인 이메일을 확인하고, 관리자일 때만 목록을 돌려준다.
-- 보낸 사람 이메일은 auth.users에서 붙인다 — 클라이언트는 auth.users를 못 읽으므로
-- 이 함수 안에서만 조인한다. 비로그인으로 남긴 글은 이메일이 null이다.
set default_transaction_read_only = off;

create or replace function public.admin_list_feedback()
returns table (
  id uuid,
  content text,
  created_at timestamptz,
  user_email text
)
language sql
security definer
set search_path = public
stable
as $$
  select f.id, f.content, f.created_at, u.email::text as user_email
  from public.feedback f
  left join auth.users u on u.id = f.user_id
  where coalesce(auth.jwt() ->> 'email', '') = 'ramax0704@gmail.com'
  order by f.created_at desc
  limit 500;
$$;

-- 로그인한 사람만 호출 가능. 관리자가 아니면 where 조건에 걸려 빈 결과.
revoke all on function public.admin_list_feedback() from public, anon;
grant execute on function public.admin_list_feedback() to authenticated;
