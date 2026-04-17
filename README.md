# 🎵 YouTube Music Auto-Liker

A Chrome extension that automatically "Likes" (👍) every song in a YouTube Music playlist — so you don't have to click hundreds of times.

## Features

- **Bulk-like an entire playlist** — paste a URL or playlist ID and let it run
- **Pause / Resume / Stop** — full playback-style controls over the liking process
- **Configurable delay** — set a custom delay between likes (minimum 1 s) to reduce rate-limit risk
- **Reverse order** — optionally start from the bottom of the playlist (oldest songs first)
- **Progress tracking** — real-time status showing the current song title, artist, and progress count
- **Per-item processing** — handles every playlist row in order, including duplicate songs
- **Resumable** — progress is persisted to `chrome.storage.local`, so you can close the popup and reopen it without losing your place

## Installation

1. Clone or download this repository:
   ```bash
   git clone https://github.com/pevenq/youtube_music_auto_liker.git
   ```
2. Open Chrome and navigate to `chrome://extensions/`.
3. Enable **Developer mode** (toggle in the top-right corner).
4. Click **Load unpacked** and select the cloned project folder.
5. The extension icon will appear in your toolbar — pin it for quick access.

## Usage

1. Make sure you are **logged in** to [YouTube Music](https://music.youtube.com) in the same browser.
2. Click the extension icon to open the popup.
3. Paste a **playlist URL** (e.g. `https://music.youtube.com/playlist?list=PL...`) or just the **playlist ID**.
4. Adjust options if needed:
   - **Delay** — seconds to wait between each like (min 1 s).
   - **Start from the bottom** — check this to like the oldest tracks first (enabled by default).
5. Click **▶ Start** and watch the progress.
6. Use **⏸ Pause**, **▶ Resume**, or **⏹ Stop** at any time.

## Build Release Folder

To avoid packaging debug files or local artifacts, build a clean `release/` folder:

```bash
bash scripts/build_release.sh
```

Upload only the generated files inside `release/` when publishing.


## ⚠️ Disclaimer

This extension interacts with YouTube's **internal, undocumented API**. Use it at your own risk. Excessive or aggressive usage may result in temporary rate-limiting by YouTube. Using a reasonable delay (≥ 1 second) is recommended.

## License

This project is provided as-is for personal use.
