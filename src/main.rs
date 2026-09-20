use axum::{
    Router,
    extract::State,
    http::{HeaderValue, StatusCode, header::CACHE_CONTROL},
    response::{IntoResponse, Json, Response},
    routing::get,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    env,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
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
