#!/bin/sh
# RV1126B boot entrypoint for the local AP, webpage, WebRTC gateway and RTSP source.
# Deploy this file to /userdata/rv1126b_autostart.sh and invoke it from the board's
# existing boot hook (for example, an S99* init script). It is intentionally
# idempotent so a manual retry cannot create duplicate daemons.

PATH=/usr/sbin:/usr/bin:/sbin:/bin:/userdata:$PATH
export PATH

LOG=/userdata/rv1126b-autostart.log
AP_MANAGER=/userdata/ap_manager
WEB_SERVER=/userdata/ap_board_web_server
MEDIAMTX=/userdata/mediamtx
MEDIAMTX_CONFIG=/userdata/mediamtx-rv1126b.yml
VIDEO_BIN=/videotuiliu/bin/videotuiliu
VIDEO_LOG=/videotuiliu/logs/videotuiliu-autostart.log
RKWIFI_SERVER=

if command -v rkwifi_server >/dev/null 2>&1; then
    RKWIFI_SERVER=$(command -v rkwifi_server)
else
    for candidate in /usr/bin/rkwifi_server /oem/usr/bin/rkwifi_server /userdata/rkwifi_server; do
        if [ -x "$candidate" ]; then
            RKWIFI_SERVER="$candidate"
            break
        fi
    done
fi

log() {
    printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG"
}

