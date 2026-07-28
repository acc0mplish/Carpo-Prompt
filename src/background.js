import { SYSTEM_PROMPT, buildAnalysisText } from "./prompt.js";

const SETTINGS_KEY = "carpoPromptSettings";
const ALLOWED_PROVIDERS = ["openai", "gemini", "glm", "custom"];
const TIMEOUT_MS = 180_000;
const IMAGE_FETCH_TIMEOUT_MS = 30_000;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_CAPTURE_BYTES = 20 * 1024 * 1024;
const MAX_API_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_DECODED_PIXELS = 40_000_000;
const CAPABILITY_TTL_MS = 20_000;
const DIRECT_IMAGE_TYPES = new Set(["image/jpeg", "image/jpg", "image/png"]);
const SUPPORTED_IMAGE_TYPES = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif"]);
const MENU_ID = "carpo-prompt-analyze-image";
const ACTION_CAPABILITIES = new Map();
const SENSITIVE_HOST_SUFFIXES = [
  "accounts.google.com",
  "login.microsoftonline.com",
  "paypal.com",
  "stripe.com",
  "wise.com",
  "coinbase.com",
  "kraken.com"
];
const GENERATOR_SITES = {
  chatgpt: "https://chatgpt.com/",
  grok: "https://grok.com/",
  gemini: "https://gemini.google.com/app",
  midjourney: "https://www.midjourney.com/imagine",
  firefly: "https://firefly.adobe.com/",
  qwen: "https://chat.qwen.ai/"
};

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: MENU_ID,
    title: "Carpo-Prompt로 이미지 분석",
    contexts: ["image", "page", "link"]
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab?.id) return;
  if (isSensitiveUrl(tab.url)) return;
  if (!info.srcUrl) {
    const capability = issueCapability({ tabId: tab.id, frameId: 0, action: "analyze", target: null });
    chrome.tabs.sendMessage(tab.id, { type: "CARPO_PROMPT_ANALYZE_CURRENT_PAGE", capability }).catch(() => {});
    return;
  }
  openPanel(tab.id, { src: info.srcUrl, pageUrl: tab.url || "", alt: "", naturalWidth: 0, naturalHeight: 0 }).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isOwnExtensionMessage(sender)) return false;

  if (message?.type === "REQUEST_ACTION_CAPABILITY") {
    try {
      const context = contentSenderContext(sender);
      if (!isAllowedAction(message.action)) throw new Error("지원하지 않는 보안 작업입니다.");
      const capability = issueCapability({ ...context, action: message.action, target: message.target || null });
      sendResponse({ ok: true, data: { capability } });
    } catch (error) {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : "보안 권한을 준비하지 못했습니다." });
    }
    return false;
  }

  if (message?.type === "ANALYZE_IMAGE") {
    try {
      consumeCapability(sender, message.capability, "analyze", message.target);
      analyzeImage(message.target)
      .then((analysis) => sendResponse({ ok: true, data: analysis }))
      .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : "Image analysis failed." }));
    } catch (error) {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : "분석 권한을 확인하지 못했습니다." });
    }
    return true;
  }

  if (message?.type === "TEST_CONNECTION") {
    testConnection(message.settings)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : "Connection test failed." }));
    return true;
  }

  if (message?.type === "FETCH_IMAGE_DATA") {
    try {
      consumeCapability(sender, message.capability, "fetch", { src: message.src });
      imageToDataUrl(message.src)
      .then((dataUrl) => sendResponse({ ok: true, data: dataUrl }))
      .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : "이미지를 준비하지 못했습니다." }));
    } catch (error) {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : "이미지 접근 권한을 확인하지 못했습니다." });
    }
    return true;
  }

  if (message?.type === "CAPTURE_VISIBLE_TAB") {
    try {
      consumeCapability(sender, message.capability, "capture");
      captureVisibleTab(sender)
      .then((dataUrl) => sendResponse({ ok: true, data: dataUrl }))
      .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : "화면을 캡처하지 못했습니다." }));
    } catch (error) {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : "화면 캡처 권한을 확인하지 못했습니다." });
    }
    return true;
  }

  if (message?.type === "OPEN_GENERATOR_SITE") {
    try {
      consumeCapability(sender, message.capability, "generator");
      openGenerator(message.siteId, message.prompt)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : "생성기 페이지를 열지 못했습니다." }));
    } catch (error) {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : "생성기 전송 권한을 확인하지 못했습니다." });
    }
    return true;
  }

  if (message?.type === "OPEN_ACTIVE_PANEL" || message?.type === "ANALYZE_CURRENT_PAGE" || message?.type === "OPEN_PANEL") {
    const targetType = message.type === "OPEN_ACTIVE_PANEL" ? "CARPO_PROMPT_OPEN_LATEST"
      : message.type === "ANALYZE_CURRENT_PAGE" ? "CARPO_PROMPT_ANALYZE_CURRENT_PAGE"
      : "CARPO_PROMPT_OPEN_READY";
    sendToActiveTab(targetType)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : "현재 탭을 열지 못했습니다." }));
    return true;
  }

  return false;
});

