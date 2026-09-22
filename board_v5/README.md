# RV1126B v5 board snapshot

This directory is an exact source snapshot of the files currently deployed on the RV1126B board at the time v5 was prepared. It is not a build from the local `video/web` directory.

## Runtime mapping

| File | Board path |
|---|---|
| `app-network-memory.js` | `/userdata/rv_web/app-network-memory.js` |
| `index.html` | `/userdata/rv_web/index.html` |
| `styles.css` | `/userdata/rv_web/styles.css` |
| `rv1126b_autostart.sh` | `/userdata/rv1126b_autostart.sh` |
| `mediamtx-rv1126b.yml` | `/userdata/mediamtx-rv1126b.yml` |

`index.html` loads `/app-network-memory.js`, so the filename must remain unchanged during deployment.

## v5 behavior

- The playback dialog is scoped to one camera at a time.
- Only finalized `.mp4` files enter the playlist; active `.mp4.part` files are excluded.
- The playlist is sorted by recording time and plays segments continuously.
- The scrubber seeks across the complete historical timeline and switches to the correct segment and in-segment offset.
- Segment durations are corrected from loaded video metadata, including a short final segment.
- Recent recordings are shown first, older pages load sequentially in the background, and closing the dialog invalidates pending loads.
- `lower-ch1-sub` and `upper-ch1-sub` are configured with `sourceOnDemand: false`; the startup script waits briefly for them before exposing the board web service.

The snapshot does not include board-specific compiled binaries. The running board services remain `/userdata/ap_board_web_server`, `/userdata/mediamtx`, and `/videotuiliu/bin/videotuiliu`.
