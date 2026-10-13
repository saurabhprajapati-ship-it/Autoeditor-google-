/**
 * AutoEditor Pro — AI Video & Audio Studio
 * Features:
 * 1. Video Jump-Cut (Silence trimmer & multi-part merger with smart serial sorting)
 * 2. Auto Silence Remover (Audio speech cleaner)
 * 3. Bulk Watermark Studio (100% WYSIWYG live canvas, 1:1 FFmpeg Normalized math, 4-Way Arrow D-Pad, 9-Grid, pre-built templates, saved logos library, individual play preview & 1-click ZIP download)
 * 4. Project History (Persistent history of past watermark batches and jump-cut jobs)
 */

(function () {
    'use strict';

    const MAX_MERGE_FILES = 25;
    const SINGLE_PART_MAX_BYTES = 45 * 1024 * 1024;
    const STORAGE_KEY_SAVED_WMS = 'autoeditor_saved_watermarks_v1';
    const STORAGE_KEY_HISTORY = 'autoeditor_project_history_v1';

    // Restore saved tool session if user previously had a tool active
    let initialSavedTool = null;
    try {
        const stored = sessionStorage.getItem('autoeditor_last_tool');
        if (stored && ['bulk-watermark', 'watermark-remover', 'merge-audio', 'video-jumpcut', 'silence-remover', 'history', 'docs'].includes(stored)) {
            initialSavedTool = stored;
        }
    } catch (e) {}

    // State
    const state = {
        currentTool: initialSavedTool,
        activeMode: 'single',
        
        // Processing Settings for Jump-Cut / Silence
        minSilence: 0.30,
        silenceThreshold: -35,
        silencePadding: 0.05,

        // Single mode file
        singleFile: null,

        // Merge mode files
        mergeFiles: [],

        // ── Bulk Watermark State ──
        wmFiles: [],
        wmSourceType: 'template',
        wmTemplateId: 'subscribe_badge',
        wmCustomText: '@MyChannel',
        wmTextBadge: true,
        wmSelectedSavedId: null,
        wmUploadedFile: null,
        wmUploadedDataUrl: null,

        // 1:1 WYSIWYG Normalized Coordinates (0.0% to 100.0%)
        wmPosition: 'bottom-right',
        wmNormXPct: 68.0, // Left % of video
        wmNormYPct: 90.0, // Top % of video
        wmScalePct: 28,   // Width % of video (10% to 60%)
        wmOpacity: 0.95,
        wmFirstVideoThumb: null,
        wmFirstVideoAspect: '9/16',
        wmPreviewVideoIndex: 0,

        // ── Merge Audio State ──
        audioMergeFiles: [],
        audioMergeIsPlaying: false,
        audioMergeCurrentTime: 0,
        audioMergeTotalDuration: 0,
        audioMergeJoints: [],
        audioMergeIsProcessing: false,
        audioMergeResult: null,

        // ── Documentation State ──
        docsActiveTab: 'all-tools',
        docsSearchQuery: '',

        // ── Watermark Remover State ──
        delogoFile: null,
        delogoVideoUrl: null,
        delogoThumbUrl: null,
        delogoVideoDims: { width: 1280, height: 720 },
        delogoBox: { x: 40, y: 40, w: 180, h: 80, band: 2 },
        delogoIsProcessing: false,
        delogoResult: null,
        delogoError: null,

        // Live Processing state
        isProcessing: false,
        processingStage: '',
        currentPartIndex: 0,
        totalPartsCount: 0,
        currentPartPercent: 0,
        overallPercent: 0,
        errorMessage: null,

        // Result data
        result: null,
        resultBlob: null,
        resultBlobUrl: null
    };

    // Calculate default (x%, y%) based on selected 9-Grid position and current scale %
    function getGridDefaultCoords(gridPos, scalePct) {
        const w = scalePct || 28;
        const padX = 3.0;
        const padY = 4.0;
        // Estimated height % for badge (approx 28% of badge width)
        const estH = w * 0.28;

        if (gridPos === 'top-left') return { x: padX, y: padY };
        if (gridPos === 'top-center') return { x: (100 - w) / 2, y: padY };
        if (gridPos === 'top-right') return { x: 100 - w - padX, y: padY };
        if (gridPos === 'center-left') return { x: padX, y: 46 };
        if (gridPos === 'center') return { x: (100 - w) / 2, y: 46 };
        if (gridPos === 'center-right') return { x: 100 - w - padX, y: 46 };
        if (gridPos === 'bottom-left') return { x: padX, y: 100 - estH - padY };
        if (gridPos === 'bottom-center') return { x: (100 - w) / 2, y: 100 - estH - padY };
        // bottom-right default
        return { x: 100 - w - padX, y: 100 - estH - padY };
    }

    // ── Pre-built SVG Templates Generator ───────────────────────
    const TEMPLATES = [
        { id: 'subscribe_badge', title: 'Subscribe (Badge)', type: 'badge', bg: '#ef4444', text: 'SUBSCRIBE', icon: '▶' },
        { id: 'subscribe_trans', title: 'Subscribe (Transparent)', type: 'trans', color: '#ff4444', text: 'SUBSCRIBE', icon: '▶' },
        { id: 'follow_badge', title: 'Follow Us (Badge)', type: 'badge', bg: 'linear-gradient(135deg, #2563eb, #8b5cf6)', text: 'FOLLOW US', icon: '★' },
        { id: 'follow_trans', title: 'Follow Us (Transparent)', type: 'trans', color: '#60a5fa', text: 'FOLLOW US', icon: '★' },
        { id: 'like_badge', title: 'Like (Badge)', type: 'badge', bg: '#1d4ed8', text: 'LIKE & SHARE', icon: '👍' },
        { id: 'like_trans', title: 'Like (Transparent)', type: 'trans', color: '#38bdf8', text: 'LIKE 👍', icon: '👍' },
        { id: 'heart_badge', title: 'Love (Badge)', type: 'badge', bg: '#e11d48', text: 'LOVE THIS', icon: '❤️' },
        { id: 'heart_trans', title: 'Heart (Transparent)', type: 'trans', color: '#fb7185', text: '❤️ LOVE', icon: '❤️' },
        { id: 'share_badge', title: 'Share (Badge)', type: 'badge', bg: '#374151', text: 'SHARE VIDEO', icon: '↗' },
        { id: 'share_trans', title: 'Share (Transparent)', type: 'trans', color: '#e5e7eb', text: 'SHARE ↗', icon: '↗' }
    ];

    function generateTemplateDataUrl(tplId) {
        const tpl = TEMPLATES.find(t => t.id === tplId) || TEMPLATES[0];
        const canvas = document.createElement('canvas');
        canvas.width = 420;
        canvas.height = 114;
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        if (tpl.type === 'badge') {
            ctx.fillStyle = tpl.bg.startsWith('linear') ? '#2563eb' : tpl.bg;
            if (tpl.id === 'follow_badge') {
                const grad = ctx.createLinearGradient(0, 0, canvas.width, 0);
                grad.addColorStop(0, '#2563eb');
                grad.addColorStop(1, '#8b5cf6');
                ctx.fillStyle = grad;
            }
            roundRect(ctx, 8, 8, 404, 98, 49);
            ctx.fill();

            ctx.fillStyle = '#ffffff';
            ctx.font = 'bold 36px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(`${tpl.icon}  ${tpl.text}`, 210, 58);
        } else {
            ctx.shadowColor = 'rgba(0, 0, 0, 0.95)';
            ctx.shadowBlur = 12;
            ctx.shadowOffsetX = 3;
            ctx.shadowOffsetY = 3;
            ctx.fillStyle = tpl.color;
            ctx.font = '900 44px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(`${tpl.text}`, 210, 58);
        }

        return canvas.toDataURL('image/png');
    }

    function generateCustomTextDataUrl(text, isBadge) {
        const cleanText = (text || '@MyChannel').trim();
        const canvas = document.createElement('canvas');
        canvas.width = 460;
        canvas.height = 114;
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        if (isBadge) {
            ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
            roundRect(ctx, 8, 8, 444, 98, 49);
            ctx.fill();
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
            ctx.lineWidth = 4;
            ctx.stroke();

            ctx.fillStyle = '#ffffff';
            ctx.font = 'bold 34px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(cleanText, 230, 58);
        } else {
            ctx.shadowColor = 'rgba(0, 0, 0, 0.98)';
            ctx.shadowBlur = 10;
            ctx.shadowOffsetX = 3;
            ctx.shadowOffsetY = 3;
            ctx.fillStyle = '#ffffff';
            ctx.font = '900 40px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(cleanText, 230, 58);
        }

        return canvas.toDataURL('image/png');
    }

    function roundRect(ctx, x, y, width, height, radius) {
        ctx.beginPath();
        ctx.moveTo(x + radius, y);
        ctx.lineTo(x + width - radius, y);
        ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
        ctx.lineTo(x + width, y + height - radius);
        ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
        ctx.lineTo(x + radius, y + height);
        ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
        ctx.lineTo(x, y + radius);
        ctx.quadraticCurveTo(x, y, x + radius, y);
        ctx.closePath();
    }

    // ── LocalStorage Helpers ─────────────────────────────────────
    function getSavedWatermarks() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY_SAVED_WMS);
            return raw ? JSON.parse(raw) : [];
        } catch (e) {
            return [];
        }
    }

    function saveWatermarkToStorage(name, dataUrl) {
        try {
            const list = getSavedWatermarks();
            const id = 'wm_' + Date.now();
            list.unshift({ id, name: name || 'Logo', dataUrl, timestamp: Date.now() });
            localStorage.setItem(STORAGE_KEY_SAVED_WMS, JSON.stringify(list.slice(0, 20)));
            return id;
        } catch (e) {
            return null;
        }
    }

    function deleteSavedWatermark(id) {
        try {
            const list = getSavedWatermarks().filter(w => w.id !== id);
            localStorage.setItem(STORAGE_KEY_SAVED_WMS, JSON.stringify(list));
        } catch (e) {}
    }

    function getProjectHistory() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY_HISTORY);
            return raw ? JSON.parse(raw) : [];
        } catch (e) {
            return [];
        }
    }

    function addProjectHistory(entry) {
        try {
            const list = getProjectHistory();
            list.unshift({
                id: 'proj_' + Date.now(),
                timestamp: Date.now(),
                ...entry
            });
            localStorage.setItem(STORAGE_KEY_HISTORY, JSON.stringify(list.slice(0, 30)));
        } catch (e) {}
    }

    function deleteProjectHistory(id) {
        try {
            const list = getProjectHistory().filter(p => p.id !== id);
            localStorage.setItem(STORAGE_KEY_HISTORY, JSON.stringify(list));
        } catch (e) {}
    }

    function clearAllHistory() {
        try {
            localStorage.removeItem(STORAGE_KEY_HISTORY);
        } catch (e) {}
    }

    // ── Smart Serial Sorting ─────────────────────────────────────
    function extractFileIndex(name) {
        if (!name) return { num: Infinity, raw: '' };
        const withoutExt = name.replace(/\.[^/.]+$/, "");

        const leadingMatch = withoutExt.match(/^0*(\d{1,4})[\s_#-]+/);
        if (leadingMatch && leadingMatch[1]) return { num: parseInt(leadingMatch[1], 10), raw: withoutExt, explicit: true };

        const prefixMatch = withoutExt.match(/(?:part|clip|scene|track|audio|video|vid|ep|seg|chunk|file)[\s_#-]*0*(\d{1,4})/i);
        if (prefixMatch && prefixMatch[1]) return { num: parseInt(prefixMatch[1], 10), raw: withoutExt, explicit: true };

        const parenMatch = withoutExt.match(/[\(\[]\s*0*(\d{1,4})\s*[\)\]]/);
        if (parenMatch && parenMatch[1]) return { num: parseInt(parenMatch[1], 10), raw: withoutExt, explicit: true };

        const trailingMatch = withoutExt.match(/[\s_#-]+0*(\d{1,4})$/);
        if (trailingMatch && trailingMatch[1]) return { num: parseInt(trailingMatch[1], 10), raw: withoutExt, explicit: true };

        const anyMatch = withoutExt.match(/(?:^|\D)0*(\d{1,3})(?:\D|$)/);
        if (anyMatch && anyMatch[1]) {
            const val = parseInt(anyMatch[1], 10);
            if (val > 0 && val <= 500) return { num: val, raw: withoutExt, explicit: false };
        }

        return { num: Infinity, raw: withoutExt, explicit: false };
    }

    function smartSortFiles(filesArray) {
        return filesArray.slice().sort((a, b) => {
            const infoA = extractFileIndex(a.name || '');
            const infoB = extractFileIndex(b.name || '');
            if (infoA.num !== infoB.num) return infoA.num - infoB.num;
            return (a.name || '').localeCompare(b.name || '', undefined, { numeric: true, sensitivity: 'base' });
        });
    }

    // ── Video Thumbnail & Frame Capture ──────────────────────────
    async function extractFrameFromServer(file) {
        try {
            if (!file) return null;
            const formData = new FormData();
            formData.append('file', file);
            formData.append('fileName', file.name || 'video.mp4');
            const res = await fetch('/api/watermark/extract-frame', {
                method: 'POST',
                body: formData
            });
            if (res.ok) {
                const data = await res.json();
                if (data.success && data.thumbUrl) {
                    return { thumbUrl: data.thumbUrl, aspect: data.aspect || '9/16' };
                }
            }
        } catch (e) {
            console.warn("Server frame extraction failed:", e);
        }
        return null;
    }

    function captureVideoThumbnail(file) {
        return new Promise((resolve) => {
            if (!file) return resolve(null);
            const isVideo = (file.type && file.type.startsWith('video')) || /\.(mp4|mov|mkv|webm|m4v|avi|3gp|flv|wmv)$/i.test(file.name);
            if (!isVideo && !file.type) return resolve(null);

            const url = URL.createObjectURL(file);
            const video = document.createElement('video');
            video.preload = 'auto';
            video.muted = true;
            video.playsInline = true;
            video.crossOrigin = 'anonymous';
            video.src = url;

            let finished = false;
            const finalize = (data, aspect) => {
                if (finished) return;
                finished = true;
                URL.revokeObjectURL(url);
                if (data) {
                    resolve({ thumbUrl: data, aspect: aspect || '9/16' });
                } else {
                    // Fallback to server ffmpeg frame extractor
                    extractFrameFromServer(file).then(res => resolve(res)).catch(() => resolve(null));
                }
            };

            const tryDrawCanvas = () => {
                try {
                    if (video.videoWidth > 0 && video.videoHeight > 0) {
                        const canvas = document.createElement('canvas');
                        const w = Math.min(video.videoWidth, 480);
                        const aspectVal = video.videoHeight / video.videoWidth;
                        canvas.width = w;
                        canvas.height = Math.max(1, Math.round(w * aspectVal));
                        const ctx = canvas.getContext('2d');
                        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                        const aspectStr = (video.videoWidth < video.videoHeight) ? '9/16' : '16/9';
                        finalize(canvas.toDataURL('image/jpeg', 0.85), aspectStr);
                        return true;
                    }
                } catch (e) {
                    console.warn("Canvas draw error:", e);
                }
                return false;
            };

            video.onloadedmetadata = () => {
                const dur = isFinite(video.duration) && video.duration > 0 ? video.duration : 1;
                video.currentTime = Math.min(0.5, dur * 0.2);
            };

            video.onloadeddata = () => {
                if (!tryDrawCanvas()) {
                    const dur = isFinite(video.duration) && video.duration > 0 ? video.duration : 1;
                    video.currentTime = Math.min(0.5, dur * 0.2);
                }
            };

            video.oncanplay = () => {
                tryDrawCanvas();
            };

            video.onseeked = () => {
                tryDrawCanvas();
            };

            video.onerror = () => {
                finalize(null, '9/16');
            };

            // Fast fallback: if browser cannot decode in 1.2s, fallback to FFmpeg backend
            setTimeout(() => {
                if (!finished) {
                    if (!tryDrawCanvas()) {
                        finalize(null, '9/16');
                    }
                }
            }, 1200);
        });
    }

    function openPreviewModal(fileOrUrl, title) {
        if (!fileOrUrl) return;
        const isBlob = typeof fileOrUrl === 'object';
        const url = isBlob ? URL.createObjectURL(fileOrUrl) : fileOrUrl;
        const existing = document.getElementById('m-preview-modal-root');
        if (existing) existing.remove();

        const fileName = (isBlob && fileOrUrl.name) ? fileOrUrl.name.toLowerCase() : (typeof fileOrUrl === 'string' ? fileOrUrl.toLowerCase() : '');
        const fileType = (isBlob && fileOrUrl.type) ? fileOrUrl.type.toLowerCase() : '';
        const isAudioFile = fileType.startsWith('audio') || /\.(mp3|wav|m4a|aac|flac|ogg|opus|wma)$/i.test(fileName) || state.currentTool === 'silence-remover' || state.currentTool === 'merge-audio';
        const isVideo = !isAudioFile && (fileType.startsWith('video') || /\.(mp4|mov|mkv|webm|m4v|avi|3gp)$/i.test(fileName) || state.currentTool === 'video-jumpcut');

        const modalHTML = `
            <div class="m-preview-modal-overlay" id="m-preview-modal-root">
                <div class="m-preview-modal">
                    <div class="m-preview-modal__header">
                        <span class="m-preview-modal__title">${escapeHTML(title || (isBlob ? fileOrUrl.name : (isVideo ? 'Video Preview' : 'Audio Preview')))}</span>
                        <button type="button" class="m-preview-modal__close" id="btn-close-modal-preview">
                            ${icons.close}
                        </button>
                    </div>
                    <div class="m-preview-modal__body" style="padding:16px;text-align:center;">
                        ${isVideo ? `
                            <video controls autoplay playsinline class="m-preview-modal__video" src="${url}"></video>
                        ` : `
                            <div style="background:#0f172a;border-radius:12px;padding:20px;border:1px solid #334155;">
                                <div style="font-size:13px;color:#93c5fd;font-weight:700;margin-bottom:12px;">🎵 Audio Player</div>
                                <audio controls autoplay playsinline style="width:100%;max-width:360px;" src="${url}"></audio>
                            </div>
                        `}
                    </div>
                </div>
            </div>
        `;
        document.body.insertAdjacentHTML('beforeend', modalHTML);

        const overlay = document.getElementById('m-preview-modal-root');
        const closeBtn = document.getElementById('btn-close-modal-preview');

        const closeModal = () => {
            const vid = overlay.querySelector('video, audio');
            if (vid) {
                vid.pause();
                vid.src = '';
            }
            overlay.remove();
        };

        if (closeBtn) closeBtn.addEventListener('click', closeModal);
        if (overlay) {
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) closeModal();
            });
        }
    }

    function formatBytes(bytes) {
        if (!bytes || bytes === 0) return '0 B';
        const k = 1024;
        const dm = 1;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
    }

    function formatTime(sec) {
        if (sec == null || isNaN(sec)) return '0:00';
        const s = Math.max(0, Number(sec));
        const m = Math.floor(s / 60);
        const rem = Math.floor(s % 60);
        const ms = Math.floor((s % 1) * 10);
        if (m > 0) return `${m}:${rem.toString().padStart(2, '0')}.${ms}`;
        return `${rem}.${ms}s`;
    }

    function formatDuration(sec) {
        if (sec == null || isNaN(sec)) return '0:00.0';
        const s = Math.max(0, Number(sec));
        const m = Math.floor(s / 60);
        const rem = Math.floor(s % 60);
        const ms = Math.floor((s % 1) * 10);
        return `${m}:${rem.toString().padStart(2, '0')}.${ms}`;
    }

    // Icons
    const icons = {
        video: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2.5"/><polygon points="10 8 16 12 10 16 10 8" fill="currentColor" stroke="none"/></svg>`,
        audio: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v20M17 5v14M7 5v14M22 9v6M2 9v6"/></svg>`,
        watermark: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"/></svg>`,
        mergeAudio: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/><path d="M6 8h6"/></svg>`,
        scissors: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/></svg>`,
        history: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
        back: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>`,
        upload: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`,
        plus: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
        close: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
        download: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`,
        zip: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8v13H3V8"/><path d="M1 3h22v5H1z"/><path d="M10 12h4"/><path d="M10 16h4"/></svg>`,
        cloud: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/></svg>`,
        check: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
        refresh: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 21h5v-5"/></svg>`,
        bolt: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`,
        alert: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
        up: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>`,
        down: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`,
        left: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>`,
        right: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`,
        play: `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4"/></svg>`,
        trash: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`,
        book: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1-2.5-2.5Z"/><path d="M6 2v20"/><path d="M9 7h8"/><path d="M9 11h6"/></svg>`,
        eraser: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/></svg>`
    };

    const rootEl = document.getElementById('autoeditor-global-app-root');

    function render() {
        if (!rootEl) return;

        if (!state.currentTool) {
            renderHomeScreen();
        } else if (state.currentTool === 'history') {
            renderHistoryScreen();
        } else if (state.currentTool === 'docs') {
            renderDocsScreen();
        } else if (state.currentTool === 'watermark-remover') {
            renderWatermarkRemoverScreen();
        } else if (state.currentTool === 'bulk-watermark') {
            renderWatermarkScreen();
        } else if (state.currentTool === 'merge-audio') {
            renderAudioMergeScreen();
        } else {
            renderToolScreen();
        }
    }

    // ── 1. HOME SCREEN ──────────────────────────────────────────
    function renderHomeScreen() {
        const historyCount = getProjectHistory().length;

        rootEl.innerHTML = `
            <div class="m-app-shell">
                <header class="m-header">
                    <div class="m-header__brand">
                        <span class="m-header__logo">${icons.scissors}</span>
                        <div class="m-header__text">
                            <span class="m-header__title">AutoEditor Pro</span>
                            <span class="m-header__badge">${icons.cloud} Cloud Engine Active</span>
                        </div>
                    </div>
                    <div style="display:flex;align-items:center;gap:6px;">
                        <button type="button" class="m-header__docs-btn" id="btn-open-docs">
                            ${icons.book}
                            <span>Docs & Guide</span>
                        </button>
                        <button type="button" class="m-header__history-btn" id="btn-open-history">
                            ${icons.history}
                            <span>History (${historyCount})</span>
                        </button>
                    </div>
                </header>

                <main class="m-main">
                    <div class="m-server-status-pill">
                        <span class="m-status-dot"></span>
                        <span>Jump-Cut & Bulk Watermarking Studio Ready</span>
                    </div>

                    <div class="m-tool-selection">
                        <div class="m-tool-card" id="btn-select-watermark">
                            <div class="m-tool-card__icon m-icon-watermark">
                                ${icons.watermark}
                            </div>
                            <div class="m-tool-card__body">
                                <h2 class="m-tool-card__title">Bulk Watermark Studio</h2>
                                <p class="m-tool-card__desc">100% WYSIWYG matching. Arrow D-Pad controls & 1-Click ZIP download.</p>
                                <div class="m-tool-card__meta">
                                    <span>Batch Upload</span>
                                    <span>·</span>
                                    <span>Universal MP4</span>
                                    <span>·</span>
                                    <span>.ZIP Archive</span>
                                </div>
                            </div>
                            <div class="m-tool-card__arrow">→</div>
                        </div>

                        <div class="m-tool-card" id="btn-select-delogo">
                            <div class="m-tool-card__icon m-icon-delogo">
                                ${icons.eraser}
                            </div>
                            <div class="m-tool-card__body">
                                <h2 class="m-tool-card__title">Watermark Remover (लोगो रिमूवर)</h2>
                                <p class="m-tool-card__desc">Remove unwanted logos & watermarks. Smart Delogo filter + 100% Blur-Free AI Inpainting Guide.</p>
                                <div class="m-tool-card__meta">
                                    <span>Interactive Box</span>
                                    <span>·</span>
                                    <span>Smart Delogo</span>
                                    <span>·</span>
                                    <span>Free AI Inpaint</span>
                                </div>
                            </div>
                            <div class="m-tool-card__arrow">→</div>
                        </div>

                        <div class="m-tool-card" id="btn-select-audio-merge">
                            <div class="m-tool-card__icon m-icon-merge-audio">
                                ${icons.mergeAudio}
                            </div>
                            <div class="m-tool-card__body">
                                <h2 class="m-tool-card__title">Merge Audio (ऑडियो मर्जर)</h2>
                                <p class="m-tool-card__desc">Multi-part audio merger. Interactive Waveform timeline with Joint Point transitions & 320kbps MP3 export.</p>
                                <div class="m-tool-card__meta">
                                    <span>Multi-Track Waveform</span>
                                    <span>·</span>
                                    <span>Joint Markers</span>
                                    <span>·</span>
                                    <span>320kbps MP3</span>
                                </div>
                            </div>
                            <div class="m-tool-card__arrow">→</div>
                        </div>

                        <div class="m-tool-card" id="btn-select-vjump">
                            <div class="m-tool-card__icon m-icon-video">
                                ${icons.video}
                            </div>
                            <div class="m-tool-card__body">
                                <h2 class="m-tool-card__title">Video Jump-Cut</h2>
                                <p class="m-tool-card__desc">Choose from Files. Auto-sorts serial parts (1, 2, 3...) with frame previews & dead-air trimmer.</p>
                                <div class="m-tool-card__meta">
                                    <span>Single Video</span>
                                    <span>·</span>
                                    <span>Merge Parts (up to ${MAX_MERGE_FILES})</span>
                                </div>
                            </div>
                            <div class="m-tool-card__arrow">→</div>
                        </div>

                        <div class="m-tool-card" id="btn-select-silence">
                            <div class="m-tool-card__icon m-icon-audio">
                                ${icons.audio}
                            </div>
                            <div class="m-tool-card__body">
                                <h2 class="m-tool-card__title">Auto Silence Remover</h2>
                                <p class="m-tool-card__desc">Clean audio speech tracks. Cuts ambient pauses and mic hum.</p>
                                <div class="m-tool-card__meta">
                                    <span>Single Audio</span>
                                    <span>·</span>
                                    <span>Merge Parts</span>
                                </div>
                            </div>
                            <div class="m-tool-card__arrow">→</div>
                        </div>

                        <div class="m-tool-card" id="btn-select-docs" style="border: 1px solid rgba(99, 102, 241, 0.4); background: linear-gradient(135deg, rgba(99, 102, 241, 0.08) 0%, rgba(17, 24, 39, 0.95) 100%);">
                            <div class="m-tool-card__icon m-icon-docs">
                                ${icons.book}
                            </div>
                            <div class="m-tool-card__body">
                                <h2 class="m-tool-card__title" style="color:#a5b4fc;">📖 Studio Documentation & Tools Guide</h2>
                                <p class="m-tool-card__desc">ऐप के सभी 5 टूल्स, बैकएंड इंजनों, कोड फंक्शंस और बिना ब्लर लोगो हटाने की विस्तृत तकनीकी गाइड।</p>
                                <div class="m-tool-card__meta">
                                    <span style="color:#818cf8;">All 5 Tools</span>
                                    <span>·</span>
                                    <span style="color:#818cf8;">FFmpeg & Python</span>
                                    <span>·</span>
                                    <span style="color:#818cf8;">Full Code Logic</span>
                                </div>
                            </div>
                            <div class="m-tool-card__arrow" style="color:#818cf8;">→</div>
                        </div>
                    </div>
                </main>
            </div>
        `;

        document.getElementById('btn-select-watermark').addEventListener('click', () => selectTool('bulk-watermark'));
        document.getElementById('btn-select-delogo').addEventListener('click', () => selectTool('watermark-remover'));
        document.getElementById('btn-select-audio-merge').addEventListener('click', () => selectTool('merge-audio'));
        document.getElementById('btn-select-vjump').addEventListener('click', () => selectTool('video-jumpcut'));
        document.getElementById('btn-select-silence').addEventListener('click', () => selectTool('silence-remover'));
        document.getElementById('btn-select-docs').addEventListener('click', () => {
            state.currentTool = 'docs';
            render();
        });
        document.getElementById('btn-open-docs').addEventListener('click', () => {
            state.currentTool = 'docs';
            render();
        });
        document.getElementById('btn-open-history').addEventListener('click', () => {
            state.currentTool = 'history';
            render();
        });
    }

    function selectTool(toolKey) {
        state.currentTool = toolKey;
        try { sessionStorage.setItem('autoeditor_last_tool', toolKey); } catch (e) {}
        state.activeMode = 'single';
        state.singleFile = null;
        state.mergeFiles = [];
        state.wmFiles = [];
        state.isProcessing = false;
        state.result = null;
        state.errorMessage = null;
        render();
    }

    // ── 2. BULK WATERMARK STUDIO SCREEN (WYSIWYG 1:1) ───────────
    function renderWatermarkScreen() {
        const fileAccept = '.mp4,.mov,.mkv,.webm,.m4v,.avi,application/octet-stream';
        const count = state.wmFiles.length;
        const totalSize = state.wmFiles.reduce((acc, f) => acc + f.size, 0);

        let activeWatermarkDataUrl = '';
        if (state.wmSourceType === 'template') {
            activeWatermarkDataUrl = generateTemplateDataUrl(state.wmTemplateId);
        } else if (state.wmSourceType === 'text') {
            activeWatermarkDataUrl = generateCustomTextDataUrl(state.wmCustomText, state.wmTextBadge);
        } else if (state.wmSourceType === 'upload' && state.wmUploadedDataUrl) {
            activeWatermarkDataUrl = state.wmUploadedDataUrl;
        } else if (state.wmSourceType === 'saved') {
            const savedList = getSavedWatermarks();
            const found = savedList.find(w => w.id === state.wmSelectedSavedId) || savedList[0];
            if (found) activeWatermarkDataUrl = found.dataUrl;
        }

        if (!activeWatermarkDataUrl) activeWatermarkDataUrl = generateTemplateDataUrl('subscribe_badge');

        const savedWatermarks = getSavedWatermarks();
        
        // 1:1 Normalized CSS coordinates
        const overlayStyle = `left:${state.wmNormXPct.toFixed(1)}%; top:${state.wmNormYPct.toFixed(1)}%; width:${state.wmScalePct}%; opacity:${state.wmOpacity};`;

        rootEl.innerHTML = `
            <div class="m-app-shell">
                <header class="m-tool-header">
                    <button type="button" class="m-back-btn" id="m-btn-back-wm" aria-label="Back to home">
                        ${icons.back}
                    </button>
                    <div class="m-tool-header__title">Bulk Watermark Studio</div>
                    <div class="m-tool-header__action">
                        ${count > 0 && !state.isProcessing ? `
                            <button type="button" class="m-clear-btn" id="m-btn-reset-wm">Clear</button>
                        ` : ''}
                    </div>
                </header>

                <main class="m-tool-main">
                    <!-- STEP 1: Video Selection -->
                    <section class="m-card">
                        <div class="m-card__header">
                            <span class="m-card__title">1. Upload Batch Videos (${count} selected)</span>
                            <span class="m-card__hint">${icons.bolt} WYSIWYG 1:1</span>
                        </div>

                        ${count > 0 ? `
                            <div class="m-parts-list">
                                <div class="m-parts-header">
                                    <span>Uploaded Videos (${count})</span>
                                    <span>Total: ${formatBytes(totalSize)}</span>
                                </div>
                                ${state.wmFiles.map((f, idx) => `
                                    <div class="m-part-item">
                                        <span class="m-part-index">${idx + 1}</span>
                                        <div class="m-part-thumb btn-preview-item-wm" data-index="${idx}" title="Tap to preview clip / use as live frame">
                                            ${f._thumbUrl ? `<img src="${f._thumbUrl}" alt="Thumb" />` : ''}
                                            <div class="m-part-thumb__play">${icons.play}</div>
                                        </div>
                                        <div class="m-part-details">
                                            <div class="m-part-name-row">
                                                <span class="m-part-name">${escapeHTML(f.name)}</span>
                                                ${state.wmPreviewVideoIndex === idx ? '<span class="m-part-preview-badge">⭐ Preview Frame</span>' : ''}
                                            </div>
                                            <div class="m-part-meta-row">
                                                <span class="m-part-size">${formatBytes(f.size)}</span>
                                                ${state.wmPreviewVideoIndex !== idx ? `<button type="button" class="m-frame-switch-link btn-set-preview-frame" data-index="${idx}">Use Frame</button>` : ''}
                                            </div>
                                        </div>
                                        <button type="button" class="m-part-remove btn-remove-wm-file" data-index="${idx}">
                                            ${icons.close}
                                        </button>
                                    </div>
                                `).join('')}
                            </div>
                        ` : ''}

                        <div class="m-dropzone" id="m-dropzone-wm-videos">
                            <input type="file" id="m-input-wm-videos" accept="${fileAccept}" multiple hidden />
                            <div class="m-dropzone__icon">${icons.plus}</div>
                            <div class="m-dropzone__text">${count === 0 ? 'Choose Videos from Files (Batch)' : 'Add More Videos to Batch'}</div>
                            <div class="m-dropzone__sub">Upload 1 to 25 videos (Shorts / Reels / 16:9)</div>
                        </div>
                    </section>

                    <!-- STEP 2: Live Canvas + Unified Placement & Arrow D-Pad Controls -->
                    <section class="m-card m-canvas-card">
                        <div class="m-card__header">
                            <span class="m-card__title">2. Live Placement & Fine-Tuning Controls</span>
                            ${count > 1 ? `
                                <button type="button" class="m-cycle-frame-btn" id="btn-cycle-preview-frame" title="Switch video frame for preview">
                                    🔄 Switch Frame (${(state.wmPreviewVideoIndex || 0) + 1}/${count})
                                </button>
                            ` : `
                                <span class="m-card__badge-ok">${icons.check} 100% Accurate</span>
                            `}
                        </div>

                        <!-- Video Frame Canvas (Uncropped true frame container) -->
                        <div class="m-canvas-wrap ${state.wmFirstVideoAspect === '16/9' ? 'is-landscape' : ''}" id="m-live-canvas-container">
                            ${state.wmFirstVideoThumb ? `
                                <img src="${state.wmFirstVideoThumb}" alt="Video Frame Preview" class="m-canvas-bg-img" />
                            ` : `
                                <div class="m-canvas-placeholder">
                                    <span>${icons.video}</span>
                                    <span>${count > 0 ? 'Extracting video frame...' : 'Upload a video to see live frame placement'}</span>
                                </div>
                            `}
                            <div class="m-canvas-watermark-overlay" style="${overlayStyle}" id="m-live-watermark-overlay">
                                <img src="${activeWatermarkDataUrl}" alt="Watermark Preview" />
                            </div>
                        </div>

                        ${state.wmFirstVideoThumb && count > 0 ? `
                            <div class="m-canvas-meta-bar">
                                <span class="m-canvas-frame-name" id="m-wm-current-preview-name">
                                    🎬 Previewing Frame: <strong>${escapeHTML((state.wmFiles[state.wmPreviewVideoIndex || 0] || state.wmFiles[0] || {}).name || 'Video')}</strong> (${state.wmFirstVideoAspect || '9/16'})
                                </span>
                                ${count > 1 ? `
                                    <button type="button" class="m-frame-switch-link" id="btn-next-preview-frame">
                                        Next Video ➡️
                                    </button>
                                ` : ''}
                            </div>
                        ` : ''}

                        <!-- Interactive Arrow Controller (D-Pad for Micro Adjustments) -->
                        <div class="m-dpad-container">
                            <div class="m-dpad-title">
                                <span>Position Controller (Arrow Nudge)</span>
                                <span class="m-dpad-offset-badge" id="m-val-dpad-offset">X: ${state.wmNormXPct.toFixed(1)}% | Y: ${state.wmNormYPct.toFixed(1)}%</span>
                            </div>
                            <div class="m-dpad-cross">
                                <button type="button" class="m-dpad-btn m-dpad-btn--up" id="btn-dpad-up" title="Move Up ⬆️">
                                    ${icons.up}
                                </button>
                                <button type="button" class="m-dpad-btn m-dpad-btn--left" id="btn-dpad-left" title="Move Left ⬅️">
                                    ${icons.left}
                                </button>
                                <button type="button" class="m-dpad-btn m-dpad-btn--center" id="btn-dpad-center" title="Reset to Default">
                                    Reset
                                </button>
                                <button type="button" class="m-dpad-btn m-dpad-btn--right" id="btn-dpad-right" title="Move Right ➡️">
                                    ${icons.right}
                                </button>
                                <button type="button" class="m-dpad-btn m-dpad-btn--down" id="btn-dpad-down" title="Move Down ⬇️">
                                    ${icons.down}
                                </button>
                            </div>
                            <span style="font-size:11px; color:#93c5fd; text-align:center; font-weight:600;">
                                💡 Tap arrows to nudge position anywhere over target watermark!
                            </span>
                        </div>

                        <!-- 9-Grid Quick Placement -->
                        <div style="margin-top:14px;">
                            <div class="m-field__label-row">
                                <label class="m-field__label">Quick 9-Grid Placement</label>
                                <span class="m-field__value-badge">${state.wmPosition.toUpperCase()}</span>
                            </div>
                            <div class="m-grid-9">
                                <button type="button" class="m-grid-btn ${state.wmPosition === 'top-left' ? 'is-selected' : ''}" data-pos="top-left">Top-Left</button>
                                <button type="button" class="m-grid-btn ${state.wmPosition === 'top-center' ? 'is-selected' : ''}" data-pos="top-center">Top-Center</button>
                                <button type="button" class="m-grid-btn ${state.wmPosition === 'top-right' ? 'is-selected' : ''}" data-pos="top-right">Top-Right</button>
                                <button type="button" class="m-grid-btn ${state.wmPosition === 'center-left' ? 'is-selected' : ''}" data-pos="center-left">Center-Left</button>
                                <button type="button" class="m-grid-btn ${state.wmPosition === 'center' ? 'is-selected' : ''}" data-pos="center">Center</button>
                                <button type="button" class="m-grid-btn ${state.wmPosition === 'center-right' ? 'is-selected' : ''}" data-pos="center-right">Center-Right</button>
                                <button type="button" class="m-grid-btn ${state.wmPosition === 'bottom-left' ? 'is-selected' : ''}" data-pos="bottom-left">Bottom-Left</button>
                                <button type="button" class="m-grid-btn ${state.wmPosition === 'bottom-center' ? 'is-selected' : ''}" data-pos="bottom-center">Bottom-Center</button>
                                <button type="button" class="m-grid-btn ${state.wmPosition === 'bottom-right' ? 'is-selected' : ''}" data-pos="bottom-right">Bottom-Right</button>
                            </div>
                        </div>

                        <!-- Size Slider -->
                        <div class="m-field" style="margin-top:14px;">
                            <div class="m-field__label-row">
                                <label for="m-slider-wm-scale" class="m-field__label">Watermark Size / Scale</label>
                                <span class="m-field__value-badge" id="m-val-wm-scale">${state.wmScalePct}%</span>
                            </div>
                            <input type="range" class="m-slider" id="m-slider-wm-scale" min="10" max="60" step="1" value="${state.wmScalePct}" ${state.isProcessing ? 'disabled' : ''} />
                            <div class="m-field__scale">
                                <span>10% (Small)</span>
                                <span>60% (Large / Full Cover)</span>
                            </div>
                        </div>

                        <!-- Opacity Slider -->
                        <div class="m-field">
                            <div class="m-field__label-row">
                                <label for="m-slider-wm-opacity" class="m-field__label">Opacity / Transparency</label>
                                <span class="m-field__value-badge" id="m-val-wm-opacity">${Math.round(state.wmOpacity * 100)}%</span>
                            </div>
                            <input type="range" class="m-slider" id="m-slider-wm-opacity" min="0.20" max="1.00" step="0.05" value="${state.wmOpacity}" ${state.isProcessing ? 'disabled' : ''} />
                            <div class="m-field__scale">
                                <span>20% (Subtle)</span>
                                <span>100% (Solid)</span>
                            </div>
                        </div>
                    </section>

                    <!-- STEP 3: Choose / Create Watermark -->
                    <section class="m-card">
                        <div class="m-card__header">
                            <span class="m-card__title">3. Choose Watermark Type</span>
                        </div>

                        <div class="m-wm-tabs" role="tablist">
                            <button type="button" class="m-wm-tab-btn ${state.wmSourceType === 'template' ? 'is-active' : ''}" id="tab-wm-templates">
                                Ready Templates
                            </button>
                            <button type="button" class="m-wm-tab-btn ${state.wmSourceType === 'text' ? 'is-active' : ''}" id="tab-wm-text">
                                Custom Text
                            </button>
                            <button type="button" class="m-wm-tab-btn ${state.wmSourceType === 'upload' ? 'is-active' : ''}" id="tab-wm-upload">
                                Upload Logo
                            </button>
                            <button type="button" class="m-wm-tab-btn ${state.wmSourceType === 'saved' ? 'is-active' : ''}" id="tab-wm-saved">
                                Saved (${savedWatermarks.length})
                            </button>
                        </div>

                        ${state.wmSourceType === 'template' ? `
                            <div class="m-templates-grid">
                                ${TEMPLATES.map(t => `
                                    <div class="m-template-card ${state.wmTemplateId === t.id ? 'is-selected' : ''}" data-tpl-id="${t.id}">
                                        <div class="m-template-preview-box">
                                            ${t.type === 'badge' ? `
                                                <span class="m-badge-${t.id.split('_')[0]}">${t.icon} ${t.text}</span>
                                            ` : `
                                                <span class="m-text-transparent-preview" style="color:${t.color};">${t.text}</span>
                                            `}
                                        </div>
                                        <span class="m-template-title">${t.title}</span>
                                    </div>
                                `).join('')}
                            </div>
                        ` : ''}

                        ${state.wmSourceType === 'text' ? `
                            <div class="m-custom-text-box">
                                <label class="m-field__label">Your Handle / Channel Name</label>
                                <input type="text" class="m-text-input" id="m-input-custom-text" value="${escapeHTML(state.wmCustomText)}" placeholder="@MyChannel or Brand Name" />
                                <div style="display:flex; gap:8px; margin-top:4px;">
                                    <button type="button" class="m-grid-btn ${state.wmTextBadge ? 'is-selected' : ''}" id="btn-text-badge-solid" style="flex:1;">
                                        Solid Dark Pill Badge
                                    </button>
                                    <button type="button" class="m-grid-btn ${!state.wmTextBadge ? 'is-selected' : ''}" id="btn-text-badge-trans" style="flex:1;">
                                        Transparent Text
                                    </button>
                                </div>
                            </div>
                        ` : ''}

                        ${state.wmSourceType === 'upload' ? `
                            <div>
                                <div class="m-dropzone" id="m-dropzone-logo-upload" style="padding:14px;">
                                    <input type="file" id="m-input-logo-file" accept="image/png,image/jpeg,image/svg+xml" hidden />
                                    <div class="m-dropzone__icon">${icons.upload}</div>
                                    <div class="m-dropzone__text">${state.wmUploadedFile ? `Selected: ${escapeHTML(state.wmUploadedFile.name)}` : 'Upload Logo / PNG Image'}</div>
                                    <div class="m-dropzone__sub">Automatically saved to your Library permanently</div>
                                </div>
                            </div>
                        ` : ''}

                        ${state.wmSourceType === 'saved' ? `
                            <div>
                                ${savedWatermarks.length === 0 ? `
                                    <div style="text-align:center; padding:16px; color:var(--text-muted); font-size:12px;">
                                        No saved logos yet. Upload a logo in "Upload Logo" to save it here forever!
                                    </div>
                                ` : `
                                    <div class="m-saved-wm-list">
                                        ${savedWatermarks.map(w => `
                                            <div class="m-saved-wm-card ${state.wmSelectedSavedId === w.id ? 'is-selected' : ''}" data-saved-id="${w.id}">
                                                <button type="button" class="m-saved-wm-delete-btn btn-delete-saved-wm" data-delete-id="${w.id}">×</button>
                                                <div class="m-saved-wm-img-wrap">
                                                    <img src="${w.dataUrl}" alt="${escapeHTML(w.name)}" />
                                                </div>
                                                <span class="m-saved-wm-title">${escapeHTML(w.name)}</span>
                                            </div>
                                        `).join('')}
                                    </div>
                                `}
                            </div>
                        ` : ''}
                    </section>

                    <!-- STEP 4: Process Action Button & Progress -->
                    <div class="m-action-area">
                        ${renderWatermarkProcessButton(count)}
                        ${state.isProcessing ? renderWatermarkProgressIndicator() : ''}
                        ${state.errorMessage ? `
                            <div class="m-error-banner">
                                <span>${escapeHTML(state.errorMessage)}</span>
                            </div>
                        ` : ''}
                    </div>

                    <!-- STEP 5: Results Section -->
                    ${state.result ? renderWatermarkResultsHTML() : ''}
                </main>
            </div>
        `;

        setupWatermarkEvents();
    }

    function renderWatermarkProcessButton(count) {
        if (state.isProcessing) {
            return `
                <button type="button" class="m-btn-process is-busy is-purple" disabled>
                    <span class="m-spinner"></span>
                    <span>Watermarking ${count} Videos in Cloud...</span>
                </button>
            `;
        }

        const isDisabled = count === 0;
        return `
            <button type="button" class="m-btn-process is-purple" id="btn-process-wm-action" ${isDisabled ? 'disabled' : ''}>
                <span>${icons.watermark}</span>
                <span>Apply Watermark to All ${count || 0} Videos</span>
            </button>
        `;
    }

    function renderWatermarkProgressIndicator() {
        return `
            <div class="m-progress-container">
                <div class="m-progress-status-row">
                    <span id="m-wm-progress-stage">${escapeHTML(state.processingStage || 'Processing batch...')}</span>
                    <span class="m-progress-pct" id="m-wm-progress-pct">${state.overallPercent}%</span>
                </div>
                <div class="m-progress-bar-bg">
                    <div class="m-progress-bar-fill" id="m-wm-progress-fill" style="width: ${state.overallPercent}%;"></div>
                </div>
            </div>
        `;
    }

    function renderWatermarkResultsHTML() {
        const res = state.result;
        if (!res) return '';

        const successfulResults = (res.results || []).filter(r => r.status === 'success');
        const zipUrl = res.zip_download_url ? `${res.zip_download_url}?nocache=${Date.now()}` : '';

        return `
            <section class="m-card m-result-card">
                <div class="m-card__header">
                    <span class="m-card__title">Completed Batch (${successfulResults.length} Videos)</span>
                    <span class="m-card__badge-ok">${icons.check} Ready</span>
                </div>

                <div class="m-result-zip-banner">
                    <div class="m-zip-banner-title">
                        <span>${icons.zip}</span>
                        <span>Download All ${successfulResults.length} Watermarked Videos in 1 File</span>
                    </div>
                    <button type="button" class="m-btn-download-zip" id="btn-download-wm-zip" data-zip-url="${zipUrl}">
                        <span>${icons.download}</span>
                        <span>Download Complete ZIP Archive (${formatBytes(res.zip_size)})</span>
                    </button>
                </div>

                <div class="m-results-video-grid">
                    ${successfulResults.map((item, idx) => {
                        const downUrl = `${item.download_url}?nocache=${Date.now()}`;
                        return `
                            <div class="m-result-video-item">
                                <div class="m-result-video-header">
                                    <span class="m-result-video-name">Part #${idx + 1}: ${escapeHTML(item.original_name)}</span>
                                    <span style="font-size:10px; color:var(--text-muted);">${formatBytes(item.size)}</span>
                                </div>
                                <div class="m-result-video-player-wrap">
                                    <video controls playsinline preload="metadata" src="${downUrl}"></video>
                                </div>
                                <button type="button" class="m-btn-download-single-wm" data-dl-url="${downUrl}" data-dl-name="watermarked_${item.original_name}">
                                    ${icons.download}
                                    <span>Download This Video</span>
                                </button>
                            </div>
                        `;
                    }).join('')}
                </div>

                <button type="button" class="m-btn-secondary" id="btn-wm-process-another">
                    <span>${icons.refresh}</span>
                    <span>Watermark Another Batch</span>
                </button>
            </section>
        `;
    }

    // ── Setup Watermark Events with Exact WYSIWYG Controls ──────
    function setupWatermarkEvents() {
        const backBtn = document.getElementById('m-btn-back-wm');
        if (backBtn) {
            backBtn.addEventListener('click', () => {
                state.currentTool = null;
                state.result = null;
                render();
            });
        }

        const resetBtn = document.getElementById('m-btn-reset-wm');
        if (resetBtn) {
            resetBtn.addEventListener('click', () => {
                state.wmFiles = [];
                state.wmFirstVideoThumb = null;
                state.wmPreviewVideoIndex = 0;
                state.result = null;
                state.errorMessage = null;
                render();
            });
        }

        // Upload Video Batch
        const dropzone = document.getElementById('m-dropzone-wm-videos');
        const input = document.getElementById('m-input-wm-videos');
        if (dropzone && input) {
            dropzone.addEventListener('click', () => input.click());
            input.addEventListener('change', async (e) => {
                if (e.target.files && e.target.files.length > 0) {
                    const newFiles = Array.from(e.target.files);
                    let combined = state.wmFiles.concat(newFiles);
                    if (combined.length > MAX_MERGE_FILES) combined = combined.slice(0, MAX_MERGE_FILES);
                    state.wmFiles = smartSortFiles(combined);
                    state.result = null;
                    state.errorMessage = null;
                    render();

                    // Extract frame for each video, and dynamically attach the first available one to the canvas
                    for (let i = 0; i < state.wmFiles.length; i++) {
                        const f = state.wmFiles[i];
                        if (!f._thumbUrl) {
                            captureVideoThumbnail(f).then(c => {
                                if (c && c.thumbUrl) {
                                    f._thumbUrl = c.thumbUrl;
                                    f._aspect = c.aspect;
                                    if (!state.wmFirstVideoThumb || state.wmPreviewVideoIndex === i) {
                                        state.wmFirstVideoThumb = c.thumbUrl;
                                        state.wmFirstVideoAspect = c.aspect;
                                        state.wmPreviewVideoIndex = i;
                                        updateLiveCanvasBg();
                                    }
                                    const thumbContainer = document.querySelector(`.btn-preview-item-wm[data-index="${i}"]`);
                                    if (thumbContainer) {
                                        let img = thumbContainer.querySelector('img');
                                        if (!img) {
                                            img = document.createElement('img');
                                            img.alt = 'Thumb';
                                            thumbContainer.prepend(img);
                                        }
                                        img.src = c.thumbUrl;
                                    }
                                }
                            });
                        }
                    }
                }
            });
        }

        // Switch preview frame buttons
        const cycleBtn = document.getElementById('btn-cycle-preview-frame');
        const nextFrameBtn = document.getElementById('btn-next-preview-frame');
        const switchFrameToNext = () => {
            if (state.wmFiles.length <= 1) return;
            const nextIdx = ((state.wmPreviewVideoIndex || 0) + 1) % state.wmFiles.length;
            setPreviewFrameByIndex(nextIdx);
        };
        if (cycleBtn) cycleBtn.addEventListener('click', switchFrameToNext);
        if (nextFrameBtn) nextFrameBtn.addEventListener('click', switchFrameToNext);

        document.querySelectorAll('.btn-set-preview-frame').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const idx = parseInt(btn.getAttribute('data-index'), 10);
                if (!isNaN(idx) && state.wmFiles[idx]) {
                    setPreviewFrameByIndex(idx);
                }
            });
        });

        document.querySelectorAll('.btn-remove-wm-file').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const idx = parseInt(btn.getAttribute('data-index'), 10);
                if (!isNaN(idx)) {
                    state.wmFiles.splice(idx, 1);
                    if (state.wmFiles.length === 0) {
                        state.wmFirstVideoThumb = null;
                        state.wmPreviewVideoIndex = 0;
                    } else if (state.wmPreviewVideoIndex >= state.wmFiles.length) {
                        state.wmPreviewVideoIndex = 0;
                        state.wmFirstVideoThumb = state.wmFiles[0]._thumbUrl || null;
                        state.wmFirstVideoAspect = state.wmFiles[0]._aspect || '9/16';
                    }
                    render();
                }
            });
        });

        document.querySelectorAll('.btn-preview-item-wm').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const idx = parseInt(btn.getAttribute('data-index'), 10);
                if (!isNaN(idx) && state.wmFiles[idx]) {
                    const file = state.wmFiles[idx];
                    openPreviewModal(file, `Part #${idx + 1}: ${file.name}`);
                }
            });
        });

        // 4-Way Arrow Controls (Nudges exact % position)
        const btnUp = document.getElementById('btn-dpad-up');
        const btnDown = document.getElementById('btn-dpad-down');
        const btnLeft = document.getElementById('btn-dpad-left');
        const btnRight = document.getElementById('btn-dpad-right');
        const btnCenter = document.getElementById('btn-dpad-center');

        if (btnUp) {
            btnUp.addEventListener('click', () => {
                state.wmNormYPct = Math.max(0.5, state.wmNormYPct - 1.5);
                updateLiveCanvasOverlay();
            });
        }

        if (btnDown) {
            btnDown.addEventListener('click', () => {
                state.wmNormYPct = Math.min(96.0, state.wmNormYPct + 1.5);
                updateLiveCanvasOverlay();
            });
        }

        if (btnLeft) {
            btnLeft.addEventListener('click', () => {
                state.wmNormXPct = Math.max(0.5, state.wmNormXPct - 1.5);
                updateLiveCanvasOverlay();
            });
        }

        if (btnRight) {
            btnRight.addEventListener('click', () => {
                state.wmNormXPct = Math.min(100 - state.wmScalePct - 0.5, state.wmNormXPct + 1.5);
                updateLiveCanvasOverlay();
            });
        }

        if (btnCenter) {
            btnCenter.addEventListener('click', () => {
                const def = getGridDefaultCoords(state.wmPosition, state.wmScalePct);
                state.wmNormXPct = def.x;
                state.wmNormYPct = def.y;
                updateLiveCanvasOverlay();
            });
        }

        // 9-Grid Position Buttons
        document.querySelectorAll('.m-grid-9 .m-grid-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                state.wmPosition = btn.getAttribute('data-pos');
                const def = getGridDefaultCoords(state.wmPosition, state.wmScalePct);
                state.wmNormXPct = def.x;
                state.wmNormYPct = def.y;
                render();
            });
        });

        // Size Slider (10% to 60%)
        const scaleSlider = document.getElementById('m-slider-wm-scale');
        const scaleVal = document.getElementById('m-val-wm-scale');
        if (scaleSlider && scaleVal) {
            scaleSlider.addEventListener('input', () => {
                state.wmScalePct = parseInt(scaleSlider.value, 10);
                scaleVal.textContent = state.wmScalePct + '%';
                // keep within right boundary if needed
                if (state.wmNormXPct + state.wmScalePct > 99) {
                    state.wmNormXPct = Math.max(1, 99 - state.wmScalePct);
                }
                updateLiveCanvasOverlay();
            });
        }

        // Opacity Slider
        const opacitySlider = document.getElementById('m-slider-wm-opacity');
        const opacityVal = document.getElementById('m-val-wm-opacity');
        if (opacitySlider && opacityVal) {
            opacitySlider.addEventListener('input', () => {
                state.wmOpacity = parseFloat(opacitySlider.value);
                opacityVal.textContent = Math.round(state.wmOpacity * 100) + '%';
                updateLiveCanvasOverlay();
            });
        }

        // Watermark Source Tabs
        const tabTpl = document.getElementById('tab-wm-templates');
        const tabTxt = document.getElementById('tab-wm-text');
        const tabUp = document.getElementById('tab-wm-upload');
        const tabSave = document.getElementById('tab-wm-saved');

        if (tabTpl) tabTpl.addEventListener('click', () => { state.wmSourceType = 'template'; render(); });
        if (tabTxt) tabTxt.addEventListener('click', () => { state.wmSourceType = 'text'; render(); });
        if (tabUp) tabUp.addEventListener('click', () => { state.wmSourceType = 'upload'; render(); });
        if (tabSave) tabSave.addEventListener('click', () => { state.wmSourceType = 'saved'; render(); });

        document.querySelectorAll('.m-template-card').forEach(card => {
            card.addEventListener('click', () => {
                state.wmTemplateId = card.getAttribute('data-tpl-id');
                render();
            });
        });

        const customTextInput = document.getElementById('m-input-custom-text');
        if (customTextInput) {
            customTextInput.addEventListener('input', (e) => {
                state.wmCustomText = e.target.value;
                updateLiveCanvasOverlay();
            });
        }

        const btnBadgeSolid = document.getElementById('btn-text-badge-solid');
        const btnBadgeTrans = document.getElementById('btn-text-badge-trans');
        if (btnBadgeSolid) btnBadgeSolid.addEventListener('click', () => { state.wmTextBadge = true; render(); });
        if (btnBadgeTrans) btnBadgeTrans.addEventListener('click', () => { state.wmTextBadge = false; render(); });

        const logoDropzone = document.getElementById('m-dropzone-logo-upload');
        const logoInput = document.getElementById('m-input-logo-file');
        if (logoDropzone && logoInput) {
            logoDropzone.addEventListener('click', () => logoInput.click());
            logoInput.addEventListener('change', (e) => {
                if (e.target.files && e.target.files[0]) {
                    const file = e.target.files[0];
                    state.wmUploadedFile = file;
                    const reader = new FileReader();
                    reader.onload = (re) => {
                        state.wmUploadedDataUrl = re.target.result;
                        const savedId = saveWatermarkToStorage(file.name, state.wmUploadedDataUrl);
                        state.wmSelectedSavedId = savedId;
                        render();
                    };
                    reader.readAsDataURL(file);
                }
            });
        }

        document.querySelectorAll('.m-saved-wm-card').forEach(card => {
            card.addEventListener('click', () => {
                state.wmSelectedSavedId = card.getAttribute('data-saved-id');
                render();
            });
        });

        document.querySelectorAll('.btn-delete-saved-wm').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const id = btn.getAttribute('data-delete-id');
                deleteSavedWatermark(id);
                render();
            });
        });

        // Process Action
        const processBtn = document.getElementById('btn-process-wm-action');
        if (processBtn) processBtn.addEventListener('click', startWatermarkProcessing);

        // Download ZIP Action
        const zipBtn = document.getElementById('btn-download-wm-zip');
        if (zipBtn) {
            zipBtn.addEventListener('click', () => {
                const url = zipBtn.getAttribute('data-zip-url');
                if (url) {
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = 'watermarked_videos_batch.zip';
                    document.body.appendChild(a);
                    a.click();
                    setTimeout(() => document.body.removeChild(a), 5000);
                }
            });
        }

        document.querySelectorAll('.m-btn-download-single-wm').forEach(btn => {
            btn.addEventListener('click', () => {
                const url = btn.getAttribute('data-dl-url') + '&download=1';
                const name = btn.getAttribute('data-dl-name') || 'watermarked_video.mp4';
                const a = document.createElement('a');
                a.href = url;
                a.download = name;
                document.body.appendChild(a);
                a.click();
                setTimeout(() => document.body.removeChild(a), 5000);
            });
        });

        const anotherBtn = document.getElementById('btn-wm-process-another');
        if (anotherBtn) {
            anotherBtn.addEventListener('click', () => {
                state.wmFiles = [];
                state.wmFirstVideoThumb = null;
                state.wmPreviewVideoIndex = 0;
                state.result = null;
                state.errorMessage = null;
                render();
            });
        }
    }

    async function setPreviewFrameByIndex(idx) {
        if (!state.wmFiles[idx]) return;
        state.wmPreviewVideoIndex = idx;
        const file = state.wmFiles[idx];
        if (file._thumbUrl) {
            state.wmFirstVideoThumb = file._thumbUrl;
            state.wmFirstVideoAspect = file._aspect || '9/16';
            updateLiveCanvasBg();
            render();
        } else {
            const cap = await captureVideoThumbnail(file);
            if (cap && cap.thumbUrl) {
                file._thumbUrl = cap.thumbUrl;
                file._aspect = cap.aspect;
                state.wmFirstVideoThumb = cap.thumbUrl;
                state.wmFirstVideoAspect = cap.aspect;
                updateLiveCanvasBg();
            }
            render();
        }
    }

    function updateLiveCanvasBg() {
        const container = document.getElementById('m-live-canvas-container');
        if (!container) return;

        if (state.wmFirstVideoAspect === '16/9') {
            container.classList.add('is-landscape');
        } else {
            container.classList.remove('is-landscape');
        }

        let bgImg = container.querySelector('.m-canvas-bg-img');
        const placeholder = container.querySelector('.m-canvas-placeholder');

        if (state.wmFirstVideoThumb) {
            if (placeholder) placeholder.remove();
            if (!bgImg) {
                bgImg = document.createElement('img');
                bgImg.className = 'm-canvas-bg-img';
                bgImg.alt = 'Video Frame Preview';
                container.prepend(bgImg);
            }
            bgImg.src = state.wmFirstVideoThumb;
        }

        const previewLabel = document.getElementById('m-wm-current-preview-name');
        if (previewLabel && state.wmFiles.length > 0) {
            const curIdx = state.wmPreviewVideoIndex || 0;
            const curFile = state.wmFiles[curIdx] || state.wmFiles[0];
            previewLabel.innerHTML = `🎬 Previewing Frame: <strong>${escapeHTML(curFile.name)}</strong> (${state.wmFirstVideoAspect || '9/16'})`;
        }
    }

    function updateLiveCanvasOverlay() {
        const overlay = document.getElementById('m-live-watermark-overlay');
        if (!overlay) return;

        let activeWatermarkDataUrl = '';
        if (state.wmSourceType === 'template') {
            activeWatermarkDataUrl = generateTemplateDataUrl(state.wmTemplateId);
        } else if (state.wmSourceType === 'text') {
            activeWatermarkDataUrl = generateCustomTextDataUrl(state.wmCustomText, state.wmTextBadge);
        } else if (state.wmSourceType === 'upload' && state.wmUploadedDataUrl) {
            activeWatermarkDataUrl = state.wmUploadedDataUrl;
        } else if (state.wmSourceType === 'saved') {
            const savedList = getSavedWatermarks();
            const found = savedList.find(w => w.id === state.wmSelectedSavedId) || savedList[0];
            if (found) activeWatermarkDataUrl = found.dataUrl;
        }

        if (!activeWatermarkDataUrl) activeWatermarkDataUrl = generateTemplateDataUrl('subscribe_badge');

        const img = overlay.querySelector('img');
        if (img) img.src = activeWatermarkDataUrl;

        overlay.style.left = state.wmNormXPct.toFixed(1) + '%';
        overlay.style.top = state.wmNormYPct.toFixed(1) + '%';
        overlay.style.width = state.wmScalePct + '%';
        overlay.style.opacity = state.wmOpacity;

        const dpadBadge = document.getElementById('m-val-dpad-offset');
        if (dpadBadge) {
            dpadBadge.textContent = `X: ${state.wmNormXPct.toFixed(1)}% | Y: ${state.wmNormYPct.toFixed(1)}%`;
        }
    }

    // ── Bulk Watermark Processing Execution ─────────────────────
    async function startWatermarkProcessing() {
        if (state.wmFiles.length === 0) return;

        state.isProcessing = true;
        state.errorMessage = null;
        state.result = null;
        state.overallPercent = 0;
        state.processingStage = 'Starting batch session...';
        render();

        try {
            const jobId = 'wm_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
            const total = state.wmFiles.length;

            let activeWatermarkDataUrl = '';
            if (state.wmSourceType === 'template') {
                activeWatermarkDataUrl = generateTemplateDataUrl(state.wmTemplateId);
            } else if (state.wmSourceType === 'text') {
                activeWatermarkDataUrl = generateCustomTextDataUrl(state.wmCustomText, state.wmTextBadge);
            } else if (state.wmSourceType === 'upload' && state.wmUploadedDataUrl) {
                activeWatermarkDataUrl = state.wmUploadedDataUrl;
            } else if (state.wmSourceType === 'saved') {
                const savedList = getSavedWatermarks();
                const found = savedList.find(w => w.id === state.wmSelectedSavedId) || savedList[0];
                if (found) activeWatermarkDataUrl = found.dataUrl;
            }

            if (!activeWatermarkDataUrl) activeWatermarkDataUrl = generateTemplateDataUrl('subscribe_badge');

            const uploadedVideosMeta = [];
            let completedWmBytes = 0;
            const uploadStartTime = Date.now();
            const totalWmSize = state.wmFiles.reduce((sum, f) => sum + f.size, 0);

            // Sequential video upload to avoid socket exhaustion, proxy resets, and Cloud Run connection drops
            for (let idx = 0; idx < total; idx++) {
                const file = state.wmFiles[idx];
                const bytesBefore = completedWmBytes;

                const meta = await uploadWatermarkPartWithRetry(file, jobId, idx, total, 'video', (loaded, partTotal) => {
                    const currentLoaded = bytesBefore + loaded;
                    const overallFraction = totalWmSize > 0 ? (currentLoaded / totalWmSize) : 0;
                    const overallPct = Math.min(80, Math.round(overallFraction * 80));

                    const elapsedSec = (Date.now() - uploadStartTime) / 1000;
                    const speedBps = elapsedSec > 0.2 ? (currentLoaded / elapsedSec) : 0;
                    const speedText = speedBps > 1024 * 1024 
                        ? (speedBps / (1024 * 1024)).toFixed(1) + ' MB/s' 
                        : (speedBps / 1024).toFixed(0) + ' KB/s';

                    const partPct = partTotal > 0 ? Math.round((loaded / partTotal) * 100) : 0;
                    updateWatermarkProgressDOM(
                        `⚡ Uploading Video ${idx + 1}/${total} (${partPct}% · ${formatBytes(currentLoaded)} / ${formatBytes(totalWmSize)} · ${speedText})...`,
                        overallPct
                    );
                });

                uploadedVideosMeta.push(meta);
                completedWmBytes = bytesBefore + file.size;
            }

            updateWatermarkProgressDOM('Cloud FFmpeg: Applying watermark to all videos & building .ZIP...', 85);

            let processResp = null;
            for (let pAttempt = 1; pAttempt <= 2; pAttempt++) {
                try {
                    processResp = await fetch('/api/watermark/process', {
                        method: 'POST',
                        credentials: 'include',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            jobId: jobId,
                            position: state.wmPosition,
                            normXPct: state.wmNormXPct,
                            normYPct: state.wmNormYPct,
                            normWPct: state.wmScalePct,
                            scalePct: state.wmScalePct,
                            opacity: state.wmOpacity,
                            videos: uploadedVideosMeta,
                            watermarkBase64: activeWatermarkDataUrl
                        })
                    });
                    if (processResp.ok) break;
                } catch (netErr) {
                    if (pAttempt === 1) {
                        await syncSessionCookie();
                        await new Promise(r => setTimeout(r, 1000));
                    } else {
                        throw netErr;
                    }
                }
            }

            if (!processResp) throw new Error('सर्वर से कनेक्ट नहीं हो सका।');
            const raw = await processResp.text();
            let data;
            try {
                data = JSON.parse(raw);
            } catch (e) {
                const match = raw.match(/<title>([^<]*)<\/title>/i);
                throw new Error(match ? match[1].trim() : 'सर्वर का रिस्पॉन्स पढ़ने में त्रुटि।');
            }

            if (!processResp.ok || !data.success) {
                throw new Error(data.error || 'Watermark batch processing failed');
            }

            updateWatermarkProgressDOM('Done! All videos watermarked.', 100);
            state.result = data;
            state.isProcessing = false;

            addProjectHistory({
                type: 'watermark',
                title: `Bulk Watermark (${data.processed} Videos)`,
                itemCount: data.processed,
                zipUrl: data.zip_download_url,
                zipSize: data.zip_size,
                results: data.results
            });

            render();

        } catch (err) {
            console.error('Watermark processing error:', err);
            state.isProcessing = false;
            state.errorMessage = err.message || 'Processing failed.';
            render();
        }
    }

    function updateWatermarkProgressDOM(stage, pct) {
        state.processingStage = stage;
        state.overallPercent = pct;
        const stageEl = document.getElementById('m-wm-progress-stage');
        const pctEl = document.getElementById('m-wm-progress-pct');
        const fillEl = document.getElementById('m-wm-progress-fill');
        if (stageEl) stageEl.textContent = stage;
        if (pctEl) pctEl.textContent = pct + '%';
        if (fillEl) fillEl.style.width = pct + '%';
    }

    async function syncSessionCookie() {
        try {
            await fetch('/health', { credentials: 'include', cache: 'no-store' });
        } catch (e) {}
    }

    function uploadWatermarkPartPromise(file, jobId, partIndex, totalParts, fileType, onProgress) {
        return new Promise((resolve, reject) => {
            const formData = new FormData();
            formData.append('file', file, file.name);
            formData.append('jobId', jobId);
            formData.append('partIndex', String(partIndex));
            formData.append('fileName', file.name);
            formData.append('fileType', fileType || 'video');

            const xhr = new XMLHttpRequest();
            xhr.open('POST', '/api/watermark/upload-file', true);
            xhr.withCredentials = true;
            xhr.timeout = 300000;

            xhr.upload.onprogress = (e) => {
                if (e.lengthComputable && e.total > 0 && typeof onProgress === 'function') {
                    onProgress(e.loaded, e.total);
                }
            };

            xhr.onload = () => {
                const raw = (xhr.responseText || '').trim();
                let res = null;
                try {
                    res = JSON.parse(raw);
                } catch (e) {
                    const match = raw.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i) || raw.match(/<title>([^<]*)<\/title>/i);
                    const serverMsg = match ? match[1].replace(/<[^>]+>/g, '').trim() : (raw ? raw.slice(0, 100) : `HTTP ${xhr.status}`);
                    return reject(new Error(serverMsg || `Upload error on video ${partIndex + 1}`));
                }

                if (xhr.status >= 200 && xhr.status < 300) {
                    if (res && res.success) resolve(res);
                    else reject(new Error((res && res.error) || `Video ${partIndex + 1} upload failed`));
                } else {
                    reject(new Error((res && res.error) || `Server error ${xhr.status} uploading video ${partIndex + 1}`));
                }
            };

            xhr.ontimeout = () => reject(new Error(`वीडियो ${partIndex + 1} अपलोड समय समाप्त (Timeout)`));
            xhr.onerror = () => reject(new Error(`वीडियो ${partIndex + 1} अपलोड करते समय नेटवर्क एरर।`));
            xhr.send(formData);
        });
    }

    async function uploadWatermarkPartWithRetry(file, jobId, partIndex, totalParts, fileType, onProgress, maxRetries = 3) {
        let lastErr = null;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                return await uploadWatermarkPartPromise(file, jobId, partIndex, totalParts, fileType, onProgress);
            } catch (err) {
                lastErr = err;
                console.warn(`Video ${partIndex + 1} upload attempt ${attempt} failed:`, err.message);
                if (attempt < maxRetries) {
                    const isCookieOrAuth = err.message && (err.message.includes('Cookie check') || err.message.includes('Session') || err.message.includes('403'));
                    if (isCookieOrAuth) {
                        await syncSessionCookie();
                    }
                    updateWatermarkProgressDOM(`Retrying Video ${partIndex + 1} (Attempt ${attempt + 1}/${maxRetries})...`, state.overallPercent);
                    await new Promise(r => setTimeout(r, 1200 * attempt));
                }
            }
        }
        throw lastErr || new Error(`Failed to upload video ${partIndex + 1} after ${maxRetries} attempts`);
    }

    // ── 3. PROJECT HISTORY SCREEN ───────────────────────────────
    function renderHistoryScreen() {
        const historyList = getProjectHistory();

        rootEl.innerHTML = `
            <div class="m-app-shell">
                <header class="m-tool-header">
                    <button type="button" class="m-back-btn" id="btn-back-history">
                        ${icons.back}
                    </button>
                    <div class="m-tool-header__title">Project History (${historyList.length})</div>
                    <div class="m-tool-header__action">
                        ${historyList.length > 0 ? `
                            <button type="button" class="m-clear-btn" id="btn-clear-all-history">Clear All</button>
                        ` : ''}
                    </div>
                </header>

                <main class="m-tool-main">
                    ${historyList.length === 0 ? `
                        <div style="text-align:center; padding:40px 16px; color:var(--text-muted);">
                            <div style="margin-bottom:10px;">${icons.history}</div>
                            <div style="font-size:14px; font-weight:600; color:var(--text-primary);">No Past Projects Yet</div>
                            <div style="font-size:12px; margin-top:4px;">When you process videos with Watermark or Jump-Cut, your projects will appear here for fast re-download!</div>
                        </div>
                    ` : `
                        <div>
                            ${historyList.map(item => {
                                const dateStr = new Date(item.timestamp).toLocaleString();
                                return `
                                    <div class="m-history-item">
                                        <div class="m-history-header">
                                            <span class="m-history-title">${escapeHTML(item.title || 'Project Batch')}</span>
                                            <span class="m-history-date">${dateStr}</span>
                                        </div>
                                        <div class="m-history-details">
                                            <span>${item.itemCount || 1} Videos Processed</span>
                                            ${item.zipSize ? `<span>· ${formatBytes(item.zipSize)} ZIP</span>` : ''}
                                        </div>
                                        <div class="m-history-actions">
                                            ${item.zipUrl ? `
                                                <button type="button" class="m-btn-history-dl btn-dl-history-zip" data-zip="${item.zipUrl}">
                                                    ${icons.download}
                                                    <span>Download .ZIP</span>
                                                </button>
                                            ` : ''}
                                            <button type="button" class="m-btn-history-del btn-del-history-item" data-id="${item.id}">
                                                ${icons.trash}
                                            </button>
                                        </div>
                                    </div>
                                `;
                            }).join('')}
                        </div>
                    `}
                </main>
            </div>
        `;

        document.getElementById('btn-back-history').addEventListener('click', () => {
            state.currentTool = null;
            render();
        });

        const clearBtn = document.getElementById('btn-clear-all-history');
        if (clearBtn) {
            clearBtn.addEventListener('click', () => {
                if (confirm('Are you sure you want to clear all project history?')) {
                    clearAllHistory();
                    render();
                }
            });
        }

        document.querySelectorAll('.btn-dl-history-zip').forEach(btn => {
            btn.addEventListener('click', () => {
                const url = btn.getAttribute('data-zip');
                if (url) {
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = 'watermarked_project.zip';
                    document.body.appendChild(a);
                    a.click();
                    setTimeout(() => document.body.removeChild(a), 5000);
                }
            });
        });

        document.querySelectorAll('.btn-del-history-item').forEach(btn => {
            btn.addEventListener('click', () => {
                const id = btn.getAttribute('data-id');
                deleteProjectHistory(id);
                render();
            });
        });
    }

    // ── 3. MERGE AUDIO STUDIO & WAVEFORM TIMELINE ───────────────
    let audioMergeCtx = null;
    let audioMergeSourceNodes = [];
    let audioMergePlayStartTime = 0;
    let audioMergeOffsetTime = 0;
    let audioMergeAnimFrame = null;

    function getAudioContext() {
        if (!audioMergeCtx) {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            if (AudioCtx) audioMergeCtx = new AudioCtx();
        }
        if (audioMergeCtx && audioMergeCtx.state === 'suspended') {
            audioMergeCtx.resume();
        }
        return audioMergeCtx;
    }

    function getAudioDurationFast(file) {
        return new Promise((resolve) => {
            if (file._duration && file._duration > 0) return resolve(file._duration);
            try {
                const audio = document.createElement('audio');
                audio.preload = 'metadata';
                const url = URL.createObjectURL(file);
                audio.src = url;
                let resolved = false;
                const cleanup = () => {
                    if (!resolved) {
                        resolved = true;
                        try { URL.revokeObjectURL(url); } catch (e) {}
                        audio.removeAttribute('src');
                    }
                };
                audio.onloadedmetadata = () => {
                    const dur = audio.duration;
                    cleanup();
                    if (dur && !isNaN(dur) && dur !== Infinity && dur > 0) {
                        file._duration = dur;
                        return resolve(dur);
                    }
                    const est = Math.max(1, Math.round(file.size / (16 * 1024)));
                    file._duration = est;
                    resolve(est);
                };
                audio.onerror = () => {
                    cleanup();
                    const est = Math.max(1, Math.round(file.size / (16 * 1024)));
                    file._duration = est;
                    resolve(est);
                };
                setTimeout(() => {
                    if (!resolved) {
                        cleanup();
                        const est = Math.max(1, Math.round(file.size / (16 * 1024)));
                        file._duration = file._duration || est;
                        resolve(file._duration);
                    }
                }, 1000);
            } catch (e) {
                const est = Math.max(1, Math.round(file.size / (16 * 1024)));
                file._duration = est;
                resolve(est);
            }
        });
    }

    async function decodeAudioFile(file) {
        if (file._audioBuffer) return file._audioBuffer;
        try {
            const ctx = getAudioContext();
            if (!ctx) return null;
            if (ctx.state === 'suspended') {
                try { await ctx.resume(); } catch (e) {}
            }
            const arrayBuf = await file.arrayBuffer();
            const decoded = await new Promise((resolve, reject) => {
                let settled = false;
                try {
                    const res = ctx.decodeAudioData(
                        arrayBuf,
                        (buf) => { if (!settled) { settled = true; resolve(buf); } },
                        (err) => { if (!settled) { settled = true; reject(err); } }
                    );
                    if (res && typeof res.then === 'function') {
                        res.then(b => { if (!settled) { settled = true; resolve(b); } })
                           .catch(err => { if (!settled) { settled = true; reject(err); } });
                    }
                } catch (err) {
                    if (!settled) { settled = true; reject(err); }
                }
            });
            file._audioBuffer = decoded;
            if (decoded && decoded.duration > 0) file._duration = decoded.duration;
            return decoded;
        } catch (e) {
            console.warn("Audio decode error for", file.name, e);
            return null;
        }
    }

    function calculateAudioMergeJoints() {
        const files = state.audioMergeFiles || [];
        const joints = [];
        let cum = 0;
        for (let i = 0; i < files.length; i++) {
            const f = files[i];
            const dur = f._duration || (f._audioBuffer ? f._audioBuffer.duration : 0);
            if (i < files.length - 1 && dur > 0) {
                cum += dur;
                joints.push({
                    index: i + 1,
                    time: cum,
                    fromPart: i + 1,
                    toPart: i + 2,
                    fromName: f.name,
                    toName: files[i + 1].name
                });
            } else if (i === files.length - 1) {
                cum += dur;
            }
        }
        state.audioMergeTotalDuration = cum;
        state.audioMergeJoints = joints;
        return joints;
    }

    function drawAudioMergeWaveform() {
        const canvas = document.getElementById('m-audiomerge-waveform-canvas');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const width = canvas.clientWidth || 340;
        const height = canvas.clientHeight || 120;
        canvas.width = width * (window.devicePixelRatio || 2);
        canvas.height = height * (window.devicePixelRatio || 2);
        ctx.scale(window.devicePixelRatio || 2, window.devicePixelRatio || 2);

        ctx.fillStyle = '#030712';
        ctx.fillRect(0, 0, width, height);

        const files = state.audioMergeFiles || [];
        if (files.length === 0 || state.audioMergeTotalDuration <= 0) {
            ctx.fillStyle = '#475569';
            ctx.font = '12px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('Upload 2 or 3 audio parts to preview waveform & joints', width / 2, height / 2);
            return;
        }

        const totalDur = state.audioMergeTotalDuration;
        const partColors = [
            { bg: '#10b981', grad: '#06b6d4', tag: '#10b981' }, // Part 1 Emerald
            { bg: '#8b5cf6', grad: '#6366f1', tag: '#8b5cf6' }, // Part 2 Purple
            { bg: '#f59e0b', grad: '#f43f5e', tag: '#f59e0b' }, // Part 3 Amber
            { bg: '#ec4899', grad: '#d946ef', tag: '#ec4899' }, // Part 4 Pink
            { bg: '#3b82f6', grad: '#0284c7', tag: '#3b82f6' }  // Part 5 Blue
        ];

        let startPx = 0;
        let cumTime = 0;

        const midY = height / 2;
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, midY);
        ctx.lineTo(width, midY);
        ctx.stroke();

        files.forEach((f, idx) => {
            const dur = f._duration || 0;
            const partWidth = (dur / totalDur) * width;
            const endPx = startPx + partWidth;
            const colorScheme = partColors[idx % partColors.length];

            ctx.fillStyle = idx % 2 === 0 ? 'rgba(255, 255, 255, 0.02)' : 'rgba(255, 255, 255, 0.04)';
            ctx.fillRect(startPx, 0, partWidth, height);

            if (f._audioBuffer) {
                const channelData = f._audioBuffer.getChannelData(0);
                const step = Math.max(1, Math.floor(channelData.length / Math.max(10, partWidth * 1.5)));
                const barWidth = Math.max(1.5, (partWidth / (channelData.length / step)) * 0.8);

                ctx.fillStyle = colorScheme.bg;
                for (let i = 0; i < channelData.length; i += step) {
                    let min = 1.0;
                    let max = -1.0;
                    for (let j = 0; j < step; j++) {
                        const datum = channelData[i + j];
                        if (datum < min) min = datum;
                        if (datum > max) max = datum;
                    }
                    const x = startPx + (i / channelData.length) * partWidth;
                    const h = Math.max(2, (max - min) * (height * 0.42));
                    ctx.fillRect(x, midY - h / 2, barWidth, h);
                }
            } else {
                ctx.fillStyle = colorScheme.bg;
                for (let x = startPx; x < endPx; x += 3) {
                    const waveH = Math.sin((x + idx * 20) * 0.1) * (height * 0.25) + (height * 0.15);
                    ctx.fillRect(x, midY - waveH / 2, 2, waveH);
                }
            }

            ctx.fillStyle = colorScheme.tag;
            ctx.font = 'bold 10px sans-serif';
            ctx.textAlign = 'left';
            ctx.fillText(`Part ${idx + 1}`, startPx + 6, 14);

            cumTime += dur;
            startPx = endPx;
        });

        (state.audioMergeJoints || []).forEach(j => {
            const jx = (j.time / totalDur) * width;

            ctx.strokeStyle = '#f43f5e';
            ctx.lineWidth = 2;
            ctx.setLineDash([4, 3]);
            ctx.beginPath();
            ctx.moveTo(jx, 0);
            ctx.lineTo(jx, height);
            ctx.stroke();
            ctx.setLineDash([]);

            ctx.fillStyle = '#f43f5e';
            ctx.beginPath();
            if (ctx.roundRect) {
                ctx.roundRect(jx - 24, height - 20, 48, 16, 4);
            } else {
                ctx.rect(jx - 24, height - 20, 48, 16);
            }
            ctx.fill();

            ctx.fillStyle = '#ffffff';
            ctx.font = 'bold 9px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(`🔗 J${j.index}`, jx, height - 8);
        });
    }

    let currentPlaybackSessionId = 0;

    function stopAllAudioPlayback() {
        currentPlaybackSessionId++;
        stopSinglePartPlayback();
        stopAudioMergePlayback();
        stopAudioMergeResultPlayback();
        try {
            document.querySelectorAll('audio, video').forEach(el => {
                if (!el.paused) el.pause();
            });
        } catch (e) {}
    }

    let multiPartAudioEl = null;

    function stopAudioMergePlayback() {
        if (audioMergeSourceNodes.length > 0) {
            audioMergeSourceNodes.forEach(node => {
                try { node.stop(); node.disconnect(); } catch (e) {}
            });
            audioMergeSourceNodes = [];
        }
        if (multiPartAudioEl) {
            try {
                multiPartAudioEl.pause();
                multiPartAudioEl.currentTime = 0;
            } catch (e) {}
            multiPartAudioEl = null;
        }
        if (audioMergeAnimFrame) {
            cancelAnimationFrame(audioMergeAnimFrame);
            audioMergeAnimFrame = null;
        }
        state.audioMergeIsPlaying = false;
        updateAudioMergeTransportUI();
    }

    function playSequentialNativeAudio(startTime, totalDur, thisSession) {
        const files = state.audioMergeFiles || [];
        if (files.length === 0) return;

        let cum = 0;
        let targetIdx = 0;
        let offsetInPart = 0;

        for (let i = 0; i < files.length; i++) {
            const d = files[i]._duration || 1;
            if (startTime >= cum && startTime < cum + d) {
                targetIdx = i;
                offsetInPart = startTime - cum;
                break;
            }
            cum += d;
        }

        const startWallTime = Date.now();
        const baseTime = startTime;

        const playPart = (idx, offset) => {
            if (!state.audioMergeIsPlaying || thisSession !== currentPlaybackSessionId || idx >= files.length) {
                if (idx >= files.length) {
                    state.audioMergeCurrentTime = 0;
                    stopAudioMergePlayback();
                }
                return;
            }
            const f = files[idx];
            if (!f._blobUrl) f._blobUrl = URL.createObjectURL(f);
            const audio = new Audio(f._blobUrl);
            multiPartAudioEl = audio;
            try {
                audio.currentTime = Math.max(0, offset || 0);
            } catch (e) {}
            audio.onended = () => {
                playPart(idx + 1, 0);
            };
            audio.onerror = () => {
                playPart(idx + 1, 0);
            };
            const p = audio.play();
            if (p && p.catch) p.catch(() => {});
        };

        state.audioMergeIsPlaying = true;
        updateAudioMergeTransportUI();

        playPart(targetIdx, offsetInPart);

        const tick = () => {
            if (!state.audioMergeIsPlaying || thisSession !== currentPlaybackSessionId) return;
            const cur = baseTime + (Date.now() - startWallTime) / 1000;
            if (cur >= totalDur) {
                state.audioMergeCurrentTime = 0;
                stopAudioMergePlayback();
            } else {
                state.audioMergeCurrentTime = cur;
                updateAudioMergePlayheadPosition();
                audioMergeAnimFrame = requestAnimationFrame(tick);
            }
        };
        audioMergeAnimFrame = requestAnimationFrame(tick);
    }

    async function startAudioMergePlayback(fromTime) {
        const ctx = getAudioContext();
        if (ctx && ctx.state === 'suspended') {
            try { await ctx.resume(); } catch (e) {}
        }

        stopAudioMergePlayback();
        stopAudioMergeResultPlayback();
        stopSinglePartPlayback();

        const thisSession = ++currentPlaybackSessionId;

        const files = state.audioMergeFiles || [];
        if (files.length === 0 || state.audioMergeTotalDuration <= 0) return;

        const totalDur = state.audioMergeTotalDuration;
        const startTime = (typeof fromTime === 'number') ? Math.max(0, Math.min(fromTime, totalDur)) : state.audioMergeCurrentTime;

        // 1. Try decoding with WebAudio if not yet decoded
        for (let f of files) {
            if (!f._audioBuffer) {
                await decodeAudioFile(f);
                if (thisSession !== currentPlaybackSessionId) return;
            }
        }
        if (thisSession !== currentPlaybackSessionId) return;

        let cumTime = 0;
        audioMergeSourceNodes = [];
        const now = (ctx ? ctx.currentTime : 0) + 0.04;
        audioMergePlayStartTime = now;
        audioMergeOffsetTime = startTime;

        files.forEach((f) => {
            const buf = f._audioBuffer;
            const dur = f._duration || (buf ? buf.duration : 0);
            const partStart = cumTime;
            const partEnd = cumTime + dur;

            if (ctx && buf && startTime < partEnd) {
                try {
                    const src = ctx.createBufferSource();
                    src.buffer = buf;
                    src.connect(ctx.destination);

                    let offsetInBuf = 0;
                    let scheduleDelay = 0;

                    if (startTime >= partStart) {
                        offsetInBuf = startTime - partStart;
                        scheduleDelay = 0;
                    } else {
                        offsetInBuf = 0;
                        scheduleDelay = partStart - startTime;
                    }

                    src.start(now + scheduleDelay, offsetInBuf);
                    audioMergeSourceNodes.push(src);
                } catch (sErr) {}
            }
            cumTime += dur;
        });

        // 2. If WebAudio buffer sources could not be scheduled, use guaranteed HTML5 fallback
        if (audioMergeSourceNodes.length === 0) {
            playSequentialNativeAudio(startTime, totalDur, thisSession);
            return;
        }

        state.audioMergeIsPlaying = true;
        updateAudioMergeTransportUI();

        const tick = () => {
            if (!state.audioMergeIsPlaying || thisSession !== currentPlaybackSessionId) return;
            const elapsed = ctx.currentTime - audioMergePlayStartTime;
            const cur = audioMergeOffsetTime + elapsed;
            if (cur >= totalDur) {
                state.audioMergeCurrentTime = 0;
                stopAudioMergePlayback();
            } else {
                state.audioMergeCurrentTime = cur;
                updateAudioMergePlayheadPosition();
                audioMergeAnimFrame = requestAnimationFrame(tick);
            }
        };
        audioMergeAnimFrame = requestAnimationFrame(tick);
    }

    function updateAudioMergePlayheadPosition() {
        const playhead = document.getElementById('m-audiomerge-playhead');
        const curTimeEl = document.getElementById('m-audiomerge-time-cur');
        if (state.audioMergeTotalDuration > 0) {
            const pct = (state.audioMergeCurrentTime / state.audioMergeTotalDuration) * 100;
            if (playhead) playhead.style.left = `${pct.toFixed(2)}%`;
        }
        if (curTimeEl) {
            curTimeEl.textContent = formatDuration(state.audioMergeCurrentTime);
        }
    }

    function updateAudioMergeTransportUI() {
        const playBtn = document.getElementById('btn-audiomerge-toggle-play');
        if (playBtn) {
            playBtn.innerHTML = state.audioMergeIsPlaying
                ? `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`
                : icons.play;
        }
    }

    function drawAudioMergeResultWaveform() {
        const canvas = document.getElementById('m-am-result-waveform-canvas');
        if (!canvas || !state.audioMergeResult) return;
        const ctx = canvas.getContext('2d');
        const width = canvas.clientWidth || 340;
        const height = canvas.clientHeight || 110;
        canvas.width = width * (window.devicePixelRatio || 2);
        canvas.height = height * (window.devicePixelRatio || 2);
        ctx.scale(window.devicePixelRatio || 2, window.devicePixelRatio || 2);

        ctx.fillStyle = '#030712';
        ctx.fillRect(0, 0, width, height);

        const res = state.audioMergeResult;
        const totalDur = res.duration || state.audioMergeTotalDuration || 1;
        const partsList = (res.verified_parts && res.verified_parts.length > 0)
            ? res.verified_parts
            : state.audioMergeFiles.map((f, i) => ({
                index: i + 1,
                name: f.name,
                duration: f._duration || 0,
                startTime: 0,
                endTime: f._duration || 0
            }));

        const partColors = [
            { bg: '#10b981', grad: '#06b6d4', tag: '#10b981' },
            { bg: '#8b5cf6', grad: '#6366f1', tag: '#8b5cf6' },
            { bg: '#f59e0b', grad: '#f43f5e', tag: '#f59e0b' },
            { bg: '#ec4899', grad: '#d946ef', tag: '#ec4899' },
            { bg: '#3b82f6', grad: '#0284c7', tag: '#3b82f6' }
        ];

        const midY = height / 2;
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, midY);
        ctx.lineTo(width, midY);
        ctx.stroke();

        let cumT = 0;
        partsList.forEach((p, idx) => {
            const pDur = p.duration || 0;
            const startX = (cumT / totalDur) * width;
            const partW = (pDur / totalDur) * width;
            const endX = startX + partW;
            const colorScheme = partColors[idx % partColors.length];

            ctx.fillStyle = idx % 2 === 0 ? 'rgba(255, 255, 255, 0.02)' : 'rgba(255, 255, 255, 0.04)';
            ctx.fillRect(startX, 0, partW, height);

            if (state.audioMergeResultAudioBuffer) {
                const channelData = state.audioMergeResultAudioBuffer.getChannelData(0);
                const bufTotal = state.audioMergeResultAudioBuffer.duration || totalDur;
                const sampleStart = Math.floor((cumT / bufTotal) * channelData.length);
                const sampleEnd = Math.floor(((cumT + pDur) / bufTotal) * channelData.length);
                const segLen = Math.max(1, sampleEnd - sampleStart);
                const step = Math.max(1, Math.floor(segLen / Math.max(10, partW * 1.5)));
                const barWidth = Math.max(1.5, (partW / (segLen / step)) * 0.8);
                ctx.fillStyle = colorScheme.bg;
                for (let i = sampleStart; i < sampleEnd; i += step) {
                    let min = 1.0;
                    let max = -1.0;
                    for (let j = 0; j < step && (i + j) < sampleEnd; j++) {
                        const datum = channelData[i + j];
                        if (datum < min) min = datum;
                        if (datum > max) max = datum;
                    }
                    const x = startX + ((i - sampleStart) / segLen) * partW;
                    const h = Math.max(2, (max - min) * (height * 0.44));
                    ctx.fillRect(x, midY - h / 2, barWidth, h);
                }
            } else {
                const fileMatch = state.audioMergeFiles[idx];
                if (fileMatch && fileMatch._audioBuffer) {
                    const channelData = fileMatch._audioBuffer.getChannelData(0);
                    const step = Math.max(1, Math.floor(channelData.length / Math.max(10, partW * 1.5)));
                    const barWidth = Math.max(1.5, (partW / (channelData.length / step)) * 0.8);
                    ctx.fillStyle = colorScheme.bg;
                    for (let i = 0; i < channelData.length; i += step) {
                        let min = 1.0;
                        let max = -1.0;
                        for (let j = 0; j < step; j++) {
                            const datum = channelData[i + j];
                            if (datum < min) min = datum;
                            if (datum > max) max = datum;
                        }
                        const x = startX + (i / channelData.length) * partW;
                        const h = Math.max(2, (max - min) * (height * 0.44));
                        ctx.fillRect(x, midY - h / 2, barWidth, h);
                    }
                } else {
                    ctx.fillStyle = colorScheme.bg;
                    for (let x = startX; x < endX; x += 3) {
                        const waveH = Math.sin((x + idx * 25) * 0.12) * (height * 0.25) + (height * 0.15);
                        ctx.fillRect(x, midY - waveH / 2, 2, waveH);
                    }
                }
            }

            ctx.fillStyle = colorScheme.tag;
            ctx.font = 'bold 10px sans-serif';
            ctx.textAlign = 'left';
            ctx.fillText(`Part ${idx + 1}`, startX + 6, 14);

            cumT += pDur;
        });

        // Draw verified Joint points on result waveform
        let resCum = 0;
        for (let i = 0; i < partsList.length - 1; i++) {
            const p = partsList[i];
            const pDur = p.duration || 0;
            resCum = p.endTime != null ? p.endTime : (resCum + pDur);
            const jx = (resCum / totalDur) * width;

            ctx.strokeStyle = '#f43f5e';
            ctx.lineWidth = 2;
            ctx.setLineDash([4, 3]);
            ctx.beginPath();
            ctx.moveTo(jx, 0);
            ctx.lineTo(jx, height);
            ctx.stroke();
            ctx.setLineDash([]);

            ctx.fillStyle = '#f43f5e';
            ctx.beginPath();
            if (ctx.roundRect) {
                ctx.roundRect(jx - 24, height - 20, 48, 16, 4);
            } else {
                ctx.rect(jx - 24, height - 20, 48, 16);
            }
            ctx.fill();

            ctx.fillStyle = '#ffffff';
            ctx.font = 'bold 9px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(`🔗 J${i + 1}`, jx, height - 8);
        }
    }

    let singlePartAudioEl = null;
    let singlePartSourceNode = null;
    let singlePartPlayingIdx = -1;

    function stopSinglePartPlayback() {
        if (singlePartAudioEl) {
            try {
                singlePartAudioEl.pause();
                singlePartAudioEl.currentTime = 0;
            } catch (e) {}
            singlePartAudioEl = null;
        }
        if (singlePartSourceNode) {
            try { singlePartSourceNode.stop(); singlePartSourceNode.disconnect(); } catch (e) {}
            singlePartSourceNode = null;
        }
        singlePartPlayingIdx = -1;
        document.querySelectorAll('.btn-play-single-part').forEach(btn => {
            const idx = parseInt(btn.getAttribute('data-index'), 10);
            btn.classList.remove('is-playing');
            btn.innerHTML = `▶ Play Part ${idx + 1}`;
        });
    }

    async function playViaWebAudio(file, idx) {
        try {
            const ctx = getAudioContext();
            if (!ctx) return;
            if (ctx.state === 'suspended') {
                try { await ctx.resume(); } catch (e) {}
            }
            if (!file._audioBuffer) {
                await decodeAudioFile(file);
            }
            if (!file._audioBuffer || singlePartPlayingIdx !== idx) return;
            const src = ctx.createBufferSource();
            src.buffer = file._audioBuffer;
            src.connect(ctx.destination);
            src.onended = () => {
                if (singlePartPlayingIdx === idx) stopSinglePartPlayback();
            };
            singlePartSourceNode = src;
            src.start(0);
        } catch (e) {
            console.warn("WebAudio fallback play failed:", e);
            if (singlePartPlayingIdx === idx) stopSinglePartPlayback();
        }
    }

    async function playSinglePartAudio(idx) {
        if (singlePartPlayingIdx === idx) {
            stopSinglePartPlayback();
            return;
        }

        stopSinglePartPlayback();
        stopAudioMergePlayback();
        stopAudioMergeResultPlayback();

        const file = state.audioMergeFiles[idx];
        if (!file) return;

        singlePartPlayingIdx = idx;

        // Update button UI immediately
        document.querySelectorAll('.btn-play-single-part').forEach(btn => {
            const bIdx = parseInt(btn.getAttribute('data-index'), 10);
            if (bIdx === idx) {
                btn.classList.add('is-playing');
                btn.innerHTML = `⏹ Stop Part ${idx + 1}`;
            } else {
                btn.classList.remove('is-playing');
                btn.innerHTML = `▶ Play Part ${bIdx + 1}`;
            }
        });

        // 1. Guaranteed HTML5 Audio playback from Blob URL (Instant on Chrome/Android/Desktop)
        try {
            if (!file._blobUrl) {
                file._blobUrl = URL.createObjectURL(file);
            }
            const audio = new Audio(file._blobUrl);
            singlePartAudioEl = audio;

            audio.onended = () => {
                if (singlePartPlayingIdx === idx) stopSinglePartPlayback();
            };
            audio.onerror = async (err) => {
                console.warn("HTML5 audio playback error, attempting WebAudio fallback:", err);
                if (singlePartPlayingIdx === idx) {
                    await playViaWebAudio(file, idx);
                }
            };

            const p = audio.play();
            if (p && p.catch) {
                p.catch(async (playErr) => {
                    console.warn("Audio play() promise rejected, trying WebAudio:", playErr);
                    if (singlePartPlayingIdx === idx) {
                        await playViaWebAudio(file, idx);
                    }
                });
            }
        } catch (e) {
            await playViaWebAudio(file, idx);
        }
    }

    let audioMergeResultSourceNodes = [];
    let audioMergeResultAnimFrame = null;
    let audioMergeResultPlayStartTime = 0;
    let audioMergeResultOffsetTime = 0;

    function stopAudioMergeResultPlayback() {
        if (audioMergeResultAnimFrame) {
            cancelAnimationFrame(audioMergeResultAnimFrame);
            audioMergeResultAnimFrame = null;
        }
        state.audioMergeResultIsPlaying = false;
        updateAudioMergeResultTransportUI();

        const resPlayer = document.getElementById('m-result-audio-player');
        if (resPlayer && !resPlayer.paused) {
            try { resPlayer.pause(); } catch (e) {}
        }
    }

    function startAudioMergeResultPlayback(fromTime) {
        stopSinglePartPlayback();
        stopAudioMergePlayback();

        const thisSession = ++currentPlaybackSessionId;

        const resPlayer = document.getElementById('m-result-audio-player');
        if (!resPlayer) return;

        // Ensure no other media elements in DOM are playing
        try {
            document.querySelectorAll('audio, video').forEach(el => {
                if (el !== resPlayer && !el.paused) {
                    el.pause();
                }
            });
        } catch (e) {}

        const totalDur = (resPlayer.duration && !isNaN(resPlayer.duration))
            ? resPlayer.duration
            : ((state.audioMergeResult && state.audioMergeResult.duration) || state.audioMergeTotalDuration || 1);
        const startTime = (typeof fromTime === 'number') ? Math.max(0, Math.min(fromTime, totalDur)) : (state.audioMergeResultCurrentTime || 0);

        const doPlay = () => {
            try {
                if (typeof startTime === 'number' && !isNaN(startTime)) {
                    resPlayer.currentTime = startTime;
                }
            } catch (cErr) {}
            try {
                if (resPlayer.paused) {
                    const p = resPlayer.play();
                    if (p && p.catch) p.catch(() => {});
                }
            } catch (pErr) {}
        };

        if (resPlayer.readyState >= 1) {
            doPlay();
        } else {
            resPlayer.addEventListener('loadedmetadata', doPlay, { once: true });
            resPlayer.load();
        }

        state.audioMergeResultIsPlaying = true;
        updateAudioMergeResultTransportUI();

        const tick = () => {
            if (!state.audioMergeResultIsPlaying || !resPlayer || thisSession !== currentPlaybackSessionId) return;
            const cur = resPlayer.currentTime || 0;
            state.audioMergeResultCurrentTime = cur;
            updateAudioMergeResultPlayheadPosition();
            if (resPlayer.paused) {
                state.audioMergeResultIsPlaying = false;
                updateAudioMergeResultTransportUI();
            } else {
                audioMergeResultAnimFrame = requestAnimationFrame(tick);
            }
        };
        if (audioMergeResultAnimFrame) cancelAnimationFrame(audioMergeResultAnimFrame);
        audioMergeResultAnimFrame = requestAnimationFrame(tick);
    }

    function updateAudioMergeResultPlayheadPosition() {
        const playhead = document.getElementById('m-am-result-playhead');
        const curTimeEl = document.getElementById('m-am-res-time-cur');
        const resPlayer = document.getElementById('m-result-audio-player');
        const totalDur = (resPlayer && resPlayer.duration && !isNaN(resPlayer.duration))
            ? resPlayer.duration
            : ((state.audioMergeResult && state.audioMergeResult.duration) || state.audioMergeTotalDuration || 1);
        const curTime = (resPlayer && !isNaN(resPlayer.currentTime)) ? resPlayer.currentTime : (state.audioMergeResultCurrentTime || 0);
        if (totalDur > 0) {
            const pct = Math.min(100, Math.max(0, (curTime / totalDur) * 100));
            if (playhead) playhead.style.left = `${pct.toFixed(2)}%`;
        }
        if (curTimeEl) {
            curTimeEl.textContent = formatDuration(curTime);
        }
    }

    function updateAudioMergeResultTransportUI() {
        const playBtn = document.getElementById('btn-am-res-toggle-play');
        if (playBtn) {
            playBtn.innerHTML = state.audioMergeResultIsPlaying
                ? `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`
                : icons.play;
        }
    }

    function renderAudioMergeScreen() {
        const fileAccept = '.mp3,.wav,.m4a,.aac,.flac,.ogg,.wma,.opus,audio/*';
        const count = state.audioMergeFiles.length;
        const totalSize = state.audioMergeFiles.reduce((acc, f) => acc + f.size, 0);

        calculateAudioMergeJoints();

        rootEl.innerHTML = `
            <div class="m-app-shell">
                <header class="m-tool-header">
                    <button type="button" class="m-back-btn" id="m-btn-back-am" aria-label="Back to home">
                        ${icons.back}
                    </button>
                    <div class="m-tool-header__title">Merge Audio (ऑडियो मर्जर)</div>
                    <div class="m-tool-header__action">
                        ${count > 0 && !state.audioMergeIsProcessing ? `
                            <button type="button" class="m-clear-btn" id="m-btn-reset-am">Clear</button>
                        ` : ''}
                    </div>
                </header>

                <main class="m-tool-main">
                    <!-- SECTION 1: Upload Audio Parts -->
                    <section class="m-card">
                        <div class="m-card__header">
                            <span class="m-card__title">1. Upload Audio Parts (${count} selected)</span>
                            <span class="m-card__hint">${icons.bolt} 2 to 3+ Parts</span>
                        </div>

                        ${count > 0 ? `
                            <div class="m-parts-list">
                                <div class="m-parts-header">
                                    <span>Audio Sequence (Part 1, 2, 3...)</span>
                                    <span>Total: ${formatBytes(totalSize)}</span>
                                </div>
                                ${state.audioMergeFiles.map((f, idx) => {
                                    const partNum = idx + 1;
                                    const colorClass = `m-part-color-${((partNum - 1) % 5) + 1}`;
                                    const durText = f._duration ? formatDuration(f._duration) : 'Loading...';
                                    return `
                                        <div class="m-part-item">
                                            <span class="m-part-index ${colorClass}">Part ${partNum}</span>
                                            <div class="m-part-details">
                                                <div class="m-part-name-row">
                                                    <span class="m-part-name">${escapeHTML(f.name)}</span>
                                                </div>
                                                <div class="m-part-meta-row">
                                                    <span class="m-part-size">${formatBytes(f.size)}</span>
                                                    <span>·</span>
                                                    <span style="color:#60a5fa; font-weight:600;">⏱️ ${durText}</span>
                                                </div>
                                            </div>
                                            <div style="display:flex; align-items:center; gap:6px;">
                                                <button type="button" class="m-btn-part-play btn-play-single-part" data-index="${idx}">
                                                    ▶ Play Part ${partNum}
                                                </button>
                                                ${idx > 0 ? `
                                                    <button type="button" class="m-part-move-btn btn-move-am-up" data-index="${idx}" title="Move Up">⬆️</button>
                                                ` : ''}
                                                ${idx < count - 1 ? `
                                                    <button type="button" class="m-part-move-btn btn-move-am-down" data-index="${idx}" title="Move Down">⬇️</button>
                                                ` : ''}
                                                <button type="button" class="m-part-remove btn-remove-am-file" data-index="${idx}" title="Remove Part">
                                                    ${icons.close}
                                                </button>
                                            </div>
                                        </div>
                                    `;
                                }).join('')}
                            </div>
                        ` : ''}

                        <div class="m-dropzone" id="m-dropzone-am-audio">
                            <input type="file" id="m-input-am-audio" accept="${fileAccept}" multiple hidden />
                            <div class="m-dropzone__icon">${icons.plus}</div>
                            <div class="m-dropzone__text">${count === 0 ? 'Choose Audio Files (2 to 3+ Parts)' : 'Add More Audio Parts'}</div>
                            <div class="m-dropzone__sub">Upload MP3, WAV, M4A, AAC, OGG, FLAC</div>
                        </div>
                    </section>

                    <!-- CARD 1 (TOP): Multi-Part Preview & Timeline (अलग-अलग पार्ट्स का प्रीव्यू) -->
                    ${count >= 1 ? `
                        <section class="m-waveform-timeline-card m-preview-card-theme" style="margin-top:14px;">
                            <div class="m-card__header">
                                <div style="display:flex; flex-direction:column; gap:2px;">
                                    <span class="m-card__title" style="color:#c7d2fe;">🎧 1. Multi-Part Preview (अपलोड किए गए पार्ट्स का प्रीव्यू)</span>
                                    <span style="font-size:11px; color:#94a3b8;">मर्ज करने से पहले अलग-अलग पार्ट्स व ट्रांजिशन का प्रीव्यू</span>
                                </div>
                                <span class="m-badge-preview">🔹 PREVIEW ONLY</span>
                            </div>

                            <!-- Multi-Track Continuous Waveform Canvas -->
                            <div class="m-timeline-wrapper" id="m-audiomerge-timeline-wrap">
                                <canvas class="m-timeline-canvas" id="m-audiomerge-waveform-canvas"></canvas>
                                <div class="m-timeline-playhead" id="m-audiomerge-playhead" style="left:0%;"></div>
                                <div class="m-timeline-legend">
                                    ${state.audioMergeFiles.map((f, idx) => `
                                        <div class="m-legend-item">
                                            <span class="m-legend-dot m-part-color-${((idx) % 5) + 1}"></span>
                                            <span>Part ${idx + 1}: ${escapeHTML(f.name)} (${f._duration ? formatDuration(f._duration) : '...'})</span>
                                        </div>
                                    `).join('')}
                                </div>
                            </div>

                            <!-- Preview Audio Playback Transport Controls -->
                            <div class="m-audio-transport-bar">
                                <div style="display:flex; align-items:center; gap:10px;">
                                    <button type="button" class="m-transport-play-btn" id="btn-audiomerge-toggle-play" title="Play/Pause Multi-Part Preview">
                                        ${icons.play}
                                    </button>
                                    <div style="display:flex; flex-direction:column;">
                                        <span style="font-size:12px; font-weight:700; color:#e2e8f0;">प्रीव्यू प्लेयर (Preview All Parts)</span>
                                        <span style="font-size:10px; color:#94a3b8;">💡 वेवफॉर्म पर टैप करके किसी भी पार्ट पर जाएं</span>
                                    </div>
                                </div>
                                <div class="m-transport-time-display">
                                    <span class="m-time-current" id="m-audiomerge-time-cur">0:00.0</span>
                                    <span class="m-time-total" id="m-audiomerge-time-tot">Total: ${formatDuration(state.audioMergeTotalDuration || 0)}</span>
                                </div>
                            </div>

                            <!-- Visual Joint Points (जॉइंट मार्कर) -->
                            ${state.audioMergeJoints.length > 0 ? `
                                <div class="m-joint-markers-container">
                                    <div style="font-size:11px; font-weight:700; color:#c7d2fe; margin-bottom:4px;">
                                        🔗 Joint Points Preview (प्रीव्यू में जोड़ के स्थान):
                                    </div>
                                    ${state.audioMergeJoints.map(j => `
                                        <div class="m-joint-pill">
                                            <div class="m-joint-pill-title">
                                                <span>📍 Joint #${j.index}:</span>
                                                <span style="color:#fff;">Part ${j.fromPart} ➔ Part ${j.toPart}</span>
                                                <span style="color:#60a5fa;">@ ${formatDuration(j.time)}</span>
                                            </div>
                                            <button type="button" class="m-joint-jump-btn btn-jump-to-joint" data-time="${j.time}">
                                                ⚡ Listen Transition
                                            </button>
                                        </div>
                                    `).join('')}
                                </div>
                            ` : ''}
                        </section>
                    ` : ''}

                    <!-- MERGE ACTION AREA -->
                    <div class="m-action-area" style="margin-top:14px;">
                        ${renderAudioMergeProcessButton(count)}
                        ${state.audioMergeIsProcessing ? renderAudioMergeProgressIndicator() : ''}
                        ${state.errorMessage ? `
                            <div class="m-error-banner">
                                <span>${escapeHTML(state.errorMessage)}</span>
                            </div>
                        ` : ''}
                    </div>

                    <!-- CARD 2 (BOTTOM): Results Area & Final Merged Output Audio -->
                    ${state.audioMergeResult ? renderAudioMergeResultHTML() : ''}
                </main>
            </div>
        `;

        setupAudioMergeEvents();
        setTimeout(drawAudioMergeWaveform, 50);
        if (state.audioMergeResult) {
            setTimeout(drawAudioMergeResultWaveform, 60);
        }
    }

    function renderAudioMergeProcessButton(count) {
        if (state.audioMergeIsProcessing) {
            return `
                <button type="button" class="m-btn-process is-busy" disabled>
                    <span class="m-spinner"></span>
                    <span>Merging ${count} Audio Parts (320kbps)...</span>
                </button>
            `;
        }

        const disabled = count < 2;
        return `
            <button type="button" class="m-btn-process" id="btn-start-audio-merge" ${disabled ? 'disabled' : ''}>
                <span>${icons.bolt}</span>
                <span>Merge & Export All ${count} Parts (MP3 320kbps)</span>
            </button>
        `;
    }

    function renderAudioMergeProgressIndicator() {
        return `
            <div class="m-progress-container">
                <div class="m-progress-status-row">
                    <span id="m-am-progress-stage">${escapeHTML(state.processingStage || 'Processing audio merge...')}</span>
                    <span class="m-progress-pct" id="m-am-progress-pct">${state.overallPercent}%</span>
                </div>
                <div class="m-progress-bar-track">
                    <div class="m-progress-bar-fill" id="m-am-progress-fill" style="width:${state.overallPercent}%;"></div>
                </div>
            </div>
        `;
    }

    function renderAudioMergeResultHTML() {
        const res = state.audioMergeResult;
        if (!res) return '';

        const baseDlUrl = res.download_url || '';
        const audioSrc = state.audioMergeResultBlobUrl || baseDlUrl;
        const totalParts = res.parts_count || state.audioMergeFiles.length || 1;
        const fileName = `merged_audio_${totalParts}_parts.mp3`;
        const directDlUrl = baseDlUrl ? `${baseDlUrl}?download=1&name=${encodeURIComponent(fileName)}` : '#';

        const partsList = (res.verified_parts && res.verified_parts.length > 0)
            ? res.verified_parts
            : state.audioMergeFiles.map((f, i) => ({
                index: i + 1,
                name: f.name,
                duration: f._duration || 0,
                startTime: 0,
                endTime: f._duration || 0
            }));

        const totalMergedParts = res.parts_count || partsList.length;
        const totalDuration = res.duration || state.audioMergeTotalDuration || 0;

        // Calculate verified joint points for final merged audio
        const resJoints = [];
        let cum = 0;
        for (let i = 0; i < partsList.length - 1; i++) {
            const p = partsList[i];
            const pDur = p.duration || 0;
            cum = p.endTime != null ? p.endTime : (cum + pDur);
            resJoints.push({
                index: i + 1,
                time: cum,
                fromPart: i + 1,
                toPart: i + 2,
                fromName: p.name || `Part ${i + 1}`,
                toName: (partsList[i + 1] && partsList[i + 1].name) || `Part ${i + 2}`
            });
        }

        return `
            <section class="m-card m-result-card-theme" style="margin-top:20px; scroll-margin-top:20px;" id="m-am-result-section">
                <div class="m-card__header">
                    <div style="display:flex; flex-direction:column; gap:2px;">
                        <span class="m-card__title" style="color:#6ee7b7; font-size:16px;">🎉 2. Final Merged Output Audio (मर्ज किया गया फाइनल रिजल्ट ऑडियो)</span>
                        <span style="font-size:11px; color:#a7f3d0;">सभी ${totalMergedParts} पार्ट्स को एक साथ जोड़कर तैयार किया गया मास्टर MP3</span>
                    </div>
                    <span class="m-badge-result">${icons.check} MERGED RESULT (320kbps)</span>
                </div>

                <div class="m-result-preview-box">
                    <div class="m-result-meta-grid">
                        <div class="m-meta-stat">
                            <span class="m-stat-label">Parts Merged</span>
                            <span class="m-stat-value">${totalMergedParts} of ${state.audioMergeFiles.length} Parts</span>
                        </div>
                        <div class="m-meta-stat">
                            <span class="m-stat-label">Total Duration</span>
                            <span class="m-stat-value">${formatDuration(totalDuration)}</span>
                        </div>
                        <div class="m-meta-stat">
                            <span class="m-stat-label">File Size</span>
                            <span class="m-stat-value">${formatBytes(res.size || 0)}</span>
                        </div>
                        <div class="m-meta-stat">
                            <span class="m-stat-label">Audio Quality</span>
                            <span class="m-stat-value">320 kbps MP3</span>
                        </div>
                    </div>

                    <!-- Native HTML5 Standard Player for Guaranteed Compatibility -->
                    <div class="m-native-player-box">
                        <div style="font-size:11px; font-weight:700; color:#6ee7b7; margin-bottom:6px; display:flex; align-items:center; justify-content:space-between;">
                            <span>🔊 Master Audio Player (स्टैंडर्ड प्लेयर):</span>
                            <span style="color:#94a3b8; font-size:10px;">Play / Pause / Seek / Volume</span>
                        </div>
                        <audio id="m-result-audio-player" controls preload="auto" playsinline src="${audioSrc}" class="m-native-audio-element"></audio>
                    </div>

                    <!-- Interactive Result Waveform Timeline & Joint Overlay -->
                    <div style="margin-top:10px; margin-bottom:12px;">
                        <div style="font-size:12px; font-weight:700; color:#38bdf8; margin-bottom:6px; display:flex; align-items:center; justify-content:space-between;">
                            <span>📊 Final Merged Waveform (फाइनल वेवफॉर्म):</span>
                            <span style="font-size:11px; color:#94a3b8;">${totalMergedParts} Parts in Exact Sequence</span>
                        </div>

                        <div class="m-timeline-wrapper" id="m-am-result-timeline-wrap">
                            <canvas class="m-timeline-canvas" id="m-am-result-waveform-canvas"></canvas>
                            <div class="m-timeline-playhead" id="m-am-result-playhead" style="left:0%;"></div>
                            <div class="m-timeline-legend">
                                ${partsList.map((p, idx) => `
                                    <div class="m-legend-item">
                                        <span class="m-legend-dot m-part-color-${((idx) % 5) + 1}"></span>
                                        <span>Part ${idx + 1}: ${escapeHTML(p.name || 'Part ' + (idx + 1))} (${p.duration ? formatDuration(p.duration) : ''})</span>
                                    </div>
                                `).join('')}
                            </div>
                        </div>

                        <!-- Integrated Custom Audio Transport Bar for Final Result -->
                        <div class="m-audio-transport-bar" style="background: #090d16; border: 1px solid rgba(16,185,129,0.3); border-radius: 10px; padding: 10px 14px; margin-top:8px;">
                            <div style="display:flex; align-items:center; justify-content:space-between; width:100%; gap:12px;">
                                <div style="display:flex; align-items:center; gap:10px;">
                                    <button type="button" class="m-transport-play-btn" id="btn-am-res-toggle-play" title="Play/Pause Merged Audio" style="width:44px; height:44px; border-radius:50%; background:linear-gradient(135deg, #059669, #10b981); color:#fff; display:flex; align-items:center; justify-content:center; border:none; cursor:pointer; box-shadow: 0 0 12px rgba(16,185,129,0.4);">
                                        ${icons.play}
                                    </button>
                                    <div style="display:flex; flex-direction:column;">
                                        <span style="font-size:13px; font-weight:700; color:#f8fafc;">Merged Master Audio (${totalMergedParts} Parts)</span>
                                        <span style="font-size:11px; color:#94a3b8;">💡 वेवफॉर्म पर टैप करके सुनें या नीचे जॉइंट बटन दबाएं</span>
                                    </div>
                                </div>
                                <div class="m-transport-time-display" style="text-align:right;">
                                    <span class="m-time-current" id="m-am-res-time-cur" style="font-size:15px; font-weight:800; color:#34d399; font-variant-numeric:tabular-nums;">0:00.0</span>
                                    <span class="m-time-total" id="m-am-res-time-tot" style="font-size:11px; color:#94a3b8; display:block;">Total: ${formatDuration(totalDuration)}</span>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- 🔗 Final Joint Verification Points with ⚡ Listen Transition -->
                    ${resJoints.length > 0 ? `
                        <div class="m-joint-markers-container" style="margin-top:12px; margin-bottom:14px; background:rgba(15,23,42,0.8); padding:12px; border-radius:10px; border:1px solid rgba(99,102,241,0.3);">
                            <div style="font-size:13px; font-weight:700; color:#c7d2fe; margin-bottom:4px; display:flex; align-items:center; justify-content:space-between;">
                                <div style="display:flex; align-items:center; gap:6px;">
                                    <span>🔗 Joint Verification (जॉइंट वेरिफिकेशन):</span>
                                </div>
                                <span style="font-size:11px; background:#4338ca; color:#e0e7ff; padding:2px 8px; border-radius:4px; font-weight:700;">${resJoints.length} Joints Ready</span>
                            </div>
                            <div style="font-size:11px; color:#94a3b8; margin-bottom:10px;">
                                प्रत्येक जोड़ (Joint) पर ट्रांजिशन की सटीक जांच करें — 'Listen Transition' बटन दबाते ही जोड़ से 3.5 सेकंड पहले से प्ले होगा:
                            </div>
                            <div style="display:flex; flex-direction:column; gap:8px;">
                                ${resJoints.map(j => `
                                    <div class="m-joint-pill" style="background:rgba(30,41,59,0.8); border:1px solid rgba(99,102,241,0.4); padding:10px 12px; border-radius:8px;">
                                        <div class="m-joint-pill-title" style="font-size:12px;">
                                            <span>📍 Joint #${j.index}:</span>
                                            <span style="color:#fff; font-weight:700;">Part ${j.fromPart} ➔ Part ${j.toPart}</span>
                                            <span style="color:#60a5fa; font-weight:700;">@ ${formatDuration(j.time)}</span>
                                        </div>
                                        <button type="button" class="m-joint-jump-btn btn-jump-res-joint" data-time="${j.time}" style="background:linear-gradient(135deg,#2563eb,#4f46e5); border:none; color:#fff; padding:6px 12px; font-weight:700; border-radius:6px; font-size:12px; cursor:pointer;">
                                            ⚡ Listen Joint #${j.index} Transition
                                        </button>
                                    </div>
                                `).join('')}
                            </div>
                        </div>
                    ` : ''}

                    <!-- Sequence & Part Verification Box -->
                    <div style="background:#0f172a; border:1px solid #334155; border-radius:10px; padding:12px; margin-bottom:14px;">
                        <div style="font-size:12px; font-weight:700; color:#38bdf8; margin-bottom:8px; display:flex; align-items:center; justify-content:space-between;">
                            <span>🔍 Part-by-Part Breakdown (सीक्वेंस विवरण):</span>
                            <span style="font-size:11px; background:#065f46; color:#a7f3d0; padding:2px 8px; border-radius:4px; font-weight:700;">✅ ${totalMergedParts} Parts Verified</span>
                        </div>
                        <div style="display:flex; flex-direction:column; gap:6px;">
                            ${partsList.map((p, idx) => {
                                const colorClass = `m-part-color-${((idx) % 5) + 1}`;
                                const sTime = p.startTime != null ? formatDuration(p.startTime) : '0:00.0';
                                const eTime = p.endTime != null ? formatDuration(p.endTime) : (p.duration ? formatDuration(p.duration) : '');
                                return `
                                    <div style="display:flex; align-items:center; justify-content:space-between; background:#1e293b; padding:8px 10px; border-radius:6px; font-size:12px; gap:8px;">
                                        <div style="display:flex; align-items:center; gap:8px; min-width:0; flex:1;">
                                            <span class="m-part-index ${colorClass}" style="font-size:10px; padding:2px 6px;">Part ${idx + 1}</span>
                                            <span style="font-weight:600; color:#f8fafc; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHTML(p.name || ('Part ' + (idx + 1)))}</span>
                                        </div>
                                        <div style="display:flex; align-items:center; gap:8px; flex-shrink:0;">
                                            <span style="color:#94a3b8; font-size:11px;">${sTime} ➔ ${eTime}</span>
                                            <span style="color:#60a5fa; font-weight:600; font-size:11px;">⏱️ ${p.duration ? formatDuration(p.duration) : ''}</span>
                                            ${p.startTime != null ? `
                                                <button type="button" class="btn-jump-res-time" data-time="${p.startTime}" style="background:#2563eb; color:#fff; border:none; border-radius:4px; padding:4px 8px; font-size:11px; cursor:pointer; font-weight:700; display:flex; align-items:center; gap:3px;">
                                                    ▶ Play Part ${idx + 1}
                                                </button>
                                            ` : ''}
                                        </div>
                                    </div>
                                `;
                            }).join('')}
                        </div>
                    </div>

                    <!-- Single Clean Download Action -->
                    <div class="m-result-actions" style="margin-top:16px;">
                        <a href="${directDlUrl}" download="${fileName}" class="m-btn-download" id="btn-am-download-link" style="width:100%; box-sizing:border-box; text-decoration:none; padding:15px 18px; font-size:15px; font-weight:800; border-radius:10px; background:linear-gradient(135deg, #10b981, #059669); color:#fff; display:flex; align-items:center; justify-content:center; gap:10px; cursor:pointer; box-shadow:0 4px 14px rgba(16,185,129,0.35);">
                            <span>${icons.download}</span>
                            <span>Download Audio (फ़ोन में सेव करें)</span>
                        </a>

                        <button type="button" class="m-btn-secondary" id="btn-am-merge-another" style="margin-top:12px;">
                            <span>Merge Another Audio</span>
                        </button>
                    </div>
                </div>
            </section>
        `;
    }

    // ═══════════════════════════════════════════════════════════════════
    // Bulletproof In-Page File Saving Engine (Saves Directly to Device Storage)
    // ═══════════════════════════════════════════════════════════════════
    async function triggerDeviceDownload({
        blob,
        url,
        fileName,
        isVideo,
        btnEl
    }) {
        const origHtml = btnEl ? btnEl.innerHTML : '';
        if (btnEl) {
            btnEl.innerHTML = `<span class="m-spinner"></span> <span>डाउनलोड हो रहा है...</span>`;
        }

        try {
            let downloadBlob = blob;

            // If we have a server URL and no pre-existing blob, fetch it safely into memory
            // This guarantees the browser saves the exact binary file directly to Downloads
            // without ever navigating the frame or displaying raw characters/codes on screen!
            if (!downloadBlob && url) {
                const cleanUrl = url.split('?')[0] + '?download=1&name=' + encodeURIComponent(fileName);
                try {
                    const resp = await fetch(cleanUrl);
                    if (resp.ok) {
                        downloadBlob = await resp.blob();
                    }
                } catch (fErr) {
                    console.warn("Direct blob fetch failed, falling back to direct anchor:", fErr);
                }
            }

            if (downloadBlob) {
                const blobUrl = URL.createObjectURL(downloadBlob);
                const a = document.createElement('a');
                a.style.display = 'none';
                a.href = blobUrl;
                a.download = fileName;
                document.body.appendChild(a);
                a.click();
                setTimeout(() => {
                    try { document.body.removeChild(a); } catch (e) {}
                    URL.revokeObjectURL(blobUrl);
                }, 30000);

                if (btnEl) {
                    btnEl.innerHTML = `${icons.check} <span>✅ फ़ाइल डाउनलोड हो गई!</span>`;
                    setTimeout(() => { if (btnEl) btnEl.innerHTML = origHtml; }, 3500);
                }
                return true;
            }

            // Fallback: Direct server download
            if (url) {
                const directUrl = url.split('?')[0] + '?download=1&name=' + encodeURIComponent(fileName);
                const a = document.createElement('a');
                a.style.display = 'none';
                a.href = directUrl;
                a.download = fileName;
                a.target = '_blank';
                document.body.appendChild(a);
                a.click();
                setTimeout(() => {
                    try { document.body.removeChild(a); } catch (e) {}
                }, 5000);

                if (btnEl) {
                    btnEl.innerHTML = `${icons.check} <span>✅ डाउनलोड शुरू हो गया!</span>`;
                    setTimeout(() => { if (btnEl) btnEl.innerHTML = origHtml; }, 3500);
                }
                return true;
            }

            throw new Error("No download source available");
        } catch (err) {
            console.error("Save error:", err);
            if (btnEl) {
                btnEl.innerHTML = `⚠️ दोबारा दबाएं`;
                setTimeout(() => { if (btnEl) btnEl.innerHTML = origHtml; }, 3000);
            }
            return false;
        }
    }

    function setupAudioMergeEvents() {
        const backBtn = document.getElementById('m-btn-back-am');
        if (backBtn) {
            backBtn.addEventListener('click', () => {
                stopSinglePartPlayback();
                stopAudioMergePlayback();
                stopAudioMergeResultPlayback();
                state.currentTool = null;
                state.audioMergeResult = null;
                state.audioMergeResultBlob = null;
                state.audioMergeResultBlobUrl = null;
                render();
            });
        }

        const resetBtn = document.getElementById('m-btn-reset-am');
        if (resetBtn) {
            resetBtn.addEventListener('click', () => {
                stopSinglePartPlayback();
                stopAudioMergePlayback();
                stopAudioMergeResultPlayback();
                state.audioMergeFiles = [];
                state.audioMergeResult = null;
                state.audioMergeResultBlob = null;
                state.audioMergeResultBlobUrl = null;
                state.errorMessage = null;
                render();
            });
        }

        const dropzone = document.getElementById('m-dropzone-am-audio');
        const input = document.getElementById('m-input-am-audio');
        if (dropzone && input) {
            dropzone.addEventListener('click', () => input.click());
            input.addEventListener('change', async (e) => {
                if (e.target.files && e.target.files.length > 0) {
                    const newFiles = Array.from(e.target.files);
                    let combined = state.audioMergeFiles.concat(newFiles);
                    if (combined.length > 10) combined = combined.slice(0, 10);
                    state.audioMergeFiles = smartSortFiles(combined);
                    state.audioMergeResult = null;
                    state.audioMergeResultBlob = null;
                    state.audioMergeResultBlobUrl = null;
                    state.errorMessage = null;
                    render();

                    // 1. Fast extract durations for instant UI response
                    await Promise.all(state.audioMergeFiles.map(f => getAudioDurationFast(f)));
                    calculateAudioMergeJoints();
                    render();

                    // 2. Decode audio buffers concurrently in background and redraw waveform & transport
                    Promise.all(state.audioMergeFiles.map(f => decodeAudioFile(f))).then(() => {
                        calculateAudioMergeJoints();
                        drawAudioMergeWaveform();
                        updateAudioMergeTransportUI();
                    });
                }
            });
        }

        // Single part play audition
        document.querySelectorAll('.btn-play-single-part').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const idx = parseInt(btn.getAttribute('data-index'), 10);
                if (!isNaN(idx)) {
                    playSinglePartAudio(idx);
                }
            });
        });

        document.querySelectorAll('.btn-move-am-up').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const idx = parseInt(btn.getAttribute('data-index'), 10);
                if (idx > 0) {
                    const temp = state.audioMergeFiles[idx];
                    state.audioMergeFiles[idx] = state.audioMergeFiles[idx - 1];
                    state.audioMergeFiles[idx - 1] = temp;
                    stopSinglePartPlayback();
                    stopAudioMergePlayback();
                    calculateAudioMergeJoints();
                    render();
                }
            });
        });

        document.querySelectorAll('.btn-move-am-down').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const idx = parseInt(btn.getAttribute('data-index'), 10);
                if (idx < state.audioMergeFiles.length - 1) {
                    const temp = state.audioMergeFiles[idx];
                    state.audioMergeFiles[idx] = state.audioMergeFiles[idx + 1];
                    state.audioMergeFiles[idx + 1] = temp;
                    stopSinglePartPlayback();
                    stopAudioMergePlayback();
                    calculateAudioMergeJoints();
                    render();
                }
            });
        });

        document.querySelectorAll('.btn-remove-am-file').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const idx = parseInt(btn.getAttribute('data-index'), 10);
                if (!isNaN(idx)) {
                    state.audioMergeFiles.splice(idx, 1);
                    stopSinglePartPlayback();
                    stopAudioMergePlayback();
                    calculateAudioMergeJoints();
                    render();
                }
            });
        });

        // Transport Play / Pause for Card 1 preview
        const playBtn = document.getElementById('btn-audiomerge-toggle-play');
        if (playBtn) {
            playBtn.addEventListener('click', () => {
                stopSinglePartPlayback();
                if (state.audioMergeIsPlaying) {
                    stopAudioMergePlayback();
                } else {
                    startAudioMergePlayback(state.audioMergeCurrentTime);
                }
            });
        }

        // Timeline Tap / Scrub for Card 1 preview
        const canvas = document.getElementById('m-audiomerge-waveform-canvas');
        if (canvas) {
            canvas.addEventListener('click', (e) => {
                stopSinglePartPlayback();
                const rect = canvas.getBoundingClientRect();
                const clickX = e.clientX - rect.left;
                const pct = Math.max(0, Math.min(1, clickX / rect.width));
                const seekTime = pct * (state.audioMergeTotalDuration || 0);
                state.audioMergeCurrentTime = seekTime;
                updateAudioMergePlayheadPosition();
                if (state.audioMergeIsPlaying) {
                    startAudioMergePlayback(seekTime);
                }
            });
        }

        // Jump to Joint Points in Card 1 preview
        document.querySelectorAll('.btn-jump-to-joint').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                stopSinglePartPlayback();
                const jTime = parseFloat(btn.getAttribute('data-time'));
                if (!isNaN(jTime)) {
                    const startTime = Math.max(0, jTime - 3.5);
                    state.audioMergeCurrentTime = startTime;
                    updateAudioMergePlayheadPosition();
                    startAudioMergePlayback(startTime);
                }
            });
        });

        // Result Audio Player & Transport Integration (Card 2)
        const resPlayer = document.getElementById('m-result-audio-player');
        const resPlayBtn = document.getElementById('btn-am-res-toggle-play');
        const resCanvas = document.getElementById('m-am-result-waveform-canvas');

        if (resPlayBtn) {
            resPlayBtn.addEventListener('click', () => {
                if (state.audioMergeResultIsPlaying) {
                    stopAudioMergeResultPlayback();
                } else {
                    startAudioMergeResultPlayback(state.audioMergeResultCurrentTime || 0);
                }
            });
        }

        if (resCanvas) {
            resCanvas.addEventListener('click', (e) => {
                stopSinglePartPlayback();
                stopAudioMergePlayback();
                const rect = resCanvas.getBoundingClientRect();
                const clickX = e.clientX - rect.left;
                const pct = Math.max(0, Math.min(1, clickX / rect.width));
                const totalDur = (resPlayer && resPlayer.duration && !isNaN(resPlayer.duration))
                    ? resPlayer.duration
                    : ((state.audioMergeResult && state.audioMergeResult.duration) || state.audioMergeTotalDuration || 1);
                const seekTime = pct * totalDur;
                state.audioMergeResultCurrentTime = seekTime;
                if (resPlayer) {
                    resPlayer.currentTime = seekTime;
                    resPlayer.play().catch(() => {});
                }
                updateAudioMergeResultPlayheadPosition();
            });
        }

        if (resPlayer) {
            resPlayer.addEventListener('play', () => {
                stopSinglePartPlayback();
                stopAudioMergePlayback();
                state.audioMergeResultIsPlaying = true;
                updateAudioMergeResultTransportUI();
                const tick = () => {
                    if (!resPlayer || resPlayer.paused) {
                        state.audioMergeResultIsPlaying = false;
                        updateAudioMergeResultTransportUI();
                        return;
                    }
                    state.audioMergeResultCurrentTime = resPlayer.currentTime || 0;
                    updateAudioMergeResultPlayheadPosition();
                    audioMergeResultAnimFrame = requestAnimationFrame(tick);
                };
                if (audioMergeResultAnimFrame) cancelAnimationFrame(audioMergeResultAnimFrame);
                audioMergeResultAnimFrame = requestAnimationFrame(tick);
            });
            resPlayer.addEventListener('pause', () => {
                state.audioMergeResultIsPlaying = false;
                updateAudioMergeResultTransportUI();
                if (audioMergeResultAnimFrame) {
                    cancelAnimationFrame(audioMergeResultAnimFrame);
                    audioMergeResultAnimFrame = null;
                }
            });
            resPlayer.addEventListener('ended', () => {
                state.audioMergeResultIsPlaying = false;
                state.audioMergeResultCurrentTime = 0;
                updateAudioMergeResultTransportUI();
                updateAudioMergeResultPlayheadPosition();
                if (audioMergeResultAnimFrame) {
                    cancelAnimationFrame(audioMergeResultAnimFrame);
                    audioMergeResultAnimFrame = null;
                }
            });
            resPlayer.addEventListener('timeupdate', () => {
                state.audioMergeResultCurrentTime = resPlayer.currentTime || 0;
                updateAudioMergeResultPlayheadPosition();
            });
            resPlayer.addEventListener('error', () => {
                if (state.audioMergeResult && state.audioMergeResult.download_url) {
                    fetch(state.audioMergeResult.download_url)
                        .then(r => r.arrayBuffer())
                        .then(ab => {
                            const audioBlob = new Blob([ab], { type: 'audio/mpeg' });
                            const blobUrl = URL.createObjectURL(audioBlob);
                            state.audioMergeResultBlobUrl = blobUrl;
                            state.audioMergeResultBlob = audioBlob;
                            resPlayer.src = blobUrl;
                            resPlayer.load();
                        })
                        .catch(err => console.error("Fallback blob fetch failed:", err));
                }
            }, { once: true });
        }

        // Jump to Part in Result Player
        document.querySelectorAll('.btn-jump-res-time').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                stopSinglePartPlayback();
                const jTime = parseFloat(btn.getAttribute('data-time'));
                if (!isNaN(jTime)) {
                    state.audioMergeResultCurrentTime = jTime;
                    startAudioMergeResultPlayback(jTime);
                }
            });
        });

        // Jump to Joint in Result Player (Listen Transition)
        document.querySelectorAll('.btn-jump-res-joint').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                stopSinglePartPlayback();
                const jTime = parseFloat(btn.getAttribute('data-time'));
                if (!isNaN(jTime)) {
                    const startTime = Math.max(0, jTime - 3.5);
                    state.audioMergeResultCurrentTime = startTime;
                    startAudioMergeResultPlayback(startTime);
                }
            });
        });

        // Single Bulletproof Download for Merged Audio
        const dlBtn = document.getElementById('btn-am-download-link');
        const count = (state.audioMergeResult && state.audioMergeResult.parts_count) || state.audioMergeFiles.length || 1;
        const fileName = `merged_audio_${count}_parts.mp3`;

        if (dlBtn) {
            dlBtn.addEventListener('click', async (e) => {
                e.preventDefault();
                const dlUrl = (state.audioMergeResult && state.audioMergeResult.download_url) || '';
                await triggerDeviceDownload({
                    blob: state.audioMergeResultBlob,
                    url: dlUrl,
                    fileName: fileName,
                    isVideo: false,
                    btnEl: dlBtn
                });
            });
        }

        const mergeBtn = document.getElementById('btn-start-audio-merge');
        if (mergeBtn) {
            mergeBtn.addEventListener('click', startAudioMergeProcessing);
        }

        const anotherBtn = document.getElementById('btn-am-merge-another');
        if (anotherBtn) {
            anotherBtn.addEventListener('click', () => {
                stopSinglePartPlayback();
                stopAudioMergePlayback();
                stopAudioMergeResultPlayback();
                state.audioMergeFiles = [];
                state.audioMergeResult = null;
                state.audioMergeResultBlob = null;
                state.audioMergeResultBlobUrl = null;
                state.errorMessage = null;
                render();
            });
        }
    }

    function updateAudioMergeProgressDOM(stage, pct) {
        state.processingStage = stage;
        state.overallPercent = pct;
        const stageEl = document.getElementById('m-am-progress-stage');
        const pctEl = document.getElementById('m-am-progress-pct');
        const fillEl = document.getElementById('m-am-progress-fill');
        if (stageEl) stageEl.textContent = stage;
        if (pctEl) pctEl.textContent = pct + '%';
        if (fillEl) fillEl.style.width = pct + '%';
    }

    function concatenateAudioBuffers(buffers, ctx) {
        if (!buffers || buffers.length === 0) return null;
        const validBuffers = buffers.filter(b => b && b.duration > 0);
        if (validBuffers.length === 0) return null;
        if (validBuffers.length === 1) return validBuffers[0];

        const sampleRate = 44100;
        const numChannels = 2;
        let totalSamples = 0;
        validBuffers.forEach(b => {
            totalSamples += Math.round(b.duration * sampleRate);
        });

        if (totalSamples <= 0) return null;
        const outBuffer = ctx.createBuffer(numChannels, totalSamples, sampleRate);

        let curOffset = 0;
        validBuffers.forEach(b => {
            const bLen = Math.round(b.duration * sampleRate);
            for (let ch = 0; ch < numChannels; ch++) {
                const outData = outBuffer.getChannelData(ch);
                const srcCh = Math.min(ch, b.numberOfChannels - 1);
                const srcData = b.getChannelData(srcCh);

                if (b.sampleRate === sampleRate) {
                    const copyLen = Math.min(srcData.length, totalSamples - curOffset);
                    for (let i = 0; i < copyLen; i++) {
                        outData[curOffset + i] = srcData[i];
                    }
                } else {
                    const ratio = b.sampleRate / sampleRate;
                    const copyLen = Math.min(bLen, totalSamples - curOffset);
                    for (let i = 0; i < copyLen; i++) {
                        const srcIdx = Math.floor(i * ratio);
                        if (srcIdx < srcData.length) {
                            outData[curOffset + i] = srcData[srcIdx];
                        }
                    }
                }
            }
            curOffset += bLen;
        });

        return outBuffer;
    }

    function audioBufferToWav(buffer) {
        const numChannels = buffer.numberOfChannels || 2;
        const sampleRate = buffer.sampleRate || 44100;
        const bitDepth = 16;
        const bytesPerSample = bitDepth / 8;
        const blockAlign = numChannels * bytesPerSample;

        let interleaved;
        if (numChannels === 2) {
            const ch0 = buffer.getChannelData(0);
            const ch1 = buffer.getChannelData(1);
            interleaved = new Float32Array(ch0.length + ch1.length);
            let idx = 0;
            for (let i = 0; i < ch0.length; i++) {
                interleaved[idx++] = ch0[i];
                interleaved[idx++] = ch1[i];
            }
        } else {
            interleaved = buffer.getChannelData(0);
        }

        const dataByteLength = interleaved.length * bytesPerSample;
        const arrayBuffer = new ArrayBuffer(44 + dataByteLength);
        const view = new DataView(arrayBuffer);

        const writeStr = (offset, str) => {
            for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
        };

        writeStr(0, 'RIFF');
        view.setUint32(4, 36 + dataByteLength, true);
        writeStr(8, 'WAVE');
        writeStr(12, 'fmt ');
        view.setUint32(16, 16, true); // SubChunk1Size (16 for PCM)
        view.setUint16(20, 1, true);  // AudioFormat (1 for PCM)
        view.setUint16(22, numChannels, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate * blockAlign, true);
        view.setUint16(32, blockAlign, true);
        view.setUint16(34, bitDepth, true);
        writeStr(36, 'data');
        view.setUint32(40, dataByteLength, true);

        // Float to 16-bit PCM
        let offset = 44;
        for (let i = 0; i < interleaved.length; i++, offset += 2) {
            const s = Math.max(-1, Math.min(1, interleaved[i]));
            view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
        }

        return new Blob([view], { type: 'audio/wav' });
    }

    function callDirectAudioMergePromise(files, partsMeta, onUploadProgress) {
        return new Promise((resolve, reject) => {
            const formData = new FormData();
            const jobId = 'am_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
            formData.append('jobId', jobId);
            formData.append('partsMeta', JSON.stringify(partsMeta || []));
            files.forEach((file, idx) => {
                formData.append('files', file, file.name || `part_${idx + 1}.mp3`);
            });

            const xhr = new XMLHttpRequest();
            xhr.open('POST', '/api/audio/merge-direct', true);
            xhr.withCredentials = true;
            xhr.timeout = 240000;

            xhr.upload.onprogress = (e) => {
                if (e.lengthComputable && e.total > 0 && typeof onUploadProgress === 'function') {
                    onUploadProgress(e.loaded, e.total);
                }
            };

            xhr.onload = () => {
                const raw = (xhr.responseText || '').trim();
                let data = null;
                try {
                    data = JSON.parse(raw);
                } catch (e) {
                    const match = raw.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i) || raw.match(/<title>([^<]*)<\/title>/i);
                    const serverMsg = match ? match[1].replace(/<[^>]+>/g, '').trim() : (raw ? raw.slice(0, 100) : `HTTP ${xhr.status}`);
                    return reject(new Error(serverMsg || `Audio merge failed (HTTP ${xhr.status})`));
                }

                if (xhr.status >= 200 && xhr.status < 300 && data && data.success) {
                    resolve(data);
                } else {
                    const msg = (data && data.error) ? data.error : `Audio merge failed (HTTP ${xhr.status})`;
                    reject(new Error(msg));
                }
            };

            xhr.ontimeout = () => reject(new Error('Audio merge timed out on server.'));
            xhr.onerror = () => reject(new Error('Network error during audio merge process.'));
            xhr.send(formData);
        });
    }

    async function callDirectAudioMergeWithRetry(files, partsMeta, onUploadProgress, maxRetries = 2) {
        let lastErr = null;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                return await callDirectAudioMergePromise(files, partsMeta, onUploadProgress);
            } catch (err) {
                lastErr = err;
                console.warn(`Audio merge attempt ${attempt} failed:`, err.message);
                if (attempt < maxRetries) {
                    await syncSessionCookie();
                    await new Promise(r => setTimeout(r, 1000 * attempt));
                }
            }
        }
        throw lastErr || new Error("Audio merge failed on server");
    }

    async function startAudioMergeProcessing() {
        if (state.audioMergeFiles.length < 2) return;

        stopSinglePartPlayback();
        stopAudioMergePlayback();
        stopAudioMergeResultPlayback();
        state.audioMergeIsProcessing = true;
        state.errorMessage = null;
        state.audioMergeResult = null;
        state.overallPercent = 0;
        state.processingStage = 'Starting high-speed audio merge...';
        render();

        try {
            const files = state.audioMergeFiles;
            const total = files.length;

            updateAudioMergeProgressDOM(`Uploading ${total} parts to server...`, 20);

            const partsMeta = files.map((f, idx) => ({
                index: idx,
                name: f.name,
                size: f.size,
                duration: f._duration || 0
            }));

            let serverResult = null;

            // Strategy 1: Fast direct multi-part upload to /api/audio/merge-direct
            try {
                serverResult = await callDirectAudioMergeWithRetry(files, partsMeta, (loaded, totalBytes) => {
                    const fraction = totalBytes > 0 ? (loaded / totalBytes) : 0;
                    const pct = Math.min(80, 20 + Math.round(fraction * 60));
                    updateAudioMergeProgressDOM(`Uploading to server (${formatBytes(loaded)} / ${formatBytes(totalBytes)})...`, pct);
                });
            } catch (directErr) {
                console.warn("Direct merge failed, falling back to sequential chunked upload:", directErr.message);

                // Strategy 2: Sequential chunked upload fallback (/upload-part + /api/audio/merge-only)
                updateAudioMergeProgressDOM('Uploading parts sequentially to server...', 30);
                const jobId = 'am_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
                const totalBytes = files.reduce((s, f) => s + f.size, 0);
                let completedBytes = 0;

                for (let i = 0; i < total; i++) {
                    const f = files[i];
                    const bytesBefore = completedBytes;
                    await uploadSinglePartWithRetry(f, jobId, i, total, (loaded, partTotal) => {
                        const curLoaded = bytesBefore + loaded;
                        const pct = Math.min(85, 30 + Math.round((curLoaded / totalBytes) * 55));
                        updateAudioMergeProgressDOM(`Uploading Part ${i + 1}/${total} (${pct}%)...`, pct);
                    });
                    completedBytes += f.size;
                }

                updateAudioMergeProgressDOM('FFmpeg: Rendering master 320kbps MP3 on server...', 88);
                const mergeResp = await fetch('/api/audio/merge-only', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        jobId: jobId,
                        expectedCount: total,
                        parts: partsMeta
                    })
                });

                if (!mergeResp.ok) {
                    const errData = await mergeResp.json().catch(() => ({}));
                    throw new Error(errData.error || `Server merge failed (HTTP ${mergeResp.status})`);
                }
                serverResult = await mergeResp.json();
            }

            if (!serverResult || !serverResult.success || !serverResult.download_url) {
                throw new Error((serverResult && serverResult.error) || 'Audio merge failed on server');
            }

            updateAudioMergeProgressDOM('Finalizing master audio preview...', 95);
            state.audioMergeResult = serverResult;
            state.audioMergeResultBlob = null;
            state.audioMergeResultBlobUrl = null;

            if (serverResult.download_url) {
                try {
                    const audioResp = await fetch(serverResult.download_url);
                    if (audioResp.ok) {
                        const audioBlob = await audioResp.blob();
                        state.audioMergeResultBlob = audioBlob;
                        state.audioMergeResultBlobUrl = URL.createObjectURL(audioBlob);
                    }
                } catch (bErr) {
                    console.warn("Could not pre-fetch result blob:", bErr);
                }
            }

            state.audioMergeIsProcessing = false;
            updateAudioMergeProgressDOM('Done! Audio merged successfully.', 100);

            addProjectHistory({
                type: 'audio_merge',
                title: `Merged Audio (${total} Parts)`,
                itemCount: total,
                duration: serverResult.duration || state.audioMergeTotalDuration,
                size: serverResult.size,
                downloadUrl: serverResult.download_url
            });

            render();

            setTimeout(() => {
                const resEl = document.getElementById('m-am-result-section');
                if (resEl) resEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }, 100);
        } catch (err) {
            console.error("Audio merge error:", err);
            state.audioMergeIsProcessing = false;
            state.errorMessage = err.message || 'Audio merge failed';
            render();
        }
    }

    // ── 4. JUMP-CUT / SILENCE TOOL SCREEN ────────────────────────
    function renderToolScreen() {
        const isVideo = state.currentTool === 'video-jumpcut';
        const toolTitle = isVideo ? 'Video Jump-Cut' : 'Auto Silence Remover';
        const fileAccept = isVideo 
            ? '.mp4,.mov,.mkv,.webm,.m4v,.avi,application/octet-stream' 
            : '.mp3,.wav,.m4a,.aac,.flac,.ogg,audio/*';

        const fileTypeLabel = isVideo ? 'video' : 'audio';
        const hasFiles = state.activeMode === 'single' ? !!state.singleFile : state.mergeFiles.length > 0;
        
        let oversizeFile = null;
        if (state.activeMode === 'single' && state.singleFile) {
            if (state.singleFile.size > SINGLE_PART_MAX_BYTES) oversizeFile = state.singleFile;
        } else if (state.activeMode === 'merge') {
            oversizeFile = state.mergeFiles.find(f => f.size > SINGLE_PART_MAX_BYTES);
        }

        rootEl.innerHTML = `
            <div class="m-app-shell">
                <header class="m-tool-header">
                    <button type="button" class="m-back-btn" id="m-btn-back" aria-label="Back to home">
                        ${icons.back}
                    </button>
                    <div class="m-tool-header__title">${toolTitle}</div>
                    <div class="m-tool-header__action">
                        ${hasFiles && !state.isProcessing ? `
                            <button type="button" class="m-clear-btn" id="m-btn-reset-top">Clear</button>
                        ` : ''}
                    </div>
                </header>

                <main class="m-tool-main">
                    <div class="m-mode-tabs" role="tablist">
                        <button type="button" role="tab" class="m-mode-tab ${state.activeMode === 'single' ? 'is-active' : ''}" id="tab-mode-single">
                            Single File
                        </button>
                        <button type="button" role="tab" class="m-mode-tab ${state.activeMode === 'merge' ? 'is-active' : ''}" id="tab-mode-merge">
                            Merge (Up to ${MAX_MERGE_FILES} parts)
                        </button>
                    </div>

                    <section class="m-card m-upload-card">
                        ${state.activeMode === 'single' ? renderSingleUploadHTML(fileAccept, fileTypeLabel) : renderMergeUploadHTML(fileAccept, fileTypeLabel)}
                        ${oversizeFile ? `
                            <div class="m-warning-box">
                                ${icons.alert}
                                <span>पार्ट "${escapeHTML(oversizeFile.name)}" का साइज़ (${formatBytes(oversizeFile.size)}) 45 MB से बड़ा है।</span>
                            </div>
                        ` : ''}
                    </section>

                    <section class="m-card m-options-card">
                        <div class="m-card__header">
                            <span class="m-card__title">Processing Options</span>
                            <span class="m-card__hint">${icons.bolt} Pure Engine</span>
                        </div>

                        <div class="m-field">
                            <div class="m-field__label-row">
                                <label for="m-input-min-dur" class="m-field__label">Min Pause Duration</label>
                                <span class="m-field__value-badge" id="m-val-min-dur">${state.minSilence.toFixed(2)}s</span>
                            </div>
                            <input type="range" class="m-slider" id="m-input-min-dur" min="0.08" max="1.50" step="0.02" value="${state.minSilence}" ${state.isProcessing ? 'disabled' : ''} />
                            <div class="m-field__scale">
                                <span>0.08s (Fast)</span>
                                <span>1.50s (Relaxed)</span>
                            </div>
                        </div>

                        <div class="m-field">
                            <label for="m-select-threshold" class="m-field__label">Sensitivity (dB Threshold)</label>
                            <div class="m-select-wrap">
                                <select class="m-select" id="m-select-threshold" ${state.isProcessing ? 'disabled' : ''}>
                                    <option value="-20" ${state.silenceThreshold === -20 ? 'selected' : ''}>Ultra Aggressive (-20 dB - Zero Pauses)</option>
                                    <option value="-22" ${state.silenceThreshold === -22 ? 'selected' : ''}>Very Aggressive (-22 dB - Faint Sound Effects/Noise)</option>
                                    <option value="-25" ${state.silenceThreshold === -25 ? 'selected' : ''}>Low (-25 dB)</option>
                                    <option value="-30" ${state.silenceThreshold === -30 ? 'selected' : ''}>Medium (-30 dB)</option>
                                    <option value="-35" ${state.silenceThreshold === -35 ? 'selected' : ''}>High (-35 dB - Recommended)</option>
                                    <option value="-40" ${state.silenceThreshold === -40 ? 'selected' : ''}>Very High (-40 dB)</option>
                                    <option value="-50" ${state.silenceThreshold === -50 ? 'selected' : ''}>Max (-50 dB)</option>
                                </select>
                            </div>
                        </div>

                        <div class="m-field">
                            <label for="m-select-padding" class="m-field__label">Edge Padding (Speech Buffer)</label>
                            <div class="m-select-wrap">
                                <select class="m-select" id="m-select-padding" ${state.isProcessing ? 'disabled' : ''}>
                                    <option value="0.01" ${state.silencePadding === 0.01 ? 'selected' : ''}>Zero Gap (10ms)</option>
                                    <option value="0.02" ${state.silencePadding === 0.02 ? 'selected' : ''}>Tight (20ms)</option>
                                    <option value="0.04" ${state.silencePadding === 0.04 ? 'selected' : ''}>Buffer (40ms)</option>
                                    <option value="0.05" ${state.silencePadding === 0.05 ? 'selected' : ''}>Smooth (50ms - Best)</option>
                                    <option value="0.10" ${state.silencePadding === 0.10 ? 'selected' : ''}>Gentle (100ms)</option>
                                </select>
                            </div>
                        </div>
                    </section>

                    <div class="m-action-area">
                        ${renderProcessButtonHTML(hasFiles, !!oversizeFile)}
                        ${state.isProcessing ? renderProgressIndicatorHTML() : ''}
                        ${state.errorMessage ? `
                            <div class="m-error-banner">
                                <span>${escapeHTML(state.errorMessage)}</span>
                            </div>
                        ` : ''}
                    </div>

                    ${state.result ? renderResultCardHTML(isVideo) : ''}
                </main>
            </div>
        `;

        setupToolScreenEvents();
    }

    function renderSingleUploadHTML(accept, typeLabel) {
        if (state.singleFile) {
            return `
                <div class="m-file-selected">
                    ${state.singleFile._thumbUrl ? `
                        <div class="m-part-thumb btn-preview-item" data-single="1" title="Tap to preview/play">
                            <img src="${state.singleFile._thumbUrl}" alt="Preview frame" />
                            <div class="m-part-thumb__play">${icons.play}</div>
                        </div>
                    ` : ''}
                    <div class="m-file-selected__info">
                        <span class="m-file-selected__name">${escapeHTML(state.singleFile.name)}</span>
                        <span class="m-file-selected__size">${formatBytes(state.singleFile.size)}</span>
                    </div>
                    <button type="button" class="m-file-remove-btn" id="btn-remove-single" aria-label="Remove file">
                        ${icons.close}
                    </button>
                </div>
            `;
        }
        return `
            <div class="m-dropzone" id="m-single-dropzone">
                <input type="file" id="m-single-input" accept="${accept}" hidden />
                <div class="m-dropzone__icon">${icons.upload}</div>
                <div class="m-dropzone__text">Choose from Files (${typeLabel})</div>
                <div class="m-dropzone__sub">Opens Android File Manager / Downloads (max 45 MB)</div>
            </div>
        `;
    }

    function renderMergeUploadHTML(accept, typeLabel) {
        const count = state.mergeFiles.length;
        const totalSize = state.mergeFiles.reduce((acc, f) => acc + f.size, 0);

        let partsListHTML = '';
        if (count > 0) {
            partsListHTML = `
                <div class="m-parts-list">
                    <div class="m-parts-header">
                        <span>Parts in Serial Order (${count} of ${MAX_MERGE_FILES})</span>
                        <span>Total: ${formatBytes(totalSize)}</span>
                    </div>
                    ${state.mergeFiles.map((f, idx) => {
                        const parsed = extractFileIndex(f.name);
                        const seqTag = (parsed.num !== Infinity && parsed.num <= 500) ? `Serial #${parsed.num}` : `Part #${idx + 1}`;
                        const isFirst = idx === 0;
                        const isLast = idx === count - 1;

                        return `
                            <div class="m-part-item">
                                <span class="m-part-index">${idx + 1}</span>
                                <div class="m-part-thumb btn-preview-item" data-preview-index="${idx}" title="Tap to play preview clip">
                                    ${f._thumbUrl ? `<img src="${f._thumbUrl}" alt="Preview frame" />` : ''}
                                    <div class="m-part-thumb__play">${icons.play}</div>
                                </div>
                                <div class="m-part-details">
                                    <div class="m-part-name-row">
                                        <span class="m-part-name" title="${escapeHTML(f.name)}">${escapeHTML(f.name)}</span>
                                        <span class="m-part-seq-badge">${seqTag}</span>
                                    </div>
                                    <div class="m-part-meta-row">
                                        <span class="m-part-size">${formatBytes(f.size)}</span>
                                    </div>
                                </div>
                                <div class="m-part-reorder-group">
                                    <button type="button" class="m-part-btn-reorder btn-move-up" data-index="${idx}" ${isFirst ? 'disabled' : ''} title="Move Part Up">
                                        ${icons.up}
                                    </button>
                                    <button type="button" class="m-part-btn-reorder btn-move-down" data-index="${idx}" ${isLast ? 'disabled' : ''} title="Move Part Down">
                                        ${icons.down}
                                    </button>
                                </div>
                                <button type="button" class="m-part-remove" data-remove-index="${idx}" aria-label="Remove part ${idx + 1}">
                                    ${icons.close}
                                </button>
                            </div>
                        `;
                    }).join('')}
                </div>
            `;
        }

        return `
            <div class="m-merge-wrapper">
                ${partsListHTML}
                ${count < MAX_MERGE_FILES ? `
                    <div class="m-dropzone m-dropzone--merge" id="m-merge-dropzone">
                        <input type="file" id="m-merge-input" accept="${accept}" multiple hidden />
                        <div class="m-dropzone__icon">${icons.plus}</div>
                        <div class="m-dropzone__text">${count === 0 ? `Choose parts from Files (up to ${MAX_MERGE_FILES})` : `Add more parts (${count}/${MAX_MERGE_FILES})`}</div>
                        <div class="m-dropzone__sub">Preserves real names, serial ordering & frame previews</div>
                    </div>
                ` : `
                    <div class="m-max-parts-hint">Maximum ${MAX_MERGE_FILES} parts added</div>
                `}
            </div>
        `;
    }

    function renderProcessButtonHTML(hasFiles, isOversize) {
        if (state.isProcessing) {
            return `
                <button type="button" class="m-btn-process is-busy" disabled>
                    <span class="m-spinner"></span>
                    <span>Processing in Progress...</span>
                </button>
            `;
        }

        const isVideo = state.currentTool === 'video-jumpcut';
        const label = state.activeMode === 'merge' 
            ? (isVideo ? 'Merge in Serial Order & Jump-Cut' : 'Merge in Serial Order & Remove Silence')
            : (isVideo ? 'Cut Dead-Air & Jump-Cut Video' : 'Cut Dead-Air & Clean Audio');

        const isDisabled = !hasFiles || isOversize;

        return `
            <button type="button" class="m-btn-process" id="btn-process-action" ${isDisabled ? 'disabled' : ''}>
                <span>${icons.scissors}</span>
                <span>${label}</span>
            </button>
        `;
    }

    function renderProgressIndicatorHTML() {
        return `
            <div class="m-progress-container">
                <div class="m-progress-status-row">
                    <span id="m-progress-stage-text">${escapeHTML(state.processingStage || 'Processing...')}</span>
                    <span class="m-progress-pct" id="m-progress-pct-text">${state.overallPercent}%</span>
                </div>
                <div class="m-progress-bar-bg">
                    <div class="m-progress-bar-fill" id="m-progress-fill" style="width: ${state.overallPercent}%;"></div>
                </div>
            </div>
        `;
    }

    function renderResultCardHTML(isVideo) {
        const res = state.result;
        if (!res) return '';

        const downUrl = state.resultBlobUrl || res.download_url || '';
        const pct = res.original_duration > 0 
            ? Math.round((res.silence_removed / res.original_duration) * 100) 
            : 0;

        return `
            <section class="m-card m-result-card">
                <div class="m-card__header">
                    <span class="m-card__title">Completed Result</span>
                    <span class="m-card__badge-ok">${icons.check} Ready</span>
                </div>

                ${res.merged_parts && res.merged_parts.length > 1 ? `
                    <div class="m-result-merged-banner">
                        <span>Merged ${res.merged_parts.length} parts in exact serial order</span>
                    </div>
                ` : ''}

                <div class="m-stats-grid">
                    <div class="m-stat-box">
                        <span class="m-stat-box__val">${formatTime(res.original_duration)}</span>
                        <span class="m-stat-box__label">Original</span>
                    </div>
                    <div class="m-stat-box m-stat-box--highlight">
                        <span class="m-stat-box__val">${formatTime(res.trimmed_duration)}</span>
                        <span class="m-stat-box__label">Processed</span>
                    </div>
                    <div class="m-stat-box m-stat-box--cut">
                        <span class="m-stat-box__val">-${(res.silence_removed || 0).toFixed(1)}s</span>
                        <span class="m-stat-box__label">Dead Air Cut</span>
                    </div>
                    <div class="m-stat-box m-stat-box--pct">
                        <span class="m-stat-box__val">${pct}%</span>
                        <span class="m-stat-box__label">Time Saved</span>
                    </div>
                </div>

                <div class="m-preview-player">
                    ${isVideo ? `
                        <video controls playsinline preload="auto" src="${downUrl}" class="m-video-player"></video>
                    ` : `
                        <div class="m-audio-player-wrap">
                            <span class="m-player-title">Clean Audio Preview</span>
                            <audio controls preload="auto" playsinline src="${downUrl}" class="m-audio-player"></audio>
                        </div>
                    `}
                </div>

                <div class="m-result-actions">
                    <a href="${downUrl || (res.download_url ? `${res.download_url}?download=1&name=${encodeURIComponent(isVideo ? 'clean_jumpcut_video.mp4' : 'clean_audio.mp3')}` : '#')}" download="${isVideo ? 'clean_jumpcut_video.mp4' : 'clean_audio.mp3'}" class="m-btn-download" id="btn-secure-download" style="text-decoration:none; display:flex; align-items:center; justify-content:center; gap:10px;">
                        <span>${icons.download}</span>
                        <span>Download High Quality ${isVideo ? 'MP4 Video' : 'MP3 Audio'} (फ़ोन में सेव करें)</span>
                    </a>
                    <button type="button" class="m-btn-secondary" id="btn-process-another">
                        <span>${icons.refresh}</span>
                        <span>Process Another</span>
                    </button>
                </div>
            </section>
        `;
    }

    function setupToolScreenEvents() {
        const backBtn = document.getElementById('m-btn-back');
        if (backBtn) {
            backBtn.addEventListener('click', () => {
                state.currentTool = null;
                state.result = null;
                render();
            });
        }

        const resetTopBtn = document.getElementById('m-btn-reset-top');
        if (resetTopBtn) {
            resetTopBtn.addEventListener('click', () => {
                state.singleFile = null;
                state.mergeFiles = [];
                state.result = null;
                state.errorMessage = null;
                render();
            });
        }

        const tabSingle = document.getElementById('tab-mode-single');
        const tabMerge = document.getElementById('tab-mode-merge');
        if (tabSingle && tabMerge) {
            tabSingle.addEventListener('click', () => {
                if (state.activeMode !== 'single') {
                    state.activeMode = 'single';
                    state.result = null;
                    state.errorMessage = null;
                    render();
                }
            });
            tabMerge.addEventListener('click', () => {
                if (state.activeMode !== 'merge') {
                    state.activeMode = 'merge';
                    state.result = null;
                    state.errorMessage = null;
                    render();
                }
            });
        }

        const singleDropzone = document.getElementById('m-single-dropzone');
        const singleInput = document.getElementById('m-single-input');
        if (singleDropzone && singleInput) {
            singleDropzone.addEventListener('click', () => singleInput.click());
            singleInput.addEventListener('change', async (e) => {
                if (e.target.files && e.target.files[0]) {
                    const f = e.target.files[0];
                    state.singleFile = f;
                    state.result = null;
                    state.errorMessage = null;
                    render();

                    const c = await captureVideoThumbnail(f);
                    if (c) f._thumbUrl = c.thumbUrl;
                    if (state.singleFile === f) render();
                }
            });
        }

        const removeSingleBtn = document.getElementById('btn-remove-single');
        if (removeSingleBtn) {
            removeSingleBtn.addEventListener('click', () => {
                state.singleFile = null;
                state.result = null;
                render();
            });
        }

        const mergeDropzone = document.getElementById('m-merge-dropzone');
        const mergeInput = document.getElementById('m-merge-input');
        if (mergeDropzone && mergeInput) {
            mergeDropzone.addEventListener('click', () => mergeInput.click());
            mergeInput.addEventListener('change', async (e) => {
                if (e.target.files && e.target.files.length > 0) {
                    const newFiles = Array.from(e.target.files);
                    let combined = state.mergeFiles.concat(newFiles);
                    if (combined.length > MAX_MERGE_FILES) combined = combined.slice(0, MAX_MERGE_FILES);
                    state.mergeFiles = smartSortFiles(combined);
                    state.result = null;
                    state.errorMessage = null;
                    render();

                    for (let f of state.mergeFiles) {
                        if (!f._thumbUrl) {
                            const c = await captureVideoThumbnail(f);
                            if (c) f._thumbUrl = c.thumbUrl;
                        }
                    }
                    render();
                }
            });
        }

        document.querySelectorAll('.btn-preview-item').forEach(el => {
            el.addEventListener('click', (e) => {
                e.stopPropagation();
                if (el.dataset.single === '1' && state.singleFile) {
                    openPreviewModal(state.singleFile, state.singleFile.name);
                } else {
                    const idx = parseInt(el.getAttribute('data-preview-index'), 10);
                    if (!isNaN(idx) && state.mergeFiles[idx]) {
                        const file = state.mergeFiles[idx];
                        openPreviewModal(file, `Part #${idx + 1}: ${file.name}`);
                    }
                }
            });
        });

        document.querySelectorAll('.btn-move-up').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const idx = parseInt(btn.getAttribute('data-index'), 10);
                if (idx > 0 && idx < state.mergeFiles.length) {
                    const temp = state.mergeFiles[idx];
                    state.mergeFiles[idx] = state.mergeFiles[idx - 1];
                    state.mergeFiles[idx - 1] = temp;
                    render();
                }
            });
        });

        document.querySelectorAll('.btn-move-down').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const idx = parseInt(btn.getAttribute('data-index'), 10);
                if (idx >= 0 && idx < state.mergeFiles.length - 1) {
                    const temp = state.mergeFiles[idx];
                    state.mergeFiles[idx] = state.mergeFiles[idx + 1];
                    state.mergeFiles[idx + 1] = temp;
                    render();
                }
            });
        });

        document.querySelectorAll('.m-part-remove').forEach(btn => {
            btn.addEventListener('click', () => {
                const idx = parseInt(btn.getAttribute('data-remove-index'), 10);
                if (!isNaN(idx)) {
                    state.mergeFiles.splice(idx, 1);
                    state.result = null;
                    render();
                }
            });
        });

        const minDurInput = document.getElementById('m-input-min-dur');
        const minDurVal = document.getElementById('m-val-min-dur');
        if (minDurInput && minDurVal) {
            minDurInput.addEventListener('input', () => {
                state.minSilence = parseFloat(minDurInput.value);
                minDurVal.textContent = state.minSilence.toFixed(2) + 's';
            });
        }

        const thresholdSelect = document.getElementById('m-select-threshold');
        if (thresholdSelect) {
            thresholdSelect.addEventListener('change', () => {
                state.silenceThreshold = parseFloat(thresholdSelect.value);
            });
        }

        const paddingSelect = document.getElementById('m-select-padding');
        if (paddingSelect) {
            paddingSelect.addEventListener('change', () => {
                state.silencePadding = parseFloat(paddingSelect.value);
            });
        }

        const processBtn = document.getElementById('btn-process-action');
        if (processBtn) processBtn.addEventListener('click', startProcessing);

        const secureDownloadBtn = document.getElementById('btn-secure-download');
        if (secureDownloadBtn) {
            secureDownloadBtn.addEventListener('click', (e) => {
                e.preventDefault();
                const isVideo = state.currentTool === 'video-jumpcut';
                triggerSecureBlobDownload(isVideo);
            });
        }

        const processAnotherBtn = document.getElementById('btn-process-another');
        if (processAnotherBtn) {
            processAnotherBtn.addEventListener('click', () => {
                state.singleFile = null;
                state.mergeFiles = [];
                state.result = null;
                state.errorMessage = null;
                render();
            });
        }
    }

    async function triggerSecureBlobDownload(isVideo) {
        const res = state.result;
        if (!res || !res.download_url) return;

        const btn = document.getElementById('btn-secure-download');
        const fileName = isVideo ? 'clean_jumpcut_video.mp4' : 'clean_audio.mp3';
        await triggerDeviceDownload({
            blob: state.resultBlob,
            url: res.download_url,
            fileName: fileName,
            isVideo: isVideo,
            btnEl: btn,
            statusBoxEl: null,
            directLinkEl: null
        });
    }

    function updateProgressDOM(stage, pct) {
        state.processingStage = stage;
        state.overallPercent = pct;
        const textEl = document.getElementById('m-progress-stage-text');
        const pctEl = document.getElementById('m-progress-pct-text');
        const fillEl = document.getElementById('m-progress-fill');
        if (textEl) textEl.textContent = stage;
        if (pctEl) pctEl.textContent = pct + '%';
        if (fillEl) fillEl.style.width = pct + '%';
    }

    function uploadSinglePartPromise(file, jobId, partIndex, totalParts, onProgress) {
        return new Promise((resolve, reject) => {
            const formData = new FormData();
            formData.append('file', file, file.name);
            formData.append('jobId', jobId);
            formData.append('partIndex', String(partIndex));
            formData.append('fileName', file.name);

            const xhr = new XMLHttpRequest();
            xhr.open('POST', '/upload-part', true);
            xhr.withCredentials = true;
            xhr.timeout = 300000;

            xhr.upload.onprogress = (e) => {
                if (e.lengthComputable && e.total > 0 && typeof onProgress === 'function') {
                    onProgress(e.loaded, e.total);
                }
            };

            xhr.onload = () => {
                const raw = (xhr.responseText || '').trim();
                let res = null;
                try {
                    res = JSON.parse(raw);
                } catch (e) {
                    const match = raw.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i) || raw.match(/<title>([^<]*)<\/title>/i);
                    const serverMsg = match ? match[1].replace(/<[^>]+>/g, '').trim() : (raw ? raw.slice(0, 100) : `HTTP ${xhr.status}`);
                    return reject(new Error(serverMsg || `Upload error on part ${partIndex + 1}`));
                }

                if (xhr.status >= 200 && xhr.status < 300) {
                    if (res && res.success) resolve(res);
                    else reject(new Error((res && res.error) || `Part ${partIndex + 1} upload failed`));
                } else {
                    reject(new Error((res && res.error) || `Server error ${xhr.status} uploading part ${partIndex + 1}`));
                }
            };

            xhr.ontimeout = () => reject(new Error(`पार्ट ${partIndex + 1} अपलोड समय समाप्त (Timeout)`));
            xhr.onerror = () => reject(new Error(`पार्ट ${partIndex + 1} अपलोड करते समय नेटवर्क एरर।`));
            xhr.send(formData);
        });
    }

    async function uploadSinglePartWithRetry(file, jobId, partIndex, totalParts, onProgress, maxRetries = 3) {
        let lastErr = null;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                return await uploadSinglePartPromise(file, jobId, partIndex, totalParts, onProgress);
            } catch (err) {
                lastErr = err;
                console.warn(`Part ${partIndex + 1} upload attempt ${attempt} failed:`, err.message);
                if (attempt < maxRetries) {
                    const isCookieOrAuth = err.message && (err.message.includes('Cookie check') || err.message.includes('Session') || err.message.includes('403'));
                    if (isCookieOrAuth) {
                        await syncSessionCookie();
                    }
                    updateProgressDOM(`Retrying Part ${partIndex + 1} (Attempt ${attempt + 1}/${maxRetries})...`, state.overallPercent);
                    await new Promise(r => setTimeout(r, 1200 * attempt));
                }
            }
        }
        throw lastErr || new Error(`Failed to upload part ${partIndex + 1} after ${maxRetries} attempts`);
    }

    async function startProcessing() {
        const isVideo = state.currentTool === 'video-jumpcut';
        const isMerge = state.activeMode === 'merge';

        if (isMerge && state.mergeFiles.length === 0) return;
        if (!isMerge && !state.singleFile) return;

        state.isProcessing = true;
        state.errorMessage = null;
        state.result = null;
        state.overallPercent = 0;
        state.processingStage = 'Starting Cloud Session...';
        render();

        try {
            const jobId = 'job_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);

            if (isMerge) {
                const orderedParts = state.mergeFiles;
                const totalParts = orderedParts.length;
                const totalSize = orderedParts.reduce((sum, f) => sum + f.size, 0);

                let completedBytes = 0;
                const uploadStartTime = Date.now();

                // Sequential ordered upload: Prevents connection drops, socket exhaustion, and Cloud Run proxy throttling
                for (let idx = 0; idx < totalParts; idx++) {
                    const file = orderedParts[idx];
                    const bytesBeforePart = completedBytes;

                    await uploadSinglePartWithRetry(file, jobId, idx, totalParts, (loaded, partTotal) => {
                        const currentLoaded = bytesBeforePart + loaded;
                        const overallFraction = totalSize > 0 ? (currentLoaded / totalSize) : 0;
                        const overallPct = Math.min(80, Math.round(overallFraction * 80));

                        const elapsedSec = (Date.now() - uploadStartTime) / 1000;
                        const speedBps = elapsedSec > 0.2 ? (currentLoaded / elapsedSec) : 0;
                        const speedText = speedBps > 1024 * 1024 
                            ? (speedBps / (1024 * 1024)).toFixed(1) + ' MB/s' 
                            : (speedBps / 1024).toFixed(0) + ' KB/s';

                        const partPct = partTotal > 0 ? Math.round((loaded / partTotal) * 100) : 0;
                        updateProgressDOM(
                            `⚡ Uploading Part ${idx + 1}/${totalParts} (${partPct}% · ${formatBytes(currentLoaded)} / ${formatBytes(totalSize)} · ${speedText})...`,
                            overallPct
                        );
                    });

                    completedBytes = bytesBeforePart + file.size;
                }

                updateProgressDOM('Cloud FFmpeg: Merging in exact serial order & cutting dead air...', 85);

                let processResp = null;
                for (let pAttempt = 1; pAttempt <= 2; pAttempt++) {
                    try {
                        processResp = await fetch('/process-parts', {
                            method: 'POST',
                            credentials: 'include',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                jobId: jobId,
                                minSilence: state.minSilence,
                                threshold: state.silenceThreshold,
                                padding: state.silencePadding,
                                is_video: isVideo
                            })
                        });
                        if (processResp.ok) break;
                    } catch (netErr) {
                        if (pAttempt === 1) {
                            await syncSessionCookie();
                            await new Promise(r => setTimeout(r, 1000));
                        } else {
                            throw netErr;
                        }
                    }
                }

                if (!processResp) throw new Error('सर्वर से कनेक्ट नहीं हो सका।');
                const rawProcess = await processResp.text();
                let data;
                try {
                    data = JSON.parse(rawProcess);
                } catch (e) {
                    const match = rawProcess.match(/<title>([^<]*)<\/title>/i);
                    throw new Error(match ? match[1].trim() : 'सर्वर का रिस्पॉन्स पढ़ने में त्रुटि।');
                }

                if (!processResp.ok || !data.success) {
                    throw new Error(data.error || 'FFmpeg processing failed on server');
                }

                updateProgressDOM('Finalizing audio preview...', 95);
                state.result = data;
                state.resultBlob = null;
                state.resultBlobUrl = null;

                if (data.download_url) {
                    try {
                        const r = await fetch(data.download_url);
                        if (r.ok) {
                            const b = await r.blob();
                            state.resultBlob = b;
                            state.resultBlobUrl = URL.createObjectURL(b);
                        }
                    } catch (bErr) {
                        console.warn("Could not pre-fetch result blob:", bErr);
                    }
                }

                updateProgressDOM('Completed!', 100);
                state.isProcessing = false;

                addProjectHistory({
                    type: 'jumpcut',
                    title: `Jump-Cut Merge (${data.parts_count || totalParts} Parts)`,
                    itemCount: data.parts_count || totalParts,
                    downloadUrl: data.download_url
                });

                render();

            } else {
                const file = state.singleFile;
                if (file.size > SINGLE_PART_MAX_BYTES) {
                    throw new Error(`फ़ाइल का साइज़ (${formatBytes(file.size)}) 45 MB से अधिक है।`);
                }

                const formData = new FormData();
                formData.append(isVideo ? 'video' : 'audio', file, file.name);
                formData.append('minSilence', String(state.minSilence));
                formData.append('threshold', String(state.silenceThreshold));
                formData.append('padding', String(state.silencePadding));

                const endpoint = isVideo 
                    ? `/video-silence-trim?minSilence=${state.minSilence}&threshold=${state.silenceThreshold}&padding=${state.silencePadding}&nocache=${Date.now()}`
                    : `/silence-trim?minSilence=${state.minSilence}&threshold=${state.silenceThreshold}&padding=${state.silencePadding}&nocache=${Date.now()}`;

                const xhr = new XMLHttpRequest();
                xhr.open('POST', endpoint, true);
                xhr.withCredentials = true;
                xhr.timeout = 600000;

                xhr.upload.onprogress = (e) => {
                    if (e.lengthComputable && e.total > 0) {
                        const pct = Math.round((e.loaded / e.total) * 75);
                        updateProgressDOM(`Uploading ${formatBytes(e.loaded)} of ${formatBytes(e.total)} (${pct}%)...`, pct);
                    }
                };

                xhr.onload = async () => {
                    const raw = (xhr.responseText || '').trim();
                    if (xhr.status >= 200 && xhr.status < 300) {
                        try {
                            const data = JSON.parse(raw);
                            if (data.success) {
                                updateProgressDOM('Finalizing audio preview...', 95);
                                state.result = data;
                                state.resultBlob = null;
                                state.resultBlobUrl = null;

                                if (data.download_url) {
                                    try {
                                        const r = await fetch(data.download_url);
                                        if (r.ok) {
                                            const b = await r.blob();
                                            state.resultBlob = b;
                                            state.resultBlobUrl = URL.createObjectURL(b);
                                        }
                                    } catch (bErr) {
                                        console.warn("Could not pre-fetch result blob:", bErr);
                                    }
                                }

                                updateProgressDOM('Done!', 100);
                                state.isProcessing = false;

                                addProjectHistory({
                                    type: 'jumpcut',
                                    title: `Jump-Cut Single (${file.name})`,
                                    itemCount: 1,
                                    downloadUrl: data.download_url
                                });

                                render();
                            } else {
                                state.isProcessing = false;
                                state.errorMessage = data.error || 'Video trim failed';
                                render();
                            }
                        } catch (e) {
                            state.isProcessing = false;
                            state.errorMessage = 'सर्वर रिस्पॉन्स पढ़ने में त्रुटि।';
                            render();
                        }
                    } else {
                        state.isProcessing = false;
                        state.errorMessage = `Server error ${xhr.status}`;
                        render();
                    }
                };

                xhr.onerror = () => {
                    state.isProcessing = false;
                    state.errorMessage = 'सर्वर से कनेक्शन कट गया। कृपया इंटरनेट चेक करें।';
                    render();
                };

                xhr.timeout = 600000;
                xhr.send(formData);
            }

        } catch (err) {
            console.error('Processing error:', err);
            state.isProcessing = false;
            state.errorMessage = err.message || 'Processing failed.';
            render();
        }
    }

    // ── 5. STUDIO DOCUMENTATION & ARCHITECTURE SCREEN ────────────
    function renderDocsScreen() {
        const activeTab = state.docsActiveTab || 'all-tools';
        const q = (state.docsSearchQuery || '').toLowerCase().trim();

        rootEl.innerHTML = `
            <div class="m-app-shell">
                <header class="m-tool-header">
                    <button type="button" class="m-back-btn" id="m-docs-btn-back" aria-label="Back to home">
                        ${icons.back}
                    </button>
                    <div class="m-tool-header__title">Studio Documentation</div>
                    <div class="m-tool-header__action">
                        <button type="button" class="m-header__docs-btn" id="m-btn-copy-docs" title="Copy documentation summary">
                            📋 Copy Summary
                        </button>
                    </div>
                </header>

                <main class="m-docs-container">
                    <div class="m-docs-hero">
                        <div class="m-docs-hero__title">
                            <span>📖</span>
                            <span>AutoEditor Pro — सम्पूर्ण सिस्टम डॉक्यूमेंटेशन</span>
                        </div>
                        <div class="m-docs-hero__subtitle">
                            स्टूडियो के सभी टूल्स, अंदरूनी फंक्शंस, बैकएंड मीडिया इंजन और बिना ब्लर लोगो हटाने की विस्तृत तकनीकी गाइड।
                        </div>
                    </div>

                    <div class="m-docs-search-bar">
                        <span class="m-docs-search-icon">🔍</span>
                        <input type="text" class="m-docs-search-input" id="m-docs-search-input" 
                               placeholder="टूल्स, इंजन या फंक्शंस खोजें (उदा: FFmpeg, delogo, sort)..." 
                               value="${escapeHTML(state.docsSearchQuery || '')}">
                    </div>

                    <div class="m-docs-nav-tabs" role="tablist">
                        <button type="button" class="m-docs-nav-btn ${activeTab === 'all-tools' ? 'is-active' : ''}" data-tab="all-tools">
                            🛠️ सभी टूल्स (Tools)
                        </button>
                        <button type="button" class="m-docs-nav-btn ${activeTab === 'engines' ? 'is-active' : ''}" data-tab="engines">
                            ⚙️ बैकएंड इंजन (Engines)
                        </button>
                        <button type="button" class="m-docs-nav-btn ${activeTab === 'functions' ? 'is-active' : ''}" data-tab="functions">
                            🔬 कोड फंक्शंस (Functions)
                        </button>
                        <button type="button" class="m-docs-nav-btn ${activeTab === 'blur-solution' ? 'is-active' : ''}" data-tab="blur-solution">
                            💡 ब्लर-फ्री वाटरमार्क गाइड
                        </button>
                        <button type="button" class="m-docs-nav-btn ${activeTab === 'integration' ? 'is-active' : ''}" data-tab="integration">
                            🔌 ऐप इंटीग्रेशन (Architecture)
                        </button>
                    </div>

                    <div id="m-docs-tab-content">
                        ${renderDocsTabContent(activeTab, q)}
                    </div>
                </main>
            </div>
        `;

        // Event Listeners
        document.getElementById('m-docs-btn-back').addEventListener('click', () => {
            state.currentTool = null;
            render();
        });

        const searchInput = document.getElementById('m-docs-search-input');
        searchInput.addEventListener('input', (e) => {
            state.docsSearchQuery = e.target.value;
            const contentEl = document.getElementById('m-docs-tab-content');
            if (contentEl) {
                contentEl.innerHTML = renderDocsTabContent(state.docsActiveTab || 'all-tools', state.docsSearchQuery.toLowerCase().trim());
                bindDocsCardButtons();
            }
        });

        document.querySelectorAll('.m-docs-nav-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                state.docsActiveTab = btn.getAttribute('data-tab');
                renderDocsScreen();
            });
        });

        const copyBtn = document.getElementById('m-btn-copy-docs');
        if (copyBtn) {
            copyBtn.addEventListener('click', () => {
                const summaryText = `AutoEditor Pro - System Documentation Summary\n\n1. Tools: Video Jump-Cut, Auto Silence Remover, Bulk Watermark Studio, Merge Audio, Watermark Remover\n2. Engines: FFmpeg 6.x, Python 3 Workers, Node.js Express REST API, Web Audio API, Canvas WYSIWYG, AI Temporal Inpainting (ProPainter)\n3. Blur-free Logo Removal: Traditional delogo produces average color blur. True blur-free removal uses AI Optical Flow (ProPainter) or DaVinci Resolve Clone Stamp.\n4. Documentation File: See STUDIO_TOOLS_ARCHITECTURE_DOCUMENT.md in root for complete source code & math specifications.`;
                navigator.clipboard.writeText(summaryText).then(() => {
                    copyBtn.textContent = '✅ Copied!';
                    setTimeout(() => { copyBtn.textContent = '📋 Copy Summary'; }, 2000);
                }).catch(() => {
                    alert('Summary copied to clipboard!');
                });
            });
        }

        bindDocsCardButtons();
    }

    function bindDocsCardButtons() {
        document.querySelectorAll('[data-launch-tool]').forEach(btn => {
            btn.addEventListener('click', () => {
                const toolKey = btn.getAttribute('data-launch-tool');
                selectTool(toolKey);
            });
        });
    }

    function renderDocsTabContent(activeTab, q) {
        if (activeTab === 'all-tools') {
            const tools = [
                {
                    id: 'bulk-watermark',
                    name: 'Bulk Watermark Studio (बल्क वॉटरमार्क)',
                    badge: '100% WYSIWYG',
                    desc: 'एक साथ कई वीडियो पर ब्रांड लोगो, चैनल वॉटरमार्क या टेक्स्ट बैज लगाना। 100% WYSIWYG मैचिंग (कैनवास और FFmpeg आउटपुट में शून्य गणितीय विसंगति)।',
                    engine: 'Python 3 watermark_engine.py + FFmpeg overlay filter + Zipfile',
                    features: ['4-Way D-Pad Arrow Buttons', '9-Grid Preset Positions', 'Responsive 0.0-100.0% Normalized Coordinates', 'Single-Click ZIP Package Download']
                },
                {
                    id: 'watermark-remover',
                    name: 'Watermark Remover (अनचाहा लोगो रिमूवर)',
                    badge: 'Smart Delogo & AI Guide',
                    desc: 'वीडियो से अनचाहे वॉटरमार्क, चैनल लोगो या टाइमस्टैम्प हटाना। स्मार्ट FFmpeg डेलोगो फेदर-बैंड स्मूथिंग और 100% ब्लर-फ्री ProPainter AI पाइपलाइन गाइड।',
                    engine: 'FFmpeg delogo filter (band=1..10) + AI Optical Flow Inpainting Pipeline',
                    features: ['Interactive Live Frame Bounding Box', '4 Corner Presets (TR, TL, BR, BL)', 'Adjustable Feather Band', '0-Cost Free HuggingFace ProPainter Workflow']
                },
                {
                    id: 'merge-audio',
                    name: 'Merge Audio Studio (मल्टी-ट्रैक ऑडियो मर्जर)',
                    badge: 'Dual Player & Waveform',
                    desc: 'कई ऑडियो फाइलों को एक सीमलेस मास्टर ऑडियो में जोड़ना। ऊपर ओरिजिनल प्रीव्यू प्लेयर और नीचे फाइनल मर्ज्ड रिजल्ट प्लेयर ताकि कोई भ्रम न रहे।',
                    engine: 'HTML5 Web Audio API + AudioContext Waveform + FFmpeg concat demuxer',
                    features: ['Separate Preview and Merged Audio Players', 'Multi-Track Visual Waveform', 'Joint Point Transition Listeners', '320kbps High-Bitrate MP3 Export']
                },
                {
                    id: 'video-jumpcut',
                    name: 'Video Jump-Cut (वीडियो साइलेंस ट्रिमर)',
                    badge: 'Multi-Part & Single',
                    desc: 'वीडियो से सन्नाटा (Dead Air, Pauses) काटकर वीडियो को फास्ट-पेस्ड बनाना। सिंगल वीडियो और पार्ट 1, 2, 3... क्लिप्स को नेचुरल सीरियल सॉर्टिंग के साथ जोड़ना।',
                    engine: 'FFmpeg silencedetect + Python silence_cutter.py + Node.js Worker',
                    features: ['Smart Natural Serial Sorting (Part 1, 2, ... 10)', 'Decibel & Millisecond Silence Trimming', 'Zero-Loss Video Stitching', 'H.264 Universal MP4']
                },
                {
                    id: 'silence-remover',
                    name: 'Auto Silence Remover (ऑडियो साइलेंस रिमूवर)',
                    badge: 'Speech Cleaner',
                    desc: 'पॉडकास्ट, वॉयसओवर और स्पीच ऑडियो ट्रैक्स से सांस लेने की आवाज़, बैकग्राउंड हम और अनचाहे पॉज को सेकंड के सौवें हिस्से की शुद्धता से काटना।',
                    engine: 'Web Audio API + FFmpeg Audio Filter Graph + MP3 Encoder',
                    features: ['Acoustic Noise Gate', 'Custom Threshold (-20dB to -50dB)', 'Real-time Waveform Preview', 'Studio Master Quality']
                }
            ];

            const filtered = q ? tools.filter(t => t.name.toLowerCase().includes(q) || t.desc.toLowerCase().includes(q) || t.engine.toLowerCase().includes(q)) : tools;

            if (filtered.length === 0) {
                return `<div class="m-docs-card"><p class="m-docs-card__text" style="text-align:center;padding:20px;">कोई टूल नहीं मिला। कृपया दूसरा कीवर्ड खोजें।</p></div>`;
            }

            return filtered.map(t => `
                <div class="m-docs-card">
                    <div class="m-docs-card__header">
                        <div class="m-docs-card__title">
                            <span>🛠️</span>
                            <span>${t.name}</span>
                        </div>
                        <span class="m-docs-card__badge">${t.badge}</span>
                    </div>
                    <p class="m-docs-card__text">${t.desc}</p>
                    <div style="margin-bottom:10px;">
                        <span style="font-size:11px;font-weight:700;color:#94a3b8;">इंजन: </span>
                        <code style="font-size:11px;color:#38bdf8;background:rgba(56,189,248,0.1);padding:2px 6px;border-radius:4px;">${t.engine}</code>
                    </div>
                    <div class="m-docs-function-list">
                        ${t.features.map(f => `<div class="m-docs-fn-item"><span style="color:#10b981;">✓</span> <span class="m-docs-fn-desc">${f}</span></div>`).join('')}
                    </div>
                    <div style="margin-top:12px;text-align:right;">
                        <button type="button" class="m-btn-history-dl" data-launch-tool="${t.id}" style="display:inline-flex;">
                            🚀 टूल खोलें (Open Tool) →
                        </button>
                    </div>
                </div>
            `).join('');
        }

        if (activeTab === 'engines') {
            return `
                <div class="m-docs-card">
                    <div class="m-docs-card__header">
                        <div class="m-docs-card__title">
                            <span>⚡</span>
                            <span>1. FFmpeg Core Media Engine</span>
                        </div>
                        <span class="m-docs-card__badge">C / Assembly</span>
                    </div>
                    <p class="m-docs-card__text">
                        FFmpeg पूरे स्टूडियो का मुख्य वर्कहॉर्स है। यह सर्वर पर बैकग्राउंड में वीडियो और ऑडियो को बिना किसी क्वालिटी नुकसान के रेंडर करता है।
                    </p>
                    <div class="m-docs-table-wrapper">
                        <table class="m-docs-table">
                            <thead>
                                <tr><th>फ़िल्टर / मॉड्यूल</th><th>उपयोग</th><th>कमांड उदाहरण</th></tr>
                            </thead>
                            <tbody>
                                <tr>
                                    <td><code>overlay</code></td>
                                    <td>वॉटरमार्क और लोगो ओवरले</td>
                                    <td><code>[0:v][1:v]overlay=x:y:format=auto</code></td>
                                </tr>
                                <tr>
                                    <td><code>delogo</code></td>
                                    <td>अनचाहा लोगो और वॉटरमार्क हटाना</td>
                                    <td><code>delogo=x=40:y=40:w=160:h=80:band=2</code></td>
                                </tr>
                                <tr>
                                    <td><code>silencedetect</code></td>
                                    <td>सन्नाटे और पॉज का पता लगाना</td>
                                    <td><code>silencedetect=noise=-30dB:d=0.5</code></td>
                                </tr>
                                <tr>
                                    <td><code>concat</code></td>
                                    <td>वीडियो और ऑडियो क्लिप्स को जोड़ना</td>
                                    <td><code>-f concat -safe 0 -i list.txt</code></td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </div>

                <div class="m-docs-card">
                    <div class="m-docs-card__header">
                        <div class="m-docs-card__title">
                            <span>🐍</span>
                            <span>2. Python 3 Worker Engine</span>
                        </div>
                        <span class="m-docs-card__badge">Python 3.10+</span>
                    </div>
                    <p class="m-docs-card__text">
                        पायथन स्क्रिप्ट्स जटिल मीडिया आर्केस्ट्रेशन, 100% WYSIWYG नॉर्मलाइज्ड गणितीय गणना और ऑटो-पैकेजिंग संभालती हैं।
                    </p>
                    <div class="m-docs-function-list">
                        <div class="m-docs-fn-item">
                            <span class="m-docs-fn-name">watermark_engine.py</span>
                            <div class="m-docs-fn-desc">लाइव कैनवास से मिले (normXPct, normYPct, normWPct) को वीडियो के वास्तविक रिज़ॉल्यूशन (1080p, 4K, 720p) में पिक्सेल-परफेक्ट कन्वर्ट करता है और बैच जिप बनाता है।</div>
                        </div>
                        <div class="m-docs-fn-item">
                            <span class="m-docs-fn-name">silence_cutter.py</span>
                            <div class="m-docs-fn-desc">ऑडियो डेसिबल वेवफॉर्म का विश्लेषण करके साइलेंस कट्स को मिलीसेकंड स्तर पर ट्रिम करता है।</div>
                        </div>
                    </div>
                </div>

                <div class="m-docs-card">
                    <div class="m-docs-card__header">
                        <div class="m-docs-card__title">
                            <span>🟢</span>
                            <span>3. Node.js Express REST Backend</span>
                        </div>
                        <span class="m-docs-card__badge">Express (Port 3000)</span>
                    </div>
                    <p class="m-docs-card__text">
                        <code>bundle.cjs</code> और <code>server.js</code> संपूर्ण वेब सर्वर को होस्ट करते हैं। यह मल्टीपार्ट स्ट्रीमिंग अपलोड, जॉब सत्र और सुरक्षा संभालता है।
                    </p>
                    <div class="m-docs-highlight-box">
                        <strong>ऑटो-रिकवरी इंजन:</strong> यदि कोई प्रक्रिया बाधित होती है, तो Node.js सर्वर अपने <code>ensureFrontendAssets()</code> रूटीन के माध्यम से फ्रंटएंड एसेट्स को री-सिंक करता है।
                    </div>
                </div>

                <div class="m-docs-card">
                    <div class="m-docs-card__header">
                        <div class="m-docs-card__title">
                            <span>🧠</span>
                            <span>4. AI Video Inpainting Engine (ProPainter & LaMa)</span>
                        </div>
                        <span class="m-docs-card__badge">PyTorch / Optical Flow</span>
                    </div>
                    <p class="m-docs-card__text">
                        बिना ब्लर लोगो हटाने के लिए डीप लर्निंग टेंपोरल ऑप्टिकल फ्लो का उपयोग किया जाता है। यह मॉडल पिछले और अगले वीडियो फ्रेम्स से ओरिजिनल बैकग्राउंड को ढूंढकर बिना किसी धुंधलेपन के भर देता है।
                    </p>
                </div>
            `;
        }

        if (activeTab === 'functions') {
            return `
                <div class="m-docs-card">
                    <div class="m-docs-card__header">
                        <div class="m-docs-card__title">
                            <span>🔬</span>
                            <span>मुख्य अंदरूनी कोड फंक्शंस (Core Internal Functions)</span>
                        </div>
                        <span class="m-docs-card__badge">Logic Specs</span>
                    </div>
                    <div class="m-docs-function-list">
                        <div class="m-docs-fn-item">
                            <span class="m-docs-fn-name">apply_watermark_normalized(video_in, wm_img, norm_x, norm_y, norm_w, opacity)</span>
                            <div class="m-docs-fn-desc"><strong>स्थान:</strong> watermark_engine.py<br><strong>लॉजिक:</strong> कैनवास से मिले प्रतिशत के आधार पर: <code>scale_w = vid_w * (norm_w / 100)</code>, <code>pos_x = vid_w * (norm_x / 100)</code>। इससे हर वीडियो रिज़ॉल्यूशन पर 1:1 सटीक प्लेसमेंट मिलती है।</div>
                        </div>
                        <div class="m-docs-fn-item">
                            <span class="m-docs-fn-name">smartNaturalSort(partsArray)</span>
                            <div class="m-docs-fn-desc"><strong>स्थान:</strong> silence_ui.js<br><strong>लॉजिक:</strong> <code>part1.mp4, part10.mp4, part2.mp4</code> को स्वाभाविक गणितीय क्रम <code>part1, part2, ... part10</code> में सॉर्ट करता है ताकि वीडियो के पार्ट्स कभी उल्टे न जुड़ें।</div>
                        </div>
                        <div class="m-docs-fn-item">
                            <span class="m-docs-fn-name">drawMultiTrackWaveform(audioCtx, buffers)</span>
                            <div class="m-docs-fn-desc"><strong>स्थान:</strong> silence_ui.js<br><strong>लॉजिक:</strong> Web Audio API से PCM ऑडियो सैंपल्स निकालकर HTML5 कैनवास पर टाइमलाइन बार्स और जॉइंट पॉइंट मार्कर गोल्डन लाइन ड्रॉ करता है।</div>
                        </div>
                        <div class="m-docs-fn-item">
                            <span class="m-docs-fn-name">delogoFilter(x, y, w, h, band)</span>
                            <div class="m-docs-fn-desc"><strong>स्थान:</strong> bundle.cjs (/api/watermark/remove)<br><strong>लॉजिक:</strong> FFmpeg के <code>delogo</code> फ़िल्टर को बाउंडिंग बॉक्स पास करता है। <code>band=2</code> किनारे के पिक्सल्स को स्मूथ फेदरिंग प्रदान करता है।</div>
                        </div>
                        <div class="m-docs-fn-item">
                            <span class="m-docs-fn-name">create_zip_archive(files_list, zip_path)</span>
                            <div class="m-docs-fn-desc"><strong>स्थान:</strong> watermark_engine.py<br><strong>लॉजिक:</strong> सभी प्रोसेस्ड वीडियो फाइलों को एक ही आर्काइव में पैक करता है ताकि यूज़र को 1 क्लिक में डाउनलोड मिल सके।</div>
                        </div>
                    </div>
                </div>
            `;
        }

        if (activeTab === 'blur-solution') {
            return `
                <div class="m-docs-card">
                    <div class="m-docs-card__header">
                        <div class="m-docs-card__title">
                            <span>🔍</span>
                            <span>पिक्सल्स हटाने पर ब्लर क्यों आता है?</span>
                        </div>
                        <span class="m-docs-card__badge">तकनीकी कारण</span>
                    </div>
                    <p class="m-docs-card__text">
                        जब आप सामान्य टूल (जैसे FFmpeg <code>delogo</code> या Premiere Pro Blur Mask) से लोगो हटाते हैं, तो वह टूल केवल लोगो के चारों तरफ के बॉर्डर पिक्सल्स का <strong>औसत (Average Interpolation)</strong> निकालता है। 
                        क्योंकि उस टूल को यह नहीं पता कि लोगो के पीछे क्या छिपा था, वह खाली जगह पर रंगों का एक धुंधला पैच (Blur Spot) छोड़ देता है।
                    </p>
                    <div class="m-docs-highlight-box">
                        <strong>असली हल:</strong> AI Video Inpainting (जैसे <strong>ProPainter</strong>)। वीडियो में कैमरा थोड़ा भी हिलता है तो लोगो के पीछे की ज़मीन या दीवार पिछले या अगले 10 फ्रेम्स में दिख जाती है। AI उन फ्रेम्स से ओरिजिनल पिक्सल्स को कॉपी करके यहाँ पेस्ट कर देता है — जिससे <strong>0% ब्लर और 100% ओरिजिनल क्वालिटी</strong> मिलती है!
                    </div>
                </div>

                <div class="m-docs-card">
                    <div class="m-docs-card__header">
                        <div class="m-docs-card__title">
                            <span>🎉</span>
                            <span>100% मुफ़्त तरीक़े (Free Methods — ₹0 खर्च)</span>
                        </div>
                        <span class="m-docs-card__badge">Zero Cost</span>
                    </div>
                    <div class="m-docs-function-list">
                        <div class="m-docs-fn-item">
                            <span class="m-docs-fn-name">तरीक़ा 1: Hugging Face Spaces (ProPainter Online Free)</span>
                            <div class="m-docs-fn-desc">
                                1. ब्राउज़र में <strong>huggingface.co/spaces</strong> खोलें और <code>sczhou/ProPainter</code> सर्च करें।<br>
                                2. यह पूरी तरह मुफ़्त क्लाउड GPU पर चलता है।<br>
                                3. अपना वीडियो अपलोड करें, ब्रश से लोगो पर मास्क फेरें और <em>Inpaint Video</em> पर क्लिक करें। आपको क्रिस्टल-क्लियर वीडियो मिलेगा बिना किसी चार्ज के!
                            </div>
                        </div>
                        <div class="m-docs-fn-item">
                            <span class="m-docs-fn-name">तरीक़ा 2: DaVinci Resolve Free Edition (Clone Stamp)</span>
                            <div class="m-docs-fn-desc">
                                1. दाविंची रिज़ॉल्व का 100% फ़्री वर्शन इस्तेमाल करें।<br>
                                2. Fusion पेज में जाएँ -> <code>Paint Tool</code> सिलेक्ट करें -> मोड को <code>Clone</code> करें।<br>
                                3. लोगो के ठीक बगल वाले टेक्सचर को लोगो पर स्टैम्प कर दें। ब्लर का नामोनिशान नहीं रहेगा।
                            </div>
                        </div>
                        <div class="m-docs-fn-item">
                            <span class="m-docs-fn-name">तरीक़ा 3: CapCut / Video Editor Crop-Overlay ट्रिक</span>
                            <div class="m-docs-fn-desc">
                                1. वीडियो को लेयर 1 पर रखें और उसी वीडियो को लेयर 2 (ऊपर) पर रखें।<br>
                                2. ऊपर वाली लेयर को केवल लोगो के आकार में क्रॉप करें और उसे 20 पिक्सेल ऊपर या नीचे सरका दें।<br>
                                3. किनारों पर 5% फेदर लगा दें। लोगो तुरंत गायब हो जाता है।
                            </div>
                        </div>
                    </div>
                </div>
            `;
        }

        if (activeTab === 'integration') {
            return `
                <div class="m-docs-card">
                    <div class="m-docs-card__header">
                        <div class="m-docs-card__title">
                            <span>🔌</span>
                            <span>यह सब कुछ इस एक ऐप में कैसे इंटीग्रेट हुआ है?</span>
                        </div>
                        <span class="m-docs-card__badge">Architecture</span>
                    </div>
                    <p class="m-docs-card__text">
                        AutoEditor Pro एक <strong>एकीकृत क्लाइंट-सर्वर स्टूडियो (Unified Client-Server Studio)</strong> है। इसमें सभी टूल्स अलग-अलग सॉफ़्टवेयर होने के बजाय एक ही सुव्यवस्थित इकोसिस्टम में काम करते हैं:
                    </p>
                    <div class="m-docs-function-list">
                        <div class="m-docs-fn-item">
                            <span class="m-docs-fn-name">1. सेंट्रल स्टेट मशीन (Single-Page App)</span>
                            <div class="m-docs-fn-desc">ब्राउज़र का फ्रंटएंड बिना पेज रीफ्रेश किए तुरंत टूल स्विच करता है। मेमोरी लीक रोकने के लिए हर टूल बदलते ही ऑडियो संदर्भ और वीडियो बफर्स को रीसेट किया जाता है।</div>
                        </div>
                        <div class="m-docs-fn-item">
                            <span class="m-docs-fn-name">2. यूनिफाइड एक्सप्रेस बैकएंड (Port 3000)</span>
                            <div class="m-docs-fn-desc">सभी टूल्स के लिए अलग-अलग REST एंडपॉइंट्स (<code>/video-silence-trim</code>, <code>/api/watermark/process</code>, <code>/api/watermark/remove</code>, <code>/api/audio/merge-only</code>) एक ही पोर्ट पर सुरक्षित चलते हैं।</div>
                        </div>
                        <div class="m-docs-fn-item">
                            <span class="m-docs-fn-name">3. सबप्रोसेस वर्कर आर्किटेक्चर</span>
                            <div class="m-docs-fn-desc">जब यूज़र हैवी टास्क रन करता है, तो Node.js सर्वर मुख्य थ्रेड को ब्लॉक नहीं करता, बल्कि अलग थ्रेड में FFmpeg या Python वर्कर को स्पॉन करता है।</div>
                        </div>
                        <div class="m-docs-fn-item">
                            <span class="m-docs-fn-name">4. प्रोजेक्ट हिस्ट्री व डायरेक्ट डाउनलोड</span>
                            <div class="m-docs-fn-desc">किसी भी टूल से बनी फाइल तुरंत लोकल हिस्ट्री में दर्ज हो जाती है और बिना एक्सपायर हुए सीधे डाउनलोड की जा सकती है।</div>
                        </div>
                    </div>
                </div>
            `;
        }

        return '';
    }

    // ── 6. WATERMARK REMOVER (DELOGO & AI GUIDE) SCREEN ───────────
    function renderWatermarkRemoverScreen() {
        const file = state.delogoFile;
        const dims = state.delogoVideoDims || { width: 1280, height: 720 };
        const box = state.delogoBox || { x: 40, y: 40, w: 180, h: 80, band: 2 };
        const res = state.delogoResult;

        rootEl.innerHTML = `
            <div class="m-app-shell">
                <header class="m-tool-header">
                    <button type="button" class="m-back-btn" id="m-delogo-btn-back" aria-label="Back to home">
                        ${icons.back}
                    </button>
                    <div class="m-tool-header__title">Watermark Remover</div>
                    <div class="m-tool-header__action">
                        ${file && !state.delogoIsProcessing ? `
                            <button type="button" class="m-clear-btn" id="m-delogo-btn-reset">Reset</button>
                        ` : ''}
                    </div>
                </header>

                <main class="m-tool-main">
                    ${!file ? `
                        <section class="m-card m-upload-card">
                            <div class="m-upload-dropzone" id="m-delogo-dropzone">
                                <div class="m-upload-icon-wrapper">${icons.eraser}</div>
                                <div class="m-upload-title">वीडियो चुनें (Select Video)</div>
                                <div class="m-upload-subtitle">जिस वीडियो से अनचाहा लोगो या वॉटरमार्क हटाना है</div>
                                <div class="m-upload-btn-fake">Choose from Files</div>
                                <input type="file" id="m-delogo-file-input" accept=".mp4,.mov,.mkv,.webm,.m4v,.avi" style="display:none;">
                            </div>
                        </section>
                    ` : `
                        <div class="m-card">
                            <div style="font-size:12px;font-weight:700;color:#94a3b8;margin-bottom:8px;">
                                📹 फ़ाइल: <span style="color:#fff;">${escapeHTML(file.name)}</span> (${formatBytes(file.size)})
                            </div>

                            <div class="m-delogo-preview-box">
                                <canvas id="m-delogo-canvas" class="m-delogo-canvas"></canvas>
                            </div>

                            <div style="font-size:11px;color:#94a3b8;margin-bottom:12px;text-align:center;">
                                लाल बॉक्स को लोगो के ऊपर सेट करें (नीचे दिए गए प्रीसेट्स या कोऑर्डिनेट्स का प्रयोग करें)
                            </div>

                            <div style="display:flex;gap:6px;margin-bottom:12px;overflow-x:auto;">
                                <button type="button" class="m-docs-nav-btn" id="m-delogo-pos-tr" style="flex:1;justify-content:center;padding:6px 8px;font-size:11px;">
                                    ↗ टॉप-राइट (TR)
                                </button>
                                <button type="button" class="m-docs-nav-btn" id="m-delogo-pos-br" style="flex:1;justify-content:center;padding:6px 8px;font-size:11px;">
                                    ↘ बॉटम-राइट (BR)
                                </button>
                                <button type="button" class="m-docs-nav-btn" id="m-delogo-pos-tl" style="flex:1;justify-content:center;padding:6px 8px;font-size:11px;">
                                    ↖ टॉप-लेफ्ट (TL)
                                </button>
                                <button type="button" class="m-docs-nav-btn" id="m-delogo-pos-bl" style="flex:1;justify-content:center;padding:6px 8px;font-size:11px;">
                                    ↙ बॉटम-लेफ्ट (BL)
                                </button>
                            </div>

                            <div class="m-delogo-controls">
                                <div class="m-delogo-grid">
                                    <div class="m-delogo-field">
                                        <label>X स्थिति (पिक्सेल):</label>
                                        <input type="number" id="m-delogo-in-x" value="${box.x}">
                                    </div>
                                    <div class="m-delogo-field">
                                        <label>Y स्थिति (पिक्सेल):</label>
                                        <input type="number" id="m-delogo-in-y" value="${box.y}">
                                    </div>
                                    <div class="m-delogo-field">
                                        <label>चौड़ाई (Width px):</label>
                                        <input type="number" id="m-delogo-in-w" value="${box.w}">
                                    </div>
                                    <div class="m-delogo-field">
                                        <label>ऊंचाई (Height px):</label>
                                        <input type="number" id="m-delogo-in-h" value="${box.h}">
                                    </div>
                                </div>
                                <div class="m-delogo-field">
                                    <label>फेदर बॉर्डर स्मूथिंग (Band 1 - 5):</label>
                                    <input type="range" id="m-delogo-in-band" min="1" max="5" value="${box.band || 2}" style="width:100%;">
                                    <div style="display:flex;justify-content:space-between;font-size:10px;color:#64748b;margin-top:2px;">
                                        <span>हल्का (1)</span>
                                        <span>मध्यम (2 - 3)</span>
                                        <span>अधिक फेदर (5)</span>
                                    </div>
                                </div>
                            </div>

                            ${state.delogoError ? `
                                <div class="m-error-banner" style="margin-bottom:12px;">
                                    ${icons.alert}
                                    <span>${escapeHTML(state.delogoError)}</span>
                                </div>
                            ` : ''}

                            ${state.delogoIsProcessing ? `
                                <div class="m-processing-card" style="margin-top:10px;text-align:center;">
                                    <div class="m-spinner"></div>
                                    <div style="font-size:13px;font-weight:700;margin-top:8px;">FFmpeg Delogo प्रोसेसिंग चालू है...</div>
                                    <div style="font-size:11px;color:#94a3b8;margin-top:4px;">पिक्सेल रीकैलकुलेशन और रेंडरिंग हो रही है।</div>
                                </div>
                            ` : `
                                <button type="button" class="m-btn-process" id="m-btn-run-delogo" style="width:100%;margin-top:8px;">
                                    🚀 इन-ऐप स्मार्ट डेलोगो से हटाएं (Instant Remove)
                                </button>
                            `}

                            ${res ? `
                                <div class="m-card" style="margin-top:16px;border-color:#10b981;background:rgba(16,185,129,0.06);">
                                    <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">
                                        <span style="color:#10b981;">${icons.check}</span>
                                        <span style="font-weight:700;color:#34d399;">लोगो सफलतापूर्वक हटाया गया!</span>
                                    </div>
                                    <video src="${escapeHTML(res.downloadUrl)}" controls playsinline style="width:100%;border-radius:8px;margin-bottom:12px;background:#000;"></video>
                                    <a href="${escapeHTML(res.downloadUrl)}" download="${escapeHTML(res.outputFilename || 'delogo_video.mp4')}" class="m-btn-dl-all" style="text-decoration:none;">
                                        ${icons.download}
                                        <span>डाउनलोड फाइनल वीडियो (MP4)</span>
                                    </a>
                                </div>
                            ` : ''}
                        </div>

                        <!-- 100% Free Blur-Free AI Inpainting Guide Box -->
                        <div class="m-card" style="margin-top:16px;border:1px solid rgba(139,92,246,0.3);background:linear-gradient(135deg,rgba(139,92,246,0.08) 0%,rgba(17,24,39,0.9) 100%);">
                            <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
                                <span style="font-size:18px;">✨</span>
                                <span style="font-weight:700;color:#c084fc;">100% बिना ब्लर का AI हल (ProPainter Free)</span>
                            </div>
                            <p style="font-size:12px;color:#cbd5e1;line-height:1.5;margin-bottom:10px;">
                                यदि आप डेलोगो के हल्के धुंधलेपन (blur patch) के बिना, वीडियो के पिछले फ्रेम्स से हू-ब-हू बैकग्राउंड रीकन्स्ट्रक्ट करना चाहते हैं, तो <strong>Hugging Face ProPainter (मुफ़्त)</strong> का उपयोग करें।
                            </p>
                            <a href="https://huggingface.co/spaces/sczhou/ProPainter" target="_blank" rel="noopener noreferrer" class="m-btn-history-dl" style="width:100%;justify-content:center;padding:8px 12px;text-decoration:none;font-size:12px;">
                                🌐 Hugging Face ProPainter (फ़्री स्पेस खोलें) ↗
                            </a>
                        </div>
                    `}
                </main>
            </div>
        `;

        // Back button
        document.getElementById('m-delogo-btn-back').addEventListener('click', () => {
            state.currentTool = null;
            render();
        });

        // Dropzone & File Input
        const dropzone = document.getElementById('m-delogo-dropzone');
        const fileInput = document.getElementById('m-delogo-file-input');
        if (dropzone && fileInput) {
            dropzone.addEventListener('click', () => fileInput.click());
            fileInput.addEventListener('change', (e) => {
                if (e.target.files && e.target.files[0]) {
                    loadDelogoFile(e.target.files[0]);
                }
            });
        }

        // Reset
        const resetBtn = document.getElementById('m-delogo-btn-reset');
        if (resetBtn) {
            resetBtn.addEventListener('click', () => {
                state.delogoFile = null;
                state.delogoResult = null;
                state.delogoError = null;
                render();
            });
        }

        // Draw Canvas Frame if file is present
        if (file) {
            initDelogoCanvas();
        }
    }

    function loadDelogoFile(file) {
        state.delogoFile = file;
        state.delogoResult = null;
        state.delogoError = null;
        state.delogoVideoUrl = URL.createObjectURL(file);

        const v = document.createElement('video');
        v.preload = 'metadata';
        v.muted = true;
        v.src = state.delogoVideoUrl;
        v.onloadedmetadata = () => {
            state.delogoVideoDims = {
                width: v.videoWidth || 1280,
                height: v.videoHeight || 720
            };
            // Default position top-right
            const w = Math.round(state.delogoVideoDims.width * 0.2);
            const h = Math.round(state.delogoVideoDims.height * 0.1);
            state.delogoBox = {
                x: Math.round(state.delogoVideoDims.width - w - 20),
                y: 20,
                w: w,
                h: h,
                band: 2
            };
            render();
        };
    }

    function initDelogoCanvas() {
        const canvas = document.getElementById('m-delogo-canvas');
        if (!canvas || !state.delogoVideoUrl) return;

        const ctx = canvas.getContext('2d');
        const v = document.createElement('video');
        v.preload = 'auto';
        v.muted = true;
        v.src = state.delogoVideoUrl;
        v.currentTime = 0.5;

        v.onseeked = () => {
            canvas.width = state.delogoVideoDims.width;
            canvas.height = state.delogoVideoDims.height;
            drawDelogoFrame(canvas, ctx, v);
            setupDelogoControls(canvas, ctx, v);
        };
    }

    function drawDelogoFrame(canvas, ctx, videoEl) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        try {
            ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
        } catch (e) {
            ctx.fillStyle = '#1e293b';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
        }

        const box = state.delogoBox;
        // Draw red dashed box over watermark
        ctx.strokeStyle = '#ef4444';
        ctx.lineWidth = 4;
        ctx.setLineDash([8, 6]);
        ctx.strokeRect(box.x, box.y, box.w, box.h);
        ctx.setLineDash([]);

        // Semi-transparent overlay inside box
        ctx.fillStyle = 'rgba(239, 68, 68, 0.25)';
        ctx.fillRect(box.x, box.y, box.w, box.h);

        // Watermark Label
        ctx.fillStyle = '#ef4444';
        ctx.font = 'bold 14px sans-serif';
        ctx.fillText('Watermark Target', box.x + 6, Math.max(20, box.y - 6));
    }

    function setupDelogoControls(canvas, ctx, videoEl) {
        const inX = document.getElementById('m-delogo-in-x');
        const inY = document.getElementById('m-delogo-in-y');
        const inW = document.getElementById('m-delogo-in-w');
        const inH = document.getElementById('m-delogo-in-h');
        const inBand = document.getElementById('m-delogo-in-band');

        function updateFromInputs() {
            state.delogoBox.x = parseInt(inX.value, 10) || 0;
            state.delogoBox.y = parseInt(inY.value, 10) || 0;
            state.delogoBox.w = parseInt(inW.value, 10) || 100;
            state.delogoBox.h = parseInt(inH.value, 10) || 50;
            if (inBand) state.delogoBox.band = parseInt(inBand.value, 10) || 2;
            drawDelogoFrame(canvas, ctx, videoEl);
        }

        if (inX) inX.addEventListener('input', updateFromInputs);
        if (inY) inY.addEventListener('input', updateFromInputs);
        if (inW) inW.addEventListener('input', updateFromInputs);
        if (inH) inH.addEventListener('input', updateFromInputs);
        if (inBand) inBand.addEventListener('input', updateFromInputs);

        // Presets
        const dims = state.delogoVideoDims;
        const setPreset = (x, y, w, h) => {
            state.delogoBox.x = x;
            state.delogoBox.y = y;
            state.delogoBox.w = w;
            state.delogoBox.h = h;
            if (inX) inX.value = x;
            if (inY) inY.value = y;
            if (inW) inW.value = w;
            if (inH) inH.value = h;
            drawDelogoFrame(canvas, ctx, videoEl);
        };

        const pw = Math.round(dims.width * 0.2);
        const ph = Math.round(dims.height * 0.1);

        const btnTR = document.getElementById('m-delogo-pos-tr');
        if (btnTR) btnTR.addEventListener('click', () => setPreset(dims.width - pw - 20, 20, pw, ph));

        const btnBR = document.getElementById('m-delogo-pos-br');
        if (btnBR) btnBR.addEventListener('click', () => setPreset(dims.width - pw - 20, dims.height - ph - 20, pw, ph));

        const btnTL = document.getElementById('m-delogo-pos-tl');
        if (btnTL) btnTL.addEventListener('click', () => setPreset(20, 20, pw, ph));

        const btnBL = document.getElementById('m-delogo-pos-bl');
        if (btnBL) btnBL.addEventListener('click', () => setPreset(20, dims.height - ph - 20, pw, ph));

        // Run Delogo
        const runBtn = document.getElementById('m-btn-run-delogo');
        if (runBtn) {
            runBtn.addEventListener('click', () => runDelogoProcess());
        }
    }

    async function runDelogoProcess() {
        if (!state.delogoFile) return;

        state.delogoIsProcessing = true;
        state.delogoError = null;
        state.delogoResult = null;
        render();

        try {
            const jobId = 'delogo_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);

            // Upload video
            const formData = new FormData();
            formData.append('jobId', jobId);
            formData.append('fileType', 'video');
            formData.append('fileName', state.delogoFile.name);
            formData.append('file', state.delogoFile);

            const uploadRes = await fetch('/api/watermark/upload-file', {
                method: 'POST',
                body: formData
            });

            if (!uploadRes.ok) {
                throw new Error('Video upload failed (' + uploadRes.status + ')');
            }

            // Call Delogo
            const box = state.delogoBox;
            const delogoRes = await fetch('/api/watermark/remove', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jobId: jobId,
                    x: box.x,
                    y: box.y,
                    w: box.w,
                    h: box.h,
                    band: box.band || 2
                })
            });

            const data = await delogoRes.json();
            if (!delogoRes.ok || !data.success) {
                throw new Error(data.error || 'Delogo processing failed');
            }

            state.delogoResult = {
                downloadUrl: data.downloadUrl,
                outputFilename: data.outputFilename
            };
            state.delogoIsProcessing = false;

            addProjectHistory({
                type: 'delogo',
                title: `Watermark Removed (${state.delogoFile.name})`,
                itemCount: 1,
                downloadUrl: data.downloadUrl
            });

            render();
        } catch (err) {
            console.error('Delogo error:', err);
            state.delogoIsProcessing = false;
            state.delogoError = err.message || 'Watermark removal failed';
            render();
        }
    }

    function escapeHTML(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    // Initialize
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', render);
    } else {
        render();
    }
})();