async function openPanel(tabId, target) {
  const tab = await chrome.tabs.get(tabId);
  if (isSensitiveUrl(tab.url)) throw new Error("민감한 페이지에서는 Carpo-Prompt를 실행하지 않습니다.");
  const capability = issueCapability({ tabId, frameId: 0, action: "analyze", target });
  try {
    await chrome.tabs.sendMessage(tabId, { type: "CARPO_PROMPT_OPEN", target, capability });
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["src/content.js"] });
    await chrome.tabs.sendMessage(tabId, { type: "CARPO_PROMPT_OPEN", target, capability });
  }
}

async function sendToActiveTab(type) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("현재 탭을 찾지 못했습니다.");
  if (isSensitiveUrl(tab.url)) throw new Error("민감한 페이지에서는 Carpo-Prompt를 실행하지 않습니다.");
  const capability = type === "CARPO_PROMPT_ANALYZE_CURRENT_PAGE"
    ? issueCapability({ tabId: tab.id, frameId: 0, action: "analyze", target: null })
    : null;
  const message = capability ? { type, capability } : { type };
  try {
    await chrome.tabs.sendMessage(tab.id, message);
  } catch {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["src/content.js"] });
    await chrome.tabs.sendMessage(tab.id, message);
  }
}

async function captureVisibleTab(sender) {
  if (!sender.tab?.windowId) throw new Error("현재 탭 정보를 찾지 못했습니다.");
  const dataUrl = await chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: "png" });
  if (!dataUrl) throw new Error("현재 화면을 캡처하지 못했습니다.");
  if (dataUrlByteLength(dataUrl) > MAX_CAPTURE_BYTES) throw new Error("캡처 이미지가 너무 큽니다. 더 작은 화면 또는 영역을 사용하세요.");
  return dataUrl;
}

async function openGenerator(siteId, prompt) {
  const url = GENERATOR_SITES[siteId];
  if (!url) throw new Error("지원하지 않는 생성기입니다.");
  if (typeof prompt !== "string" || !prompt.trim()) throw new Error("전달할 프롬프트가 없습니다.");
  const tab = await chrome.tabs.create({ url, active: true });
  if (!tab.id) throw new Error("생성기 탭을 열지 못했습니다.");
  await waitForTab(tab.id);
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "CARPO_PROMPT_AUTOFILL", prompt: prompt.trim() });
  } catch {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["src/content.js"] });
    await chrome.tabs.sendMessage(tab.id, { type: "CARPO_PROMPT_AUTOFILL", prompt: prompt.trim() });
  }
}

function waitForTab(tabId) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
      resolve();
    };
    const onUpdated = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") finish();
    };
    const timer = setTimeout(finish, 15_000);
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

function isOwnExtensionMessage(sender) {
  return sender?.id === chrome.runtime.id;
}

