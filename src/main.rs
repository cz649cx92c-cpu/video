use axum::{
    Router,
    body::Body,
    extract::{Query, State},
    http::{
        HeaderValue, StatusCode,
        header::{CACHE_CONTROL, CONTENT_TYPE},
    },
    response::{IntoResponse, Json, Response},
    routing::{delete, get},
};
use futures_core::Stream;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    env, io,
    pin::Pin,
    process::Stdio,
    sync::Arc,
    task::{Context, Poll},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
    sync::RwLock,
    time::{sleep, timeout},
};
use tower_http::{services::ServeDir, set_header::SetResponseHeaderLayer, trace::TraceLayer};

const DEFAULT_BOARD_HOST: &str = "192.168.100.125";
const DEFAULT_RTSP_PORT: u16 = 8554;
const DEFAULT_STATUS_PORT: u16 = 8555;
const DEFAULT_WEB_PORT: u16 = 9076;
const DEFAULT_WEBRTC_PORT: u16 = 8889;

#[derive(Clone, Copy)]
struct CameraDef {
    id: &'static str,
    board: &'static str,
    board_name: &'static str,
    channel: u8,
    device: &'static str,
}

const CAMERAS: [CameraDef; 8] = [
    CameraDef {
        id: "lower-ch1",
        board: "lower",
        board_name: "下层板",
        channel: 1,
        device: "/dev/video1",
    },
    CameraDef {
        id: "lower-ch2",
        board: "lower",
        board_name: "下层板",
        channel: 2,
        device: "/dev/video2",
    },
    CameraDef {
        id: "lower-ch3",
        board: "lower",
        board_name: "下层板",
        channel: 3,
        device: "/dev/video3",
    },
    CameraDef {
        id: "lower-ch4",
        board: "lower",
        board_name: "下层板",
        channel: 4,
        device: "/dev/video4",
    },
    CameraDef {
        id: "upper-ch1",
        board: "upper",
        board_name: "上层板",
        channel: 1,
        device: "/dev/video12",
    },
    CameraDef {
        id: "upper-ch2",
        board: "upper",
        board_name: "上层板",
        channel: 2,
        device: "/dev/video13",
    },
    CameraDef {
        id: "upper-ch3",
        board: "upper",
        board_name: "上层板",
        channel: 3,
        device: "/dev/video14",
    },
    CameraDef {
        id: "upper-ch4",
        board: "upper",
        board_name: "上层板",
        channel: 4,
        device: "/dev/video15",
    },
];

#[derive(Clone)]
struct AppState {
    board_host: String,
    rtsp_port: u16,
    status_port: u16,
    webrtc_port: u16,
    presence: Arc<RwLock<HashMap<String, bool>>>,
    stream_config: Arc<RwLock<StreamConfig>>,
}

#[derive(Deserialize)]
struct BoardStateFile {
    cameras: Vec<BoardCameraState>,
    #[serde(default)]
    config: Option<StreamConfig>,
}

