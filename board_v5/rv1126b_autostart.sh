#!/bin/sh
# RV1126B boot entrypoint for the local AP, webpage, WebRTC gateway and RTSP source.
# Deploy this file to /userdata/rv1126b_autostart.sh and invoke it from the board's
# existing boot hook (for example, an S99* init script). It is intentionally
# idempotent so a manual retry cannot create duplicate daemons.

PATH=/usr/sbin:/usr/bin:/sbin:/bin:/userdata:$PATH
export PATH
# The board image has no /etc/localtime. Keep recorder filenames, web logs,
# and the boot-time recovery logic on the same China-local clock explicitly.
TZ=CST-8
export TZ

LOG=/userdata/rv1126b-autostart.log
AP_MANAGER=/userdata/ap_manager
WEB_SERVER=/userdata/ap_board_web_server
MEDIAMTX=/userdata/mediamtx
MEDIAMTX_CONFIG=/userdata/mediamtx-rv1126b.yml
VIDEO_BIN=/videotuiliu/bin/videotuiliu
VIDEO_LOG=/videotuiliu/logs/videotuiliu-autostart.log
CLOCK_STATE=/userdata/rv1126b-clock.state
# Do not accept an uninitialised RTC or a malformed/far-future SD filename.
CLOCK_MIN_EPOCH=1577836800
# Permit long offline periods while still rejecting an obviously corrupt
# filename (for example a year far beyond the valid RTC/state clock).
CLOCK_MAX_RECORDING_AHEAD=31622400
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

is_valid_epoch() {
    value="$1"
    case "$value" in
        ''|*[!0-9]*) return 1 ;;
    esac
    [ "$value" -ge "$CLOCK_MIN_EPOCH" ] 2>/dev/null
}

save_clock_state() {
    epoch="$1"
    is_valid_epoch "$epoch" || return 0
    tmp="${CLOCK_STATE}.tmp"
    if printf '%s\n' "$epoch" > "$tmp" 2>/dev/null && mv -f "$tmp" "$CLOCK_STATE" 2>/dev/null; then
        return 0
    fi
    rm -f "$tmp" 2>/dev/null || true
    log "failed to persist clock state"
}

set_clock_forward() {
    source="$1"
    candidate="$2"
    is_valid_epoch "$candidate" || return 0
    current=$(date -u '+%s' 2>/dev/null)
    if is_valid_epoch "$current" && [ "$current" -ge "$candidate" ]; then
        return 0
    fi
    if date -u -s "@$candidate" >/dev/null 2>&1; then
        # Keep the hardware RTC in UTC; BusyBox otherwise treats it as local time.
        hwclock -w -u >/dev/null 2>&1 || true
        save_clock_state "$candidate"
        log "clock advanced from $source: $(date '+%Y-%m-%d %H:%M:%S %Z')"
    else
        log "clock advance failed from $source: $candidate"
    fi
}

restore_clock_from_recordings() {
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
    current_epoch=$(date -u '+%s' 2>/dev/null)
    is_valid_epoch "$utc_epoch" || return 0
    # A completed .mp4 is renamed atomically by the recorder, so it is safe as
    # a fallback. Reject an obviously corrupt filename, but allow the normal
    # one-day China-local/UTC boundary after a cold boot.
    if is_valid_epoch "$current_epoch" && [ "$utc_epoch" -gt $((current_epoch + CLOCK_MAX_RECORDING_AHEAD)) ] 2>/dev/null; then
        log "ignored far-future recording stamp: $latest"
        return 0
    fi
    set_clock_forward "latest completed recording $stamp Asia/Shanghai" "$utc_epoch"
}

restore_clock_from_state() {
    saved=$(sed -n '1p' "$CLOCK_STATE" 2>/dev/null)
    is_valid_epoch "$saved" || return 0
    set_clock_forward "persistent clock state" "$saved"
}