function contentSenderContext(sender) {
  if (!sender?.tab?.id) throw new Error("이 작업은 현재 웹페이지에서만 실행할 수 있습니다.");
  if (isSensitiveUrl(sender.tab.url)) throw new Error("민감한 페이지에서는 Carpo-Prompt를 실행하지 않습니다.");
  return {
    tabId: sender.tab.id,
    frameId: Number.isInteger(sender.frameId) ? sender.frameId : 0,
    documentId: typeof sender.documentId === "string" ? sender.documentId : null
  };
}

function isAllowedAction(action) {
  return ["analyze", "fetch", "capture", "generator"].includes(action);
}

function issueCapability({ tabId, frameId = 0, documentId = null, action, target = null }) {
  if (!isAllowedAction(action)) throw new Error("지원하지 않는 보안 작업입니다.");
  purgeExpiredCapabilities();
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const capability = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  ACTION_CAPABILITIES.set(capability, {
    tabId,
    frameId,
    documentId,
    action,
    targetFingerprint: target ? fingerprintTarget(target) : null,
    expiresAt: Date.now() + CAPABILITY_TTL_MS
  });
  return capability;
}

function consumeCapability(sender, capability, action, target = null) {
  const context = contentSenderContext(sender);
  if (typeof capability !== "string") throw new Error("사용자 작업 확인이 만료되었습니다. 다시 시도하세요.");
  const record = ACTION_CAPABILITIES.get(capability);
  ACTION_CAPABILITIES.delete(capability);
  if (!record || record.expiresAt < Date.now()) throw new Error("사용자 작업 확인이 만료되었습니다. 다시 시도하세요.");
  if (record.action !== action || record.tabId !== context.tabId || record.frameId !== context.frameId) {
    throw new Error("현재 탭에 대한 사용자 작업 확인이 아닙니다.");
  }
  if (record.documentId && context.documentId && record.documentId !== context.documentId) {
    throw new Error("페이지가 변경되어 작업을 계속할 수 없습니다.");
  }
  if (record.targetFingerprint && record.targetFingerprint !== fingerprintTarget(target)) {
    throw new Error("선택한 대상이 변경되었습니다. 다시 시도하세요.");
  }
}

function purgeExpiredCapabilities() {
  const now = Date.now();
  for (const [capability, record] of ACTION_CAPABILITIES) {
    if (record.expiresAt < now) ACTION_CAPABILITIES.delete(capability);
  }
}

function fingerprintTarget(target) {
  const value = typeof target === "string" ? target : String(target?.src || "");
  const sample = value.length > 8192 ? `${value.slice(0, 4096)}:${value.slice(-4096)}` : value;
  let hash = 0x811c9dc5;
  for (let index = 0; index < sample.length; index += 1) {
    hash ^= sample.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${value.length}:${(hash >>> 0).toString(16)}`;
}

function isSensitiveUrl(value) {
  try {
    const hostname = new URL(value || "").hostname.toLowerCase();
    return SENSITIVE_HOST_SUFFIXES.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`));
  } catch {
    return true;
  }
}

function dataUrlByteLength(value) {
  const comma = String(value || "").indexOf(",");
  if (comma < 0) return Number.POSITIVE_INFINITY;
  const base64 = value.length - comma - 1;
  return Math.floor(base64 * 0.75);
}

async function settingsFromStorage() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return sanitizeSettings(stored[SETTINGS_KEY] || {});
}

function sanitizeSettings(value) {
  const source = value || {};
  return {
    provider: ALLOWED_PROVIDERS.includes(source.provider) ? source.provider : "custom",
    baseUrl: typeof source.baseUrl === "string" ? source.baseUrl.trim() : "",
    apiKey: typeof source.apiKey === "string" ? source.apiKey.trim() : "",
    model: typeof source.model === "string" ? source.model.trim() : ""
  };
}