#[derive(Deserialize)]
struct BoardCameraState {
    board: String,
    channel: u8,
    present: bool,
    running: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
struct QualityConfig {
    width: u16,
    height: u16,
    fps: u8,
    bitrate_kbps: u32,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
struct StreamConfig {
    main: QualityConfig,
    sub: QualityConfig,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    generation: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    applied_generation: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    rebuilding: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct RecordingConfig {
    enabled: bool,
    source: String,
    segment_seconds: u32,
    reserve_mb: u32,
    max_usage_percent: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    client_epoch_seconds: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    generation: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    profile: Option<QualityConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    storage: Option<RecordingStorage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    recording_cameras: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    cameras: Option<Vec<RecordingCamera>>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct RecordingStorage {
    mounted: bool,
    root: String,
    total_mb: u64,
    free_mb: u64,
    used_percent: u8,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct RecordingCamera {
    board: String,
    channel: u8,
    present: bool,
    recording: bool,
    segments: u64,
    dropped: u64,
    error: String,
    folder: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct RecordingFile {
    camera: String,
    name: String,
    size_bytes: u64,
    modified_epoch: u64,
    #[serde(default)]
    url: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct RecordingFilePage {
    camera: String,
    offset: u32,
    limit: u32,
    total: u32,
    files: Vec<RecordingFile>,
}

#[derive(Debug, Deserialize)]
struct RecordingQuery {
    camera: Option<String>,
    offset: Option<u32>,
    limit: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct RecordingStreamQuery {
    camera: String,
    start: Option<String>,
}

struct RecordingByteStream {
    receiver: tokio::sync::mpsc::Receiver<Result<Vec<u8>, io::Error>>,
}

impl Stream for RecordingByteStream {
    type Item = Result<Vec<u8>, io::Error>;

    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.get_mut().receiver.poll_recv(cx)
    }
}

#[derive(Debug, Deserialize)]
struct RecordingDeleteQuery {
    camera: String,
    name: String,
}

impl Default for StreamConfig {
    fn default() -> Self {
        Self {
            main: QualityConfig {
                width: 1280,
                height: 720,
                fps: 25,
                bitrate_kbps: 3072,
            },
            sub: QualityConfig {
                width: 640,
                height: 360,
                fps: 15,
                bitrate_kbps: 512,
            },
            generation: None,
            applied_generation: None,
            rebuilding: None,
        }
    }
}

#[derive(Serialize)]
struct ApiError {
    error: String,
}

#[derive(Serialize)]
struct ApiResponse {
    board_host: String,
    rtsp_port: u16,
    webrtc_port: u16,
    protocol: &'static str,
    generated_at_ms: u64,
    streams: Vec<StreamSnapshot>,
}

#[derive(Serialize)]
struct StreamSnapshot {
    id: String,
    camera_id: String,
    board: String,
    board_name: String,
    channel: u8,
    device: String,
    quality: String,
    resolution: String,
    expected_fps: u8,
    bitrate_kbps: u32,
    rtsp_url: String,
    webrtc_url: String,
    state: String,
    message: String,
    present: bool,
    passthrough: bool,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = env::current_dir()?;
    let web_root = root.join("web");
    let board_host = env::var("RV1126B_HOST").unwrap_or_else(|_| DEFAULT_BOARD_HOST.into());
    let rtsp_port = env_u16("RV1126B_RTSP_PORT", DEFAULT_RTSP_PORT);
    let status_port = env_u16("RV1126B_STATUS_PORT", DEFAULT_STATUS_PORT);
    let web_port = env_u16("VIDEO_WALL_PORT", DEFAULT_WEB_PORT);
    let webrtc_port = env_u16("VIDEO_WALL_WEBRTC_PORT", DEFAULT_WEBRTC_PORT);
    let bind_host = env::var("VIDEO_WALL_BIND").unwrap_or_else(|_| "127.0.0.1".into());

    let presence = Arc::new(RwLock::new(HashMap::new()));
    let stream_config = Arc::new(RwLock::new(StreamConfig::default()));
    for camera in CAMERAS {
        presence.write().await.insert(camera.id.into(), false);
    }
    tokio::spawn(board_state_monitor(
        board_host.clone(),
        status_port,
        presence.clone(),
        stream_config.clone(),
    ));

    let state = AppState {
        board_host: board_host.clone(),
        rtsp_port,
        status_port,
        webrtc_port,
        presence,
        stream_config,
    };
    let cache_layer = SetResponseHeaderLayer::if_not_present(
        CACHE_CONTROL,
        HeaderValue::from_static("no-cache, no-store, must-revalidate"),
    );
    let app = Router::new()
        .route("/api/streams", get(api_streams))
        .route("/api/config", get(api_config_get).post(api_config_post))
        .route(
            "/api/recording",
            get(api_recording_get).post(api_recording_post),
        )
        .route("/api/recordings", get(api_recordings_get))
        .route("/api/recording/stream", get(api_recording_stream))
        .route("/api/recording/file", delete(api_recording_delete))
        .fallback_service(ServeDir::new(&web_root).append_index_html_on_directories(true))
        .layer(cache_layer)
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let address = format!("{bind_host}:{web_port}");
    let listener = tokio::net::TcpListener::bind(&address).await?;
    println!("RV1126B Vision WebRTC 已启动: http://{address}");
    println!("板端硬件 H.264: rtsp://{board_host}:{rtsp_port}");
    println!("WebRTC/WHEP: http://127.0.0.1:{webrtc_port}");
    println!("视频保持 H.264 直通，无软件转码。\n");
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}

async fn api_streams(State(state): State<AppState>) -> Json<ApiResponse> {
    let presence = state.presence.read().await;
    let config = *state.stream_config.read().await;
    let mut streams = Vec::with_capacity(CAMERAS.len() * 2);
    for camera in CAMERAS {
        let present = presence.get(camera.id).copied().unwrap_or(false);
        for quality in ["main", "sub"] {
            let quality_config = if quality == "main" {
                config.main
            } else {
                config.sub
            };
            let id = format!("{}-{quality}", camera.id);
            streams.push(StreamSnapshot {
                id: id.clone(),
                camera_id: camera.id.into(),
                board: camera.board.into(),
                board_name: camera.board_name.into(),
                channel: camera.channel,
                device: camera.device.into(),
                quality: quality.into(),
                resolution: format!("{} × {}", quality_config.width, quality_config.height),
                expected_fps: quality_config.fps,
                bitrate_kbps: quality_config.bitrate_kbps,
                rtsp_url: format!(
                    "rtsp://{}:{}/{}/ch{}/{}",
                    state.board_host, state.rtsp_port, camera.board, camera.channel, quality
                ),
                webrtc_url: format!("http://127.0.0.1:{}/{id}/whep", state.webrtc_port),
                state: if present { "online" } else { "waiting" }.into(),
                message: if present {
                    "WebRTC 信号正常"
                } else {
                    "板端未检测到此摄像头"
                }
                .into(),
                present,
                passthrough: true,
            });
        }
    }
    Json(ApiResponse {
        board_host: state.board_host.clone(),
        rtsp_port: state.rtsp_port,
        webrtc_port: state.webrtc_port,
        protocol: "WebRTC",
        generated_at_ms: now_ms(),
        streams,
    })
}

async fn api_config_get(State(state): State<AppState>) -> Response {
    match fetch_board_json::<StreamConfig>(
        &state.board_host,
        state.status_port,
        "GET",
        "/config.json",
        None,
    )
    .await
    {
        Ok(config) => {
            *state.stream_config.write().await = config;
            Json(config).into_response()
        }
        Err(error) => (
            StatusCode::BAD_GATEWAY,
            Json(ApiError {
                error: format!("无法读取板端编码配置: {error}"),
            }),
        )
            .into_response(),
    }
}

async fn api_config_post(
    State(state): State<AppState>,
    Json(config): Json<StreamConfig>,
) -> Response {
    if let Err(error) = validate_stream_config(config) {
        return (StatusCode::UNPROCESSABLE_ENTITY, Json(ApiError { error })).into_response();
    }
    let body = match serde_json::to_vec(&config) {
        Ok(body) => body,
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiError {
                    error: error.to_string(),
                }),
            )
                .into_response();
        }
    };
    match fetch_board_json::<StreamConfig>(
        &state.board_host,
        state.status_port,
        "POST",
        "/config.json",
        Some(&body),
    )
    .await
    {
        Ok(applied) => {
            *state.stream_config.write().await = applied;
            Json(applied).into_response()
        }
        Err(error) => (
            StatusCode::BAD_GATEWAY,
            Json(ApiError {
                error: format!("板端应用编码配置失败: {error}"),
            }),
        )
            .into_response(),
    }
}

async fn api_recording_get(State(state): State<AppState>) -> Response {
    match fetch_board_json::<RecordingConfig>(
        &state.board_host,
        state.status_port,
        "GET",
        "/record.json",
        None,
    )
    .await
    {
        Ok(config) => Json(config).into_response(),
        Err(error) => (
            StatusCode::BAD_GATEWAY,
            Json(ApiError {
                error: format!("无法读取板端录像状态: {error}"),
            }),
        )
            .into_response(),
    }
}

async fn api_recording_post(
    State(state): State<AppState>,
    Json(mut config): Json<RecordingConfig>,
) -> Response {
    if let Err(error) = validate_recording_config(&config) {
        return (StatusCode::UNPROCESSABLE_ENTITY, Json(ApiError { error })).into_response();
    }
    config.client_epoch_seconds = Some(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
    );
    config.generation = None;
    config.profile = None;
    config.storage = None;
    config.recording_cameras = None;
    config.cameras = None;
    let body = match serde_json::to_vec(&config) {
        Ok(body) => body,
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiError {
                    error: error.to_string(),
                }),
            )
                .into_response();
        }
    };
    match fetch_board_json::<RecordingConfig>(
        &state.board_host,
        state.status_port,
        "POST",
        "/record.json",
        Some(&body),
    )
    .await
    {
        Ok(applied) => Json(applied).into_response(),
        Err(error) => (
            StatusCode::BAD_GATEWAY,
            Json(ApiError {
                error: format!("板端应用录像设置失败: {error}"),
            }),
        )
            .into_response(),
    }
}

async fn api_recordings_get(
    State(state): State<AppState>,
    Query(query): Query<RecordingQuery>,
) -> Response {
    let camera = query.camera.unwrap_or_else(|| "all".into());
    let offset = query.offset.unwrap_or(0);
    let limit = query.limit.unwrap_or(50).clamp(1, 100);
    if !valid_camera_id(&camera) {
        return (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(ApiError {
                error: "无效的摄像头目录".into(),
            }),
        )
            .into_response();
    }
    let path = format!("/recordings.json?camera={camera}&offset={offset}&limit={limit}");
    match fetch_board_json::<RecordingFilePage>(
        &state.board_host,
        state.status_port,
        "GET",
        &path,
        None,
    )
    .await
    {
        Ok(mut page) => {
            for file in &mut page.files {
                file.url = format!(
                    "http://{}:{}/recording.mp4?camera={}&name={}",
                    state.board_host, state.status_port, file.camera, file.name
                );
            }
            Json(page).into_response()
        }
        Err(error) => (
            StatusCode::BAD_GATEWAY,
            Json(ApiError {
                error: format!("无法读取 SD 卡录像目录: {error}"),
            }),
        )
            .into_response(),
    }
}

async fn load_recording_files(
    state: &AppState,
    camera: &str,
    start_name: Option<&str>,
) -> Result<Vec<RecordingFile>, Box<dyn std::error::Error + Send + Sync>> {
    let mut files = Vec::new();
    let mut offset = 0_u32;
    loop {
        let path = format!("/recordings.json?camera={camera}&offset={offset}&limit=100");
        let page = fetch_board_json::<RecordingFilePage>(
            &state.board_host,
            state.status_port,
            "GET",
            &path,
            None,
        )
        .await?;
        let total = page.total;
        let raw_page_len = page.files.len() as u32;
        let page_files: Vec<RecordingFile> = page
            .files
            .into_iter()
            .filter(|file| valid_recording_name(&file.name))
            .collect();
        if let Some(start_name) = start_name {
            if let Some(start_index) = page_files.iter().position(|file| file.name == start_name) {
                // The board returns newest-first. Keep the prefix through the
                // requested file; sorting below changes it to playback order.
                files.extend(page_files.into_iter().take(start_index + 1));
                break;
            }
            files.extend(page_files);
        } else {
            files.extend(page_files);
        }
        offset = offset.saturating_add(raw_page_len);
        if offset >= total || raw_page_len == 0 {
            break;
        }
    }
    if start_name.is_some()
        && !start_name.is_some_and(|name| files.iter().any(|file| file.name == name))
    {
        return Ok(Vec::new());
    }
    files.sort_by(|left, right| {
        left.modified_epoch
            .cmp(&right.modified_epoch)
            .then_with(|| left.name.cmp(&right.name))
    });
    Ok(files)
}

async fn api_recording_stream(
    State(state): State<AppState>,
    Query(query): Query<RecordingStreamQuery>,
) -> Response {
    if query.camera == "all" || !valid_camera_id(&query.camera) {
        return (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(ApiError {
                error: "连续播放必须选择一个摄像头".into(),
            }),
        )
            .into_response();
    }
    if query
        .start
        .as_deref()
        .is_some_and(|name| !valid_recording_name(name))
    {
        return (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(ApiError {
                error: "无效的起始录像文件名".into(),
            }),
        )
            .into_response();
    }
    let files = match load_recording_files(&state, &query.camera, query.start.as_deref()).await {
        Ok(files) if !files.is_empty() => files,
        Ok(_) => {
            return (
                StatusCode::NOT_FOUND,
                Json(ApiError {
                    error: "当前摄像头没有已封存录像".into(),
                }),
            )
                .into_response();
        }
        Err(error) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(ApiError {
                    error: format!("无法读取连续播放分片: {error}"),
                }),
            )
                .into_response();
        }
    };
    if query.start.is_some()
        && !query
            .start
            .as_ref()
            .is_some_and(|name| files.iter().any(|file| file.name == *name))
    {
        return (
            StatusCode::NOT_FOUND,
            Json(ApiError {
                error: "找不到起始录像分片".into(),
            }),
        )
            .into_response();
    }
    let ffmpeg = env::var("RV1126B_FFMPEG").unwrap_or_else(|_| "ffmpeg".into());
    let list_path = env::temp_dir().join(format!(
        "rv1126b-recording-{}-{}.txt",
        std::process::id(),
        now_ms()
    ));
    let mut concat_list = String::new();
    for file in &files {
        concat_list.push_str(&format!(
            "file 'http://{}:{}/recording.mp4?camera={}&name={}'\n",
            state.board_host, state.status_port, query.camera, file.name
        ));
    }
    if let Err(error) = tokio::fs::write(&list_path, concat_list).await {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiError {
                error: format!("无法创建连续播放清单: {error}"),
            }),
        )
            .into_response();
    }
    let mut child = match Command::new(ffmpeg)
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "concat",
            "-safe",
            "0",
            "-protocol_whitelist",
            "file,http,https,tcp,tls,crypto",
            "-i",
        ])
        .arg(&list_path)
        .args([
            "-map",
            "0:v:0",
            "-c",
            "copy",
            "-movflags",
            "+frag_keyframe+empty_moov+default_base_moof",
            "-f",
            "mp4",
            "pipe:1",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            let _ = tokio::fs::remove_file(&list_path).await;
            return (
                StatusCode::BAD_GATEWAY,
                Json(ApiError {
                    error: format!("无法启动连续播放封装器: {error}"),
                }),
            )
                .into_response();
        }
    };
    let Some(mut stdout) = child.stdout.take() else {
        let _ = tokio::fs::remove_file(&list_path).await;
        return (
            StatusCode::BAD_GATEWAY,
            Json(ApiError {
                error: "连续播放封装器没有输出流".into(),
            }),
        )
            .into_response();
    };
    let (sender, receiver) = tokio::sync::mpsc::channel::<Result<Vec<u8>, io::Error>>(8);
    tokio::spawn(async move {
        let mut buffer = vec![0_u8; 64 * 1024];
        loop {
            match stdout.read(&mut buffer).await {
                Ok(0) => break,
                Ok(size) => {
                    if sender.send(Ok(buffer[..size].to_vec())).await.is_err() {
                        let _ = child.kill().await;
                        return;
                    }
                }
                Err(error) => {
                    let _ = sender.send(Err(error)).await;
                    break;
                }
            }
        }
        let _ = child.wait().await;
        let _ = tokio::fs::remove_file(&list_path).await;
    });
    Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, "video/mp4")
        .header(CACHE_CONTROL, "no-store")
        .body(Body::from_stream(RecordingByteStream { receiver }))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