restore_clock_from_recordings() {
    year=$(date -u '+%Y' 2>/dev/null)
    [ -n "$year" ] && [ "$year" -ge 2025 ] 2>/dev/null && return 0

    latest=$(find /mnt/sdcard/recordings -type f -name '*.mp4' 2>/dev/null \
        | sed 's#.*/##' \
        | sed -n 's/^\([0-9]\{8\}\)_\([0-9]\{6\}\).*/\1 \2/p' \
        | sort | tail -n 1)
    [ -n "$latest" ] || return 0

    day=${latest% *}
    clock=${latest#* }
    year_part=${day%????}
    month_day=${day#????}
    month_part=${month_day%??}
    day_part=${day#??????}
    hour_part=${clock%????}
    minute_second=${clock#??}
    minute_part=${minute_second%??}
    second_part=${clock#????}
    stamp="$year_part-$month_part-$day_part $hour_part:$minute_part:$second_part"
    # Recorder filenames use China local time while the board clock is UTC.
    local_epoch=$(date -u -d "$stamp" '+%s' 2>/dev/null)
    [ -n "$local_epoch" ] || return 0
    utc_epoch=$((local_epoch - 28800))
    if date -u -s "@$utc_epoch" >/dev/null 2>&1; then
        log "clock restored from latest recording: $stamp Asia/Shanghai"
        hwclock -w >/dev/null 2>&1 || true
    else
        log "clock restore failed for recording stamp: $latest"
    fi
}

configure_ethernet() {
    if ifconfig eth0 192.168.100.125 netmask 255.255.255.0 up >/dev/null 2>&1; then
        log "eth0 ready at 192.168.100.125"
    else
        log "failed to configure eth0 at 192.168.100.125"
    fi
}

is_listening() {
    port="$1"
    netstat -lnt 2>/dev/null | awk -v p=":$port" '$4 ~ p"$" { found=1 } END { exit(found ? 0 : 1) }'
}

wait_for_camera_streams() {
    i=0
    while [ "$i" -lt 20 ]; do
        recent=$(tail -n 80 "$LOG" 2>/dev/null)
        lower_ready=0
        upper_ready=0
        echo "$recent" | grep -F "path lower-ch1-sub] stream is available and online" >/dev/null 2>&1 && lower_ready=1
        echo "$recent" | grep -F "path upper-ch1-sub] stream is available and online" >/dev/null 2>&1 && upper_ready=1
        if [ "$lower_ready" -eq 1 ] && [ "$upper_ready" -eq 1 ]; then
            log "camera streams ready before board_web"
            return 0
        fi
        sleep 1
        i=$((i + 1))
    done
    log "camera streams not ready after 20s; exposing board_web anyway"
    return 1
}

start_ap() {
    [ -n "$RKWIFI_SERVER" ] || {
        log "rkwifi_server not found; AP was not started"
        return 1
    }

    # rkwifi_server is started by the vendor launcher and exposes this socket
    # only after its command service is ready.
    i=0
    while [ "$i" -lt 20 ] && [ ! -S /tmp/rkserver_socket ]; do
        sleep 1
        i=$((i + 1))
    done
    if [ ! -S /tmp/rkserver_socket ]; then
        log "rkwifi socket was not ready after 20s"
        return 1
    fi

    # USB/Wi-Fi initialization can lag the init script by a few seconds.
    i=0
    while [ "$i" -lt 15 ] && ! ifconfig wlan0 >/dev/null 2>&1; do
        sleep 1
        i=$((i + 1))
    done
    if ! ifconfig wlan0 >/dev/null 2>&1; then
        log "wlan0 not available after 15s"
        return 1
    fi

    ap_ready() {
        [ -e /var/run/hostapd/wlan0 ] || return 1
        ifconfig wlan0 2>/dev/null | grep '192\.168\.0\.1' >/dev/null 2>&1 || return 1
        ifconfig wlan0 2>/dev/null | grep 'RUNNING' >/dev/null 2>&1
    }

    # Do not reconfigure an already active wlan0. The IP can remain briefly
    # after hostapd stops, so the control socket and RUNNING flag are required.
    if ! ap_ready; then
        log "starting AP on wlan0"
        if ! "$RKWIFI_SERVER" ap_cfg wlan0 RV1126B-AP 12345678 >> "$LOG" 2>&1; then
            log "AP command failed"
            return 1
        fi
    else
        log "AP already configured on wlan0"
    fi

    i=0
    while [ "$i" -lt 30 ] && ! ap_ready; do
        sleep 1
        i=$((i + 1))
    done
    if ap_ready; then
        log "AP ready at 192.168.0.1"
    else
        log "AP did not receive 192.168.0.1 after 30s"
        return 1
    fi
}

start_if_needed() {
    label="$1"
    port="$2"
    shift 2
    if is_listening "$port"; then
        log "$label already listening on $port"
        return 0
    fi
    log "starting $label on $port"
    "$@" >> "$LOG" 2>&1 &
}

mkdir -p /userdata 2>/dev/null
log "boot sequence started"

# Some board images lose RTC time after power removal. Restore a useful date
# before starting the recorder so new segments are listed under the right day.
restore_clock_from_recordings

# Keep the management webpage reachable at the same wired address after reboot.
configure_ethernet

# AP services must be available before the board webpage is exposed.
start_ap

if [ -x "$AP_MANAGER" ]; then
    start_if_needed ap_manager 8556 "$AP_MANAGER"
else
    log "missing executable: $AP_MANAGER"
fi

# The camera service owns RTSP 8554. Start it only when the source is absent;
# recording remains controlled by /videotuiliu/record.cfg and is not changed here.
if [ -x "$VIDEO_BIN" ] && ! is_listening 8554; then
    log "starting RTSP source"
    LD_LIBRARY_PATH=/videotuiliu/lib:/lib:/usr/lib \
        "$VIDEO_BIN" >> "$VIDEO_LOG" 2>&1 &
fi

# Wait briefly for the RTSP source before opening MediaMTX. This avoids a
# startup race while keeping boot bounded if no camera is present.
i=0
while [ "$i" -lt 20 ] && ! is_listening 8554; do
    sleep 1
    i=$((i + 1))
done
if is_listening 8554; then
    log "RTSP source ready on 8554"
else
    log "RTSP source not ready after 20s; starting MediaMTX anyway"
fi

if [ -x "$MEDIAMTX" ] && [ -f "$MEDIAMTX_CONFIG" ]; then
    start_if_needed mediamtx 8889 "$MEDIAMTX" "$MEDIAMTX_CONFIG"
    wait_for_camera_streams
else
    log "MediaMTX files missing: $MEDIAMTX / $MEDIAMTX_CONFIG"
fi

if [ -x "$WEB_SERVER" ]; then
    start_if_needed board_web 8080 "$WEB_SERVER" 8080
else
    log "missing executable: $WEB_SERVER"
fi

log "boot sequence finished"
exit 0