function assertSettings(settings) {
  if (!settings.baseUrl) throw new Error("확장 팝업에서 Base URL을 저장하세요.");
  if (!settings.apiKey) throw new Error("확장 팝업에서 API key를 저장하세요.");
  if (!settings.model) throw new Error("확장 팝업에서 비전 모델 이름을 저장하세요.");
  const endpoint = parseSecureApiUrl(settings.baseUrl);
  if (endpoint.username || endpoint.password) throw new Error("Base URL에는 사용자 정보가 포함될 수 없습니다.");
}

function endpointFor(baseUrl) {
  const normalized = parseSecureApiUrl(baseUrl).toString().replace(/\/+$/, "");
  return /\/chat\/completions$/i.test(normalized) ? normalized : `${normalized}/chat/completions`;
}

function hostFor(baseUrl) {
  try {
    return parseSecureApiUrl(baseUrl).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function parseSecureApiUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Base URL은 https://로 시작하는 유효한 주소여야 합니다.");
  }
  if (url.protocol !== "https:") throw new Error("API key 보호를 위해 Base URL은 HTTPS여야 합니다.");
  if (url.username || url.password) throw new Error("Base URL에는 사용자 정보가 포함될 수 없습니다.");
  if (url.search || url.hash) throw new Error("Base URL에는 query 또는 # fragment를 포함할 수 없습니다.");
  return url;
}

function isGemini(settings) {
  return hostFor(settings.baseUrl).includes("generativelanguage.googleapis.com");
}

function isGlm(settings) {
  const host = hostFor(settings.baseUrl);
  // z.ai = 글로벌 엔드포인트(api.z.ai), bigmodel.cn = 중국 본토(open.bigmodel.cn)
  return host === "z.ai" || host.endsWith(".z.ai") || host.endsWith("bigmodel.cn");
}

function withProviderOptions(settings, body, jsonMode = true) {
  const next = { ...body };
  if (isGemini(settings) && settings.model.toLowerCase().includes("2.5")) next.reasoning_effort = "none";
  if (isGemini(settings) && jsonMode) next.response_format = { type: "json_object" };
  // GLM-5V: thinking(추론)을 꺼 결정적·빠른 JSON 출력 우선. Gemini 2.5 reasoning-off와 동일 철학.
  if (isGlm(settings)) next.thinking = { type: "disabled" };
  return next;
}

async function analyzeImage(target) {
  const settings = await settingsFromStorage();
  assertSettings(settings);
  validateTarget(target);
  const image = await imageToDataUrl(target.src);
  const payload = withProviderOptions(settings, {
    model: settings.model,
    temperature: 0.18,
    max_tokens: 8192,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
        { type: "text", text: buildAnalysisText(target) },
        { type: "image_url", image_url: { url: image } }
        ]
      }
    ]
  });

  const raw = await postJson(endpointFor(settings.baseUrl), settings.apiKey, payload, TIMEOUT_MS);
  const text = extractMessageText(raw);
  let analysis;
  try {
    analysis = normalizeAnalysis(parseModelJson(text));
  } catch (error) {
    const repaired = await repairJson(settings, text);
    analysis = normalizeAnalysis(parseModelJson(repaired));
  }
  if (needsLanguageRepair(analysis)) {
    const repaired = await repairLanguages(settings, JSON.stringify(analysis));
    analysis = normalizeAnalysis(parseModelJson(repaired));
  }
  return analysis;
}

function validateTarget(target) {
  if (!target || typeof target.src !== "string" || !target.src.trim()) throw new Error("분석할 이미지 주소를 찾지 못했습니다.");
  validateImageSource(target.src);
}

async function imageToDataUrl(src) {
  const source = validateImageSource(src);
  if (source.kind === "data") {
    if (src.length > MAX_IMAGE_BYTES * 1.37) throw new Error("이미지가 너무 큽니다. 20MB 이하 이미지를 사용하세요.");
    const blob = await (await fetch(src)).blob();
    return imageBlobToDataUrl(blob, source.type);
  }
  const { blob, contentType } = await fetchImageBlob(source.url);
  return imageBlobToDataUrl(blob, contentType);
}