load_hardware_clock() {
    before=$(date -u '+%s' 2>/dev/null)
    if hwclock -s -u >/dev/null 2>&1; then
        loaded=$(date -u '+%s' 2>/dev/null)
        # hwclock -s can successfully load a stale RTC and silently roll back
        # a time already supplied by an earlier network/init service. Preserve
        # a valid newer kernel clock and refresh the RTC from it.
        if is_valid_epoch "$before" && ! is_valid_epoch "$loaded"; then
            if date -u -s "@$before" >/dev/null 2>&1; then
                hwclock -w -u >/dev/null 2>&1 || true
                log "ignored invalid hardware RTC; kept newer kernel clock"
            fi
        elif is_valid_epoch "$before" && is_valid_epoch "$loaded" &&
            [ "$loaded" -lt $((before - 300)) ] 2>/dev/null; then
            if date -u -s "@$before" >/dev/null 2>&1; then
                hwclock -w -u >/dev/null 2>&1 || true
                log "ignored stale hardware RTC; kept newer kernel clock"
            fi
        elif is_valid_epoch "$loaded"; then
            log "clock loaded from hardware RTC: $(date '+%Y-%m-%d %H:%M:%S %Z')"
        else
            log "hardware RTC returned an invalid date"
        fi
    else
        log "hardware RTC unavailable; keeping kernel clock"
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

    # AP and station mode cannot share wlan0 on this driver. A stale
    # wpa_supplicant instance can prevent hostapd from emitting beacons.
    stop_station_on_ap_iface() {
        for pid in $(ps 2>/dev/null | grep '[w]pa_supplicant .* -i wlan0' | awk '{print $1}'); do
            kill "$pid" 2>/dev/null || true
            log "stopped station wpa_supplicant pid=$pid before AP"
        done
    }

    stop_station_on_ap_iface

    ap_security_is_compatible() {
        [ -f /data/hostapd.conf ] || return 1
        grep '^wpa=2$' /data/hostapd.conf >/dev/null 2>&1 || return 1
        grep '^wpa_key_mgmt=WPA-PSK$' /data/hostapd.conf >/dev/null 2>&1 || return 1
        grep '^rsn_pairwise=CCMP$' /data/hostapd.conf >/dev/null 2>&1 || return 1
        ! grep '^wpa_pairwise=' /data/hostapd.conf >/dev/null 2>&1
    }

    # rkwifi_server may write hostapd.conf asynchronously after ap_cfg returns.
    # Recheck for several seconds and atomically replace the incompatible
    # WPA3/TKIP mix before starting hostapd, so the driver keeps broadcasting.
    force_ap_security() {
        i=0
        while [ "$i" -lt 10 ]; do
            if ! ap_security_is_compatible; then
                ap_pass=$(sed -n 's/^wpa_passphrase=//p' /data/hostapd.conf | head -n 1)
                [ -n "$ap_pass" ] || ap_pass=12345678
                ap_tmp=/data/hostapd.conf.apfix
                sed '/^wpa=/d;/^wpa_passphrase=/d;/^wpa_key_mgmt=/d;/^wpa_pairwise=/d;/^rsn_pairwise=/d' /data/hostapd.conf > "$ap_tmp" || return 1
                printf '%s\n' "wpa=2" "wpa_passphrase=$ap_pass" "wpa_key_mgmt=WPA-PSK" "rsn_pairwise=CCMP" >> "$ap_tmp"
                mv -f "$ap_tmp" /data/hostapd.conf || return 1
                killall hostapd 2>/dev/null || true
                sleep 1
                hostapd -B /data/hostapd.conf >> "$LOG" 2>&1 || {
                    log "failed to restart hostapd with WPA2/CCMP"
                    return 1
                }
                log "normalized AP security to WPA2-PSK/CCMP"
            elif ! ap_ready; then
                hostapd -B /data/hostapd.conf >> "$LOG" 2>&1 || true
            fi
            sleep 1
            i=$((i + 1))
        done
        ap_security_is_compatible
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

    force_ap_security || return 1

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
load_hardware_clock
restore_clock_from_state
restore_clock_from_recordings
current_epoch=$(date -u '+%s' 2>/dev/null)
save_clock_state "$current_epoch"

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
    LD_LIBRARY_PATH=/videotuiliu/lib:/oem/usr/lib:/lib:/usr/lib \
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
