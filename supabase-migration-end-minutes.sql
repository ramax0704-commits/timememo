-- 블록이 '언제 끝나는지'를 기록마다 직접 저장한다.
--
-- 지금까지 블록의 끝은 spans_to_next(= 다음 기록 시각까지) 하나로만 표현됐다.
-- 그래서 "10:00에 적고 11:30에 끝났다"처럼 다음 기록과 상관없는 끝 시각을
-- 정할 방법이 없었고, 편집 화면에도 '기록 시간'과 '시작 시각'이 따로 뜨는
-- 혼란이 생겼다. 시작만 직접 정할 수 있고 끝은 못 정하는 반쪽 모델이었기 때문.
--
-- end_minutes = 기록 시각에서 몇 분 뒤에 끝나는가. back_minutes(몇 분 전에
-- 시작했는가)와 짝을 이룬다.
--   블록 = [recorded_at - back_minutes, recorded_at + end_minutes]
-- 0 = 직접 정하지 않음. 이때는 기존 spans_to_next 자동 규칙을 그대로 따른다.
--
-- Supabase 대시보드 → SQL Editor에 붙여넣고 Run 하면 됩니다.
set default_transaction_read_only = off;

alter table public.memos
  add column if not exists end_minutes integer not null default 0;

-- 기존 데이터는 건드리지 않는다.
-- spans_to_next를 켜둔 기록은 '다음 기록까지'라는 자동 규칙이 여전히 맞는
-- 표현이라, 굳이 고정된 분 단위로 옮기면 다음 기록을 옮겼을 때 어긋난다.