function validateImageSource(value) {
  const src = String(value || "").trim();
  const dataMatch = src.match(/^data:(image\/(?:jpeg|jpg|png|webp|gif));base64,/i);
  if (dataMatch) return { kind: "data", type: dataMatch[1].toLowerCase() };
  if (/^data:/i.test(src)) throw new Error("base64 PNG, JPEG, WebP 또는 GIF data URL만 분석할 수 있습니다.");
  let url;
  try {
    url = new URL(src);
  } catch {
    throw new Error("분석할 이미지 주소가 올바르지 않습니다.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("HTTPS 또는 HTTP 이미지 주소만 분석할 수 있습니다.");
  if (url.username || url.password) throw new Error("사용자 정보가 포함된 이미지 주소는 사용할 수 없습니다.");
  if (!isPublicHostname(url.hostname)) throw new Error("localhost 또는 사설 네트워크 이미지 주소는 사용할 수 없습니다.");
  return { kind: "url", url };
}

function isPublicHostname(value) {
  const hostname = String(value || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) return false;
  const parts = hostname.split(".");
  if (parts.length === 4 && parts.every((part) => /^\d+$/.test(part))) {
    const octets = parts.map(Number);
    if (octets.some((part) => part > 255)) return false;
    const [first, second] = octets;
    if (first === 0 || first === 10 || first === 127 || first >= 224) return false;
    if (first === 100 && second >= 64 && second <= 127) return false;
    if (first === 169 && second === 254) return false;
    if (first === 172 && second >= 16 && second <= 31) return false;
    if (first === 192 && second === 168) return false;
    if (first === 198 && (second === 18 || second === 19)) return false;
  }
  if (hostname.includes(":")) {
    const normalized = hostname.replace(/^0+/, "");
    if (normalized === "::" || normalized === "::1" || normalized.startsWith("fe80:") || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.includes("::ffff:127.")) return false;
  }
  return true;
}

async function fetchImageBlob(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      credentials: "omit",
      referrerPolicy: "no-referrer",
      redirect: "error",
      cache: "no-store"
    });
    if (!response.ok) throw new Error(`이미지를 가져오지 못했습니다 (${response.status}).`);
    const contentType = response.headers.get("content-type")?.split(";")[0]?.toLowerCase() || "";
    if (contentType && !contentType.startsWith("image/")) throw new Error("선택한 주소가 이미지가 아닙니다.");
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_BYTES) throw new Error("이미지가 너무 큽니다. 20MB 이하 이미지를 사용하세요.");
    return { blob: await readResponseBlob(response, MAX_IMAGE_BYTES, contentType), contentType };
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("이미지를 가져오는 시간이 초과되었습니다.");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function readResponseBlob(response, maxBytes, type = "") {
  if (!response.body) {
    const blob = await response.blob();
    if (blob.size > maxBytes) throw new Error("응답이 너무 큽니다.");
    return blob;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("응답이 너무 큽니다.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new Blob(chunks, { type });
}

async function imageBlobToDataUrl(blob, hintedType) {
  if (!blob.type?.startsWith("image/") && !hintedType?.startsWith("image/")) throw new Error("선택한 주소가 이미지가 아닙니다.");
  if (blob.size > MAX_IMAGE_BYTES) throw new Error("이미지가 너무 큽니다. 20MB 이하 이미지를 사용하세요.");
  const type = (blob.type || hintedType || "image/jpeg").toLowerCase();
  if (!SUPPORTED_IMAGE_TYPES.has(type)) throw new Error("PNG, JPEG, WebP 또는 GIF 이미지만 분석할 수 있습니다.");
  if (DIRECT_IMAGE_TYPES.has(type)) return `data:${type};base64,${arrayBufferToBase64(await blob.arrayBuffer())}`;
  return reencodeImage(blob);
}

async function reencodeImage(blob) {
  if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas === "undefined") {
    throw new Error("이 이미지 형식은 바로 분석할 수 없습니다. PNG 또는 JPEG로 저장해 다시 시도하세요.");
  }
  const bitmap = await createImageBitmap(blob);
  if (bitmap.width * bitmap.height > MAX_DECODED_PIXELS) {
    bitmap.close();
    throw new Error("이미지 해상도가 너무 높습니다. 4천만 픽셀 이하 이미지를 사용하세요.");
  }
  const scale = Math.min(1, 2200 / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d", { alpha: false });
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const jpeg = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.9 });
  return `data:image/jpeg;base64,${arrayBufferToBase64(await jpeg.arrayBuffer())}`;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

async function postJson(endpoint, apiKey, body, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
      credentials: "omit",
      referrerPolicy: "no-referrer",
      redirect: "error",
      cache: "no-store"
    });
    if (!response.ok) {
      const detail = (await readResponseText(response, 100_000)).slice(0, 700);
      throw new Error(`API 요청이 실패했습니다 (${response.status}). ${detail}`.trim());
    }
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_API_RESPONSE_BYTES) throw new Error("API 응답이 너무 큽니다.");
    try {
      return JSON.parse(await readResponseText(response, MAX_API_RESPONSE_BYTES));
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error("API가 유효한 JSON 응답을 반환하지 않았습니다.");
      throw error;
    }
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("분석 시간이 3분을 초과했습니다. 더 작은 이미지를 시도하세요.");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function readResponseText(response, maxBytes) {
  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) throw new Error("응답이 너무 큽니다.");
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("응답이 너무 큽니다.");
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function extractMessageText(response) {
  const content = response?.choices?.[0]?.message?.content;
  if (typeof content === "string" && content.trim()) return content.trim();
  if (Array.isArray(content)) {
    const text = content.map((part) => typeof part?.text === "string" ? part.text : "").join("\n").trim();
    if (text) return text;
  }
  throw new Error("모델이 분석 텍스트를 반환하지 않았습니다. OpenAI 호환 비전 chat completions 엔드포인트인지 확인하세요.");
}

