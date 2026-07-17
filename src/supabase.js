import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  alert('Supabase 설정이 없습니다. .env.local 파일에 VITE_SUPABASE_URL과 VITE_SUPABASE_ANON_KEY를 입력해주세요.');
}

// 자동 로그인 여부에 따라 저장 위치 선택
// - 자동 로그인 ON(기본): localStorage → 브라우저를 닫아도 로그인 유지
// - 자동 로그인 OFF: sessionStorage → 브라우저를 닫으면 로그아웃
const REMEMBER_KEY = 'timememo-remember';

export function setRememberMe(remember) {
  localStorage.setItem(REMEMBER_KEY, remember ? 'true' : 'false');
}

export function getRememberMe() {
  return localStorage.getItem(REMEMBER_KEY) !== 'false';
}

function pickStorage() {
  return getRememberMe() ? localStorage : sessionStorage;
}

const storageAdapter = {
  getItem: (key) => pickStorage().getItem(key),
  setItem: (key, value) => pickStorage().setItem(key, value),
  removeItem: (key) => {
    localStorage.removeItem(key);
    sessionStorage.removeItem(key);
  },
};

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: storageAdapter,
  },
});
