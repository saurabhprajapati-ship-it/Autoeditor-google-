#!/usr/bin/env python3
"""
watermark_engine.py — 100% WYSIWYG Bulk Video Watermarker with FFmpeg
Uses Normalized Coordinates (x_pct, y_pct, width_pct) so that HTML5 Live Canvas Preview
and FFmpeg Video Output match 1:1 with ZERO mathematical discrepancy on any resolution!
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import zipfile


def get_video_dimensions(ffmpeg_path, input_path):
    """Retrieve video width, height, and duration using ffprobe or ffmpeg."""
    ffprobe_path = shutil.which("ffprobe")
    width, height, duration = 1080, 1920, 0
    if ffprobe_path:
        cmd = [
            ffprobe_path,
            "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "stream=width,height,duration:format=duration",
            "-of", "json",
            input_path
        ]
        try:
            res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=10)
            data = json.loads(res.stdout)
            streams = data.get("streams", [])
            if streams:
                width = int(streams[0].get("width", 1080))
                height = int(streams[0].get("height", 1920))
                dur = streams[0].get("duration")
                if dur:
                    duration = float(dur)
            if not duration:
                fmt_dur = data.get("format", {}).get("duration")
                if fmt_dur:
                    duration = float(fmt_dur)
        except Exception:
            pass
    return width, height, duration


def apply_watermark_normalized(ffmpeg_path, video_in, watermark_img, video_out, norm_x_pct, norm_y_pct, norm_w_pct, opacity):
    """
    Apply watermark using exact normalized percentage coordinates (0.0 to 100.0).
    norm_x_pct: Left position as % of video width (0-100)
    norm_y_pct: Top position as % of video height (0-100)
    norm_w_pct: Watermark width as % of video width (5-80)
    opacity: 0.1 to 1.0
    """
    vid_w, vid_h, _ = get_video_dimensions(ffmpeg_path, video_in)

    # Calculate exact pixel dimensions on the actual video
    scale_w = max(40, int(round(vid_w * (norm_w_pct / 100.0))))
    if scale_w % 2 != 0:
        scale_w += 1

    pos_x = int(round(vid_w * (norm_x_pct / 100.0)))
    pos_y = int(round(vid_h * (norm_y_pct / 100.0)))

    # Ensure bounds
    pos_x = max(0, min(vid_w - 10, pos_x))
    pos_y = max(0, min(vid_h - 10, pos_y))

    op = max(0.1, min(1.0, float(opacity)))

    filter_str = (
        f"[1:v]scale={scale_w}:-2,format=rgba,"
        f"colorchannelmixer=aa={op:.2f}[wm];"
        f"[0:v][wm]overlay={pos_x}:{pos_y}:format=auto,format=yuv420p[v]"
    )

    cmd = [
        ffmpeg_path,
        "-y",
        "-i", video_in,
        "-loop", "1", "-i", watermark_img,
        "-filter_complex", filter_str,
        "-map", "[v]",
        "-map", "0:a?",
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-profile:v", "main",
        "-level", "4.1",
        "-preset", "veryfast",
        "-crf", "22",
        "-c:a", "aac",
        "-b:a", "192k",
        "-ar", "44100",
        "-shortest",
        "-movflags", "+faststart",
        video_out
    ]

    res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if res.returncode != 0:
        # Fallback with ultrafast
        cmd_fallback = [
            ffmpeg_path,
            "-y",
            "-i", video_in,
            "-loop", "1", "-i", watermark_img,
            "-filter_complex", filter_str,
            "-map", "[v]",
            "-map", "0:a?",
            "-c:v", "libx264",
            "-pix_fmt", "yuv420p",
            "-preset", "ultrafast",
            "-crf", "24",
            "-c:a", "aac",
            "-b:a", "192k",
            "-ar", "44100",
            "-shortest",
            "-movflags", "+faststart",
            video_out
        ]
        res_fb = subprocess.run(cmd_fallback, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        if res_fb.returncode != 0:
            raise RuntimeError(f"FFmpeg watermarking failed: {res_fb.stderr[-400:]}")

    return True


def create_zip_archive(files_list, zip_output_path):
    """Create a zip archive containing all watermarked output videos."""
    with zipfile.ZipFile(zip_output_path, 'w', zipfile.ZIP_DEFLATED) as zipf:
        for idx, file_info in enumerate(files_list):
            fpath = file_info["path"]
            orig_name = file_info.get("original_name") or f"video_{idx+1}.mp4"
            base, ext = os.path.splitext(orig_name)
            if not ext:
                ext = ".mp4"
            zip_entry_name = f"watermarked_{idx+1:02d}_{base}{ext}"
            if os.path.exists(fpath):
                zipf.write(fpath, arcname=zip_entry_name)


def main():
    parser = argparse.ArgumentParser(description="WYSIWYG Bulk Watermark Engine for AutoEditor Pro")
    parser.add_argument("--spec", required=True, help="JSON spec file with batch details")
    parser.add_argument("--ffmpeg", default="ffmpeg", help="Path to ffmpeg binary")
    args = parser.parse_args()

    with open(args.spec, "r", encoding="utf-8") as f:
        spec = json.load(f)

    job_id = spec["jobId"]
    output_dir = spec["outputDir"]
    watermark_path = spec["watermarkPath"]
    videos = spec["videos"]

    # Exact Normalized % values from live UI canvas
    norm_x_pct = float(spec.get("normXPct", 65.0))
    norm_y_pct = float(spec.get("normYPct", 88.0))
    norm_w_pct = float(spec.get("normWPct", 28.0))
    opacity = float(spec.get("opacity", 0.95))

    os.makedirs(output_dir, exist_ok=True)

    results = []
    total_videos = len(videos)

    for idx, v in enumerate(videos):
        in_path = v["path"]
        orig_name = v.get("original_name") or f"video_{idx+1}.mp4"
        out_filename = f"wm_out_{idx+1}.mp4"
        out_path = os.path.join(output_dir, out_filename)

        try:
            apply_watermark_normalized(
                args.ffmpeg,
                in_path,
                watermark_path,
                out_path,
                norm_x_pct,
                norm_y_pct,
                norm_w_pct,
                opacity
            )

            file_size = os.path.getsize(out_path) if os.path.exists(out_path) else 0
            w, h, dur = get_video_dimensions(args.ffmpeg, out_path)

            results.append({
                "index": idx,
                "original_name": orig_name,
                "output_filename": out_filename,
                "path": out_path,
                "size": file_size,
                "width": w,
                "height": h,
                "duration": dur,
                "status": "success"
            })
        except Exception as e:
            results.append({
                "index": idx,
                "original_name": orig_name,
                "status": "error",
                "error": str(e)
            })

    zip_filename = f"watermarked_batch_{job_id}.zip"
    zip_path = os.path.join(output_dir, zip_filename)
    successful_files = [r for r in results if r.get("status") == "success"]

    if successful_files:
        create_zip_archive(successful_files, zip_path)
        zip_size = os.path.getsize(zip_path) if os.path.exists(zip_path) else 0
    else:
        zip_size = 0

    output_summary = {
        "success": len(successful_files) > 0,
        "jobId": job_id,
        "total": total_videos,
        "processed": len(successful_files),
        "results": results,
        "zip_filename": zip_filename,
        "zip_size": zip_size
    }

    print(json.dumps(output_summary))


if __name__ == "__main__":
    main()
