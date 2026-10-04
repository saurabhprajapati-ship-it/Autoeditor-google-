#!/usr/bin/env python3
"""
silence_cutter.py — Auto Silence Remover for Audio & Video
Detects silent segments in audio/video using FFmpeg's silencedetect filter,
then trims both audio and video streams together with frame-accurate AV sync.

Usage:
    Audio: python silence_cutter.py --input voice.mp3 --output clean.mp3 --ffmpeg ffmpeg.exe
    Video: python silence_cutter.py --input video.mp4 --output clean.mp4 --ffmpeg ffmpeg.exe --is-video
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys


VIDEO_EXTENSIONS = {".mp4", ".mov", ".mkv", ".avi", ".webm", ".flv", ".ts", ".m4v"}


def is_video_file(path):
    ext = os.path.splitext(path)[1].lower()
    return ext in VIDEO_EXTENSIONS


def has_audio_stream(input_path):
    """Check if the media file contains an audio stream."""
    ffprobe_path = shutil.which("ffprobe")
    if ffprobe_path:
        cmd = [
            ffprobe_path,
            "-v", "error",
            "-select_streams", "a",
            "-show_entries", "stream=codec_type",
            "-of", "csv=p=0",
            input_path
        ]
        res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        return "audio" in res.stdout.lower()
    return True


def detect_silence(ffmpeg_path, input_path, min_silence, threshold):
    """
    Run FFmpeg silencedetect filter and parse the output.
    Returns a list of (start, end) tuples for each silent segment.
    Uses -vn to skip video frames and -threads 0 for fast processing.
    Pure full-spectrum silence detection that preserves all vocal frequencies,
    natural breathing room, and strictly respects min_silence and threshold.
    """
    cmd = [
        ffmpeg_path,
        "-threads", "0",
        "-vn",
        "-i", input_path,
        "-af", f"silencedetect=noise={threshold}dB:d={min_silence}",
        "-f", "null",
        "-"
    ]

    result = subprocess.run(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace"
    )

    stderr = result.stderr
    silences = []
    current_start = None

    for line in stderr.split("\n"):
        m_start = re.search(r"silence_start:\s*([\d.]+)", line)
        if m_start:
            current_start = float(m_start.group(1))
            continue

        m_end = re.search(r"silence_end:\s*([\d.]+)", line)
        if m_end and current_start is not None:
            silence_end = float(m_end.group(1))
            silences.append((current_start, silence_end))
            current_start = None

    return silences


def get_media_duration(ffmpeg_path, input_path):
    """Get the duration of an audio or video file instantly using ffprobe or fast header inspect."""
    ffprobe_path = shutil.which("ffprobe")
    if ffprobe_path:
        cmd = [
            ffprobe_path,
            "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            input_path
        ]
        res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            val = float(res.stdout.strip())
            if val > 0:
                return val
        except (ValueError, TypeError):
            pass

    cmd = [
        ffmpeg_path,
        "-threads", "0",
        "-vn",
        "-i", input_path,
        "-t", "0.001",
        "-f", "null",
        "-"
    ]

    result = subprocess.run(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace"
    )

    m = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", result.stderr)
    if m:
        hours = int(m.group(1))
        minutes = int(m.group(2))
        seconds = float(m.group(3))
        return hours * 3600 + minutes * 60 + seconds

    return 0.0


# Backward compatible alias
get_audio_duration = get_media_duration


def compute_speech_segments(silences, total_duration, padding):
    """
    Invert silence segments to get speech/activity segments.
    Add padding to avoid cutting words or abrupt visual jump cuts.
    Merge any segments that overlap due to padding so natural pauses stay intact.
    """
    if not silences:
        return [{"start": 0.0, "end": total_duration,
                 "original_start": 0.0, "original_end": total_duration}]

    raw_segments = []
    prev_end = 0.0

    for silence_start, silence_end in silences:
        seg_start = max(0.0, prev_end - padding) if prev_end > 0 else 0.0
        seg_end = min(total_duration, silence_start + padding)

        if seg_end > seg_start + 0.03:
            raw_segments.append((seg_start, seg_end))

        prev_end = silence_end

    last_start = max(0.0, prev_end - padding)
    if total_duration > last_start + 0.03:
        raw_segments.append((last_start, total_duration))

    if not raw_segments:
        return [{"start": 0.0, "end": total_duration,
                 "original_start": 0.0, "original_end": total_duration}]

    # Merge any overlapping segments caused by padding
    merged = []
    for start, end in raw_segments:
        if merged and start <= merged[-1][1]:
            # Overlapping or touching: combine into one smooth segment
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))

    speech_segments = []
    current_pos = 0.0
    for start, end in merged:
        duration = end - start
        if duration >= 0.05:
            speech_segments.append({
                "original_start": round(start, 3),
                "original_end": round(end, 3),
                "start": round(current_pos, 3),
                "end": round(current_pos + duration, 3)
            })
            current_pos += duration

    return speech_segments


def trim_audio(ffmpeg_path, input_path, output_path, segments):
    """
    Use FFmpeg filter_complex to trim and concatenate audio segments.
    """
    if not segments:
        return False

    filter_parts = []
    concat_inputs = []

    for i, seg in enumerate(segments):
        start = seg["original_start"]
        end = seg["original_end"]
        label = f"a{i}"
        filter_parts.append(
            f"[0:a]atrim=start={start:.3f}:end={end:.3f},asetpts=PTS-STARTPTS[{label}]"
        )
        concat_inputs.append(f"[{label}]")

    n = len(segments)
    concat_str = "".join(concat_inputs)
    filter_parts.append(f"{concat_str}concat=n={n}:v=0:a=1[out]")

    filter_complex = ";".join(filter_parts)

    filter_file = output_path + ".filter.txt"
    with open(filter_file, "w", encoding="utf-8") as f:
        f.write(filter_complex)

    cmd = [
        ffmpeg_path,
        "-threads", "0",
        "-i", input_path,
        "-filter_complex_script", filter_file,
        "-map", "[out]",
    ]

    ext = os.path.splitext(output_path)[1].lower()
    if ext in (".mp3",):
        cmd.extend(["-c:a", "libmp3lame", "-b:a", "256k", "-ar", "44100", "-ac", "2"])
    elif ext in (".wav",):
        cmd.extend(["-c:a", "pcm_s16le", "-ar", "44100", "-ac", "2"])
    elif ext in (".ogg",):
        cmd.extend(["-c:a", "libvorbis", "-b:a", "256k", "-ar", "44100", "-ac", "2"])
    else:
        cmd.extend(["-c:a", "aac", "-b:a", "256k", "-ar", "44100", "-ac", "2"])

    cmd.extend(["-y", output_path])

    result = subprocess.run(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace"
    )

    try:
        os.remove(filter_file)
    except OSError:
        pass

    if result.returncode != 0:
        raise RuntimeError(f"FFmpeg audio trim failed: {result.stderr[-500:]}")

    return True


def trim_video(ffmpeg_path, input_path, output_path, segments):
    """
    Use FFmpeg filter_complex to trim and concatenate video and audio streams simultaneously
    with frame-accurate audio-video sync. Uses high profile H.264, stereo AAC, faststart,
    and visually crisp CRF 19.
    """
    if not segments:
        return False

    filter_parts = []
    concat_inputs = []

    for i, seg in enumerate(segments):
        start = seg["original_start"]
        end = seg["original_end"]
        v_label = f"v{i}"
        a_label = f"a{i}"
        filter_parts.append(
            f"[0:v]trim=start={start:.3f}:end={end:.3f},setpts=PTS-STARTPTS[{v_label}]"
        )
        filter_parts.append(
            f"[0:a]atrim=start={start:.3f}:end={end:.3f},asetpts=PTS-STARTPTS[{a_label}]"
        )
        concat_inputs.append(f"[{v_label}][{a_label}]")

    n = len(segments)
    concat_str = "".join(concat_inputs)
    filter_parts.append(f"{concat_str}concat=n={n}:v=1:a=1[outv][outa]")

    filter_complex = ";".join(filter_parts)

    filter_file = output_path + ".filter.txt"
    with open(filter_file, "w", encoding="utf-8") as f:
        f.write(filter_complex)

    cmd = [
        ffmpeg_path,
        "-threads", "0",
        "-i", input_path,
        "-filter_complex_script", filter_file,
        "-map", "[outv]",
        "-map", "[outa]",
        "-c:v", "libx264",
        "-profile:v", "high",
        "-level", "4.1",
        "-preset", "veryfast",
        "-crf", "19",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", "256k",
        "-ar", "44100",
        "-ac", "2",
        "-movflags", "+faststart",
        "-y",
        output_path
    ]

    result = subprocess.run(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace"
    )

    try:
        os.remove(filter_file)
    except OSError:
        pass

    if result.returncode != 0:
        raise RuntimeError(f"FFmpeg video trim failed: {result.stderr[-800:]}")

    return True


def main():
    parser = argparse.ArgumentParser(description="Auto Silence Remover for Audio & Video")
    parser.add_argument("--input", required=True, help="Path to input media file")
    parser.add_argument("--output", required=True, help="Path to save trimmed media")
    parser.add_argument("--ffmpeg", default="ffmpeg", help="Path to ffmpeg binary")
    parser.add_argument("--min-silence", type=float, default=0.3,
                        help="Minimum silence duration to cut (seconds)")
    parser.add_argument("--threshold", type=float, default=-35,
                        help="Silence threshold in dB (e.g. -35)")
    parser.add_argument("--padding", type=float, default=0.05,
                        help="Padding around cuts (seconds)")
    parser.add_argument("--is-video", action="store_true",
                        help="Force video processing mode")
    parser.add_argument("--detect-only", action="store_true",
                        help="Only detect silence, don't trim")

    args = parser.parse_args()

    if not os.path.isfile(args.input):
        result = {"success": False, "error": f"Input file not found: {args.input}"}
        print(json.dumps(result))
        sys.exit(1)

    try:
        total_duration = get_media_duration(args.ffmpeg, args.input)
        if total_duration <= 0:
            result = {"success": False, "error": "Could not determine media duration"}
            print(json.dumps(result))
            sys.exit(1)

        if not has_audio_stream(args.input):
            result = {
                "success": False,
                "error": "The uploaded file does not contain an audio track. Video jump-cut requires an audio track to detect speech and pauses."
            }
            print(json.dumps(result))
            sys.exit(1)

        silences = detect_silence(
            args.ffmpeg, args.input,
            args.min_silence, args.threshold
        )

        segments = compute_speech_segments(silences, total_duration, args.padding)

        trimmed_duration = sum(s["end"] - s["start"] for s in segments)
        silence_removed = total_duration - trimmed_duration

        if args.detect_only:
            result = {
                "success": True,
                "original_duration": round(total_duration, 3),
                "trimmed_duration": round(trimmed_duration, 3),
                "silence_removed": round(silence_removed, 3),
                "silence_count": len(silences),
                "segments_count": len(segments),
                "segments": segments,
                "is_video": args.is_video or is_video_file(args.input)
            }
            print(json.dumps(result))
            sys.exit(0)

        is_video = args.is_video or is_video_file(args.input) or is_video_file(args.output)

        if len(silences) == 0:
            shutil.copy2(args.input, args.output)
            result = {
                "success": True,
                "original_duration": round(total_duration, 3),
                "trimmed_duration": round(total_duration, 3),
                "silence_removed": 0.0,
                "silence_count": 0,
                "segments_count": 1,
                "segments": segments,
                "output_file": args.output,
                "is_video": is_video,
                "no_silence_found": True
            }
            print(json.dumps(result))
            sys.exit(0)

        if is_video:
            trim_video(args.ffmpeg, args.input, args.output, segments)
        else:
            trim_audio(args.ffmpeg, args.input, args.output, segments)

        result = {
            "success": True,
            "original_duration": round(total_duration, 3),
            "trimmed_duration": round(trimmed_duration, 3),
            "silence_removed": round(silence_removed, 3),
            "silence_count": len(silences),
            "segments_count": len(segments),
            "segments": segments,
            "is_video": is_video,
            "output_file": args.output
        }
        print(json.dumps(result))

    except Exception as e:
        result = {"success": False, "error": str(e)}
        print(json.dumps(result))
        sys.exit(1)


if __name__ == "__main__":
    main()
