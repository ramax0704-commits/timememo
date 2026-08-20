-- 사용 후기·의견·문의 테이블 (2026-08-21)
-- 로그인 화면(비로그인)과 마이페이지(로그인) 양쪽에서 남길 수 있다.
set default_transaction_read_only = off;

create table if not exists public.feedback (
  id uuid primary key default gen_random_uuid(),
  -- 비로그인이면 null. 회원탈퇴하면 글은 남기되 익명으로 (on delete set null)
  user_id uuid references auth.users(id) on delete set null,
  content text not null check (char_length(content) between 1 and 2000),
  created_at timestamptz not null default now()
);

alter table public.feedback enable row level security;

-- 쓰기만 열고 읽기 정책은 아예 안 만든다:
-- 누구나(비로그인 포함) 남길 수 있지만, 앱에서는 아무도 못 읽는다.
-- 내용을 보는 곳은 Supabase 대시보드(Table Editor)뿐이다.
drop policy if exists "feedback_insert" on public.feedback;
create policy "feedback_insert" on public.feedback
  for insert to anon, authenticated
  with check (user_id is null or user_id = auth.uid());
