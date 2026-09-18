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
  document.querySelector("#exitFocus").hidden = !state.focused;
  document.querySelector("#focusAction span").textContent = state.focused ? "返回视频墙" : "聚焦查看";
}

function setQuality(cameraId, quality) {
  state.quality.set(cameraId, quality);
  stopPlayer(cameraId);
  updateFeed(cameraId);
  updateInspector();
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
  document.querySelector("#selectedState").textContent = statusText(stream?.state);
  const dot = document.querySelector("#selectedDot");
  dot.className = stream?.state === "online" ? "online" : (stream?.state === "offline" || stream?.state === "error" ? "offline" : "");
  document.querySelectorAll(".quality-switch button").forEach((button) => button.classList.toggle("is-active", button.dataset.quality === requestedQuality));
}

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

document.querySelectorAll(".quality-switch button").forEach((button) => button.addEventListener("click", () => setQuality(state.selected, button.dataset.quality)));
document.querySelector("#focusAction").addEventListener("click", () => toggleFocus());
document.querySelector("#exitFocus").addEventListener("click", () => toggleFocus());
document.querySelector("#qualityAll").addEventListener("click", () => cameraDefs.forEach((camera) => setQuality(camera.id, "sub")));
document.addEventListener("keydown", (event) => { if (event.key === "Escape" && state.focused) toggleFocus(); });
window.addEventListener("beforeunload", () => cameraDefs.forEach((camera) => stopPlayer(camera.id)));

renderFeeds();
detectHardwareDecode();
updateInspector();
updateClock();
setInterval(updateClock, 1000);
refresh();
window.addEventListener("load", () => setTimeout(() => document.querySelector("#boot").classList.add("is-hidden"), 500));
