const SETTINGS_KEY = "carpoPromptSettings";
const UI_KEY = "carpoPromptUi";
const form = document.getElementById("settings-form");
const statusNode = document.getElementById("status");
const testButton = document.getElementById("test");
const saveButton = document.getElementById("save");
const providerSelect = document.getElementById("provider");

const PROVIDER_PRESETS = {
  openai: { baseUrl: "https://api.openai.com/v1", modelPlaceholder: "gpt-5.6" },
  gemini: { baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", modelPlaceholder: "gemini-3.6" },
  glm: { baseUrl: "https://api.z.ai/api/paas/v4", modelPlaceholder: "glm-5.2" },
  custom: { baseUrl: "", modelPlaceholder: "gpt-5.6 / glm-5.2 / claude-5 / vision-model" }
};

function inferProviderFromBaseUrl(baseUrl) {
  let host = "";
  try { host = new URL(baseUrl).hostname.toLowerCase(); } catch { host = ""; }
  if (!host) return "custom";
  if (host === "z.ai" || host.endsWith(".z.ai") || host.endsWith("bigmodel.cn")) return "glm";
  if (host.includes("generativelanguage.googleapis.com")) return "gemini";
  if (host === "api.openai.com" || host.endsWith(".openai.com")) return "openai";
  return "custom";
}

function applyProviderPreset(provider, { overwriteBaseUrl = false } = {}) {
  const preset = PROVIDER_PRESETS[provider] || PROVIDER_PRESETS.custom;
  form.elements.model.placeholder = preset.modelPlaceholder;
  if (overwriteBaseUrl && provider !== "custom") {
    form.elements.baseUrl.value = preset.baseUrl;
  }
}

function currentSettings() {
  return {
    provider: providerSelect.value,
    baseUrl: form.elements.baseUrl.value.trim(),
    apiKey: form.elements.apiKey.value.trim(),
    model: form.elements.model.value.trim()
  };
}

function setStatus(message, tone = "") {
  statusNode.textContent = message;
  statusNode.dataset.tone = tone;
}

function setBusy(busy, action) {
  testButton.disabled = busy;
  saveButton.disabled = busy;
  if (busy) {
    testButton.textContent = action === "test" ? "확인 중…" : "연결 테스트";
    saveButton.textContent = action === "save" ? "저장 중…" : "저장";
  } else {
    testButton.textContent = "연결 테스트";
    saveButton.textContent = "저장";
  }
}

async function loadSettings() {
  const stored = await chrome.storage.local.get([SETTINGS_KEY, UI_KEY]);
  const settings = stored[SETTINGS_KEY] || {};
  const provider = PROVIDER_PRESETS[settings.provider]
    ? settings.provider
    : inferProviderFromBaseUrl(settings.baseUrl || "");
  providerSelect.value = provider;
  form.elements.baseUrl.value = settings.baseUrl || "";
  form.elements.apiKey.value = settings.apiKey || "";
  form.elements.model.value = settings.model || "";
  applyProviderPreset(provider);
  document.getElementById("inline-enabled").checked = stored[UI_KEY]?.inlineEnabled !== false;
}

providerSelect.addEventListener("change", () => {
  applyProviderPreset(providerSelect.value, { overwriteBaseUrl: true });
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!form.reportValidity()) return;
  setBusy(true, "save");
  try {
    await chrome.storage.local.set({
      [SETTINGS_KEY]: currentSettings(),
      [UI_KEY]: { inlineEnabled: document.getElementById("inline-enabled").checked }
    });
    setStatus("저장했습니다. 이제 웹 이미지에서 오른쪽 클릭 → Carpo-Prompt로 이미지 분석을 선택하세요.", "success");
  } catch {
    setStatus("저장하지 못했습니다. 확장 저장소 권한을 확인하세요.", "error");
  } finally {
    setBusy(false);
  }
});

testButton.addEventListener("click", async () => {
  if (!form.reportValidity()) return;
  setBusy(true, "test");
  setStatus("비전 API 연결을 확인하고 있습니다…");
  try {
    const response = await chrome.runtime.sendMessage({ type: "TEST_CONNECTION", settings: currentSettings() });
    if (!response?.ok) throw new Error(response?.error || "연결 테스트에 실패했습니다.");
    setStatus("연결이 확인되었습니다. 저장을 눌러 사용하세요.", "success");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "연결 테스트에 실패했습니다.", "error");
  } finally {
    setBusy(false);
  }
});

document.getElementById("analyze-page").addEventListener("click", async () => {
  try {
    const response = await chrome.runtime.sendMessage({ type: "ANALYZE_CURRENT_PAGE" });
    if (!response?.ok) throw new Error(response?.error || "현재 페이지를 열지 못했습니다.");
    window.close();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "현재 페이지를 분석하지 못했습니다.", "error");
  }
});

document.getElementById("open-latest").addEventListener("click", async () => {
  try {
    const response = await chrome.runtime.sendMessage({ type: "OPEN_ACTIVE_PANEL" });
    if (!response?.ok) throw new Error(response?.error || "최근 결과를 열지 못했습니다.");
    window.close();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "최근 결과를 열지 못했습니다.", "error");
  }
});

document.getElementById("open-panel").addEventListener("click", async () => {
  try {
    const response = await chrome.runtime.sendMessage({ type: "OPEN_PANEL" });
    if (!response?.ok) throw new Error(response?.error || "패널을 열지 못했습니다.");
    window.close();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "패널을 열지 못했습니다.", "error");
  }
});

loadSettings().catch(() => setStatus("저장된 설정을 불러오지 못했습니다.", "error"));
