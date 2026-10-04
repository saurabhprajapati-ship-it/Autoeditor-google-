/**
 * silence_wrapper.js — Node.js wrapper for silence_cutter.py
 * Called by the patched bundle.cjs to detect and remove silence from audio.
 *
 * Usage (from bundle.cjs):
 *   const { removeSilence, detectSilence } = require('./silence_wrapper');
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Resolve paths relative to this file's directory
const SCRIPT_DIR = __dirname;
const PYTHON_SCRIPT = path.join(SCRIPT_DIR, 'silence_cutter.py');

// Find ffmpeg: same folder as this script, or fall back to PATH
function findFfmpeg() {
    const local = path.join(SCRIPT_DIR, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    if (fs.existsSync(local)) return local;
    return 'ffmpeg';
}

/**
 * Run the Python silence_cutter.py script and return parsed JSON result.
 * @param {object} opts
 * @param {string} opts.input      - Path to the input audio file
 * @param {string} opts.output     - Path to write the trimmed audio
 * @param {number} [opts.minSilence=0.3]  - Min silence duration (seconds)
 * @param {number} [opts.threshold=-35]   - Silence threshold (dB)
 * @param {number} [opts.padding=0.05]    - Padding around cuts (seconds)
 * @param {boolean} [opts.detectOnly=false] - Only detect, don't trim
 * @returns {Promise<object>} - JSON result from silence_cutter.py
 */
function removeSilence(opts) {
    return new Promise((resolve, reject) => {
        const ffmpegPath = opts.ffmpeg || findFfmpeg();
        const args = [
            PYTHON_SCRIPT,
            '--input', opts.input,
            '--output', opts.output || opts.input + '.trimmed.mp3',
            '--ffmpeg', ffmpegPath,
            '--min-silence', String(opts.minSilence != null ? opts.minSilence : 0.3),
            '--threshold', String(opts.threshold != null ? opts.threshold : -35),
            '--padding', String(opts.padding != null ? opts.padding : 0.05),
        ];

        if (opts.detectOnly) {
            args.push('--detect-only');
        }

        const pythonBin = process.env.PYTHON_PATH || (process.platform === 'win32' ? 'python' : 'python3');
        const proc = spawn(pythonBin, args, {
            cwd: SCRIPT_DIR,
            stdio: ['ignore', 'pipe', 'pipe']
        });

        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (data) => { stdout += data.toString(); });
        proc.stderr.on('data', (data) => { stderr += data.toString(); });

        proc.on('error', (err) => {
            reject(new Error('Failed to start Python: ' + err.message));
        });

        proc.on('close', (code) => {
            try {
                const result = JSON.parse(stdout);
                if (result.success) {
                    resolve(result);
                } else {
                    reject(new Error(result.error || 'Silence removal failed'));
                }
            } catch (e) {
                reject(new Error(
                    'Failed to parse silence_cutter output. ' +
                    'stdout: ' + stdout.slice(0, 200) +
                    ' stderr: ' + stderr.slice(0, 200)
                ));
            }
        });
    });
}

/**
 * Detect-only shortcut — returns segment info without trimming.
 */
function detectSilence(opts) {
    return removeSilence({ ...opts, detectOnly: true });
}

/**
 * Remap image timestamps after silence removal.
 * Given original clip timestamps and the silence segments mapping,
 * compute new clip start times in the trimmed audio timeline.
 *
 * @param {Array} clips - Original clips array [{name, start, duration, gap}, ...]
 * @param {Array} segments - Segments from silence_cutter [{start, end, original_start, original_end}, ...]
 * @returns {Array} - New clips with adjusted start times and durations
 */
function remapClipTimestamps(clips, segments) {
    if (!segments || !segments.length || !clips || !clips.length) return clips;

    // Build a mapping function: original_time -> new_time
    function mapTime(originalTime) {
        let newTime = 0;
        for (const seg of segments) {
            if (originalTime <= seg.original_start) {
                // Time is before or at the start of this segment
                return seg.start;
            }
            if (originalTime >= seg.original_start && originalTime <= seg.original_end) {
                // Time falls within this segment
                const offset = originalTime - seg.original_start;
                return seg.start + offset;
            }
            newTime = seg.end;  // Track the end of last known segment
        }
        return newTime;
    }

    // Remap each clip
    const newClips = [];
    for (let i = 0; i < clips.length; i++) {
        const clip = { ...clips[i] };
        const newStart = mapTime(clip.start);
        const newEnd = mapTime(clip.start + clip.duration);
        clip.start = Math.max(0, newStart);
        clip.duration = Math.max(0.001, newEnd - newStart);
        newClips.push(clip);
    }

    return newClips;
}

module.exports = { removeSilence, detectSilence, remapClipTimestamps, findFfmpeg };
