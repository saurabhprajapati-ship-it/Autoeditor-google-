#!/usr/bin/env python3
"""
silence_server.py — High-reliability HTTP backend for Silence Removal & Audio Editor
Runs on port 4001 using Python standard library (no third-party pip dependencies required).
Handles:
  - POST /silence-detect   (detects silent gaps, returns JSON metadata)
  - POST /silence-trim     (cuts silence, returns JSON + download URL)
  - GET  /silence-download (serves the trimmed audio MP3)
  - GET  /health           (health check)
"""

import http.server
import json
import os
import re
import shutil
import sys
import tempfile
import time
import urllib.parse
import uuid

# Import our silence cutter logic
from silence_cutter import (
    get_audio_duration,
    detect_silence,
    compute_speech_segments,
    trim_audio
)

PORT = int(os.environ.get("SILENCE_PORT", 4001))
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
FFMPEG_PATH = os.path.join(SCRIPT_DIR, "ffmpeg.exe" if sys.platform == "win32" else "ffmpeg")
if not os.path.isfile(FFMPEG_PATH):
    FFMPEG_PATH = "ffmpeg"

TEMP_DIR = os.path.join(tempfile.gettempdir(), "autoeditor-silence")
os.makedirs(TEMP_DIR, exist_ok=True)


class SilenceHTTPRequestHandler(http.server.BaseHTTPRequestHandler):

    def log_message(self, format, *args):
        # Clean logging
        sys.stderr.write(f"[SilenceServer] {self.address_string()} - {format % args}\n")

    def send_cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Range")
        self.send_header("Access-Control-Expose-Headers", "Content-Length, Content-Range")

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_cors_headers()
        self.end_headers()

    def parse_multipart_data(self):
        """Parse multipart/form-data from request body."""
        content_type = self.headers.get("Content-Type", "")
        if "boundary=" not in content_type:
            raise ValueError("No multipart boundary found in Content-Type")

        boundary_str = content_type.split("boundary=")[1].strip()
        if boundary_str.startswith('"') and boundary_str.endswith('"'):
            boundary_str = boundary_str[1:-1]
        boundary = boundary_str.encode("latin1")

        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length)

        parts = {}
        delimiter = b"--" + boundary
        chunks = body.split(delimiter)

        for chunk in chunks:
            if not chunk or chunk == b"--\r\n" or chunk == b"--" or chunk == b"\r\n":
                continue
            if b"\r\n\r\n" not in chunk:
                continue

            header_bytes, data_bytes = chunk.split(b"\r\n\r\n", 1)
            # Remove trailing \r\n
            if data_bytes.endswith(b"\r\n"):
                data_bytes = data_bytes[:-2]

            header_text = header_bytes.decode("utf-8", errors="ignore")

            m_name = re.search(r'name="([^"]+)"', header_text)
            m_filename = re.search(r'filename="([^"]+)"', header_text)

            if m_name:
                field_name = m_name.group(1)
                if m_filename:
                    parts[field_name] = {
                        "filename": m_filename.group(1),
                        "data": data_bytes
                    }
                else:
                    parts[field_name] = data_bytes.decode("utf-8", errors="ignore")

        return parts

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        url_path = parsed.path

        if url_path == "/health":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_cors_headers()
            self.end_headers()
            self.wfile.write(json.dumps({"ok": True, "service": "silence-api-python"}).encode("utf-8"))
            return

        # Serve downloaded trimmed audio: /silence-download/<job_id>/<filename>
        m_down = re.match(r"^/silence-download/([^/]+)/(.+)$", url_path)
        if m_down:
            job_id, filename = m_down.group(1), m_down.group(2)
            file_path = os.path.join(TEMP_DIR, job_id, filename)

            if os.path.isfile(file_path):
                file_size = os.path.getsize(file_path)
                self.send_response(200)
                self.send_header("Content-Type", "audio/mpeg")
                self.send_header("Content-Length", str(file_size))
                self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
                self.send_cors_headers()
                self.end_headers()

                with open(file_path, "rb") as f:
                    shutil.copyfileobj(f, self.wfile)
                return
            else:
                self.send_response(404)
                self.send_header("Content-Type", "application/json")
                self.send_cors_headers()
                self.end_headers()
                self.wfile.write(json.dumps({"error": "File not found"}).encode("utf-8"))
                return

        self.send_response(404)
        self.send_header("Content-Type", "application/json")
        self.send_cors_headers()
        self.end_headers()
        self.wfile.write(json.dumps({"error": "Not found"}).encode("utf-8"))

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        url_path = parsed.path
        query_params = urllib.parse.parse_qs(parsed.query)

        if url_path in ("/silence-detect", "/silence-trim"):
            try:
                parts = self.parse_multipart_data()
                if "audio" not in parts or not isinstance(parts["audio"], dict):
                    self.send_response(400)
                    self.send_header("Content-Type", "application/json")
                    self.send_cors_headers()
                    self.end_headers()
                    self.wfile.write(json.dumps({"error": "No audio file uploaded"}).encode("utf-8"))
                    return

                audio_file = parts["audio"]
                job_id = str(uuid.uuid4())
                job_dir = os.path.join(TEMP_DIR, job_id)
                os.makedirs(job_dir, exist_ok=True)

                orig_filename = audio_file["filename"]
                ext = os.path.splitext(orig_filename)[1].lower() or ".mp3"
                input_path = os.path.join(job_dir, "input" + ext)
                output_path = os.path.join(job_dir, "trimmed.mp3")

                with open(input_path, "wb") as f:
                    f.write(audio_file["data"])

                min_silence = float(query_params.get("minSilence", [parts.get("minSilence", 0.3)])[0])
                threshold = float(query_params.get("threshold", [parts.get("threshold", -35)])[0])
                padding = float(query_params.get("padding", [parts.get("padding", 0.05)])[0])

                total_duration = get_audio_duration(FFMPEG_PATH, input_path)
                if total_duration <= 0:
                    raise RuntimeError("Could not detect audio duration")

                silences = detect_silence(FFMPEG_PATH, input_path, min_silence, threshold)
                segments = compute_speech_segments(silences, total_duration, padding)

                trimmed_duration = sum(s["end"] - s["start"] for s in segments)
                silence_removed = max(0.0, total_duration - trimmed_duration)

                if url_path == "/silence-detect":
                    # Detect only
                    try:
                        shutil.rmtree(job_dir, ignore_errors=True)
                    except Exception:
                        pass

                    res = {
                        "success": True,
                        "original_duration": round(total_duration, 3),
                        "trimmed_duration": round(trimmed_duration, 3),
                        "silence_removed": round(silence_removed, 3),
                        "silence_count": len(silences),
                        "segments_count": len(segments),
                        "segments": segments
                    }
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_cors_headers()
                    self.end_headers()
                    self.wfile.write(json.dumps(res).encode("utf-8"))
                    return

                # For /silence-trim:
                if len(silences) == 0:
                    shutil.copy2(input_path, output_path)
                else:
                    trim_audio(FFMPEG_PATH, input_path, output_path, segments)

                res = {
                    "success": True,
                    "original_duration": round(total_duration, 3),
                    "trimmed_duration": round(trimmed_duration, 3),
                    "silence_removed": round(silence_removed, 3),
                    "silence_count": len(silences),
                    "segments_count": len(segments),
                    "segments": segments,
                    "download_url": f"/silence-download/{job_id}/trimmed.mp3",
                    "job_id": job_id
                }
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_cors_headers()
                self.end_headers()
                self.wfile.write(json.dumps(res).encode("utf-8"))

            except Exception as e:
                self.send_response(500)
                self.send_header("Content-Type", "application/json")
                self.send_cors_headers()
                self.end_headers()
                self.wfile.write(json.dumps({"error": str(e)}).encode("utf-8"))
            return

        self.send_response(404)
        self.send_header("Content-Type", "application/json")
        self.send_cors_headers()
        self.end_headers()
        self.wfile.write(json.dumps({"error": "Not found"}).encode("utf-8"))


def run_server():
    server_address = ("127.0.0.1", PORT)
    httpd = http.server.ThreadingHTTPServer(server_address, SilenceHTTPRequestHandler)
    print(f"============================================================")
    print(f" Silence API Server (Python) running on http://127.0.0.1:{PORT}")
    print(f" FFmpeg path: {FFMPEG_PATH}")
    print(f"============================================================")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down server...")
        httpd.server_close()


if __name__ == "__main__":
    run_server()
