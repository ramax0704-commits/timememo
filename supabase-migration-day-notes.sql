-- '내일의 나에게 한 줄' (2026-08-30)
-- 회고 화면 맨 아래에서 사용자가 직접 적는 한 줄. AI가 쓰지 않는다.
-- 다음날 타임라인 첫 화면에 그대로 떠서, 기록 → 회고 → 다음날 재방문의 고리가 되는지 본다.
-- 날짜(date)는 회고 날짜 키(yyyy-MM-dd). 하루에 한 줄만 — 같은 날 다시 쓰면 덮어쓴다.
set default_transaction_read_only = off;

create table if not exists public.day_notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  date text not null,
  content text not null,
  updated_at timestamptz not null default now(),
  unique (user_id, date)
);

alter table public.day_notes enable row level security;

drop policy if exists "own day_notes" on public.day_notes;
create policy "own day_notes" on public.day_notes for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
