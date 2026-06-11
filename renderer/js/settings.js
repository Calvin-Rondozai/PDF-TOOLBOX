const STORAGE_KEY = "hello-c-settings";
const SIDEBAR_KEY = "hello-c-sidebar-collapsed";
const DEFAULTS = {
  theme: "system",
  defaultZoom: 100,
  notificationSounds: true,
  ttsVoice: "",
  ttsRate: 1.0,
};

let systemThemeListener = null;

function migrateSettings(raw) {
  const s = { ...DEFAULTS, ...raw };
  if (raw.darkTheme === true && !raw.theme) s.theme = "dark";
  if (raw.darkTheme === false && !raw.theme) s.theme = "light";
  return s;
}

export function loadSettings() {
  try {
    return migrateSettings(JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"));
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  return next;
}

function resolveTheme(mode) {
  if (mode === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return mode === "dark" ? "dark" : "light";
}

export function applyTheme(mode) {
  const resolved = resolveTheme(mode);
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.themeMode = mode;

  if (systemThemeListener) {
    window.matchMedia("(prefers-color-scheme: dark)").removeEventListener("change", systemThemeListener);
    systemThemeListener = null;
  }
  if (mode === "system") {
    systemThemeListener = () => {
      document.documentElement.dataset.theme = resolveTheme("system");
    };
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", systemThemeListener);
  }
}

export function isSidebarCollapsed() {
  return localStorage.getItem(SIDEBAR_KEY) === "1";
}

export function setSidebarCollapsed(collapsed) {
  localStorage.setItem(SIDEBAR_KEY, collapsed ? "1" : "0");
  document.getElementById("app")?.classList.toggle("sidebar-collapsed", collapsed);
}

export function initSettings() {
  const s = loadSettings();
  applyTheme(s.theme);
  setSidebarCollapsed(isSidebarCollapsed());
  return s;
}

function getBrowserVoiceOptions() {
  if (!window.speechSynthesis) return [];
  return window.speechSynthesis.getVoices().map((v) => ({
    id: v.voiceURI,
    name: `${v.name} (browser)`,
  }));
}

async function getPythonVoiceOptions() {
  try {
    const r = await window.pdfApi.runOp({ op: "get_tts_voices" });
    return (r.voices || []).map((v) => ({
      id: `py:${v.id}`,
      name: `${v.name} (export)`,
    }));
  } catch {
    return [];
  }
}

function buildVoiceSelectOptions(voices, selected) {
  return voices
    .map((v) => `<option value="${v.id}" ${v.id === selected ? "selected" : ""}>${v.name}</option>`)
    .join("");
}

export async function mountSettingsView({ appVersion, developer, showToast }) {
  const root = document.getElementById("view-settings");
  if (!root) return;
  const s = loadSettings();
  let aiSettings = { groqApiKey: "", groqModel: "llama-3.3-70b-versatile", hasApiKey: false };
  try {
    aiSettings = await window.aiApi.getSettings();
  } catch {
    /* ai not available */
  }

  const models = [
    "llama-3.3-70b-versatile",
    "llama-3.1-8b-instant",
    "mixtral-8x7b-32768",
  ];

  const browserVoices = getBrowserVoiceOptions();
  const pythonVoices = await getPythonVoiceOptions();
  const allVoices = [...browserVoices, ...pythonVoices];
  const savedVoice = s.ttsVoice || allVoices[0]?.id || "";

  root.innerHTML = `
    <div class="settings-page">
      <header class="settings-page-header">
        <h2>Settings</h2>
        <p>Appearance, read aloud, and Chenny AI</p>
      </header>

      <div class="settings-stack">
        <section class="settings-card">
          <h3 class="settings-card-title">Appearance</h3>
          <label class="settings-row">
            <span>Theme</span>
            <select id="set-theme" class="field-select settings-select theme-select">
              <option value="light" ${s.theme === "light" ? "selected" : ""}>Light</option>
              <option value="dark" ${s.theme === "dark" ? "selected" : ""}>Dark</option>
              <option value="system" ${s.theme === "system" ? "selected" : ""}>System</option>
            </select>
          </label>
          <label class="settings-row">
            <span>Default zoom</span>
            <select id="set-zoom" class="field-select settings-select">
              ${[75, 100, 125, 150].map((z) => `<option value="${z}" ${s.defaultZoom === z ? "selected" : ""}>${z}%</option>`).join("")}
            </select>
          </label>
          <label class="settings-row settings-toggle-row">
            <span>Notification sounds</span>
            <input type="checkbox" id="set-notification-sounds" ${s.notificationSounds !== false ? "checked" : ""} />
          </label>
          <p class="settings-hint">Play a short sound when toast notifications appear.</p>
        </section>

        <section class="settings-card">
          <h3 class="settings-card-title">Read aloud</h3>
          <label class="settings-row settings-row-col">
            <span>Voice</span>
            <select id="set-tts-voice" class="field-select settings-select-wide">
              ${buildVoiceSelectOptions(allVoices, savedVoice)}
            </select>
          </label>
          <label class="settings-row settings-row-col">
            <span>Speed <strong id="set-speed-val" class="speed-badge">${(s.ttsRate ?? 1).toFixed(1)}×</strong></span>
            <input type="range" id="set-tts-rate" class="field-range settings-range" min="0.5" max="2" step="0.1" value="${s.ttsRate ?? 1}" />
          </label>
          <p class="settings-hint">Used for Read Aloud and Save Audio.</p>
        </section>

        <section class="settings-card">
          <h3 class="settings-card-title">Chenny AI</h3>
          <label class="settings-row settings-row-col">
            <span>Groq API key</span>
            <input type="password" id="set-groq-key" class="form-input ai-settings-key" placeholder="gsk_…" value="${aiSettings.hasApiKey ? "••••••••••••••••" : ""}" autocomplete="off" />
          </label>
          <label class="settings-row">
            <span>Model</span>
            <select id="set-groq-model" class="field-select settings-select-wide">
              ${models.map((m) => `<option value="${m}" ${aiSettings.groqModel === m ? "selected" : ""}>${m}</option>`).join("")}
            </select>
          </label>
          <p class="settings-hint">Get a free key at <strong>console.groq.com</strong>. Stored locally on your device.</p>
        </section>

        <section class="settings-card settings-card-about">
          <h3 class="settings-card-title">About</h3>
          <div class="about-box">
            <img src="images/icon.png" alt="" class="about-logo" />
            <div>
              <div class="about-name">Hello C — PDF Tool</div>
              <div class="about-meta">Version ${appVersion}</div>
              <div class="about-meta">Developed by ${developer}</div>
            </div>
          </div>
        </section>

        <div class="settings-save-row">
          <button type="button" class="btn-primary" id="btn-save-settings">Save settings</button>
        </div>
      </div>
    </div>
  `;

  root.querySelector("#set-theme")?.addEventListener("change", (e) => {
    applyTheme(e.target.value);
  });

  root.querySelector("#set-tts-rate")?.addEventListener("input", (e) => {
    const lbl = root.querySelector("#set-speed-val");
    if (lbl) lbl.textContent = `${parseFloat(e.target.value).toFixed(1)}×`;
  });

  root.querySelector("#btn-save-settings")?.addEventListener("click", async () => {
    const theme = root.querySelector("#set-theme").value;
    const defaultZoom = parseInt(root.querySelector("#set-zoom").value, 10);
    const notificationSounds = root.querySelector("#set-notification-sounds").checked;
    const ttsVoice = root.querySelector("#set-tts-voice")?.value || "";
    const ttsRate = parseFloat(root.querySelector("#set-tts-rate")?.value || "1");
    saveSettings({ theme, defaultZoom, notificationSounds, ttsVoice, ttsRate });
    applyTheme(theme);

    const keyInput = root.querySelector("#set-groq-key")?.value?.trim();
    const groqModel = root.querySelector("#set-groq-model")?.value;
    const aiPatch = { groqModel };
    if (keyInput && !keyInput.startsWith("••")) aiPatch.groqApiKey = keyInput;
    const aiRes = await window.aiApi.saveSettings(aiPatch);
    if (!aiRes.ok) {
      showToast?.(aiRes.error || "Failed to save AI settings.", "error");
      return;
    }
    showToast?.("Settings saved.", "success");
  });
}
