-- 회고: 기록마다 활동 카테고리를 남기고, 사용자별 고정 카테고리 세트를 둔다 (2026-08-24)
--
-- memos.category        — AI가 분류했거나 사용자가 고친 카테고리 이름. null = 미분류.
--                          기록 본문(content)은 절대 건드리지 않는다. 분류는 항상 별도 칸.
-- settings.review_categories — 누적 기록일 4일째부터 고정되는 상위 5개 이름(jsonb 배열).
--                          이름이 날마다 바뀌면 주간 비교가 안 되므로 한 번 정해지면 유지한다.
--
-- Supabase 대시보드 → SQL Editor에 붙여넣고 Run 하면 됩니다. 기존 데이터는 그대로 유지됩니다.
set default_transaction_read_only = off;

alter table public.memos
  add column if not exists category text;

alter table public.settings
  add column if not exists review_categories jsonb not null default '[]'::jsonb;
