# Carpo-Prompt

> 웹 이미지를 한국어·영어 재현 프롬프트로 역복원하는 Chrome(Manifest V3) 확장 프로그램입니다. 본인의 OpenAI 호환 비전 API를 사용합니다.

[English](./README.md)

## 스크린샷

| 이미지 위 버튼 | 분석 중 | 결과 | 공유 카드 |
| :---: | :---: | :---: | :---: |
| <img src="docs/img/02-mouseover.png" width="220" alt="이미지 위 버튼" /> | <img src="docs/img/03-analyzing.png" width="220" alt="분석 중" /> | <img src="docs/img/04-result.png" width="220" alt="결과" /> | <img src="docs/img/01-card.png" width="220" alt="공유 카드" /> |

## 지원 비전 모델 (현시점)

OpenAI 호환 `/chat/completions` 비전 엔드포인트라면 모두 사용할 수 있습니다. 현재 기준 사용/테스트 모델:

- **ChatGPT 5.6** (`gpt-5.6`) — OpenAI
- **Gemini 3.6** (`gemini-3.6`) — Google
- **GLM 5.2** (`glm-5.2`) — 지푸(z.ai)
- **Claude 5** — OpenAI 호환 게이트웨이 경유(Custom)

## 로컬 설치

1. `chrome://extensions`에서 **개발자 모드**를 켭니다.
2. **압축해제된 프로그램 로드**로 이 프로젝트 디렉토리를 선택합니다.
3. Carpo-Prompt 팝업에서 **Provider**(OpenAI · Gemini · GLM-5V · Custom)를 고르고 Base URL, API key, 비전 모델명을 저장합니다:
   - OpenAI — `https://api.openai.com/v1`, 모델 `gpt-5.6` (이미지 생성 모델 아님).
   - Gemini — `https://generativelanguage.googleapis.com/v1beta/openai`, 모델 `gemini-3.6`.
   - GLM-5V — `https://api.z.ai/api/paas/v4`, 모델 `glm-5.2`.
   - Custom — OpenAI 호환 `/chat/completions` 엔드포인트. Claude 5 게이트웨이 포함.
4. 웹 이미지에 마우스 올리기(Prompt 버튼), 툴바에서 **패널 열기**, 또는 이미지/링크 우클릭 → **Carpo-Prompt로 이미지 분석**.

## 기능

- 이미지와 시각 단서 프롬프트를 `{baseUrl}/chat/completions`로 전송합니다.
- 이미지 위 버튼, 툴바 **패널 열기**, 페이지 내 가장 큰 이미지 자동 선택, 우클릭 컨텍스트 메뉴, 이동/최소화 가능한 결과 패널.
- 로컬 이미지 파일, 패널로 드래그&드롭, 화면 영역 캡처.
- 한국어·영어·구조화 JSON 편집 가능 출력; 프롬프트 초안은 로컬 히스토리에 저장.
- 프롬프트와 원본 이미지 복사, PNG 카드 내보내기, ChatGPT Images · Grok Imagine · Gemini · Midjourney · Adobe Firefly · Qwen Image 3.0 으로 자동 전송.
- 프로바이더 특성 처리: Gemini JSON 모드 + reasoning-off, GLM thinking 비활성화, 이미지 재인코딩(WebP/GIF → JPEG), JSON 복구, 언어 버킷 복구, 180초 타임아웃.

## 개인정보

API key는 이 브라우저 프로필의 `chrome.storage.local`에만 보관됩니다. 페이지 DOM에 노출되지 않으며, 사용자가 설정한 HTTPS 엔드포인트로만 전송됩니다. localhost/사설망 이미지 URL을 차단하고, 분석/캡처/내보내기에 짧은 수명의 사용자 작업 확인(capability)을 요구하며, 계정·결제·거래 도메인에서는 실행하지 않습니다.
