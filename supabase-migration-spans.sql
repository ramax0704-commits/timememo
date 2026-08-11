-- 스케줄 뷰에서 "다음 기록까지 이어서 표시"를 켠 기록만 길게 그리기 위한 칸 추가
-- Supabase 대시보드 → SQL Editor에 붙여넣고 Run 하면 됩니다. 기존 데이터는 그대로 유지됩니다.
set default_transaction_read_only = off;

alter table public.memos
  add column if not exists spans_to_next boolean not null default false;
