-- RLS UPDATE 정책 보완 (2026-08-16, 외부 사용자 모집 전 점검에서 발견)
--
-- 문제: memos / settings 의 UPDATE 정책에 with check 가 빠져 있었다.
--   create policy ... for update using (auth.uid() = user_id);
--
-- using 은 "어떤 행을 수정할 수 있나"만 본다. 수정한 결과가 어때야 하는지는
-- with check 가 본다. 둘 중 하나가 없으면, 자기 행의 user_id 를 남의 것으로
-- 바꿔서 남의 타임라인에 기록을 밀어넣을 수 있다.
-- (남의 기록을 '읽는' 건 원래부터 막혀 있었다. 이건 밀어넣기 쪽 구멍이다)
--
-- todos 는 처음부터 `for all using ... with check ...` 라 문제 없다.
--
-- Supabase 대시보드 → SQL Editor 에 붙여넣고 Run. 여러 번 실행해도 안전하다.

set default_transaction_read_only = off;

-- memos: 수정 후에도 여전히 본인 것이어야 한다
drop policy if exists "본인 메모만 수정" on public.memos;
create policy "본인 메모만 수정" on public.memos
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- settings: 같은 이유
drop policy if exists "본인 설정만 수정" on public.settings;
create policy "본인 설정만 수정" on public.settings
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- settings 에는 DELETE 정책이 없었다. 앱이 설정을 지우지 않으므로 그대로 두면
-- '아무도 못 지움'이 되어 오히려 안전하다. 회원탈퇴 시에는 delete_user() 가
-- auth.users 를 지우고 cascade 로 함께 사라진다.

-- 확인용: 아래를 실행하면 정책 목록이 나온다.
-- select tablename, policyname, cmd, qual, with_check
--   from pg_policies where schemaname = 'public' order by tablename, cmd;