function parseModelJson(text) {
  const candidate = extractJsonObject(text);
  try {
    return JSON.parse(candidate);
  } catch {
    throw new Error("모델 응답이 유효한 JSON이 아닙니다.");
  }
}

function extractJsonObject(text) {
  const stripped = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const start = stripped.indexOf("{");
  if (start < 0) throw new Error("모델 응답에 JSON 객체가 없습니다.");
  let depth = 0;
  let quote = false;
  let escaped = false;
  for (let index = start; index < stripped.length; index += 1) {
    const char = stripped[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quote = false;
      continue;
    }
    if (char === '"') quote = true;
    else if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) return stripped.slice(start, index + 1);
  }
  throw new Error("완전한 JSON 객체를 찾지 못했습니다.");
}

async function repairJson(settings, rawText) {
  const repairPrompt = [
    "Repair the following response into valid JSON only. No markdown fences.",
    "Use this exact Carpo-Prompt schema: ko {prompt, analysis}, en {prompt, analysis}, ko_style_tags, en_style_tags, json_prompt, recreation_prompt, prompt_core, negative_prompt.",
    "Do not invent visual details. Keep ko fields Korean and en plus structured fields English.",
    "Return exactly 4 Korean and 4 English style tags.",
    "",
    String(rawText).slice(0, 18_000)
  ].join("\n");
  const body = withProviderOptions(settings, {
    model: settings.model,
    temperature: 0,
    max_tokens: 2600,
    messages: [{ role: "user", content: repairPrompt }]
  });
  const response = await postJson(endpointFor(settings.baseUrl), settings.apiKey, body, TIMEOUT_MS);
  return extractMessageText(response);
}

function needsLanguageRepair(analysis) {
  return !/[가-힣]/.test(`${analysis.ko.prompt}\n${analysis.ko.analysis}\n${analysis.ko_style_tags.join(" ")}`)
    || !/[A-Za-z]{4}/.test(`${analysis.en.prompt}\n${analysis.en.analysis}\n${analysis.en_style_tags.join(" ")}`);
}

