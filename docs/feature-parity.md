# Carpo-Prompt 클라이언트 기능 범위

원본 PromptCard v1.3.2에서 계정·호스팅 서비스 의존 기능을 제외하고 재구현한 범위다. 언어 출력은 요청에 맞춰 `ko` / `en` / JSON으로 바꿨다.

| 백업 클라이언트 흐름 | Carpo-Prompt 구현 |
|---|---|
| 웹 이미지 우클릭 분석 | 이미지 및 빈 페이지 우클릭 메뉴. 페이지 메뉴는 가장 큰 가시 이미지를 선택 |
| 이미지 hover 빠른 동작 | 이미지 위 `Prompt` 버튼. 팝업 설정에서 켜고 끌 수 있음 |
| Custom API 설정 및 test | 확장 popup 전용 설정과 API 연결 테스트. OpenAI / Gemini / GLM-5V(z.ai) / Custom provider 프리셋으로 Base URL·추천 모델을 자동 채움 — 페이지 DOM에는 API key를 절대 표시하지 않음 |
| 원격 이미지 전송 | 배경 서비스 워커 fetch, JPEG/PNG 직접 전송, WebP/GIF 재인코딩. 사설망·localhost·자격증명 URL 차단, 20MB/30초 제한 |
| 로컬 이미지 | 파일 선택 및 패널 drop zone |
| 수동 screenshot | 현재 보이는 탭 캡처 후 드래그 영역 crop. 신뢰된 사용자 동작과 단발 capability가 있어야 실행 |
| 결과 언어/JSON 보기 | 한국어, English, 구조화 JSON 탭 |
| 프롬프트 편집과 reset | 한국어/영문 textarea 편집, 원본 복귀 |
| JSON/언어 복구 | JSON repair와 Korean/English bucket repair |
| 결과 히스토리 | `chrome.storage.local` 저장, 재열기·삭제·전체 삭제·편집본 보존 |
| 복사와 이미지 복사 | 활성 프롬프트 복사, Ctrl/Cmd+Shift+C 또는 버튼 이미지 복사 |
| 공유 이미지 | 재현 프롬프트 PNG 카드 생성 및 다운로드 |
| 패널 제어 | 접기/펼치기, 드래그 위치 보존, 최신 결과 다시 열기 |
| 생성기 연동 | ChatGPT Images, Grok Imagine, Gemini, Midjourney, Adobe Firefly, Qwen Image 3.0 새 탭 열기 및 도메인별 허용 selector에만 자동 입력 시도 |

## 보안 경계

- 페이지가 만든 synthetic event는 분석·캡처·복사·생성기 전송을 실행할 수 없다. 각 특권 작업은 신뢰된 사용자 이벤트 뒤에 발급되는 단발 capability가 필요하다.
- Google 계정, Microsoft 로그인, PayPal, Stripe, Wise 및 주요 거래소 도메인에서는 콘텐츠 UI와 분석을 차단한다.
- API endpoint는 HTTPS만 허용한다. 로컬 HTTP endpoint가 필요하면 보안 정책을 별도로 설계해야 하며, 현재 빌드는 의도적으로 지원하지 않는다.
