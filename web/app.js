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
  focused: false,
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
  recordingsOffset: 0,
};

const grid = document.querySelector("#videoGrid");
const inspector = document.querySelector(".inspector");

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
    feed.addEventListener("dblclick", () => toggleFocus(feed.dataset.camera));
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
  if (window.innerWidth <= 1000) inspector.classList.add("is-open");
}

function toggleFocus(cameraId = state.selected) {
  if (cameraId !== state.selected) selectCamera(cameraId);
  state.focused = !state.focused;
  grid.classList.toggle("is-focus", state.focused);
  document.body.classList.toggle("focus-layout", state.focused);
  document.querySelector("#exitFocus").hidden = !state.focused;
  document.querySelector("#focusAction span").textContent = state.focused ? "返回视频墙" : "聚焦查看";
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
  const stream = streamFor(camera.id, requestedQuality);
  const decoder = state.decoder.get(camera.id);

  document.querySelector("#selectedBoard").textContent = camera.boardName;
  document.querySelector("#selectedChannel").textContent = String(camera.channel).padStart(2, "0");
  document.querySelector("#selectedDevice").textContent = camera.device;
  document.querySelector("#selectedQuality").textContent = requestedQuality.toUpperCase();
  document.querySelector("#selectedResolution").textContent = stream?.resolution || (requestedQuality === "main" ? "1280 × 720" : "640 × 360");
  document.querySelector("#selectedFps").textContent = decoder?.fps ? `${decoder.fps} FPS` : `${stream?.expected_fps || (requestedQuality === "main" ? 25 : 15)} FPS`;
  document.querySelector("#selectedBitrate").textContent = `${stream?.bitrate_kbps || configFor(requestedQuality).bitrate_kbps} Kbps`;
  document.querySelector("#selectedState").textContent = statusText(stream?.state);
  const dot = document.querySelector("#selectedDot");
  dot.className = stream?.state === "online" ? "online" : (stream?.state === "offline" || stream?.state === "error" ? "offline" : "");
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

function placeSettings(trigger) {
  placeDialog(document.querySelector("#settingsBody"), trigger);
}

function closeSettings({ restoreFocus = true } = {}) {
  const form = document.querySelector("#settingsBody");
  const backdrop = document.querySelector("#settingsBackdrop");
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

function closeRecordings({ restoreFocus = true } = {}) {
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
  if (!page.files?.length) {
    if (!append) list.innerHTML = '<p class="recordings-empty">当前筛选没有已封存的录像</p>';
    return;
  }
  const rows = page.files.map((file) => `
    <article class="recording-file" data-url="${file.url}" data-camera="${file.camera}" data-name="${file.name}">
      <div><b>${file.camera.replace("-", " · ").toUpperCase()}</b><span>${formatRecordingTime(file.modified_epoch)} · ${formatRecordingSize(file.size_bytes)}</span></div>
      <div class="recording-file-actions">
        <button type="button" data-recording-play>播放</button>
        <a href="${file.url}" download="${file.name}">下载</a>
        <button type="button" data-recording-delete>删除</button>
      </div>
    </article>`).join("");
  if (append) list.insertAdjacentHTML("beforeend", rows);
  else list.innerHTML = rows;
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
    state.recordings = data;
    renderRecordings(data, append);
    state.recordingsOffset += data.files.length;
    const more = document.querySelector("#moreRecordings");
    more.hidden = state.recordingsOffset >= data.total;
    status.textContent = `已显示 ${state.recordingsOffset} / ${data.total} 个已封存文件`;
    status.dataset.kind = "success";
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
document.querySelector("#recordingList").addEventListener("click", async (event) => {
  const file = event.target.closest(".recording-file");
  if (!file) return;
  if (event.target.closest("[data-recording-play]")) {
    const preview = document.querySelector("#recordingPreview");
    preview.src = file.dataset.url;
    preview.hidden = false;
    preview.play().catch(() => {});
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
document.querySelector("#focusAction").addEventListener("click", () => toggleFocus());
document.querySelector("#exitFocus").addEventListener("click", () => toggleFocus());
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
  if (!document.querySelector("#settingsBody").hidden) closeSettings();
  else if (!document.querySelector("#recordingBody").hidden) closeRecording();
  else if (!document.querySelector("#recordingsBody").hidden) closeRecordings();
  else if (state.focused) toggleFocus();
});
window.addEventListener("resize", () => {
  if (state.settingsTrigger && !document.querySelector("#settingsBody").hidden) placeSettings(state.settingsTrigger);
  if (state.recordingTrigger && !document.querySelector("#recordingBody").hidden) placeDialog(document.querySelector("#recordingBody"), state.recordingTrigger);
  if (state.recordingsTrigger && !document.querySelector("#recordingsBody").hidden) placeDialog(document.querySelector("#recordingsBody"), state.recordingsTrigger);
});
window.addEventListener("beforeunload", () => cameraDefs.forEach((camera) => stopPlayer(camera.id)));

renderFeeds();
detectHardwareDecode();
updateInspector();
updateQualityAllAction();
updateClock();
setInterval(updateClock, 1000);
refresh();
refreshRecording();
setInterval(refreshRecording, 2000);
window.addEventListener("load", () => setTimeout(() => document.querySelector("#boot").classList.add("is-hidden"), 500));
