(() => {
  const SENSITIVE_HOST_SUFFIXES = [
    "accounts.google.com",
    "login.microsoftonline.com",
    "paypal.com",
    "stripe.com",
    "wise.com",
    "coinbase.com",
    "kraken.com"
  ];
  if (isSensitiveLocation()) return;
  const ROOT_ID = `carpo-prompt-root-${chrome.runtime.id}`;
  // 확장을 다시 불러오면 이미 열려 있던 탭의 content script는 고립(orphan) 상태가 됩니다.
  // DOM 호스트와 가드 플래그는 남지만 chrome.runtime 컨텍스트가 무효화되어 메시지
  // 리스너가 죽으므로, 패널 열기/우클릭 분석이 조용히 동작하지 않습니다.
  // 이전 인스턴스가 살아 있으면 건너뛰고, 고립되었으면 호스트를 치우고 새로 인계합니다.
  if (window.__carpoPromptContentLoaded && typeof window.__carpoPromptIsAlive === "function" && window.__carpoPromptIsAlive()) {
    return;
  }
  document.getElementById(ROOT_ID)?.remove();
  window.__carpoPromptContentLoaded = true;
  window.__carpoPromptIsAlive = () => { try { chrome.runtime.getURL(""); return true; } catch { return false; } };
  const HISTORY_KEY = "carpoPromptHistory";
  const UI_KEY = "carpoPromptUi";
  const MAX_HISTORY = 24;
  const logoUrl = chrome.runtime.getURL("icons/icon-48.png");
  const state = {
    status: "hidden",
    tab: "ko",
    target: null,
    analysis: null,
    drafts: null,
    history: [],
    activeHistoryId: null,
    historyOpen: false,
    generatorOpen: false,
    inlineEnabled: true,
    error: "",
    capture: null,
    pendingCapability: null,
    panelPosition: null,
    drag: null
  };
  let root;
  let host;
  let panelHost;
  let inlineButton;
  let fileInput;
  let saveTimer;

  function isSensitiveLocation() {
    const hostname = location.hostname.toLowerCase();
    return SENSITIVE_HOST_SUFFIXES.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`));
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>'"]/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", "\"": "&quot;"
    })[character]);
  }

  function message(payload) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(payload, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response?.ok) {
          reject(new Error(response?.error || "확장 요청에 실패했습니다."));
          return;
        }
        resolve(response.data);
      });
    });
  }

  function ensureRoot() {
    if (root) {
      if (!host?.isConnected) (document.body || document.documentElement).append(host);
      return root;
    }
    host = document.createElement("div");
    host.id = ROOT_ID;
    host.dataset.carpoPromptHost = "";
    root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `
      <button data-carpo-inline class="carpo-inline" type="button" hidden><img src="${logoUrl}" alt="" /><span>Prompt</span></button>
      <div data-carpo-panel></div>
      <input data-carpo-file type="file" accept="image/jpeg,image/jpg,image/png,image/webp,image/gif" hidden />`;
    loadShadowStyles(root);
    (document.body || document.documentElement).append(host);
    panelHost = root.querySelector("[data-carpo-panel]");
    inlineButton = root.querySelector("[data-carpo-inline]");
    fileInput = root.querySelector("[data-carpo-file]");
    root.addEventListener("click", onClick);
    root.addEventListener("input", onInput);
    root.addEventListener("change", onChange);
    root.addEventListener("pointerdown", capturePointerDown);
    root.addEventListener("pointermove", capturePointerMove);
    root.addEventListener("pointerup", capturePointerUp);
    root.addEventListener("dragover", onDragOver);
    root.addEventListener("drop", onDrop);
    fileInput.addEventListener("change", loadLocalFile);
    inlineButton.addEventListener("click", (event) => {
      if (!event.isTrusted) return;
      if (inlineButton._carpoTarget) openForTarget(inlineButton._carpoTarget);
    });
    document.addEventListener("pointermove", inspectImageHover, true);
    document.addEventListener("pointermove", movePanel, true);
    document.addEventListener("pointerup", finishPanelDrag, true);
    hydrate().catch(() => {});
    return root;
  }

  async function loadShadowStyles(shadowRoot) {
    try {
      const response = await fetch(chrome.runtime.getURL("src/content.css"));
      if (!response.ok) throw new Error("stylesheet unavailable");
      const css = await response.text();
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      shadowRoot.adoptedStyleSheets = [...shadowRoot.adoptedStyleSheets, sheet];
    } catch {
      // The UI remains functional even if a browser does not support constructable stylesheets.
    }
  }

  async function hydrate() {
    const stored = await chrome.storage.local.get([HISTORY_KEY, UI_KEY]);
    state.history = Array.isArray(stored[HISTORY_KEY]) ? stored[HISTORY_KEY].filter(validHistoryEntry).slice(0, MAX_HISTORY) : [];
    state.inlineEnabled = stored[UI_KEY]?.inlineEnabled !== false;
    state.panelPosition = validPanelPosition(stored[UI_KEY]?.panelPosition) ? stored[UI_KEY].panelPosition : null;
    updateInlineVisibility();
  }

  function validHistoryEntry(entry) {
    return entry && typeof entry.id === "string" && entry.analysis?.ko?.prompt && entry.analysis?.en?.prompt && entry.target;
  }

  function validPanelPosition(position) {
    return position && Number.isFinite(position.left) && Number.isFinite(position.top);
  }

  function imageTarget(target) {
    const image = Array.from(document.images).find((element) => element.currentSrc === target.src || element.src === target.src);
    return {
      ...target,
      pageUrl: target.pageUrl || location.href,
      alt: target.alt || image?.alt || "",
      naturalWidth: target.naturalWidth || image?.naturalWidth || 0,
      naturalHeight: target.naturalHeight || image?.naturalHeight || 0
    };
  }

  function targetFromImage(image) {
    return {
      src: image.currentSrc || image.src,
      pageUrl: location.href,
      alt: image.alt || "",
      naturalWidth: image.naturalWidth || image.width || 0,
      naturalHeight: image.naturalHeight || image.height || 0
    };
  }

  function openForTarget(target, capability = null) {
    ensureRoot();
    state.target = imageTarget(target);
    state.analysis = null;
    state.drafts = null;
    state.activeHistoryId = null;
    state.error = "";
    state.pendingCapability = capability;
    state.status = "loading";
    state.historyOpen = false;
    render();
    runAnalysis();
  }

  async function runAnalysis() {
    try {
      const capability = takePendingCapability() || await requestCapability("analyze", state.target);
      const analysis = await message({ type: "ANALYZE_IMAGE", target: state.target, capability });
      state.analysis = analysis;
      state.drafts = { ko: analysis.ko.prompt, en: analysis.en.prompt };
      state.activeHistoryId = `analysis-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      state.status = "success";
      await rememberCurrent();
    } catch (error) {
      state.error = error instanceof Error ? error.message : "이미지 분석에 실패했습니다.";
      state.status = /Base URL|API key|모델 이름|설정|HTTPS/.test(state.error) ? "setup" : "error";
    }
    render();
  }

  async function rememberCurrent() {
    if (!state.analysis || !state.target || !state.activeHistoryId) return;
    const target = await compactTarget(state.target);
    const entry = {
      id: state.activeHistoryId,
      createdAt: Date.now(),
      target,
      analysis: state.analysis,
      drafts: state.drafts
    };
    state.history = [entry, ...state.history.filter((item) => item.id !== entry.id)].slice(0, MAX_HISTORY);
    try {
      await chrome.storage.local.set({ [HISTORY_KEY]: state.history });
    } catch {
      // A large local screenshot may exceed storage quota. Keep the result in the active panel.
      state.history = state.history.filter((item) => item.id !== entry.id);
    }
  }

  async function compactTarget(target) {
    if (!String(target.src).startsWith("data:")) return { ...target, thumbnail: target.src };
    const thumbnail = await makeThumbnail(target.src).catch(() => "");
    return { ...target, src: thumbnail || target.src.slice(0, 0), thumbnail };
  }

  function makeThumbnail(src) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => {
        const scale = Math.min(1, 260 / Math.max(image.naturalWidth, image.naturalHeight));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", 0.78));
      };
      image.onerror = reject;
      image.src = src;
    });
  }

  function render() {
    ensureRoot();
    updateInlineVisibility();
    if (state.status === "hidden") {
      panelHost.replaceChildren();
      return;
    }
    if (state.status === "capture") {
      panelHost.innerHTML = captureView();
      return;
    }
    if (state.status === "minimized") {
      panelHost.innerHTML = `<button class="carpo-minimized" type="button" data-action="expand"><img src="${logoUrl}" alt="" /><span>Carpo-Prompt</span></button>`;
      return;
    }
    if (state.status === "loading") {
      panelHost.innerHTML = panelShell("이미지를 역분석하는 중", `
        <div class="carpo-image-row"><img class="carpo-thumb" src="${escapeHtml(state.target?.src || "")}" alt="" /><div><p class="carpo-kicker">IMAGE TO PROMPT</p><h2>시각 단서를 읽고 있어요</h2><p>구도, 조명, 소재와 재현 의도를 분석합니다.</p></div></div>
        <div class="carpo-progress"><i></i></div><p class="carpo-loading-note">API 응답을 기다리는 중입니다.</p>`);
      return;
    }
    if (state.status === "setup") {
      panelHost.innerHTML = setupView();
      return;
    }
    if (state.status === "error") {
      panelHost.innerHTML = panelShell("분석을 완료하지 못했어요", `
        <div class="carpo-error"><p class="carpo-kicker">ANALYSIS ERROR</p><h2>다시 확인해 주세요</h2><p>${escapeHtml(state.error)}</p><div class="carpo-actions"><button class="carpo-button secondary" type="button" data-action="close">닫기</button><button class="carpo-button primary" type="button" data-action="retry">다시 분석</button></div></div>`);
      return;
    }
    if (state.status === "ready") {
      panelHost.innerHTML = readyView();
      return;
    }
    panelHost.innerHTML = successView();
  }

  function panelShell(subtitle, content, className = "") {
    const position = state.panelPosition;
    const style = validPanelPosition(position) ? `style="left:${Math.round(position.left)}px;top:${Math.round(position.top)}px;right:auto;bottom:auto"` : "";
    return `<aside class="carpo-panel ${className}" ${style} role="dialog" aria-label="Carpo-Prompt">${panelHeader(subtitle)}${content}</aside>`;
  }

  function panelHeader(subtitle) {
    return `<header class="carpo-header"><div class="carpo-brand" data-drag-handle><img src="${logoUrl}" alt="" /><div><strong>Carpo-Prompt</strong><span>${escapeHtml(subtitle)}</span></div></div><div class="carpo-head-actions"><button class="carpo-text-button" type="button" data-action="settings">설정</button><button class="carpo-text-button" type="button" data-action="minimize">접기</button><button class="carpo-text-button" type="button" data-action="close">닫기</button></div></header>`;
  }

  function setupView() {
    return panelShell("Custom vision API 설정", `
      <section class="carpo-setup"><p class="carpo-kicker">CUSTOM API</p><h2>확장 아이콘에서 연결해 주세요</h2><p>API key는 웹페이지에 표시하지 않습니다. 브라우저 툴바의 Carpo-Prompt 아이콘을 열어 Base URL, API key, Vision model을 저장한 뒤 다시 분석하세요.</p>
        <p class="carpo-help">${escapeHtml(state.error || "API 설정은 popup에서만 관리됩니다.")}</p><div class="carpo-actions"><button class="carpo-button secondary" type="button" data-action="close">닫기</button><button class="carpo-button primary" type="button" data-action="retry">설정 완료 후 다시 분석</button></div>
      </section>`);
  }

  function readyView() {
    return panelShell("이미지를 불러오세요", `
      <div class="carpo-preview"><img src="${logoUrl}" alt="" /><div><p class="carpo-kicker">IMAGE TO PROMPT</p><h2>분석할 이미지 선택</h2><p>로컬 파일, 화면 캡처, 또는 히스토리에서 선택하세요.</p></div></div>
      <div class="carpo-tool-row"><button type="button" data-action="local">로컬 이미지</button><button type="button" data-action="screenshot">화면 캡처</button><button type="button" data-action="history">히스토리 ${state.history.length ? `(${state.history.length})` : ""}</button></div>
      <div class="carpo-drop-zone" data-drop-zone>이미지 파일을 이곳에 끌어 놓아 바로 분석</div>
      ${state.historyOpen ? historyView() : ""}`);
  }

  function successView() {
    const activeText = activeOutput();
    const tags = state.tab === "ko" ? state.analysis.ko_style_tags : state.tab === "en" ? state.analysis.en_style_tags : [];
    const analysis = state.tab === "ko" ? state.analysis.ko.analysis : state.tab === "en" ? state.analysis.en.analysis : "";
    const imageSrc = escapeHtml(state.target?.src || state.target?.thumbnail || "");
    const editor = state.tab === "json"
      ? `<section class="carpo-output"><pre>${escapeHtml(activeText)}</pre></section>`
      : `<textarea class="carpo-editor" data-editor="${state.tab}" spellcheck="false">${escapeHtml(activeText)}</textarea>`;
    return panelShell("재현 프롬프트 준비 완료", `
      <div class="carpo-preview"><img src="${imageSrc}" alt="" /><div><p class="carpo-kicker">IMAGE TO PROMPT</p><h2>재현 프롬프트</h2><p>${escapeHtml(state.target?.naturalWidth ? `${state.target.naturalWidth} × ${state.target.naturalHeight}` : "저장된 분석 결과")}</p></div></div>
      <div class="carpo-tool-row"><button type="button" data-action="local">로컬 이미지</button><button type="button" data-action="screenshot">화면 캡처</button><button type="button" data-action="image-copy">이미지 복사</button><button type="button" data-action="share">카드 저장</button><button type="button" data-action="history">히스토리 ${state.history.length ? `(${state.history.length})` : ""}</button></div>
      <div class="carpo-drop-zone" data-drop-zone>이미지 파일을 이곳에 끌어 놓아 바로 분석</div>
      <nav class="carpo-tabs" aria-label="출력 언어"><button type="button" data-action="tab" data-tab="ko" class="${state.tab === "ko" ? "active" : ""}">한국어</button><button type="button" data-action="tab" data-tab="en" class="${state.tab === "en" ? "active" : ""}">English</button><button type="button" data-action="tab" data-tab="json" class="${state.tab === "json" ? "active" : ""}">JSON</button></nav>
      ${tags.length ? `<div class="carpo-tags">${tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join("")}</div>` : ""}
      ${editor}
      ${state.analysis.negative_prompt ? `<div class="carpo-negative"><span>${escapeHtml(state.analysis.negative_prompt)}</span><button type="button" data-action="copy-negative">복사</button></div>` : ""}
      ${analysis ? `<section class="carpo-analysis"><p class="carpo-kicker">ANALYSIS</p><p>${escapeHtml(analysis)}</p></section>` : ""}
      <div class="carpo-actions"><button class="carpo-button secondary" type="button" data-action="reset">원본으로 되돌리기</button><button class="carpo-button secondary" type="button" data-action="copy-active">현재 내용 복사</button><button class="carpo-button primary" type="button" data-action="generator-toggle">생성기에 보내기</button></div>
      ${state.generatorOpen ? generatorView() : ""}
      <details class="carpo-details"><summary>추가 프롬프트 보기</summary><div><h3>Recreation prompt</h3><p>${escapeHtml(state.analysis.recreation_prompt || "제공되지 않음")}</p><h3>Prompt core</h3><p>${escapeHtml(state.analysis.prompt_core || "제공되지 않음")}</p><h3>Negative prompt</h3><p>${escapeHtml(state.analysis.negative_prompt || "제공되지 않음")}</p></div></details>
      ${state.historyOpen ? historyView() : ""}`);
  }

  function generatorView() {
    return `<section class="carpo-generator"><p class="carpo-kicker">SEND TO GENERATOR</p><div><button type="button" data-action="generator" data-generator="chatgpt">ChatGPT Images</button><button type="button" data-action="generator" data-generator="grok">Grok Imagine</button><button type="button" data-action="generator" data-generator="gemini">Gemini</button><button type="button" data-action="generator" data-generator="midjourney">Midjourney</button><button type="button" data-action="generator" data-generator="firefly">Adobe Firefly</button><button type="button" data-action="generator" data-generator="qwen">Qwen Image 3.0</button></div></section>`;
  }

  function historyView() {
    const items = state.history.map((entry) => `<li class="${entry.id === state.activeHistoryId ? "active" : ""}"><button type="button" data-action="history-open" data-history-id="${escapeHtml(entry.id)}"><img src="${escapeHtml(entry.target.thumbnail || entry.target.src || "")}" alt="" /><span>${escapeHtml(new Date(entry.createdAt).toLocaleString())}</span></button><button class="carpo-history-delete" type="button" data-action="history-delete" data-history-id="${escapeHtml(entry.id)}">삭제</button></li>`).join("");
    return `<section class="carpo-history"><header><strong>히스토리</strong><div><button type="button" data-action="history-close">닫기</button><button type="button" data-action="history-clear">전체 삭제</button></div></header>${items ? `<ul>${items}</ul>` : "<p>저장된 분석이 없습니다.</p>"}</section>`;
  }

  function captureView() {
    return `<div class="carpo-capture" data-capture><div class="carpo-capture-guide"><strong>분석할 영역을 드래그하세요</strong><span>Esc 또는 취소를 누르면 돌아갑니다.</span><button type="button" data-action="capture-cancel">취소</button></div><div class="carpo-capture-selection" data-capture-selection hidden></div></div>`;
  }

  function activeOutput() {
    if (state.tab === "ko") return state.drafts.ko;
    if (state.tab === "en") return state.drafts.en;
    return JSON.stringify({
      ko: { ...state.analysis.ko, prompt: state.drafts.ko },
      en: { ...state.analysis.en, prompt: state.drafts.en },
      ko_style_tags: state.analysis.ko_style_tags,
      en_style_tags: state.analysis.en_style_tags,
      json_prompt: state.analysis.json_prompt,
      recreation_prompt: state.analysis.recreation_prompt,
      prompt_core: state.analysis.prompt_core,
      negative_prompt: state.analysis.negative_prompt
    }, null, 2);
  }

  function closePanel() {
    state.status = "hidden";
    state.generatorOpen = false;
    state.historyOpen = false;
    state.capture = null;
    render();
  }

  function onClick(event) {
    if (!event.isTrusted) return;
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const action = button.dataset.action;
    if (action === "close") closePanel();
    if (action === "minimize") { state.status = "minimized"; render(); }
    if (action === "expand") { state.status = state.analysis ? "success" : "hidden"; render(); }
    if (action === "retry") {
      if (!state.target?.src) { state.status = "ready"; render(); return; }
      state.status = "loading"; render(); runAnalysis();
    }
    if (action === "settings") { state.status = "setup"; state.error = ""; render(); }
    if (action === "tab") { state.tab = button.dataset.tab; render(); }
    if (action === "copy-active") copyText(activeOutput(), button);
    if (action === "copy-negative") copyText(state.analysis?.negative_prompt || "", button);
    if (action === "reset") { state.drafts = { ko: state.analysis.ko.prompt, en: state.analysis.en.prompt }; persistDrafts(); render(); }
    if (action === "local") fileInput.click();
    if (action === "screenshot") beginCapture();
    if (action === "image-copy") copyImage();
    if (action === "share") downloadShareCard();
    if (action === "history") { state.historyOpen = !state.historyOpen; render(); }
    if (action === "history-close") { state.historyOpen = false; render(); }
    if (action === "history-clear") clearHistory();
    if (action === "history-delete") deleteHistory(button.dataset.historyId);
    if (action === "history-open") openHistory(button.dataset.historyId);
    if (action === "generator-toggle") { state.generatorOpen = !state.generatorOpen; render(); }
    if (action === "generator") sendToGenerator(button.dataset.generator);
    if (action === "capture-cancel") { state.capture = null; state.status = state.analysis ? "success" : "hidden"; render(); }
  }

  function onInput(event) {
    if (!event.isTrusted) return;
    const editor = event.target.closest("textarea[data-editor]");
    if (!editor || !state.drafts) return;
    state.drafts[editor.dataset.editor] = editor.value;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(persistDrafts, 350);
  }

  function onChange(event) {
    if (!event.isTrusted) return;
    const toggle = event.target.closest("input[data-inline-toggle]");
    if (!toggle) return;
    state.inlineEnabled = toggle.checked;
    persistUi();
    updateInlineVisibility();
  }

  async function persistDrafts() {
    if (!state.activeHistoryId || !state.drafts) return;
    const entry = state.history.find((item) => item.id === state.activeHistoryId);
    if (!entry) return;
    entry.drafts = { ...state.drafts };
    try { await chrome.storage.local.set({ [HISTORY_KEY]: state.history }); } catch {}
  }

  async function copyText(text, button) {
    try {
      await navigator.clipboard.writeText(text || "");
      const original = button.textContent;
      button.textContent = "복사됨";
      setTimeout(() => { button.textContent = original; }, 1300);
    } catch (error) {
      toast("클립보드에 복사하지 못했습니다.", "error");
    }
  }

  async function copyImage() {
    try {
      const capability = await requestCapability("fetch", { src: state.target.src });
      const dataUrl = await message({ type: "FETCH_IMAGE_DATA", src: state.target.src, capability });
      const blob = await (await fetch(dataUrl)).blob();
      await navigator.clipboard.write([new ClipboardItem({ [blob.type || "image/png"]: blob })]);
      toast("이미지를 클립보드에 복사했습니다.");
    } catch (error) {
      toast("이미지 복사를 지원하지 않는 페이지 또는 브라우저입니다.", "error");
    }
  }

  async function loadLocalFile(event) {
    if (!event?.isTrusted) return;
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (!file) return;
    await openLocalFile(file);
  }

  async function openLocalFile(file) {
    if (!file.type.startsWith("image/")) { toast("이미지 파일만 선택할 수 있습니다.", "error"); return; }
    try {
      const src = await readFile(file);
      const dimensions = await imageDimensions(src);
      openForTarget({ src, pageUrl: location.href, alt: file.name, naturalWidth: dimensions.width, naturalHeight: dimensions.height });
    } catch {
      toast("로컬 이미지를 읽지 못했습니다.", "error");
    }
  }

  function hasImageFile(dataTransfer) {
    return Array.from(dataTransfer?.files || []).some((file) => file.type.startsWith("image/"));
  }

  function onDragOver(event) {
    if (!event.isTrusted) return;
    if (!event.target.closest?.("[data-drop-zone]") || !hasImageFile(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    event.target.closest("[data-drop-zone]").classList.add("dragging");
  }

  function onDrop(event) {
    if (!event.isTrusted) return;
    const zone = event.target.closest?.("[data-drop-zone]");
    if (!zone || !hasImageFile(event.dataTransfer)) return;
    event.preventDefault();
    zone.classList.remove("dragging");
    const file = Array.from(event.dataTransfer.files).find((candidate) => candidate.type.startsWith("image/"));
    if (file) openLocalFile(file);
  }

  function readFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  function imageDimensions(src) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
      image.onerror = reject;
      image.src = src;
    });
  }

  async function beginCapture() {
    try {
      state.status = "hidden";
      render();
      const capability = await requestCapability("capture");
      const image = await message({ type: "CAPTURE_VISIBLE_TAB", capability });
      state.capture = { image, start: null, end: null };
      state.status = "capture";
      render();
    } catch (error) {
      state.error = error instanceof Error ? error.message : "화면을 캡처하지 못했습니다.";
      toast(state.error, "error");
      state.status = state.analysis ? "success" : "error";
      render();
    }
  }

  function capturePointerDown(event) {
    if (!event.isTrusted) return;
    if (state.status !== "capture" || !event.target.closest("[data-capture]")) return;
    if (event.target.closest("button")) return;
    state.capture.start = { x: event.clientX, y: event.clientY };
    state.capture.end = { ...state.capture.start };
    updateCaptureSelection();
  }

  function capturePointerMove(event) {
    if (!event.isTrusted) return;
    if (state.status !== "capture" || !state.capture?.start) return;
    state.capture.end = { x: event.clientX, y: event.clientY };
    updateCaptureSelection();
  }

  function capturePointerUp(event) {
    if (!event.isTrusted) return;
    if (state.status !== "capture" || !state.capture?.start) return;
    state.capture.end = { x: event.clientX, y: event.clientY };
    const box = captureBox();
    state.capture.start = null;
    if (box.width < 18 || box.height < 18) { updateCaptureSelection(); return; }
    cropCapture(box).catch(() => { toast("선택한 영역을 준비하지 못했습니다.", "error"); });
  }

  function captureBox() {
    const { start, end } = state.capture;
    const left = Math.min(start.x, end.x);
    const top = Math.min(start.y, end.y);
    return { left, top, width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) };
  }

  function updateCaptureSelection() {
    const node = root.querySelector("[data-capture-selection]");
    if (!node) return;
    if (!state.capture?.start || !state.capture?.end) { node.hidden = true; return; }
    const box = captureBox();
    node.hidden = false;
    Object.assign(node.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` });
  }

  async function cropCapture(box) {
    const image = await loadImage(state.capture.image);
    const scaleX = image.naturalWidth / window.innerWidth;
    const scaleY = image.naturalHeight / window.innerHeight;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(box.width * scaleX));
    canvas.height = Math.max(1, Math.round(box.height * scaleY));
    canvas.getContext("2d").drawImage(image, box.left * scaleX, box.top * scaleY, box.width * scaleX, box.height * scaleY, 0, 0, canvas.width, canvas.height);
    const src = canvas.toDataURL("image/jpeg", 0.92);
    state.capture = null;
    openForTarget({ src, pageUrl: location.href, alt: "Screenshot selection", naturalWidth: canvas.width, naturalHeight: canvas.height });
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = src;
    });
  }

  async function sendToGenerator(siteId) {
    const prompt = state.analysis.recreation_prompt || state.drafts.en;
    try {
      const capability = await requestCapability("generator");
      await message({ type: "OPEN_GENERATOR_SITE", siteId, prompt, capability });
      toast("생성기 탭을 열고 프롬프트 입력을 시도했습니다.");
      state.generatorOpen = false;
      render();
    } catch (error) {
      toast(error instanceof Error ? error.message : "생성기 페이지를 열지 못했습니다.", "error");
    }
  }

  async function openHistory(id) {
    const entry = state.history.find((item) => item.id === id);
    if (!entry) return;
    state.target = { ...entry.target, src: entry.target.src || entry.target.thumbnail || "" };
    state.analysis = entry.analysis;
    state.drafts = entry.drafts || { ko: entry.analysis.ko.prompt, en: entry.analysis.en.prompt };
    state.activeHistoryId = entry.id;
    state.status = "success";
    state.historyOpen = false;
    render();
  }

  async function deleteHistory(id) {
    state.history = state.history.filter((entry) => entry.id !== id);
    if (state.activeHistoryId === id) state.activeHistoryId = null;
    await chrome.storage.local.set({ [HISTORY_KEY]: state.history });
    render();
  }

  async function clearHistory() {
    state.history = [];
    state.activeHistoryId = null;
    await chrome.storage.local.set({ [HISTORY_KEY]: [] });
    render();
  }

  async function downloadShareCard() {
    try {
      const capability = await requestCapability("fetch", { src: state.target.src });
      const imageData = await message({ type: "FETCH_IMAGE_DATA", src: state.target.src, capability });
      const source = await loadImage(imageData);
      const canvas = document.createElement("canvas");
      canvas.width = 1600;
      canvas.height = 900;
      const context = canvas.getContext("2d");
      context.fillStyle = "#151516";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = "#ff7417";
      context.fillRect(0, 0, 18, canvas.height);
      const size = Math.min(560 / source.naturalWidth, 560 / source.naturalHeight);
      const drawWidth = source.naturalWidth * size;
      const drawHeight = source.naturalHeight * size;
      context.drawImage(source, 72 + (560 - drawWidth) / 2, 170 + (560 - drawHeight) / 2, drawWidth, drawHeight);
      context.fillStyle = "#ff9a51";
      context.font = "700 24px system-ui";
      context.fillText("CARPO-PROMPT", 700, 112);
      context.fillStyle = "#f6f2ed";
      context.font = "700 44px system-ui";
      context.fillText("Image recreation prompt", 700, 170);
      context.fillStyle = "#d7d2cc";
      context.font = "26px system-ui";
      drawWrappedText(context, state.analysis.recreation_prompt || state.drafts.en, 700, 230, 780, 40, 13);
      context.fillStyle = "#77716c";
      context.font = "22px system-ui";
      context.fillText("Korean + English visual reconstruction", 700, 820);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      if (!blob) throw new Error("카드 이미지를 만들지 못했습니다.");
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `carpo-prompt-${Date.now()}.png`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast("프롬프트 카드를 저장했습니다.");
    } catch {
      toast("카드 이미지를 저장하지 못했습니다.", "error");
    }
  }

  function drawWrappedText(context, text, x, y, maxWidth, lineHeight, maxLines) {
    const words = String(text || "").split(/\s+/);
    let line = "";
    let lineNumber = 0;
    for (const word of words) {
      const test = line ? `${line} ${word}` : word;
      if (context.measureText(test).width > maxWidth && line) {
        context.fillText(line, x, y + lineNumber * lineHeight);
        line = word;
        lineNumber += 1;
        if (lineNumber >= maxLines) return;
      } else line = test;
    }
    if (line && lineNumber < maxLines) context.fillText(line, x, y + lineNumber * lineHeight);
  }

  function inspectImageHover(event) {
    if (!event.isTrusted) return;
    if (!state.inlineEnabled || state.status === "capture") return;
    if (event.composedPath().includes(host)) return;
    const image = event.target instanceof Element ? event.target.closest("img") : null;
    if (!image || !image.complete || image.naturalWidth < 80 || image.naturalHeight < 80) { hideInline(); return; }
    const rect = image.getBoundingClientRect();
    if (rect.width < 48 || rect.height < 48 || rect.bottom < 0 || rect.right < 0 || rect.top > innerHeight || rect.left > innerWidth) { hideInline(); return; }
    inlineButton._carpoTarget = targetFromImage(image);
    inlineButton.style.left = `${Math.max(8, Math.min(innerWidth - 106, rect.right - 98))}px`;
    inlineButton.style.top = `${Math.max(8, Math.min(innerHeight - 40, rect.top + 8))}px`;
    inlineButton.hidden = false;
  }

  function hideInline() {
    if (inlineButton) inlineButton.hidden = true;
  }

  function updateInlineVisibility() {
    if (!state.inlineEnabled) hideInline();
  }

  function beginPanelDrag(event) {
    if (!event.isTrusted) return;
    const handle = event.target.closest?.("[data-drag-handle]");
    const panel = event.target.closest?.(".carpo-panel");
    if (!handle || !panel || event.button !== 0 || state.status === "capture") return;
    const rect = panel.getBoundingClientRect();
    state.drag = { offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top };
    panel.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }

  function movePanel(event) {
    if (!state.drag) return;
    const panel = root.querySelector(".carpo-panel");
    if (!panel) return;
    const left = Math.max(8, Math.min(window.innerWidth - Math.min(panel.offsetWidth, window.innerWidth - 16) - 8, event.clientX - state.drag.offsetX));
    const top = Math.max(8, Math.min(window.innerHeight - Math.min(panel.offsetHeight, window.innerHeight - 16) - 8, event.clientY - state.drag.offsetY));
    state.panelPosition = { left, top };
    Object.assign(panel.style, { left: `${left}px`, top: `${top}px`, right: "auto", bottom: "auto" });
  }

  function finishPanelDrag() {
    if (!state.drag) return;
    state.drag = null;
    persistUi();
  }

  function persistUi() {
    chrome.storage.local.set({ [UI_KEY]: { inlineEnabled: state.inlineEnabled, panelPosition: state.panelPosition } }).catch(() => {});
  }

  function toast(text, tone = "") {
    let node = root?.querySelector("[data-carpo-toast]");
    if (!node) {
      node = document.createElement("div");
      node.dataset.carpoToast = "";
      node.className = "carpo-toast";
      root.append(node);
    }
    node.textContent = text;
    node.dataset.tone = tone;
    node.hidden = false;
    clearTimeout(node._carpoTimer);
    node._carpoTimer = setTimeout(() => { node.hidden = true; }, 2700);
  }

  async function autofillGenerator(prompt) {
    ensureRoot();
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const field = findGeneratorField();
      if (field) {
        setFieldValue(field, prompt);
        toast("Carpo-Prompt가 프롬프트를 입력했습니다.");
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    toast("지원되는 생성 프롬프트 입력창을 찾지 못했습니다.", "error");
  }

  function findGeneratorField() {
    const selectors = generatorSelectorsFor(location.hostname);
    if (!selectors.length) return null;
    const candidates = selectors.flatMap((selector) => [...document.querySelectorAll(selector)]);
    return candidates.find((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 80 && rect.height > 24 && !element.closest(`#${ROOT_ID}`);
    });
  }

  function setFieldValue(field, value) {
    field.focus();
    if (field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement) {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")?.set;
      setter?.call(field, value);
    } else {
      field.textContent = value;
    }
    field.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
  }

  document.addEventListener("keydown", (event) => {
    if (!event.isTrusted) return;
    if (event.key === "Escape" && state.status === "capture") {
      state.capture = null;
      state.status = state.analysis ? "success" : "hidden";
      render();
    }
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "c" && state.analysis) {
      event.preventDefault();
      copyImage();
    }
  }, true);

  chrome.runtime.onMessage.addListener((messageData) => {
    if (messageData?.type === "CARPO_PROMPT_OPEN" && messageData.target && typeof messageData.capability === "string") openForTarget(messageData.target, messageData.capability);
    if (messageData?.type === "CARPO_PROMPT_ANALYZE_CURRENT_PAGE") {
      const image = Array.from(document.images)
        .filter((candidate) => candidate.complete && candidate.naturalWidth >= 80 && candidate.naturalHeight >= 80)
        .map((candidate) => ({ candidate, area: candidate.getBoundingClientRect().width * candidate.getBoundingClientRect().height }))
        .sort((a, b) => b.area - a.area)[0]?.candidate;
      if (image && typeof messageData.capability === "string") openForTarget(targetFromImage(image), messageData.capability);
      else { ensureRoot(); toast("분석할 수 있는 이미지를 현재 페이지에서 찾지 못했습니다.", "error"); }
    }
    if (messageData?.type === "CARPO_PROMPT_OPEN_LATEST") openLatestHistory();
    if (messageData?.type === "CARPO_PROMPT_OPEN_READY") openReadyPanel();
    if (messageData?.type === "CARPO_PROMPT_AUTOFILL" && typeof messageData.prompt === "string" && isKnownGeneratorHost(location.hostname)) autofillGenerator(messageData.prompt);
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (changes[UI_KEY]) {
      state.inlineEnabled = changes[UI_KEY].newValue?.inlineEnabled !== false;
      updateInlineVisibility();
    }
  });

  ensureRoot();
  root.addEventListener("pointerdown", beginPanelDrag);

  async function requestCapability(action, target = null) {
    const response = await message({ type: "REQUEST_ACTION_CAPABILITY", action, target });
    if (typeof response?.capability !== "string") throw new Error("보안 권한을 준비하지 못했습니다. 다시 시도하세요.");
    return response.capability;
  }

  function takePendingCapability() {
    const capability = state.pendingCapability;
    state.pendingCapability = null;
    return capability;
  }

  function isKnownGeneratorHost(hostname) {
    return generatorSelectorsFor(hostname).length > 0;
  }

  function generatorSelectorsFor(hostname) {
    const hostName = String(hostname || "").toLowerCase();
    const maps = [
      [/^(chatgpt\.com|chat\.openai\.com)$/, ["#prompt-textarea", "textarea[placeholder*='Message']"]],
      [/^(grok\.com|x\.com)$/, ["textarea[placeholder*='Ask']", "[contenteditable='true'][role='textbox']"]],
      [/^gemini\.google\.com$/, ["rich-textarea [contenteditable='true']", "[contenteditable='true'][aria-label*='prompt' i]"]],
      [/^www\.midjourney\.com$/, ["textarea[placeholder*='Imagine']", "textarea[data-testid*='prompt']"]],
      [/^firefly\.adobe\.com$/, ["textarea[placeholder*='prompt' i]", "[contenteditable='true'][aria-label*='prompt' i]"]],
      [/^(chat\.)?qwen\.ai$/, ["textarea[placeholder*='message' i]", "[contenteditable='true'][role='textbox']"]]
    ];
    return maps.find(([pattern]) => pattern.test(hostName))?.[1] || [];
  }

  function openReadyPanel() {
    ensureRoot();
    state.target = null;
    state.analysis = null;
    state.drafts = null;
    state.activeHistoryId = null;
    state.error = "";
    state.capture = null;
    state.historyOpen = false;
    state.status = "ready";
    render();
  }

  async function openLatestHistory() {
    ensureRoot();
    if (!state.history.length) {
      const stored = await chrome.storage.local.get(HISTORY_KEY);
      state.history = Array.isArray(stored[HISTORY_KEY]) ? stored[HISTORY_KEY].filter(validHistoryEntry).slice(0, MAX_HISTORY) : [];
    }
    if (state.history[0]) openHistory(state.history[0].id);
    else toast("저장된 분석 결과가 없습니다.", "error");
  }
})();
