const cameraDefs = [
  { id: "lower-ch1", board: "lower", boardName: "下层板", channel: 1, device: "/dev/video1" },
  { id: "lower-ch2", board: "lower", boardName: "下层板", channel: 2, device: "/dev/video2" },
  { id: "lower-ch3", board: "lower", boardName: "下层板", channel: 3, device: "/dev/video3" },
  { id: "lower-ch4", board: "lower", boardName: "下层板", channel: 4, device: "/dev/video4" },
  { id: "upper-ch1", board: "upper", boardName: "上层板", channel: 1, device: "/dev/video12" },
  { id: "upper-ch2", board: "upper", boardName: "上层板", channel: 2, device: "/dev/video13" },
  { id: "upper-ch3", board: "upper", boardName: "上层板", channel: 3, device: "/dev/video14" },
  { id: "upper-ch4", board: "upper", boardName: "上层板", channel: 4, device: "/dev/video15" },
];

const state = {
  selected: "lower-ch1",
  filter: "all",
  streams: new Map(),
  quality: new Map(cameraDefs.map((camera) => [camera.id, "sub"])),
  players: new Map(),
  decoder: new Map(),
  apiOnline: false,
  hardwareCapable: null,
  config: null,
  configLoaded: false,
  editingProfile: null,
  settingsTrigger: null,
  settingsCloseTimer: null,
  settingsAutoCloseTimer: null,
  recording: null,
  recordingTrigger: null,
  recordingCloseTimer: null,
  recordingsTrigger: null,
  recordings: null,
  recordingFiles: [],
  recordingFilterDate: "",
  recordingTimelineFiles: [],
  recordingsOffset: 0,
  recordingTimelineToken: 0,
  recordingPlaylist: [],
  recordingDurations: [],
  recordingOffsets: [],
  recordingTotalDuration: 0,
  recordingTimelineStartEpoch: 0,
  recordingActiveIndex: -1,
  recordingSeekTarget: null,
  networkStatus: { wifiConnected: false, apEnabled: false, apiOnline: false },
  networkTrigger: null,
  networkCloseTimer: null,
  settingsHubTrigger: null,
  settingsHubCloseTimer: null,
  settingsPanel: "network",
};

const grid = document.querySelector("#videoGrid");

function mountInlineSettings() {
  const destinations = {
    "#networkBody": document.querySelector('[data-settings-pane="network"]'),
    "#settingsBody": document.querySelector('[data-settings-pane="main"]'),
    "#recordingBody": document.querySelector('[data-settings-pane="recording"]'),
  };
  for (const [selector, destination] of Object.entries(destinations)) {
    const panel = document.querySelector(selector);
    if (!panel || !destination) continue;
    destination.appendChild(panel);
    panel.hidden = false;
    panel.dataset.inline = "true";
    panel.classList.add("settings-inline-form");
    panel.querySelector(".editor-head")?.setAttribute("hidden", "true");
  }
  document.querySelectorAll('#settingsBody fieldset[data-profile]').forEach((fieldset) => {
    fieldset.hidden = false;
  });
}

mountInlineSettings();

function renderFeeds() {
  grid.innerHTML = cameraDefs.map((camera) => `
    <article class="feed ${camera.id === state.selected ? "is-selected" : ""}" data-camera="${camera.id}" data-board="${camera.board}" tabindex="0">
      <video muted autoplay playsinline></video>
      <div class="feed-empty"><i></i><span>WAITING FOR SIGNAL</span></div>
      <div class="feed-shade"></div>
      <div class="feed-meta">
        <div class="feed-top">
          <span class="feed-title"><i></i>${camera.boardName} · CH${camera.channel}</span>
          <span class="feed-quality">SUB</span>
        </div>
        <div class="feed-bottom">
          <span class="feed-device">${camera.device}</span>
          <span class="feed-state">等待信号</span>
        </div>
      </div>
    </article>
  `).join("");

  grid.querySelectorAll(".feed").forEach((feed) => {
    feed.addEventListener("click", () => selectCamera(feed.dataset.camera));
    feed.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") selectCamera(feed.dataset.camera);
    });
  });
}

function streamFor(cameraId, quality) {
  return state.streams.get(`${cameraId}-${quality}`);
}

function selectCamera(cameraId) {
  state.selected = cameraId;
  grid.querySelectorAll(".feed").forEach((feed) => feed.classList.toggle("is-selected", feed.dataset.camera === cameraId));
  updateInspector();
  if (window.innerWidth <= 1000) document.querySelector(".rail-controls")?.classList.add("is-open");
}

function setQuality(cameraId, quality) {
  state.quality.set(cameraId, quality);
  stopPlayer(cameraId);
  updateFeed(cameraId);
  updateInspector();
  updateQualityAllAction();
}

function updateQualityAllAction() {
  const allMain = cameraDefs.every((camera) => state.quality.get(camera.id) === "main");
  const target = allMain ? "sub" : "main";
  const button = document.querySelector("#qualityAll");
  button.dataset.target = target;
  button.textContent = target === "main" ? "切换成主码流" : "切换成子码流";
  button.setAttribute("aria-label", `全部摄像头切换成${target === "main" ? "主码流" : "子码流"}`);
}

function updateFeed(cameraId) {
  const camera = cameraDefs.find((item) => item.id === cameraId);
  const feed = grid.querySelector(`[data-camera="${cameraId}"]`);
  if (!camera || !feed) return;

  const quality = state.quality.get(cameraId) || "sub";
  const stream = streamFor(cameraId, quality);
  const online = stream?.state === "online";
  feed.hidden = state.filter !== "all" && camera.board !== state.filter;
  feed.classList.toggle("is-online", online);
  feed.querySelector(".feed-quality").textContent = quality.toUpperCase();
  feed.querySelector(".feed-state").textContent = statusText(stream?.state);
  feed.querySelector(".feed-empty span").textContent = online ? "CONNECTING WEBRTC" : statusEnglish(stream?.state);

  if (online) ensurePlayer(cameraId, quality, stream.webrtc_url, feed);
  else stopPlayer(cameraId);
}

function ensurePlayer(cameraId, quality, url, feed) {
  const existing = state.players.get(cameraId);
  const sourceKey = `${quality}:${url}`;
  if (existing?.sourceKey === sourceKey) return;
  stopPlayer(cameraId);

  const video = feed.querySelector("video");
  const player = { reader: null, sourceKey, video, statsTimer: null, stopping: false };
  const reader = new MediaMTXWebRTCReader({
    url,
    user: "",
    pass: "",
    token: "",
    onError: (error) => {
      if (player.stopping || state.players.get(cameraId) !== player) return;
      console.warn(`${cameraId} WebRTC:`, error);
      feed.classList.remove("is-playing");
      feed.querySelector(".feed-empty span").textContent = "WEBRTC RETRYING";
      stopPlayer(cameraId);
      window.setTimeout(() => updateFeed(cameraId), 800);
    },
    onTrack: (event) => {
      if (event.track.kind !== "video") return;
      video.srcObject = event.streams[0];
      video.play().catch(() => {});
      const markPlaying = () => {
        feed.classList.add("is-playing");
        feed.querySelector(".feed-state").textContent = "WebRTC 低延迟";
      };
      video.addEventListener("playing", markPlaying, { once: true });
      video.addEventListener("loadeddata", markPlaying, { once: true });
    },
  });
  player.reader = reader;
  player.statsTimer = window.setInterval(() => updateDecoderStats(cameraId, player), 1500);
  state.players.set(cameraId, player);
}

