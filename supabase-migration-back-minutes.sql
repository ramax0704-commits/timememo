-- 끝나고 남긴 기록의 소요 시간(분). 기록 시각에서 이만큼 뒤로 블록을 그린다.
-- 0 = 안 이음(기본 짧은 블록). 예: 30 이면 기록 시각 30분 전부터 기록 시각까지.
-- 이전에 만든 spans_from_prev는 "이전 기록에 맞춰 늘리는" 방식이라 실제 소요 시간과
-- 어긋나서 쓰지 않기로 했다. 지우지는 않고 그대로 둔다(데이터 손실 방지).
-- Supabase 대시보드 → SQL Editor에 붙여넣고 Run 하면 됩니다.
set default_transaction_read_only = off;

alter table public.memos
  add column if not exists back_minutes integer not null default 0;

-- 기존에 spans_from_prev를 켜둔 기록이 있으면 30분으로 옮겨준다
update public.memos
  set back_minutes = 30
  where spans_from_prev = true and back_minutes = 0;