async fn api_recording_delete(
    State(state): State<AppState>,
    Query(query): Query<RecordingDeleteQuery>,
) -> Response {
    if !valid_camera_id(&query.camera) || !valid_recording_name(&query.name) {
        return (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(ApiError {
                error: "无效的摄像头目录或录像文件名".into(),
            }),
        )
            .into_response();
    }
    let path = format!(
        "/recording.json?camera={}&name={}",
        query.camera, query.name
    );
    match fetch_board_json::<serde_json::Value>(
        &state.board_host,
        state.status_port,
        "DELETE",
        &path,
        None,
    )
    .await
    {
        Ok(result) => Json(result).into_response(),
        Err(error) => (
            StatusCode::BAD_GATEWAY,
            Json(ApiError {
                error: format!("删除录像失败: {error}"),
            }),
        )
            .into_response(),
    }
}

async fn board_state_monitor(
    board_host: String,
    status_port: u16,
    presence: Arc<RwLock<HashMap<String, bool>>>,
    stream_config: Arc<RwLock<StreamConfig>>,
) {
    loop {
        match fetch_board_state(&board_host, status_port).await {
            Ok(board_state) => {
                let mut next = HashMap::new();
                for camera in board_state.cameras {
                    next.insert(
                        format!("{}-ch{}", camera.board, camera.channel),
                        camera.present && camera.running,
                    );
                }
                let mut current = presence.write().await;
                for camera in CAMERAS {
                    current.insert(
                        camera.id.into(),
                        next.get(camera.id).copied().unwrap_or(false),
                    );
                }
                drop(current);
                if let Some(config) = board_state.config {
                    *stream_config.write().await = config;
                }
            }
            Err(error) => eprintln!("板端状态同步失败: {error}"),
        }
        sleep(Duration::from_millis(500)).await;
    }
}

