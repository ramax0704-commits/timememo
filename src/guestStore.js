// 로그인 전 '체험 모드'에서 쓴 기록을 브라우저에 잠깐 담아두는 곳.
//
// 왜 이게 있나: 로그인 화면부터 띄우면 써보지도 않고 나가는 사람이 많다.
// 타임메모는 첫 동작이 "한 줄 적고 전송"이라 30초면 뭔지 이해되는 앱이므로,
// 일단 써보게 하고 저장할 때가 되면 로그인을 권하는 쪽이 맞다.
//
// Supabase의 memos 행과 같은 모양(snake_case)으로 저장한다.
// 로그인 시 그대로 insert 하면 되고, 화면에 그릴 때도 rowToMemo를 그대로 쓸 수 있다.

const KEY = 'timememo-guest-memos';

export function loadGuestRows() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const rows = JSON.parse(raw);
    return Array.isArray(rows) ? rows : [];
  } catch {
    // 저장값이 깨졌으면 체험 기록을 포기한다. 이것 때문에 앱이 안 뜨면 안 된다.
    return [];
  }
}

export function saveGuestRows(rows) {
  try {
    localStorage.setItem(KEY, JSON.stringify(rows));
  } catch {
    // 시크릿 모드 등 저장이 막힌 환경. 화면에는 남아 있으니 그대로 진행한다.
  }
}

export function clearGuestRows() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // 무시
  }
}

// 체험 기록에 붙일 임시 id. 로그인 후 실제 저장할 때는 DB가 새 id를 발급한다.
export function newGuestId() {
  return (crypto.randomUUID?.() ?? `guest-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}
