const fs = require('fs');
const path = require('path');

// Auto-heal frontend assets from public_static if out/ files are ever removed
function ensureFrontendAssets() {
    try {
        const outDir = path.join(__dirname, 'out');
        const backupDir = path.join(__dirname, 'public_static');
        if (!fs.existsSync(outDir)) {
            fs.mkdirSync(outDir, { recursive: true });
        }
        if (fs.existsSync(backupDir)) {
            const files = fs.readdirSync(backupDir);
            for (const f of files) {
                const srcPath = path.join(backupDir, f);
                const destPath = path.join(outDir, f);
                if (!fs.existsSync(destPath)) {
                    fs.copyFileSync(srcPath, destPath);
                }
            }
        }
    } catch (e) {}
}
ensureFrontendAssets();
setInterval(ensureFrontendAssets, 2000);

// Configure environment defaults for AI Studio environment
process.env.PORT = '3000';
process.env.HOST = process.env.HOST || '0.0.0.0';
process.env.OPEN_BROWSER = '0';
process.env.FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';
process.env.CAPTION_FONT_PATH = process.env.CAPTION_FONT_PATH || path.join(__dirname, 'caption.ttf');
process.env.FRONTEND_DIR = process.env.FRONTEND_DIR || path.join(__dirname, 'out');
process.env.PYTHON_PATH = process.env.PYTHON_PATH || 'python3';
process.env.FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || '*';

// Require and start the AutoEditor studio engine
require('./bundle.cjs');
