/**
 * silence_server.js — Standalone silence detection API server
 * 
 * This runs alongside AutoEditor.exe and adds the silence removal endpoints.
 * It uses the same ffmpeg.exe that AutoEditor bundles.
 * 
 * How it works:
 *   1. AutoEditor.exe runs on port 4000 (original server)
 *   2. This script runs on port 4001 (silence API server)
 *   3. The frontend calls port 4001 for silence detection
 *   4. When rendering, the frontend sends the trimmed audio to port 4000
 * 
 * Usage:
 *   node silence_server.js
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const os = require('os');
const crypto = require('crypto');

const PORT = process.env.SILENCE_PORT || 4001;
const SCRIPT_DIR = __dirname;
const FFMPEG_PATH = path.join(SCRIPT_DIR, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const PYTHON_SCRIPT = path.join(SCRIPT_DIR, 'silence_cutter.py');
const TEMP_DIR = path.join(os.tmpdir(), 'autoeditor-silence');

// Ensure temp directory exists
if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
}

/**
 * Parse multipart form data (simple implementation for single file upload)
 */
function parseMultipart(req) {
    return new Promise((resolve, reject) => {
        const contentType = req.headers['content-type'] || '';
        const boundaryMatch = contentType.match(/boundary=(.+)/);
        if (!boundaryMatch) {
            return reject(new Error('No multipart boundary found'));
        }
        const boundary = boundaryMatch[1];

        let body = Buffer.alloc(0);
        req.on('data', chunk => {
            body = Buffer.concat([body, chunk]);
        });
        req.on('end', () => {
            try {
                const parts = {};
                const boundaryBuf = Buffer.from('--' + boundary);
                let start = 0;

                while (true) {
                    let idx = body.indexOf(boundaryBuf, start);
                    if (idx === -1) break;
                    let nextIdx = body.indexOf(boundaryBuf, idx + boundaryBuf.length);
                    if (nextIdx === -1) break;

                    const part = body.slice(idx + boundaryBuf.length, nextIdx);
                    const headerEnd = part.indexOf('\r\n\r\n');
                    if (headerEnd === -1) { start = nextIdx; continue; }

                    const headerStr = part.slice(0, headerEnd).toString('utf-8');
                    const dataStart = headerEnd + 4;
                    let data = part.slice(dataStart);
                    // Remove trailing \r\n
                    if (data.length >= 2 && data[data.length - 2] === 0x0d && data[data.length - 1] === 0x0a) {
                        data = data.slice(0, -2);
                    }

                    const nameMatch = headerStr.match(/name="([^"]+)"/);
                    const filenameMatch = headerStr.match(/filename="([^"]+)"/);

                    if (nameMatch) {
                        if (filenameMatch) {
                            parts[nameMatch[1]] = {
                                filename: filenameMatch[1],
                                data: data
                            };
                        } else {
                            parts[nameMatch[1]] = data.toString('utf-8');
                        }
                    }
                    start = nextIdx;
                }
                resolve(parts);
            } catch (e) {
                reject(e);
            }
        });
        req.on('error', reject);
    });
}

/**
 * Parse URL query parameters
 */
function parseQuery(url) {
    const idx = url.indexOf('?');
    if (idx === -1) return {};
    const params = {};
    url.slice(idx + 1).split('&').forEach(p => {
        const [k, v] = p.split('=');
        if (k) params[decodeURIComponent(k)] = decodeURIComponent(v || '');
    });
    return params;
}

/**
 * Run silence_cutter.py
 */
function runSilenceCutter(args) {
    return new Promise((resolve, reject) => {
        const pythonBin = process.env.PYTHON_PATH || (process.platform === 'win32' ? 'python' : 'python3');
        const proc = spawn(pythonBin, [PYTHON_SCRIPT, ...args], {
            cwd: SCRIPT_DIR,
            stdio: ['ignore', 'pipe', 'pipe']
        });

        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', d => stdout += d.toString());
        proc.stderr.on('data', d => stderr += d.toString());

        proc.on('error', err => reject(new Error('Python not found: ' + err.message)));
        proc.on('close', () => {
            try {
                const result = JSON.parse(stdout);
                resolve(result);
            } catch (e) {
                reject(new Error('Parse error. stdout=' + stdout.slice(0, 300) + ' stderr=' + stderr.slice(0, 300)));
            }
        });
    });
}

/**
 * HTTP Server
 */
