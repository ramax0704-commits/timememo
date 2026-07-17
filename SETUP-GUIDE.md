# 타임메모 Supabase + Vercel 설정 가이드

코드는 전부 준비됐어요. 아래 순서대로 따라하면 됩니다.
**1~3단계만 하면 내 컴퓨터에서 바로 테스트할 수 있고, 4~6단계까지 하면 배포 완료입니다.**

---

## 1단계. Supabase 프로젝트 만들기

1. https://supabase.com 접속 → 로그인
2. **New Project** 클릭
3. 입력값:
   - **Name**: `timememo` (아무거나 OK)
   - **Database Password**: 아무거나 생성 (자동생성 버튼 눌러도 됨, 따로 쓸 일 거의 없음)
   - **Region**: `Northeast Asia (Seoul)` 선택
4. **Create new project** 클릭 → 1~2분 기다리기

## 2단계. 데이터베이스 설정 (SQL 실행)

1. 왼쪽 메뉴에서 **SQL Editor** 클릭
2. 이 프로젝트 폴더에 있는 `supabase-setup.sql` 파일을 열어서 **전체 복사**
3. SQL Editor에 붙여넣고 **Run** 클릭
4. "Success. No rows returned" 나오면 성공

## 3단계. API 키 연결

1. Supabase 왼쪽 메뉴 → ⚙️ **Project Settings** → **API Keys**
2. 두 값을 복사:
   - **Project URL** (https://xxxx.supabase.co 형태)
   - **anon public** 키 (긴 문자열)
3. 프로젝트 폴더의 `.env.local` 파일을 열어서 붙여넣기:
   ```
   VITE_SUPABASE_URL=https://xxxx.supabase.co
   VITE_SUPABASE_ANON_KEY=eyJhbG...(긴 문자열)
   ```

> 🎉 여기까지 하면 로컬 테스트 가능: 터미널에서 `npm run dev` 실행
> (이메일 회원가입/로그인, 메모 작성 모두 동작. 구글 로그인만 5단계 필요)

## 4단계. 이메일 인증 링크 설정 (Supabase)

회원가입 인증 메일, 비밀번호 재설정 메일의 링크가 올바른 주소로 가도록 설정:

1. Supabase → **Authentication** → **URL Configuration**
2. **Site URL**: 일단 `http://localhost:5173` (배포 후 Vercel 주소로 변경)
3. **Redirect URLs**에 추가:
   - `http://localhost:5173`
   - `http://localhost:5173/**`
   - (배포 후) `https://내앱이름.vercel.app` 과 `https://내앱이름.vercel.app/**`

## 5단계. 구글 로그인 설정

### 5-1. Google Cloud Console에서 OAuth 키 만들기

1. https://console.cloud.google.com 접속 (기존 timememo Firebase 프로젝트 선택해도 되고, 새 프로젝트 만들어도 됨)
2. 검색창에 "OAuth" 검색 → **OAuth 동의 화면(OAuth consent screen)** 이동
   - 처음이라면: User Type **외부(External)** 선택 → 앱 이름 `타임메모`, 이메일 입력 → 나머지 기본값으로 저장
3. 왼쪽 메뉴 **사용자 인증 정보(Credentials)** → **+ 사용자 인증 정보 만들기** → **OAuth 클라이언트 ID**
   - 애플리케이션 유형: **웹 애플리케이션**
   - 이름: `timememo-supabase`
   - **승인된 리디렉션 URI**에 추가: `https://xxxx.supabase.co/auth/v1/callback`
     (xxxx는 3단계의 내 Project URL — Supabase의 Authentication → Sign In / Providers → Google 화면에도 "Callback URL"이 표시되어 있으니 그걸 복사하면 정확함)
4. 만들기 클릭 → **클라이언트 ID**와 **클라이언트 보안 비밀번호(Secret)** 복사

### 5-2. Supabase에 등록

1. Supabase → **Authentication** → **Sign In / Providers** → **Google** 클릭
2. **Enable** 켜기
3. 5-1에서 복사한 **Client ID**, **Client Secret** 붙여넣기 → **Save**

## 6단계. Vercel 배포

1. https://vercel.com 접속 → 회원가입/로그인 (GitHub 계정으로 가입 추천)
2. 배포 방법 (둘 중 하나):

   **방법 A — 터미널로 배포 (GitHub 없이 가능, 추천)**
   ```
   npx vercel login
   npx vercel --prod
   ```
   - 질문이 나오면 전부 엔터(기본값)로 진행하면 됨

3. 배포되면 나오는 주소(예: `https://timememo.vercel.app`)를 확인
4. **Vercel에 환경변수 등록** (중요!):
   - Vercel 대시보드 → 내 프로젝트 → **Settings** → **Environment Variables**
   - `VITE_SUPABASE_URL` 과 `VITE_SUPABASE_ANON_KEY` 를 `.env.local`과 같은 값으로 추가
   - 추가 후 **Deployments 탭 → 최신 배포 → ⋯ 메뉴 → Redeploy** (환경변수는 재배포해야 적용됨)
5. **Supabase URL 설정 업데이트**:
   - Authentication → URL Configuration → **Site URL**을 Vercel 주소로 변경
   - **Redirect URLs**에 Vercel 주소 추가 (4단계 참고)

---

## 문제가 생기면

- **로그인은 되는데 메모가 저장 안 됨** → 2단계 SQL이 실행됐는지 확인
- **인증 메일 링크가 localhost로 감** → 4단계 Site URL 확인
- **구글 로그인 후 에러** → 5-1의 리디렉션 URI가 정확한지 확인
- **배포한 사이트가 하얀 화면** → 6-4단계 환경변수 등록 + 재배포 확인

무엇이든 막히면 Claude Code에 그대로 물어보세요!
