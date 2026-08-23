-- 가입 시 약관·개인정보 동의 시각을 계정에 남긴다 (2026-08-25)
-- 동의는 구글 로그인 직전에 기기에서 받고, 로그인이 끝나면 앱이 여기로 옮겨 적는다.
set default_transaction_read_only = off;

alter table public.settings
  add column if not exists consent_at timestamptz,
  add column if not exists consent_version text;
