# Pro metallic rocket — Telegram assets

Transparent VP9 WebM (yuva420p), 2s loop at 30 fps, same animation as the Pro Access chip rocket.

| File | Size | Use |
|------|------|-----|
| `rocket-emoji-100.webm` | 100×100 | Custom emoji (@stickers / Bot API) |
| `rocket-sticker-512.webm` | 512×512 | Video sticker |

Regenerate:

```bash
node scripts/export-pro-rocket-webm.mjs
```

Requires `@napi-rs/canvas` and `ffmpeg` (set `FFMPEG` if not on PATH).
