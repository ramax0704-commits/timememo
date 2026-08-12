-- 할 일 리스트 테이블 (2026-08-12 적용)
-- 날짜를 일부러 붙이지 않는다. 날짜가 있으면 '어제 못 한 것'이 생기고,
-- 그 목록 자체가 압박이 된다. 그냥 메모지처럼 쌓였다가 지워지는 것으로 둔다.
--
-- 주의: 마지막 줄(realtime 등록)만 두 번 실행하면 오류가 난다.
--       "already member of publication" 은 이미 적용됐다는 뜻이라 무시해도 된다.
set default_transaction_read_only = off;

create table if not exists public.todos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  content text not null,
  done boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists todos_user_created_idx on public.todos (user_id, created_at);

alter table public.todos enable row level security;

drop policy if exists "own todos" on public.todos;
create policy "own todos" on public.todos for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

alter publication supabase_realtime add table public.todos;