const server = http.createServer(async (req, res) => {
    // CORS headers (allow frontend on port 4000 or any localhost)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    const urlPath = req.url.split('?')[0];

    // Health check
    if (urlPath === '/health' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, service: 'silence-api' }));
        return;
    }

    // POST /silence-detect — detect silence in uploaded audio
    if (urlPath === '/silence-detect' && req.method === 'POST') {
        try {
            const query = parseQuery(req.url);
            const parts = await parseMultipart(req);

            if (!parts.audio || !parts.audio.data) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'No audio file uploaded' }));
                return;
            }

            // Save uploaded audio to temp
            const jobId = crypto.randomUUID();
            const jobDir = path.join(TEMP_DIR, jobId);
            fs.mkdirSync(jobDir, { recursive: true });

            const ext = path.extname(parts.audio.filename) || '.mp3';
            const inputPath = path.join(jobDir, 'input' + ext);
            fs.writeFileSync(inputPath, parts.audio.data);

            const minSilence = query.minSilence || parts.minSilence || '0.3';
            const threshold = query.threshold || parts.threshold || '-35';
            const padding = query.padding || parts.padding || '0.05';

            const result = await runSilenceCutter([
                '--input', inputPath,
                '--output', path.join(jobDir, 'trimmed' + ext),
                '--ffmpeg', FFMPEG_PATH,
                '--min-silence', minSilence,
                '--threshold', threshold,
                '--padding', padding,
                '--detect-only'
            ]);

            // Cleanup temp input
            try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch (e) {}

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
        }
        return;
    }

    // POST /silence-trim — detect + trim audio, return trimmed file
    if (urlPath === '/silence-trim' && req.method === 'POST') {
        try {
            const query = parseQuery(req.url);
            const parts = await parseMultipart(req);

            if (!parts.audio || !parts.audio.data) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'No audio file uploaded' }));
                return;
            }

            const jobId = crypto.randomUUID();
            const jobDir = path.join(TEMP_DIR, jobId);
            fs.mkdirSync(jobDir, { recursive: true });

            const ext = path.extname(parts.audio.filename) || '.mp3';
            const inputPath = path.join(jobDir, 'input' + ext);
            const outputPath = path.join(jobDir, 'trimmed' + ext);
            fs.writeFileSync(inputPath, parts.audio.data);

            const minSilence = query.minSilence || parts.minSilence || '0.3';
            const threshold = query.threshold || parts.threshold || '-35';
            const padding = query.padding || parts.padding || '0.05';

            const result = await runSilenceCutter([
                '--input', inputPath,
                '--output', outputPath,
                '--ffmpeg', FFMPEG_PATH,
                '--min-silence', minSilence,
                '--threshold', threshold,
                '--padding', padding
            ]);

            if (result.success && fs.existsSync(outputPath)) {
                // Return JSON metadata + make trimmed file available for download
                result.download_url = `/silence-download/${jobId}/trimmed${ext}`;
                result.job_id = jobId;
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result));
            } else {
                try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch (e) {}
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: result.error || 'Trim failed' }));
            }
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
        }
        return;
    }

    // GET /silence-download/:jobId/:filename — serve trimmed audio file
    const downloadMatch = urlPath.match(/^\/silence-download\/([^/]+)\/(.+)$/);
    if (downloadMatch && req.method === 'GET') {
        const jobId = downloadMatch[1];
        const filename = downloadMatch[2];
        const filePath = path.join(TEMP_DIR, jobId, filename);

        if (fs.existsSync(filePath)) {
            const stat = fs.statSync(filePath);
            res.writeHead(200, {
                'Content-Type': 'audio/mpeg',
                'Content-Length': stat.size,
                'Content-Disposition': `attachment; filename="${filename}"`
            });
            fs.createReadStream(filePath).pipe(res);

            // Cleanup after 60 seconds
            setTimeout(() => {
                try { fs.rmSync(path.join(TEMP_DIR, jobId), { recursive: true, force: true }); } catch (e) {}
            }, 60000);
        } else {
            res.writeHead(404);
            res.end('File not found');
        }
        return;
    }

    // 404 for anything else
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
    console.log(`Silence API server running on http://localhost:${PORT}`);
    console.log(`Endpoints:`);
    console.log(`  POST /silence-detect  — detect silence (returns segments JSON)`);
    console.log(`  POST /silence-trim    — detect + trim audio (returns trimmed file)`);
    console.log(`  GET  /health          — health check`);
});