async fn fetch_board_state(
    board_host: &str,
    status_port: u16,
) -> Result<BoardStateFile, Box<dyn std::error::Error + Send + Sync>> {
    let request = async {
        let mut stream = tokio::net::TcpStream::connect((board_host, status_port)).await?;
        let request =
            format!("GET /state.json HTTP/1.1\r\nHost: {board_host}\r\nConnection: close\r\n\r\n");
        stream.write_all(request.as_bytes()).await?;
        let mut response = Vec::with_capacity(8192);
        stream.read_to_end(&mut response).await?;
        let body_start = response
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .map(|index| index + 4)
            .ok_or("状态服务返回了无效 HTTP 响应")?;
        Ok::<_, Box<dyn std::error::Error + Send + Sync>>(serde_json::from_slice(
            &response[body_start..],
        )?)
    };
    Ok(timeout(Duration::from_secs(2), request).await??)
}

async fn fetch_board_json<T: serde::de::DeserializeOwned>(
    board_host: &str,
    status_port: u16,
    method: &str,
    path: &str,
    body: Option<&[u8]>,
) -> Result<T, Box<dyn std::error::Error + Send + Sync>> {
    let request = async {
        let mut stream = tokio::net::TcpStream::connect((board_host, status_port)).await?;
        let body = body.unwrap_or_default();
        let request = format!(
            "{method} {path} HTTP/1.1\r\nHost: {board_host}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        stream.write_all(request.as_bytes()).await?;
        if !body.is_empty() {
            stream.write_all(body).await?;
        }
        let mut response = Vec::with_capacity(4096);
        stream.read_to_end(&mut response).await?;
        let header_end = response
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .map(|index| index + 4)
            .ok_or("板端配置服务返回了无效 HTTP 响应")?;
        let header = std::str::from_utf8(&response[..header_end])?;
        let status = header
            .lines()
            .next()
            .and_then(|line| line.split_whitespace().nth(1))
            .and_then(|value| value.parse::<u16>().ok())
            .ok_or("板端配置服务缺少 HTTP 状态码")?;
        if !(200..300).contains(&status) {
            let message = String::from_utf8_lossy(&response[header_end..]);
            return Err(format!("HTTP {status}: {message}").into());
        }
        Ok::<_, Box<dyn std::error::Error + Send + Sync>>(serde_json::from_slice(
            &response[header_end..],
        )?)
    };
    Ok(timeout(Duration::from_secs(4), request).await??)
}

fn validate_stream_config(config: StreamConfig) -> Result<(), String> {
    for (name, value, min_bitrate, max_bitrate) in [
        ("主码流", config.main, 256, 4096),
        ("子码流", config.sub, 64, 1024),
    ] {
        if value.width < 320 || value.width > 1280 || value.width % 2 != 0 {
            return Err(format!("{name}宽度必须是 320–1280 之间的偶数"));
        }
        if value.height < 180 || value.height > 720 || value.height % 2 != 0 {
            return Err(format!("{name}高度必须是 180–720 之间的偶数"));
        }
        if u32::from(value.width) * 9 != u32::from(value.height) * 16 {
            return Err(format!("{name}分辨率必须是 16:9"));
        }
        if !(1..=25).contains(&value.fps) {
            return Err(format!("{name}帧率必须是 1–25 FPS"));
        }
        if !(min_bitrate..=max_bitrate).contains(&value.bitrate_kbps) {
            return Err(format!("{name}码率必须是 {min_bitrate}–{max_bitrate} Kbps"));
        }
    }
    if config.sub.width > config.main.width || config.sub.height > config.main.height {
        return Err("子码流分辨率不能高于主码流".into());
    }
    Ok(())
}

fn validate_recording_config(config: &RecordingConfig) -> Result<(), String> {
    if config.source != "main" && config.source != "sub" {
        return Err("录像码流必须选择主码流或子码流".into());
    }
    if !(10..=3600).contains(&config.segment_seconds) {
        return Err("录像分片时长必须是 10–3600 秒".into());
    }
    if !(256..=16384).contains(&config.reserve_mb) {
        return Err("SD 卡保留空间必须是 256–16384 MB".into());
    }
    if !(50..=98).contains(&config.max_usage_percent) {
        return Err("SD 卡最大使用率必须是 50%–98%".into());
    }
    Ok(())
}

fn valid_camera_id(camera: &str) -> bool {
    camera == "all"
        || CAMERAS
            .iter()
            .any(|item| format!("{}-ch{}", item.board, item.channel) == camera)
}

fn valid_recording_name(name: &str) -> bool {
    name.len() >= 5
        && name.len() <= 255
        && name.ends_with(".mp4")
        && !name.contains("..")
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_.-".contains(&byte))
}

fn env_u16(name: &str, fallback: u16) -> u16 {
    env::var(name)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(fallback)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