async function updateDecoderStats(cameraId, player) {
  if (state.players.get(cameraId) !== player) return;
  try {
    const report = await player.reader.getStats();
    let inbound = null;
    report.forEach((entry) => {
      if (entry.type === "inbound-rtp" && entry.kind === "video") inbound = entry;
    });
    if (!inbound) return;
    const implementation = inbound.decoderImplementation || "";
    const explicitHardware = inbound.powerEfficientDecoder === true || /d3d|dxva|media foundation|hardware|nvdec|vaapi|v4l2|videotoolbox/i.test(implementation);
    const explicitSoftware = inbound.powerEfficientDecoder === false || /libav|ffmpeg|openh264|software/i.test(implementation);
    const mode = explicitHardware ? "硬件解码" : explicitSoftware ? "软件解码" : (state.hardwareCapable ? "硬件可用" : "硬件优先");
    state.decoder.set(cameraId, {
      mode,
      implementation,
      fps: Math.round(inbound.framesPerSecond || 0),
      frames: inbound.framesDecoded || 0,
      dropped: inbound.framesDropped || 0,
    });
    if (cameraId === state.selected) updateInspector();
  } catch (_error) {}
}

function stopPlayer(cameraId) {
  const player = state.players.get(cameraId);
  if (!player) return;
  player.stopping = true;
  window.clearInterval(player.statsTimer);
  player.reader?.close();
  if (player.video.srcObject) {
    player.video.srcObject.getTracks().forEach((track) => track.stop());
    player.video.srcObject = null;
  }
  player.video.pause();
  grid.querySelector(`[data-camera="${cameraId}"]`)?.classList.remove("is-playing");
  state.players.delete(cameraId);
  state.decoder.delete(cameraId);
}

function updateInspector() {
  const camera = cameraDefs.find((item) => item.id === state.selected) || cameraDefs[0];
  const requestedQuality = state.quality.get(camera.id) || "sub";
  document.querySelectorAll(".quality-option").forEach((option) => option.classList.toggle("is-active", option.dataset.quality === requestedQuality));
  updateQualityLabels();
}

function configFor(quality) {
  return state.config?.[quality] || (quality === "main"
    ? { width: 1280, height: 720, fps: 25, bitrate_kbps: 3072 }
    : { width: 640, height: 360, fps: 15, bitrate_kbps: 512 });
}

function updateQualityLabels() {
  document.querySelectorAll(".quality-select").forEach((button) => {
    const config = configFor(button.dataset.quality);
    button.querySelector("small").textContent = `${config.width}×${config.height} · ${config.fps}FPS`;
  });
}

function placeDialog(form, trigger) {
  form.style.removeProperty("left");
  form.style.removeProperty("top");
  form.style.removeProperty("bottom");
  if (window.innerWidth <= 680) return;
  const triggerRect = trigger.getBoundingClientRect();
  const width = form.offsetWidth;
  const height = form.offsetHeight;
  const left = Math.max(12, Math.min(window.innerWidth - width - 12, triggerRect.right - width));
  const below = triggerRect.bottom + 8;
  const top = below + height <= window.innerHeight - 12
    ? below
    : Math.max(12, triggerRect.top - height - 8);
  form.style.left = `${left}px`;
  form.style.top = `${top}px`;
}

function setNetworkStatus(selector, message, kind = "idle") {
  const status = document.querySelector(selector);
  if (!status) return;
  status.textContent = message;
  status.dataset.kind = kind;
}

function updateNetworkDot() {
  const dot = document.querySelector("#networkDot");
  if (!dot) return;
  const online = state.networkStatus.apiOnline || state.networkStatus.wifiConnected || state.networkStatus.apEnabled;
  dot.className = online ? "online" : "";
  const summary = document.querySelector("#hubNetworkSummary");
  if (summary) summary.textContent = online ? "网络已连接 · Wi-Fi / AP 可配置" : "网络未连接 · Wi-Fi / AP 可配置";
}

async function refreshNetworkIndicator() {
  const requests = [
    ["wifiConnected", "/api/wifi", (data) => data.connected === true],
    ["apEnabled", "/api/ap", (data) => data.enabled === true],
  ];
  await Promise.all(requests.map(async ([key, url, readState]) => {
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) return;
      const data = await response.json();
      state.networkStatus[key] = readState(data);
    } catch (_error) {
      // Keep the last known state when a transient network request fails.
    }
  }));
  updateNetworkDot();
}

const networkCredentialKeys = {
  wifi: { ssid: "rv1126b.wifi.ssid", password: "rv1126b.wifi.password" },
  ap: { ssid: "rv1126b.ap.ssid", password: "rv1126b.ap.password" },
};

function restoreNetworkCredentials() {
  try {
    Object.entries(networkCredentialKeys).forEach(([mode, keys]) => {
      const form = document.querySelector(mode === "wifi" ? "#wifiPane" : "#apPane");
      const ssid = localStorage.getItem(keys.ssid);
      const password = localStorage.getItem(keys.password);
      if (ssid) form.elements.ssid.value = ssid;
      if (password) form.elements.password.value = password;
    });
  } catch (_) {
    // Keep the form usable when browser storage is unavailable.
  }
}

function rememberNetworkCredentials(mode, form) {
  try {
    const keys = networkCredentialKeys[mode];
    localStorage.setItem(keys.ssid, form.elements.ssid.value.trim());
    localStorage.setItem(keys.password, form.elements.password.value);
  } catch (_) {
    // Saving the board setting must not depend on browser storage.
  }
}

function setNetworkTab(tab) {
  document.querySelectorAll(".network-tab").forEach((button) => {
    const active = button.dataset.networkTab === tab;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
  });
  document.querySelectorAll(".network-pane").forEach((pane) => {
    pane.hidden = pane.dataset.networkPane !== tab;
  });
}