async function repairLanguages(settings, rawText) {
  const repairPrompt = [
    "Repair the following Carpo-Prompt JSON so language buckets are correct. Return valid JSON only. No markdown fences.",
    "Do not add visual details. Only translate or move existing content into the correct fields.",
    "Required language mapping: ko.prompt, ko.analysis and ko_style_tags must be Korean. en.prompt, en.analysis, en_style_tags, json_prompt, recreation_prompt, prompt_core and negative_prompt must be English.",
    "Return exactly 4 style tags for Korean and English.",
    "",
    String(rawText).slice(0, 24_000)
  ].join("\n");
  const body = withProviderOptions(settings, {
    model: settings.model,
    temperature: 0,
    max_tokens: 5200,
    messages: [{ role: "user", content: repairPrompt }]
  });
  const response = await postJson(endpointFor(settings.baseUrl), settings.apiKey, body, TIMEOUT_MS);
  return extractMessageText(response);
}

function text(value) {
  return typeof value === "string" ? value.trim().slice(0, 12_000) : "";
}

function tags(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string").map((item) => item.trim().slice(0, 80)).filter(Boolean).slice(0, 4) : [];
}

function stringList(value, maxItems = 8, maxLength = 240) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === "string").map((item) => item.trim().slice(0, maxLength)).filter(Boolean).slice(0, maxItems)
    : [];
}

function normalizeJsonPrompt(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    subject: text(source.subject),
    action_pose: text(source.action_pose),
    details_appearance: text(source.details_appearance),
    environment_background: text(source.environment_background),
    lighting_atmosphere: text(source.lighting_atmosphere),
    composition_framing: text(source.composition_framing),
    style_camera: text(source.style_camera),
    colors: stringList(source.colors, 6, 120),
    materials: stringList(source.materials, 8, 160),
    aspect_ratio: text(source.aspect_ratio).slice(0, 40),
    quality_modifiers: stringList(source.quality_modifiers, 8, 160),
    likely_generation_intent: text(source.likely_generation_intent)
  };
}

function normalizeAnalysis(value) {
  const ko = value?.ko;
  const en = value?.en;
  if (!text(ko?.prompt) || !text(en?.prompt)) throw new Error("응답에 한국어 또는 영어 프롬프트가 없습니다.");
  return {
    ko: { prompt: text(ko.prompt), analysis: text(ko.analysis) },
    en: { prompt: text(en.prompt), analysis: text(en.analysis) },
    ko_style_tags: tags(value.ko_style_tags),
    en_style_tags: tags(value.en_style_tags),
    json_prompt: normalizeJsonPrompt(value?.json_prompt),
    recreation_prompt: text(value.recreation_prompt),
    prompt_core: text(value.prompt_core),
    negative_prompt: text(value.negative_prompt)
  };
}

async function testConnection(untrustedSettings) {
  const settings = sanitizeSettings(untrustedSettings);
  assertSettings(settings);
  const testImage = await createConnectionTestImage();
  const body = withProviderOptions(settings, {
    model: settings.model,
    temperature: 0,
    max_tokens: 800,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: 'Return JSON only: {"ko":{"prompt":"테스트","analysis":"테스트"},"en":{"prompt":"test","analysis":"test"}}' },
        { type: "image_url", image_url: { url: testImage } }
      ]
    }]
  });
  const response = await postJson(endpointFor(settings.baseUrl), settings.apiKey, body, 30_000);
  extractMessageText(response);
}

async function createConnectionTestImage() {
  if (typeof OffscreenCanvas === "undefined") {
    return "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9JHqAAAAAASUVORK5CYII=";
  }
  const canvas = new OffscreenCanvas(64, 64);
  const context = canvas.getContext("2d", { alpha: false });
  context.fillStyle = "#ff7417";
  context.fillRect(0, 0, 64, 64);
  const blob = await canvas.convertToBlob({ type: "image/png" });
  return `data:image/png;base64,${arrayBufferToBase64(await blob.arrayBuffer())}`;
}

// Preserve the full source prompt in the service-worker bundle for transparent auditing.
void SYSTEM_PROMPT;
