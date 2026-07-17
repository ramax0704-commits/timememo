-- ─────────────────────────────────────────────────────────────
-- 타임메모 Supabase 초기 설정
-- Supabase 대시보드 → SQL Editor 에 전체 붙여넣고 Run 하세요.
-- ─────────────────────────────────────────────────────────────

-- 1. 메모 테이블
create table public.memos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  content text not null,
  color text not null default 'default',
  recorded_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index memos_user_recorded_idx on public.memos (user_id, recorded_at);

-- 2. 사용자 설정 테이블 (습관 키워드)
create table public.settings (
  user_id uuid primary key references auth.users (id) on delete cascade,
  habit_keywords jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

-- 3. 보안 규칙 (RLS): 본인 데이터만 읽고 쓸 수 있음
alter table public.memos enable row level security;
alter table public.settings enable row level security;

create policy "본인 메모만 조회" on public.memos
  for select using (auth.uid() = user_id);
create policy "본인 메모만 추가" on public.memos
  for insert with check (auth.uid() = user_id);
create policy "본인 메모만 수정" on public.memos
  for update using (auth.uid() = user_id);
create policy "본인 메모만 삭제" on public.memos
  for delete using (auth.uid() = user_id);

create policy "본인 설정만 조회" on public.settings
  for select using (auth.uid() = user_id);
create policy "본인 설정만 추가" on public.settings
  for insert with check (auth.uid() = user_id);
create policy "본인 설정만 수정" on public.settings
  for update using (auth.uid() = user_id);

-- 4. 실시간 동기화 활성화 (다른 기기에서 추가한 메모가 바로 보이게)
alter publication supabase_realtime add table public.memos;

-- 5. 회원탈퇴 함수 (본인 계정 삭제, 메모/설정은 cascade로 함께 삭제됨)
create or replace function public.delete_user()
returns void
language sql
security definer
set search_path = ''
as $$
  delete from auth.users where id = auth.uid();
$$;