async function loadApStatus() {
  setNetworkStatus("#apStatus", "正在读取 AP 状态…", "loading");
  try {
    const response = await fetch("/api/ap", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    const form = document.querySelector("#apPane");
    form.elements.enabled.checked = data.enabled === true;
    if (data.ssid) form.elements.ssid.value = data.ssid;
    if (data.password) form.elements.password.value = data.password;
    setNetworkStatus("#apStatus", data.enabled ? `热点已开启 · ${data.ssid || "未命名"} · ${data.address || "192.168.0.1"}` : "AP 热点当前未开启", data.enabled ? "success" : "idle");
    state.networkStatus.apEnabled = data.enabled === true;
    updateNetworkDot();
  } catch (error) {
    setNetworkStatus("#apStatus", error.message || "AP 状态读取失败", "error");
  }
}

async function loadWifiStatus() {
  setNetworkStatus("#wifiStatus", "正在读取 Wi-Fi 状态…", "loading");
  try {
    const response = await fetch("/api/wifi", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    const text = data.connected ? `已连接 · ${data.ssid || "Wi-Fi"}${data.address ? ` · ${data.address}` : ""}` : "Wi-Fi 当前未连接";
    setNetworkStatus("#wifiStatus", text, data.connected ? "success" : "idle");
    state.networkStatus.wifiConnected = data.connected === true;
    updateNetworkDot();
  } catch (error) {
    setNetworkStatus("#wifiStatus", "板端暂未提供连接 Wi-Fi 接口（AP 功能不受影响）", "error");
  }
}

async function scanWifi() {
  const button = document.querySelector("#scanWifi");
  const list = document.querySelector("#wifiScanList");
  button.disabled = true;
  button.textContent = "扫描中";
  setNetworkStatus("#wifiStatus", "正在扫描附近 Wi-Fi…", "loading");
  try {
    const response = await fetch("/api/wifi/scan", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    const networks = Array.isArray(data) ? data : (data.networks || []);
    list.innerHTML = networks.length ? networks.map((network) => {
      const ssid = String(network.ssid || "");
      const signal = network.signal == null ? "" : `${network.signal}%`;
      return `<button type="button" data-ssid="${ssid.replaceAll('"', '&quot;')}"><span>${ssid || "隐藏网络"}</span><small>${signal}</small></button>`;
    }).join("") : '<span class="recordings-empty">没有发现可用网络</span>';
    list.hidden = false;
    setNetworkStatus("#wifiStatus", `扫描完成 · 发现 ${networks.length} 个网络`, "success");
  } catch (error) {
    setNetworkStatus("#wifiStatus", "板端暂未提供 Wi-Fi 扫描接口", "error");
    list.hidden = true;
  } finally {
    button.disabled = false;
    button.textContent = "扫描";
  }
}

function dismissSettingsHub() {
  const panel = document.querySelector("#settingsHubBody");
  const backdrop = document.querySelector("#settingsHubBackdrop");
  window.clearTimeout(state.settingsHubCloseTimer);
  panel.classList.remove("is-open");
  backdrop.classList.remove("is-open");
  panel.hidden = true;
  backdrop.hidden = true;
  document.querySelector("#networkTrigger").setAttribute("aria-expanded", "false");
  state.settingsHubTrigger = null;
}

function closeSettingsHub({ restoreFocus = true } = {}) {
  const panel = document.querySelector("#settingsHubBody");
  const backdrop = document.querySelector("#settingsHubBackdrop");
  if (panel.hidden) return;
  window.clearTimeout(state.settingsHubCloseTimer);
  panel.classList.remove("is-open");
  backdrop.classList.remove("is-open");
  const focusTarget = state.settingsHubTrigger;
  state.settingsHubCloseTimer = window.setTimeout(() => {
    panel.hidden = true;
    backdrop.hidden = true;
    if (restoreFocus) focusTarget?.focus();
    state.settingsHubTrigger = null;
  }, 190);
}

function selectSettingsPanel(target) {
  const panel = ["network", "main", "recording"].includes(target) ? target : "network";
  state.settingsPanel = panel;
  document.querySelectorAll("[data-settings-hub-target]").forEach((button) => {
    const active = button.dataset.settingsHubTarget === panel;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
  });
  document.querySelectorAll("[data-settings-pane]").forEach((pane) => {
    pane.hidden = pane.dataset.settingsPane !== panel;
  });
  if (panel === "network") {
    Promise.all([loadWifiStatus(), loadApStatus()]);
  } else if (panel === "main") {
    loadSettings();
  } else {
    loadRecording();
  }
}

function openSettingsHubTarget(target) {
  selectSettingsPanel(target);
}

function toggleSettingsHub(trigger) {
  const panel = document.querySelector("#settingsHubBody");
  const backdrop = document.querySelector("#settingsHubBackdrop");
  if (!panel.hidden) {
    closeSettingsHub();
    return;
  }
  closeRecordings({ restoreFocus: false });
  window.clearTimeout(state.settingsHubCloseTimer);
  state.settingsHubTrigger = trigger;
  panel.hidden = false;
  backdrop.hidden = false;
  trigger.setAttribute("aria-expanded", "true");
  selectSettingsPanel("network");
  updateNetworkDot();
  const recordingSummary = document.querySelector("#recordingSummary")?.textContent;
  const hubRecordingSummary = document.querySelector("#hubRecordingSummary");
  if (hubRecordingSummary && recordingSummary) hubRecordingSummary.textContent = recordingSummary;
  window.requestAnimationFrame(() => {
    panel.classList.add("is-open");
    backdrop.classList.add("is-open");
  });
}

function closeNetwork({ restoreFocus = true } = {}) {
  const panel = document.querySelector("#networkBody");
  const backdrop = document.querySelector("#networkBackdrop");
  if (panel.dataset.inline === "true") return;
  if (panel.hidden) return;
  window.clearTimeout(state.networkCloseTimer);
  panel.classList.remove("is-open");
  backdrop.classList.remove("is-open");
  document.querySelector("#networkTrigger").setAttribute("aria-expanded", "false");
  const focusTarget = state.networkTrigger;
  state.networkCloseTimer = window.setTimeout(() => {
    panel.hidden = true;
    backdrop.hidden = true;
    if (restoreFocus) focusTarget?.focus();
    state.networkTrigger = null;
  }, 190);
}

async function toggleNetwork(trigger) {
  const panel = document.querySelector("#networkBody");
  const backdrop = document.querySelector("#networkBackdrop");
  if (!panel.hidden) {
    closeNetwork();
    return;
  }
  closeSettings({ restoreFocus: false });
  closeRecording({ restoreFocus: false });
  closeRecordings({ restoreFocus: false });
  window.clearTimeout(state.networkCloseTimer);
  state.networkTrigger = trigger;
  panel.hidden = false;
  backdrop.hidden = false;
  trigger.setAttribute("aria-expanded", "true");
  setNetworkTab("wifi");
  window.requestAnimationFrame(() => {
    panel.classList.add("is-open");
    backdrop.classList.add("is-open");
  });
  await Promise.all([loadWifiStatus(), loadApStatus()]);
  if (!panel.hidden) document.querySelector("#wifiPane input[name=ssid]")?.focus();
}

async function saveWifi(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const button = form.querySelector("button[type=submit]");
  rememberNetworkCredentials("wifi", form);
  button.disabled = true;
  setNetworkStatus("#wifiStatus", "正在连接 Wi-Fi…", "loading");
  try {
    const response = await fetch("/api/wifi", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true, ssid: form.elements.ssid.value.trim(), password: form.elements.password.value }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    setNetworkStatus("#wifiStatus", `已连接 · ${data.ssid || form.elements.ssid.value}`, "success");
    state.networkStatus.wifiConnected = true;
    updateNetworkDot();
  } catch (error) {
    setNetworkStatus("#wifiStatus", error.message || "Wi-Fi 连接失败", "error");
  } finally {
    button.disabled = false;
  }
}

async function saveAp(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const button = form.querySelector("button[type=submit]");
  rememberNetworkCredentials("ap", form);
  button.disabled = true;
  setNetworkStatus("#apStatus", "正在应用 AP 设置…", "loading");
  try {
    const response = await fetch("/api/ap", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: form.elements.enabled.checked, ssid: form.elements.ssid.value.trim(), password: form.elements.password.value }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    setNetworkStatus("#apStatus", data.enabled ? `热点已开启 · ${form.elements.ssid.value.trim()}` : "AP 热点已关闭", data.enabled ? "success" : "idle");
    state.networkStatus.apEnabled = data.enabled === true;
    updateNetworkDot();
  } catch (error) {
    setNetworkStatus("#apStatus", error.message || "AP 设置失败", "error");
  } finally {
    button.disabled = false;
  }
}

function placeSettings(trigger) {
  placeDialog(document.querySelector("#settingsBody"), trigger);
}

function closeSettings({ restoreFocus = true } = {}) {
  const form = document.querySelector("#settingsBody");
  const backdrop = document.querySelector("#settingsBackdrop");
  if (form.dataset.inline === "true") return;
  if (form.hidden) return;
  window.clearTimeout(state.settingsCloseTimer);
  window.clearTimeout(state.settingsAutoCloseTimer);
  form.classList.remove("is-open");
  backdrop.classList.remove("is-open");
  state.editingProfile = null;
  document.querySelectorAll(".quality-config").forEach((button) => {
    button.classList.remove("is-open");
    button.setAttribute("aria-expanded", "false");
  });
  const focusTarget = state.settingsTrigger;
  state.settingsCloseTimer = window.setTimeout(() => {
    form.hidden = true;
    backdrop.hidden = true;
    if (restoreFocus) focusTarget?.focus();
    state.settingsTrigger = null;
  }, 190);
}

async function toggleSettings(quality, trigger) {
  const form = document.querySelector("#settingsBody");
  const backdrop = document.querySelector("#settingsBackdrop");
  if (!form.hidden && state.editingProfile === quality) {
    closeSettings();
    return;
  }
  closeRecording({ restoreFocus: false });
  window.clearTimeout(state.settingsCloseTimer);
  window.clearTimeout(state.settingsAutoCloseTimer);
  state.editingProfile = quality;
  state.settingsTrigger = trigger;
  form.hidden = false;
  backdrop.hidden = false;
  document.querySelector("#editorTitle").textContent = `${quality === "main" ? "主码流" : "子码流"}设置`;
  form.querySelectorAll("fieldset[data-profile]").forEach((fieldset) => {
    fieldset.hidden = fieldset.dataset.profile !== quality;
  });
  document.querySelectorAll(".quality-config").forEach((button) => {
    const active = button.dataset.quality === quality;
    button.classList.toggle("is-open", active);
    button.setAttribute("aria-expanded", String(active));
  });
  placeSettings(trigger);
  window.requestAnimationFrame(() => {
    form.classList.add("is-open");
    backdrop.classList.add("is-open");
  });
  await loadSettings();
  if (state.editingProfile === quality) {
    placeSettings(trigger);
    form.querySelector(`fieldset[data-profile="${quality}"] select`)?.focus();
  }
}

function setSettingsStatus(message, kind = "idle") {
  const status = document.querySelector("#settingsStatus");
  status.textContent = message;
  status.dataset.kind = kind;
}

function populateSettings(config) {
  const form = document.querySelector("#settingsBody");
  for (const quality of ["main", "sub"]) {
    const value = config[quality];
    const resolution = form.elements[`${quality}Resolution`];
    const resolutionValue = `${value.width}x${value.height}`;
    if (![...resolution.options].some((option) => option.value === resolutionValue)) {
      resolution.add(new Option(`${value.width} × ${value.height}`, resolutionValue));
    }
    resolution.value = resolutionValue;
    form.elements[`${quality}Fps`].value = value.fps;
    form.elements[`${quality}Bitrate`].value = value.bitrate_kbps;
  }
}

async function loadSettings() {
  const saveButton = document.querySelector("#saveSettings");
  saveButton.disabled = true;
  setSettingsStatus("正在读取板端配置…", "loading");
  try {
    const response = await fetch("/api/config", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    state.config = data;
    state.configLoaded = data.rebuilding !== true;
    populateSettings(data);
    updateQualityLabels();
    updateInspector();
    setSettingsStatus(data.rebuilding ? "板端正在应用上一组配置…" : "已读取当前配置", data.rebuilding ? "loading" : "success");
  } catch (error) {
    state.configLoaded = false;
    setSettingsStatus(error.message || "板端配置读取失败", "error");
  } finally {
    saveButton.disabled = !state.configLoaded;
  }
}

async function waitForConfigApplied(initial) {
  let latest = initial;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const generationApplied = latest.generation == null
      || (latest.applied_generation != null && latest.applied_generation >= latest.generation);
    if (latest.rebuilding !== true && generationApplied) return latest;
    await new Promise((resolve) => window.setTimeout(resolve, 500));
    const response = await fetch("/api/config", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    latest = data;
  }
  throw new Error("板端重建码流超时，请检查板端日志");
}

function settingsPayload() {
  const form = document.querySelector("#settingsBody");
  const profile = (quality) => {
    const [width, height] = form.elements[`${quality}Resolution`].value.split("x").map(Number);
    return {
      width,
      height,
      fps: Number(form.elements[`${quality}Fps`].value),
      bitrate_kbps: Number(form.elements[`${quality}Bitrate`].value),
    };
  };
  return { main: profile("main"), sub: profile("sub") };
}

async function saveSettings(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const saveButton = document.querySelector("#saveSettings");
  if (!form.reportValidity()) return;
  saveButton.disabled = true;
  setSettingsStatus("正在应用到 8 路码流…", "loading");
  try {
    const response = await fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settingsPayload()),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    setSettingsStatus(data.rebuilding ? "板端正在重建编码通道…" : "配置已提交，正在确认…", "loading");
    const applied = await waitForConfigApplied(data);
    state.config = applied;
    state.configLoaded = true;
    populateSettings(applied);
    updateQualityLabels();
    updateInspector();
    setSettingsStatus("设置已生效，视频正在重新连接", "success");
    window.setTimeout(refresh, 300);
    state.settingsAutoCloseTimer = window.setTimeout(() => closeSettings(), 750);
  } catch (error) {
    setSettingsStatus(error.message || "设置应用失败", "error");
  } finally {
    saveButton.disabled = !state.configLoaded;
  }
}

function recordingProfileText(data = state.recording) {
  const source = data?.source || "main";
  const profile = data?.profile || configFor(source);
  return `${source === "main" ? "主码流" : "子码流"} · ${profile.width}×${profile.height} · ${profile.fps}FPS · ${profile.bitrate_kbps}Kbps`;
}

function updateRecordingUi(data) {
  if (!data) return;
  state.recording = data;
  const row = document.querySelector("#recordingRow");
  const dot = document.querySelector("#recordingDot");
  const mounted = data.storage?.mounted === true;
  const active = data.enabled && mounted;
  row.classList.toggle("is-active", active);
  dot.className = active ? "active" : (data.enabled && !mounted ? "error" : "");
  document.querySelector("#recordingSummary").textContent = active
    ? `${data.recording_cameras || 0} 路录像 · ${data.segment_seconds} 秒分片`
    : (data.enabled ? "SD 卡不可用" : "已停止");
  const hubRecordingSummary = document.querySelector("#hubRecordingSummary");
  if (hubRecordingSummary) hubRecordingSummary.textContent = document.querySelector("#recordingSummary").textContent;
  document.querySelector("#recordProfile").textContent = `${recordingProfileText(data)}；清晰度、帧率和码率可通过对应码流齿轮调整。`;
  const storage = data.storage;
  if (storage) {
    document.querySelector("#storageFree").textContent = `${(storage.free_mb / 1024).toFixed(1)} GB 可用`;
    document.querySelector("#storageTotal").textContent = `/ ${(storage.total_mb / 1024).toFixed(1)} GB`;
    const bar = document.querySelector("#storageBar");
    bar.style.width = `${Math.min(100, storage.used_percent)}%`;
    bar.classList.toggle("warning", storage.used_percent >= data.max_usage_percent - 5);
  }
}

function populateRecording(data) {
  const form = document.querySelector("#recordingBody");
  form.elements.enabled.checked = data.enabled;
  form.elements.source.value = data.source;
  form.elements.segmentSeconds.value = data.segment_seconds;
  form.elements.reserveMb.value = data.reserve_mb;
  form.elements.maxUsage.value = data.max_usage_percent;
  updateRecordingUi(data);
}

function setRecordingStatus(message, kind = "idle") {
  const status = document.querySelector("#recordingStatus");
  status.textContent = message;
  status.dataset.kind = kind;
}

function closeRecording({ restoreFocus = true } = {}) {
  const form = document.querySelector("#recordingBody");
  const backdrop = document.querySelector("#recordingBackdrop");
  if (form.dataset.inline === "true") return;
  if (form.hidden) return;
  window.clearTimeout(state.recordingCloseTimer);
  form.classList.remove("is-open");
  backdrop.classList.remove("is-open");
  document.querySelector("#recordingRow").classList.remove("is-open");
  document.querySelector("#recordingConfig").classList.remove("is-open");
  document.querySelector("#recordingConfig").setAttribute("aria-expanded", "false");
  const focusTarget = state.recordingTrigger;
  state.recordingCloseTimer = window.setTimeout(() => {
    form.hidden = true;
    backdrop.hidden = true;
    if (restoreFocus) focusTarget?.focus();
    state.recordingTrigger = null;
  }, 190);
}

async function loadRecording() {
  const saveButton = document.querySelector("#saveRecording");
  saveButton.disabled = true;
  setRecordingStatus("正在读取 SD 卡状态…", "loading");
  try {
    const response = await fetch("/api/recording", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    populateRecording(data);
    setRecordingStatus(data.storage?.mounted ? "SD 卡状态正常" : "未检测到 SD 卡", data.storage?.mounted ? "success" : "error");
    saveButton.disabled = false;
  } catch (error) {
    setRecordingStatus(error.message || "录像状态读取失败", "error");
  }
}

async function toggleRecording(trigger) {
  const form = document.querySelector("#recordingBody");
  const backdrop = document.querySelector("#recordingBackdrop");
  if (!form.hidden) {
    closeRecording();
    return;
  }
  closeSettings({ restoreFocus: false });
  window.clearTimeout(state.recordingCloseTimer);
  state.recordingTrigger = trigger;
  form.hidden = false;
  backdrop.hidden = false;
  trigger.classList.add("is-open");
  trigger.setAttribute("aria-expanded", "true");
  document.querySelector("#recordingRow").classList.add("is-open");
  placeDialog(form, trigger);
  window.requestAnimationFrame(() => {
    form.classList.add("is-open");
    backdrop.classList.add("is-open");
  });
  await loadRecording();
  if (!form.hidden) {
    placeDialog(form, trigger);
    form.elements.enabled.focus();
  }
}

function recordingPayload() {
  const form = document.querySelector("#recordingBody");
  return {
    enabled: form.elements.enabled.checked,
    source: form.elements.source.value,
    segment_seconds: Number(form.elements.segmentSeconds.value),
    reserve_mb: Number(form.elements.reserveMb.value),
    max_usage_percent: Number(form.elements.maxUsage.value),
  };
}

async function saveRecording(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const saveButton = document.querySelector("#saveRecording");
  if (!form.reportValidity()) return;
  saveButton.disabled = true;
  setRecordingStatus("正在应用到 RV1126B…", "loading");
  try {
    const response = await fetch("/api/recording", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(recordingPayload()),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    populateRecording(data);
    setRecordingStatus(data.enabled ? "录像已启动，等待关键帧写入" : "录像已停止，当前分片已安全封口", "success");
  } catch (error) {
    setRecordingStatus(error.message || "录像设置失败", "error");
  } finally {
    saveButton.disabled = false;
  }
}

async function refreshRecording() {
  try {
    const response = await fetch("/api/recording", { cache: "no-store" });
    if (!response.ok) return;
    updateRecordingUi(await response.json());
  } catch (_error) {}
}

function formatRecordingSize(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatRecordingTime(epoch) {
  return new Date(Number(epoch) * 1000).toLocaleString("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}

function recordingStartEpoch(file = {}) {
  const match = String(file.name || "").match(/^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/);
  if (match) {
    const [, year, month, day, hour, minute, second] = match;
    return Math.floor(new Date(
      Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second),
    ).getTime() / 1000);
  }
  return Number(file.modified_epoch || 0);
}

function formatRecordingTimelineTime(epoch) {
  const date = new Date(Number(epoch) * 1000);
  if (!Number.isFinite(date.getTime())) return "--/-- --:--:--";
  return date.toLocaleString("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

function recordingFileUrl(file = {}) {
  if (file.url) return file.url;
  if (!file.camera || !file.name) return "";
  return `/api/recording/file?camera=${encodeURIComponent(file.camera)}&name=${encodeURIComponent(file.name)}`;
}

function localDateValue(date = new Date()) {
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((value) => String(value).padStart(2, "0"))
    .join("-");
}

function syncRecordingDateLimit() {
  const input = document.querySelector("#recordingsDateFilter");
  if (!input) return;
  const today = localDateValue();
  input.max = today;
  if (input.value && input.value > today) {
    input.value = today;
    state.recordingFilterDate = today;
  }
}

function recordingMatchesFilter(file) {
  const date = new Date(Number(file.modified_epoch || 0) * 1000);
  if (!Number.isFinite(date.getTime())) return !state.recordingFilterDate;
  const localDate = localDateValue(date);
  if (localDate > localDateValue()) return false;
  if (!state.recordingFilterDate) return true;
  return localDate === state.recordingFilterDate;
}

function filteredRecordingFiles(files = []) {
  return files.filter(recordingMatchesFilter);
}

function closeRecordings({ restoreFocus = true } = {}) {
  state.recordingTimelineToken += 1;
  const form = document.querySelector("#recordingsBody");
  const backdrop = document.querySelector("#recordingsBackdrop");
  if (form.hidden) return;
  form.classList.remove("is-open");
  backdrop.classList.remove("is-open");
  const focusTarget = state.recordingsTrigger;
  window.setTimeout(() => {
    form.hidden = true;
    backdrop.hidden = true;
    if (restoreFocus) focusTarget?.focus();
    state.recordingsTrigger = null;
  }, 190);
}

function renderRecordings(page, append = false) {
  const list = document.querySelector("#recordingList");
  const files = filteredRecordingFiles(page.files || []);
  if (!files.length) {
    list.innerHTML = '<p class="recordings-empty">当前筛选没有已封存的录像</p>';
    return;
  }
  const rows = files.map((file) => {
    const url = recordingFileUrl(file);
    return `
    <article class="recording-file" data-url="${url}" data-camera="${file.camera}" data-name="${file.name}">
      <div><b>${file.camera.replace("-", " · ").toUpperCase()}</b><span>${formatRecordingTime(file.modified_epoch)} · ${formatRecordingSize(file.size_bytes)}</span></div>
      <div class="recording-file-actions">
        <button type="button" data-recording-play>播放</button>
        <a href="${url}" download="${file.name}">下载</a>
        <button type="button" data-recording-delete>删除</button>
      </div>
    </article>`;
  }).join("");
  list.innerHTML = rows;
}

function rebuildRecordingPlaylist() {
  const activeName = state.recordingPlaylist[state.recordingActiveIndex]?.name;
  state.recordingPlaylist = filteredRecordingFiles(state.recordingTimelineFiles)
    .filter((file) => file && file.name && file.name.endsWith(".mp4") && !file.name.endsWith(".mp4.part"))
    .sort((left, right) => Number(left.modified_epoch) - Number(right.modified_epoch) || left.name.localeCompare(right.name));
  state.recordingDurations = state.recordingPlaylist.map(() => RECORDING_SEGMENT_SECONDS);
  const player = document.querySelector("#recordingPlayer");
  const scrubber = document.querySelector("#recordingScrubber");
  player.hidden = !state.recordingPlaylist.length;
  scrubber.disabled = !state.recordingPlaylist.length;
  if (activeName) {
    state.recordingActiveIndex = state.recordingPlaylist.findIndex((file) => file.name === activeName);
    if (state.recordingActiveIndex < 0) {
      document.querySelector("#recordingPreview").pause();
      document.querySelector("#recordingPreview").removeAttribute("src");
      document.querySelector("#recordingPreview").load();
      state.recordingActiveIndex = -1;
    }
  }
  rebuildRecordingOffsets();
}

function applyRecordingFilter() {
  renderRecordings({ files: state.recordingFiles });
  rebuildRecordingPlaylist();
  const total = state.recordingFiles.length;
  const visible = filteredRecordingFiles(state.recordingFiles).length;
  const status = document.querySelector("#recordingsStatus");
  status.textContent = state.recordingFilterDate
    ? `日期 ${state.recordingFilterDate} · 显示 ${visible} / ${total} 个已封存文件`
    : `已显示 ${visible} 个已封存文件`;
  status.dataset.kind = "success";
  if (state.recordingPlaylist.length) {
    setRecordingPlaybackStatus(`筛选后保留 ${state.recordingPlaylist.length} 段录像，可拖动总时间轴定位`);
  } else if (state.recordingFilterDate) {
    setRecordingPlaybackStatus("当前日期没有可连续播放的录像");
  }
}

const RECORDING_SEGMENT_SECONDS = 30;

function formatRecordingDuration(seconds) {
  const value = Math.max(0, Math.round(Number(seconds) || 0));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const remainder = value % 60;
  return hours ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}` : `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function setRecordingPlaybackStatus(text, kind = "") {
  const status = document.querySelector("#recordingPlaybackStatus");
  status.textContent = text;
  status.dataset.kind = kind;
}

function updateRecordingScrubberFill(value = null) {
  const scrubber = document.querySelector("#recordingScrubber");
  if (!scrubber) return;
  const minimum = Number(scrubber.min || 0);
  const maximum = Number(scrubber.max || 0);
  const current = Number(value == null ? scrubber.value : value);
  const ratio = maximum > minimum
    ? Math.max(0, Math.min(1, (current - minimum) / (maximum - minimum)))
    : 0;
  scrubber.style.setProperty("--recording-progress", `${(ratio * 100).toFixed(3)}%`);
}

function updateRecordingTimelinePosition(position = null) {
  const scrubber = document.querySelector("#recordingScrubber");
  const minimum = Number(scrubber.min || 0);
  const current = Math.max(minimum, Math.min(state.recordingTotalDuration, position == null ? Number(scrubber.value || 0) : Number(position)));
  const startEpoch = state.recordingTimelineStartEpoch;
  document.querySelector("#recordingCurrentTime").textContent = startEpoch
    ? formatRecordingTimelineTime(startEpoch + current)
    : formatRecordingDuration(current);
  document.querySelector("#recordingTotalTime").textContent = startEpoch
    ? formatRecordingTimelineTime(startEpoch + state.recordingTotalDuration)
    : formatRecordingDuration(state.recordingTotalDuration);
  if (position != null && !scrubber.matches(":active")) scrubber.value = String(current);
  updateRecordingScrubberFill(current);
}

function resetRecordingTimeline(message = "请选择单个摄像头读取录像时间轴") {
  state.recordingTimelineToken += 1;
  state.recordingPlaylist = [];
  state.recordingDurations = [];
  state.recordingOffsets = [];
  state.recordingTotalDuration = 0;
  state.recordingTimelineStartEpoch = 0;
  state.recordingActiveIndex = -1;
  state.recordingSeekTarget = null;
  const player = document.querySelector("#recordingPlayer");
  const preview = document.querySelector("#recordingPreview");
  const scrubber = document.querySelector("#recordingScrubber");
  preview.pause();
  preview.removeAttribute("src");
  preview.load();
  player.hidden = true;
  scrubber.disabled = true;
  scrubber.max = "0";
  scrubber.value = "0";
  updateRecordingTimelinePosition(0);
  setRecordingPlaybackStatus(message);
}

function rebuildRecordingOffsets() {
  const offsets = [];
  let total = 0;
  state.recordingDurations.forEach((duration) => {
    offsets.push(total);
    total += Math.max(0.1, Number(duration) || RECORDING_SEGMENT_SECONDS);
  });
  state.recordingOffsets = offsets;
  state.recordingTotalDuration = total;
  state.recordingTimelineStartEpoch = state.recordingPlaylist.length
    ? recordingStartEpoch(state.recordingPlaylist[0])
    : 0;
  const scrubber = document.querySelector("#recordingScrubber");
  scrubber.min = "0";
  scrubber.max = String(total);
  updateRecordingTimelinePosition();
}

function recordingIndexAt(position) {
  const offsets = state.recordingOffsets;
  if (!offsets.length) return -1;
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (offsets[middle] <= position) low = middle;
    else high = middle - 1;
  }
  return low;
}

function recordingFileOffset(index, position) {
  return Math.max(0, Number(position) - (state.recordingOffsets[index] || 0));
}

async function loadRecordingSegment(index, offset = 0, autoplay = false) {
  const file = state.recordingPlaylist[index];
  if (!file) return;
  const preview = document.querySelector("#recordingPreview");
  const url = recordingFileUrl(file);
  state.recordingActiveIndex = index;
  state.recordingSeekTarget = { offset, autoplay };
  preview.pause();
  preview.src = url;
  preview.load();
  setRecordingPlaybackStatus(`${formatRecordingTimelineTime(recordingStartEpoch(file))} · 已封存录像`);
}

async function loadRecordingTimeline(camera, firstPage, token) {
  if (camera === "all") {
    resetRecordingTimeline();
    return;
  }
  const total = Number(firstPage.total) || 0;
  const files = [...(firstPage.files || [])];
  const publishTimeline = (final = false) => {
    if (token !== state.recordingTimelineToken) return;
    const activeName = state.recordingPlaylist[state.recordingActiveIndex]?.name;
    state.recordingTimelineFiles = files;
    rebuildRecordingPlaylist();
    if (final) {
      setRecordingPlaybackStatus(`已载入 ${state.recordingPlaylist.length} 段已封存录像，可拖动总时间轴定位`);
    } else {
      setRecordingPlaybackStatus(`已载入最近 ${state.recordingPlaylist.length} 段，正在后台读取更早录像…`);
    }
  };

  publishTimeline();
  if (!files.length) {
    setRecordingPlaybackStatus("当前摄像头没有已封存录像");
    return;
  }
  // Start with the newest finalized segment so opening the manager immediately
  // shows a real frame instead of leaving the player parked at 0:00.
  await loadRecordingSegment(state.recordingPlaylist.length - 1, 0, true);

  try {
    for (let offset = 100; offset < total; offset += 100) {
      const response = await fetch(`/api/recordings?camera=${encodeURIComponent(camera)}&offset=${offset}&limit=100`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      files.push(...(data.files || []));
      if (token !== state.recordingTimelineToken) return;
      await new Promise((resolve) => window.setTimeout(resolve, 30));
    }
  } catch (error) {
    if (token === state.recordingTimelineToken) setRecordingPlaybackStatus(error.message || "录像时间轴读取失败", "error");
    return;
  }
  if (token !== state.recordingTimelineToken) return;
  publishTimeline(true);
}

async function loadRecordings({ append = false } = {}) {
  const status = document.querySelector("#recordingsStatus");
  const list = document.querySelector("#recordingList");
  const camera = document.querySelector("#recordingsCamera").value;
  if (!append) state.recordingsOffset = 0;
  status.textContent = "正在读取录像目录…";
  status.dataset.kind = "loading";
  try {
    const response = await fetch(`/api/recordings?camera=${encodeURIComponent(camera)}&offset=${state.recordingsOffset}&limit=100`, { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    state.recordingFiles = append ? [...state.recordingFiles, ...(data.files || [])] : [...(data.files || [])];
    state.recordings = { ...data, files: state.recordingFiles };
    renderRecordings({ files: state.recordingFiles });
    state.recordingsOffset += data.files.length;
    const more = document.querySelector("#moreRecordings");
    more.hidden = state.recordingsOffset >= data.total;
    status.textContent = `已显示 ${state.recordingsOffset} / ${data.total} 个已封存文件`;
    status.dataset.kind = "success";
    if (!append) {
      const token = ++state.recordingTimelineToken;
      loadRecordingTimeline(camera, data, token);
    }
  } catch (error) {
    list.innerHTML = "";
    status.textContent = error.message || "录像目录读取失败";
    status.dataset.kind = "error";
  }
}

async function toggleRecordings(trigger) {
  const form = document.querySelector("#recordingsBody");
  const backdrop = document.querySelector("#recordingsBackdrop");
  if (!form.hidden) {
    closeRecordings();
    return;
  }
  closeSettings({ restoreFocus: false });
  closeRecording({ restoreFocus: false });
  syncRecordingDateLimit();
  state.recordingsTrigger = trigger;
  form.hidden = false;
  backdrop.hidden = false;
  placeDialog(form, trigger);
  window.requestAnimationFrame(() => {
    form.classList.add("is-open");
    backdrop.classList.add("is-open");
  });
  await loadRecordings();
  if (!form.hidden) placeDialog(form, trigger);
}

document.querySelector("#recordingManage").addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  toggleRecordings(event.currentTarget);
});
document.querySelector("#closeRecordings").addEventListener("click", closeRecordings);
document.querySelector("#recordingsBackdrop").addEventListener("click", closeRecordings);
document.querySelector("#refreshRecordings").addEventListener("click", loadRecordings);
document.querySelector("#recordingsCamera").addEventListener("change", loadRecordings);
document.querySelector("#moreRecordings").addEventListener("click", () => loadRecordings({ append: true }));
document.querySelector("#recordingsDateFilter").addEventListener("input", (event) => {
  const today = localDateValue();
  event.currentTarget.max = today;
  state.recordingFilterDate = event.currentTarget.value > today ? today : event.currentTarget.value;
  event.currentTarget.value = state.recordingFilterDate;
  applyRecordingFilter();
});
document.querySelector("#clearRecordingFilter").addEventListener("click", () => {
  state.recordingFilterDate = "";
  document.querySelector("#recordingsDateFilter").value = "";
  applyRecordingFilter();
});
document.querySelector("#recordingList").addEventListener("click", async (event) => {
  const file = event.target.closest(".recording-file");
  if (!file) return;
  if (event.target.closest("[data-recording-play]")) {
    const preview = document.querySelector("#recordingPreview");
    const url = file.dataset.url || recordingFileUrl(file.dataset);
    if (!url) return;
    const index = state.recordingPlaylist.findIndex((item) => item.name === file.dataset.name);
    if (index >= 0) {
      await loadRecordingSegment(index, 0, true);
      preview.hidden = false;
    } else {
      preview.src = url;
      preview.hidden = false;
      preview.play().catch(() => {});
    }
  }
  if (event.target.closest("[data-recording-delete]")) {
    if (!window.confirm("确定删除这个录像文件吗？")) return;
    const response = await fetch(`/api/recording/file?camera=${encodeURIComponent(file.dataset.camera)}&name=${encodeURIComponent(file.dataset.name)}`, { method: "DELETE" });
    if (!response.ok) {
      document.querySelector("#recordingsStatus").textContent = "删除失败，文件可能正在写入";
      return;
    }
    await loadRecordings();
  }
});

document.querySelector("#recordingScrubber").addEventListener("input", (event) => {
  if (!state.recordingPlaylist.length) return;
  const position = Number(event.currentTarget.value);
  updateRecordingTimelinePosition(position);
  const index = recordingIndexAt(position);
  if (index < 0) return;
  const offset = recordingFileOffset(index, position);
  state.recordingSeekTarget = { offset, autoplay: !document.querySelector("#recordingPreview").paused };
  const timelineTime = state.recordingTimelineStartEpoch
    ? formatRecordingTimelineTime(state.recordingTimelineStartEpoch + position)
    : formatRecordingDuration(position);
  setRecordingPlaybackStatus(`定位到 ${timelineTime} · 正在切换录像段`);
});

document.querySelector("#recordingScrubber").addEventListener("change", (event) => {
  if (!state.recordingPlaylist.length) return;
  const position = Number(event.currentTarget.value);
  const index = recordingIndexAt(position);
  if (index >= 0) loadRecordingSegment(index, recordingFileOffset(index, position), true);
});

document.querySelector("#recordingPreview").addEventListener("loadedmetadata", (event) => {
  const preview = event.currentTarget;
  const index = state.recordingActiveIndex;
  if (index < 0 || !Number.isFinite(preview.duration) || preview.duration <= 0) return;
  state.recordingDurations[index] = preview.duration;
  rebuildRecordingOffsets();
  const target = state.recordingSeekTarget;
  state.recordingSeekTarget = null;
  if (target) {
    preview.currentTime = Math.min(Math.max(0, target.offset), Math.max(0, preview.duration - 0.05));
    if (target.autoplay) preview.play().catch(() => {});
  }
});

document.querySelector("#recordingPreview").addEventListener("timeupdate", (event) => {
  const index = state.recordingActiveIndex;
  if (index < 0) return;
  const position = (state.recordingOffsets[index] || 0) + Number(event.currentTarget.currentTime || 0);
  updateRecordingTimelinePosition(position);
});

document.querySelector("#recordingPreview").addEventListener("ended", () => {
  const nextIndex = state.recordingActiveIndex + 1;
  if (nextIndex < state.recordingPlaylist.length) loadRecordingSegment(nextIndex, 0, true);
});

async function recoverRecordingPreviewError() {
  const preview = document.querySelector("#recordingPreview");
  if (preview.dataset.recovering === "1") return;
  const file = state.recordingPlaylist[state.recordingActiveIndex];
  if (!file) {
    setRecordingPlaybackStatus("没有可播放的录像段", "error");
    return;
  }
  preview.dataset.recovering = "1";
  let missing = false;
  try {
    const response = await fetch(recordingFileUrl(file), {
      cache: "no-store",
      headers: { Range: "bytes=0-1" },
    });
    missing = response.status === 404 || response.status === 410;
  } catch (_error) {}
  if (!missing) {
    delete preview.dataset.recovering;
    setRecordingPlaybackStatus("录像段读取失败，请稍后重试", "error");
    return;
  }

  const failedIndex = state.recordingActiveIndex;
  state.recordingTimelineFiles = state.recordingTimelineFiles.filter((item) => item.name !== file.name);
  state.recordingFiles = state.recordingFiles.filter((item) => item.name !== file.name);
  state.recordingActiveIndex = -1;
  renderRecordings({ files: state.recordingFiles });
  rebuildRecordingPlaylist();
  const nextIndex = Math.min(failedIndex, state.recordingPlaylist.length - 1);
  delete preview.dataset.recovering;
  if (nextIndex >= 0) {
    setRecordingPlaybackStatus("最旧录像已被存储清理，已跳到最早可读片段", "loading");
    await loadRecordingSegment(nextIndex, 0, true);
  } else {
    resetRecordingTimeline("录像已被存储清理");
  }
}

document.querySelector("#recordingPreview").addEventListener("error", () => {
  recoverRecordingPreviewError();
});

function updateOverview() {
  const onlineCameras = (board = null) => cameraDefs.filter((camera) => {
    if (board && camera.board !== board) return false;
    return ["main", "sub"].some((quality) => streamFor(camera.id, quality)?.state === "online");
  }).length;
  const all = onlineCameras();
  document.querySelector("#countAll").textContent = `${all} / 8`;
  document.querySelector("#countLower").textContent = `${onlineCameras("lower")} / 4`;
  document.querySelector("#countUpper").textContent = `${onlineCameras("upper")} / 4`;
}

async function refresh() {
  try {
    const response = await fetch("/api/streams", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    state.apiOnline = true;
    state.networkStatus.apiOnline = true;
    updateNetworkDot();
    state.streams = new Map(data.streams.map((stream) => [stream.id, stream]));
    const main = data.streams.find((stream) => stream.quality === "main");
    const sub = data.streams.find((stream) => stream.quality === "sub");
    if (main && sub) {
      state.config = {
        main: { width: Number(main.resolution.split("×")[0]), height: Number(main.resolution.split("×")[1]), fps: main.expected_fps, bitrate_kbps: main.bitrate_kbps },
        sub: { width: Number(sub.resolution.split("×")[0]), height: Number(sub.resolution.split("×")[1]), fps: sub.expected_fps, bitrate_kbps: sub.bitrate_kbps },
      };
    }
    cameraDefs.forEach((camera) => updateFeed(camera.id));
    updateInspector();
    updateOverview();
  } catch (_error) {
    state.apiOnline = false;
    state.networkStatus.apiOnline = false;
    updateNetworkDot();
    updateOverview();
  } finally {
    window.setTimeout(refresh, 1000);
  }
}

async function detectHardwareDecode() {
  if (!navigator.mediaCapabilities?.decodingInfo) return;
  try {
    const info = await navigator.mediaCapabilities.decodingInfo({
      type: "file",
      video: {
        contentType: 'video/mp4; codecs="avc1.64001f"',
        width: 1280,
        height: 720,
        bitrate: 4000000,
        framerate: 25,
      },
    });
    state.hardwareCapable = info.supported && info.powerEfficient;
  } catch (_error) {
    state.hardwareCapable = null;
  }
}

function statusText(value) {
  return ({ online: "信号正常", connecting: "正在连接", waiting: "等待信号", offline: "信号离线", error: "接收异常" })[value] || "等待信号";
}

function statusEnglish(value) {
  return ({ connecting: "CONNECTING", offline: "SIGNAL OFFLINE", error: "RECEIVER ERROR" })[value] || "WAITING FOR SIGNAL";
}

function updateClock() {
  const now = new Date();
  document.querySelector("#clock").textContent = now.toLocaleTimeString("zh-CN", { hour12: false });
  document.querySelector("#date").textContent = now.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).replaceAll("/", ".");
}

document.querySelectorAll(".filter").forEach((button) => button.addEventListener("click", () => {
  state.filter = button.dataset.filter;
  document.querySelectorAll(".filter").forEach((item) => item.classList.toggle("is-active", item === button));
  document.querySelector("#viewTitle").textContent = state.filter === "all" ? "全部摄像头" : state.filter === "lower" ? "下层板摄像头" : "上层板摄像头";
  cameraDefs.forEach((camera) => updateFeed(camera.id));
}));

document.querySelectorAll(".quality-select").forEach((button) => button.addEventListener("click", () => setQuality(state.selected, button.dataset.quality)));
document.querySelectorAll(".quality-config").forEach((button) => button.addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  toggleSettings(button.dataset.quality, button);
}));
document.querySelector("#networkTrigger").addEventListener("click", (event) => {
  event.preventDefault();
  toggleSettingsHub(event.currentTarget);
});
document.querySelector("#closeSettingsHub").addEventListener("click", closeSettingsHub);
document.querySelector("#settingsHubBackdrop").addEventListener("click", closeSettingsHub);
document.querySelectorAll("[data-settings-hub-target]").forEach((button) => button.addEventListener("click", () => {
  openSettingsHubTarget(button.dataset.settingsHubTarget);
}));
document.querySelector("#closeNetwork").addEventListener("click", closeNetwork);
document.querySelector("#networkBackdrop").addEventListener("click", closeNetwork);
document.querySelectorAll(".network-tab").forEach((button) => button.addEventListener("click", () => setNetworkTab(button.dataset.networkTab)));
document.querySelector("#wifiPane").addEventListener("submit", saveWifi);
document.querySelector("#apPane").addEventListener("submit", saveAp);
document.querySelector("#scanWifi").addEventListener("click", scanWifi);
document.querySelector("#wifiScanList").addEventListener("click", (event) => {
  const button = event.target.closest("[data-ssid]");
  if (button) document.querySelector("#wifiPane input[name=ssid]").value = button.dataset.ssid;
});
document.querySelector("#qualityAll").addEventListener("click", (event) => {
  const quality = event.currentTarget.dataset.target === "sub" ? "sub" : "main";
  cameraDefs.forEach((camera) => {
    state.quality.set(camera.id, quality);
    stopPlayer(camera.id);
    updateFeed(camera.id);
  });
  updateInspector();
  updateQualityAllAction();
});
document.querySelector("#closeSettings").addEventListener("click", closeSettings);
document.querySelector("#settingsBackdrop").addEventListener("click", closeSettings);
document.querySelector("#settingsBody").addEventListener("submit", saveSettings);
document.querySelector("#settingsBody").addEventListener("keydown", (event) => {
  if (event.key !== "Tab") return;
  const controls = [...event.currentTarget.querySelectorAll("button:not(:disabled), select:not(:disabled), input:not(:disabled)")]
    .filter((element) => element.offsetParent !== null);
  if (!controls.length) return;
  const first = controls[0];
  const last = controls.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});
document.querySelector("#recordingConfig").addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  toggleRecording(event.currentTarget);
});
document.querySelector("#closeRecording").addEventListener("click", closeRecording);
document.querySelector("#recordingBackdrop").addEventListener("click", closeRecording);
document.querySelector("#recordingBody").addEventListener("submit", saveRecording);
document.querySelector("#recordingBody").elements.source.addEventListener("change", (event) => {
  const profile = configFor(event.currentTarget.value);
  document.querySelector("#recordProfile").textContent = `${event.currentTarget.value === "main" ? "主码流" : "子码流"} · ${profile.width}×${profile.height} · ${profile.fps}FPS · ${profile.bitrate_kbps}Kbps；可通过码流齿轮调整。`;
});
document.querySelector("#recordingBody").addEventListener("keydown", (event) => {
  if (event.key !== "Tab") return;
  const controls = [...event.currentTarget.querySelectorAll("button:not(:disabled), select:not(:disabled), input:not(:disabled)")]
    .filter((element) => element.offsetParent !== null);
  if (!controls.length) return;
  const first = controls[0];
  const last = controls.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!document.querySelector("#settingsHubBody").hidden) closeSettingsHub();
  else if (document.querySelector("#networkBody").dataset.inline !== "true" && !document.querySelector("#networkBody").hidden) closeNetwork();
  else if (document.querySelector("#settingsBody").dataset.inline !== "true" && !document.querySelector("#settingsBody").hidden) closeSettings();
  else if (document.querySelector("#recordingBody").dataset.inline !== "true" && !document.querySelector("#recordingBody").hidden) closeRecording();
  else if (!document.querySelector("#recordingsBody").hidden) closeRecordings();
});
window.addEventListener("resize", () => {
  if (state.settingsTrigger && !document.querySelector("#settingsBody").hidden) placeSettings(state.settingsTrigger);
  if (state.recordingTrigger && !document.querySelector("#recordingBody").hidden) placeDialog(document.querySelector("#recordingBody"), state.recordingTrigger);
  if (state.recordingsTrigger && !document.querySelector("#recordingsBody").hidden) placeDialog(document.querySelector("#recordingsBody"), state.recordingsTrigger);
});
window.addEventListener("beforeunload", () => cameraDefs.forEach((camera) => stopPlayer(camera.id)));

restoreNetworkCredentials();
renderFeeds();
detectHardwareDecode();
updateInspector();
updateQualityAllAction();
updateClock();
setInterval(updateClock, 1000);
refresh();
refreshNetworkIndicator();
setInterval(refreshNetworkIndicator, 5000);
refreshRecording();
setInterval(refreshRecording, 2000);
window.addEventListener("load", () => setTimeout(() => document.querySelector("#boot").classList.add("is-hidden"), 500));
