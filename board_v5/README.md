# RV1126B board snapshot used by v6

This directory contains the board-facing web snapshot carried forward into the v6 release. It is not a build from the local `video/web` directory.

## Runtime mapping

| File | Board path |
|---|---|
| `app-network-memory-v5.js` | `/userdata/rv_web/app-network-memory-v5.js` |
| `app-network-memory-v5-filter.js` | `/userdata/rv_web/app-network-memory-v5-filter.js` |
| `index.html` | `/userdata/rv_web/index.html` |
| `styles.css` | `/userdata/rv_web/styles.css` |
| `styles.css` | `/userdata/rv_web/styles-wifi.css` |
| `rv1126b_autostart.sh` | `/userdata/rv1126b_autostart.sh` |
| `mediamtx-rv1126b.yml` | `/userdata/mediamtx-rv1126b.yml` |

`index.html` loads `/app-network-memory-v5-filter.js`. The board's static file server does not support query strings on asset paths, so the cache-busting version is part of the filename.

## v6 behavior

- Adds the date-filtered recording manager and refreshed responsive styling used by the board web UI.
- The page loads the versioned `app-network-memory-v5-filter.js` entrypoint so the board's static server does not treat a query string as part of the filename.
- The board deployment also mirrors `styles.css` to `styles-wifi.css`, the stylesheet name referenced by the deployed page.

- The playback dialog is scoped to one camera at a time.
- Only finalized `.mp4` files enter the playlist; active `.mp4.part` files are excluded.
- The playlist is sorted by recording time and plays segments continuously.
- The scrubber seeks across the complete historical timeline and switches to the correct segment and in-segment offset.
- Segment durations are corrected from loaded video metadata, including a short final segment.
- Recent recordings are shown first, older pages load sequentially in the background, and closing the dialog invalidates pending loads.
- `lower-ch1-sub` and `upper-ch1-sub` are configured with `sourceOnDemand: false`; the startup script waits briefly for them before exposing the board web service.
- The network indicator reads Wi-Fi and AP status on page startup and every five seconds, and also treats a reachable `/api/streams` endpoint as an active wired connection. It is green without requiring the network settings button to be opened.
- The recording manager supports a date filter and one-click reset. The selected date filters both the segment list and the continuous playback timeline.

The snapshot does not include board-specific compiled binaries. The running board services remain `/userdata/ap_board_web_server`, `/userdata/mediamtx`, and `/videotuiliu/bin/videotuiliu`.
