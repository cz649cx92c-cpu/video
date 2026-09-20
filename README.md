# RV / VISION

RV1126B 多摄像头 WebRTC 本地监看台。接收板端 8 个摄像头位置的主、子码流，并在浏览器中自动显示当前存在的摄像头。

## 特点

- Rust 负责页面、状态和热插拔管理，MediaMTX 负责 RTSP 到 WebRTC/WHEP 协议转发。
- H.264 全程直通，不解码、不重新编码，也不再产生 HLS 分片。
- 默认同时管理 16 个流：上下两层板 × CH1–CH4 × 主/子码流。
- 摄像头拔掉后显示离线，重新插入后自动恢复，不需要刷新网页。
- 通过板端只读状态接口 `http://192.168.100.125:8555/state.json` 获取真实热插拔状态，只连接实际存在的摄像头。
- 视频墙默认使用子码流；聚焦时保持用户当前选择，不会自动切换主码流。
- 右侧主、子码流卡片的齿轮分别打开对应设置，并从板端读取后统一调整 8 路摄像头的分辨率、帧率和码率。
- RV1126B 使用硬件 H.264 编码，浏览器 WebRTC 使用平台硬件解码优先；右侧显示实际统计或硬件能力检测结果。

## 启动

双击 `start-video-wall.cmd`，程序会自动启动并打开：

```text
http://127.0.0.1:9076
```

首次启动会自动下载官方 MediaMTX v1.21.0，并验证 SHA-256。需要预先安装 Rust GNU/LLVM 工具链：

```powershell
rustup toolchain install stable-x86_64-pc-windows-gnullvm
```

停止服务：双击 `stop-video-wall.cmd`，或在 PowerShell 中运行：

```powershell
.\stop.ps1
```

## 环境变量

| 名称 | 默认值 | 说明 |
|---|---|---|
| `RV1126B_HOST` | `192.168.100.125` | 板子 IP |
| `RV1126B_RTSP_PORT` | `8554` | RTSP 端口 |
| `RV1126B_STATUS_PORT` | `8555` | 板端状态与编码配置端口 |
| `VIDEO_WALL_PORT` | `9076` | 本机网页端口 |
| `VIDEO_WALL_WEBRTC_PORT` | `8889` | 本机 WebRTC/WHEP 端口 |
| `VIDEO_WALL_BIND` | `127.0.0.1` | 网页监听地址 |

## 板端地址映射

- 下层板 CH1–CH4：`/lower/ch1` 至 `/lower/ch4`
- 上层板 CH1–CH4：`/upper/ch1` 至 `/upper/ch4`
- 每个通道后缀：`/main` 或 `/sub`
- 网页会严格保持每路手动选择的主/子码流；进入聚焦模式不会自动切换。
- MediaMTX 对 H.264 只做协议转发，不在电脑端软件重编码；浏览器负责解码。

例如：

```text
rtsp://192.168.100.125:8554/lower/ch1/main
rtsp://192.168.100.125:8554/lower/ch1/sub
```

## 编码配置接口

电脑端公开 `GET/POST /api/config`，并代理板端 `8555` 端口的 `GET/POST /config.json`。请求与响应格式一致：

```json
{
  "main": { "width": 1280, "height": 720, "fps": 25, "bitrate_kbps": 3072 },
  "sub": { "width": 640, "height": 360, "fps": 15, "bitrate_kbps": 512 }
}
```

配置是 8 路摄像头共用的主、子码流模板。板端不可达或拒绝配置时，网页会显示原始错误，不会将本地默认值显示为已生效。
