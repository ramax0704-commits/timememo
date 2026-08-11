-- 스케줄 뷰에서 "이전 기록부터 이어서 표시"를 켠 기록을 앞쪽으로 늘려 그리기 위한 칸 추가
-- (끝나고 나서 기록을 남기는 경우: "운동함" → 이전 기록 시각부터 지금까지)
-- Supabase 대시보드 → SQL Editor에 붙여넣고 Run 하면 됩니다. 기존 데이터는 그대로 유지됩니다.
set default_transaction_read_only = off;

alter table public.memos
  add column if not exists spans_from_prev boolean not null default false;
