---
title: AutoEditor Pro Cloud
emoji: 🎬
colorFrom: indigo
colorTo: blue
sdk: docker
app_port: 4000
pinned: false
---

# 🎬 AutoEditor Pro Cloud

AutoEditor is a complete browser-based video and audio editing studio powered by Node.js, FFmpeg, and AI.

## ✨ Features
- 🎙️ **Silence Remover**: Upload audio/video, detect silent gaps, and cut automatically.
- 🎬 **Video Jumpcut & Auto-Sync**: Sync scenes, images, transitions, and voiceover to produce final MP4 videos.
- ✂️ **Transitions**: Crossfade, Whip, Zoom, and more.
- 💬 **Dynamic Captions**: Auto-caption styling with embedded fonts.
- ☁️ **Cloud Ready**: Runs on Docker, Hugging Face Spaces, Render.com, or any VPS.

## 🚀 Running Locally
```bash
Start-AutoEditor.bat
```
Visit `http://localhost:4000`

## 🐳 Running with Docker
```bash
docker build -t auto-editor .
docker run -p 4000:4000 auto-editor
```
