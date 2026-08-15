-- ─────────────────────────────────────────────────────────────
-- 기존 이메일 계정의 데이터를 구글 계정으로 옮긴다 (2026-08-16)
--
-- 왜: 외부 사용자를 받으면서 신규 가입을 구글로만 열었다. 운영자 본인 계정만
--     이메일이라 이메일 로그인 경로를 남겨둬야 했는데, 그것까지 정리하려는 것.
--
-- ★ 실행 전 반드시:
--   1) 터미널에서  npm run backup   (backups/ 에 JSON이 떨어진다)
--   2) 앱에서 '구글로 로그인'을 한 번 해서 구글 계정을 만들어 둔다
--      (안 만들면 옮길 대상이 없어 아래 1단계에서 멈춘다)
--
-- Supabase 대시보드 → SQL Editor 에 붙여넣고, 단계별로 나눠서 실행하세요.
-- ─────────────────────────────────────────────────────────────

set default_transaction_read_only = off;


-- ══ 1단계: 계정 확인 (읽기만 함, 안전) ════════════════════════
-- 먼저 이것만 실행해서 두 계정이 다 보이는지 확인하세요.

select
  u.email,
  u.raw_app_meta_data ->> 'provider' as 로그인수단,
  u.id,
  u.created_at::date as 가입일,
  (select count(*) from public.memos m where m.user_id = u.id) as 메모수,
  (select count(*) from public.todos t where t.user_id = u.id) as 할일수
from auth.users u
order by u.created_at;

-- 여기서 이메일 계정(메모 51개)과 구글 계정(메모 0개) 두 줄이 보여야 합니다.
-- 구글 계정이 안 보이면 → 앱에서 '구글로 로그인'을 먼저 하고 다시 실행하세요.


-- ══ 2단계: 이사 ═══════════════════════════════════════════════
-- 아래 두 줄의 이메일 주소를 본인 것으로 고친 뒤 통째로 실행하세요.
-- 전부 한 트랜잭션이라, 중간에 하나라도 잘못되면 아무것도 안 바뀝니다.

do $$
declare
  -- ↓↓↓ 여기 두 줄만 고치세요 ↓↓↓
  old_email text := 'jhi5670@naver.com';        -- 지금 쓰는 이메일 계정
  new_email text := '여기에@구글주소.com';        -- 옮겨갈 구글 계정
  -- ↑↑↑ 여기 두 줄만 고치세요 ↑↑↑

  old_id uuid;
  new_id uuid;
  moved_memos int;
  moved_todos int;
begin
  select id into old_id from auth.users where email = old_email;
  select id into new_id from auth.users where email = new_email;

  if old_id is null then
    raise exception '이메일 계정을 못 찾았습니다: %', old_email;
  end if;
  if new_id is null then
    raise exception '구글 계정을 못 찾았습니다: % — 앱에서 구글로 한 번 로그인하세요', new_email;
  end if;
  if old_id = new_id then
    raise exception '두 주소가 같은 계정입니다. 옮길 게 없습니다.';
  end if;

  -- settings 는 user_id 가 기본키라 그냥 옮기면 충돌한다.
  -- 구글 계정 쪽에 빈 설정이 있으면 먼저 치운다 (기존 계정 설정이 정답이므로).
  delete from public.settings where user_id = new_id;

  update public.memos    set user_id = new_id where user_id = old_id;
  get diagnostics moved_memos = row_count;

  update public.todos    set user_id = new_id where user_id = old_id;
  get diagnostics moved_todos = row_count;

  update public.settings set user_id = new_id where user_id = old_id;

  raise notice '옮김 완료 — 메모 %개, 할 일 %개 → %', moved_memos, moved_todos, new_email;
  raise notice '아직 옛 계정은 남아 있습니다. 앱에서 구글로 로그인해 기록이 다 보이는지 먼저 확인하세요.';
end $$;


-- ══ 3단계: 확인 ═══════════════════════════════════════════════
-- 2단계 후 1단계 쿼리를 다시 돌려보세요.
-- 구글 계정에 메모 51개, 이메일 계정에 0개로 뒤집혀 있어야 합니다.
--
-- 그리고 ★앱에서 구글로 로그인해 기록이 전부 보이는지 눈으로 확인하세요.★
-- 여기까지 확인되기 전에는 절대 4단계로 가지 마세요.


-- ══ 4단계: 옛 계정 삭제 (되돌릴 수 없음) ═══════════════════════
-- 3단계까지 확인한 뒤에만 실행하세요.
-- memos/todos/settings 는 user_id 에 on delete cascade 가 걸려 있어서,
-- 데이터가 남은 채로 이걸 실행하면 그 데이터도 같이 사라집니다.
--
-- 아래 주석(--)을 지우고 실행:
--
-- delete from auth.users
--  where email = 'jhi5670@naver.com'
--    and not exists (select 1 from public.memos where user_id = auth.users.id);
--
-- (안전장치: 메모가 하나라도 남아 있으면 지워지지 않습니다)
