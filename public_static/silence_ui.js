/**
 * AutoEditor Pro — High Performance AI Video Jump-Cut & Auto Silence Remover
 * - Android Files/Document Manager (preserves real filenames like 1_1080p_...)
 * - Smart Serial Sequence Ordering (1, 2, 3...)
 * - Part Thumbnail Preview Frames + Interactive Play Clip Feature
 * - Pure FFmpeg Silence Detection (No distortion filter, respects 0.30s + padding)
 * - Secure In-Memory Blob MP4 Downloader
 */

(function () {
    'use strict';

    const MAX_MERGE_FILES = 20;
    const SINGLE_PART_MAX_BYTES = 31 * 1024 * 1024; // 31 MB max per part

    // State
    const state = {
        currentTool: null, // 'video-jumpcut' | 'silence-remover' | null
        activeMode: 'single', // 'single' | 'merge'
        
        // Processing Settings (Restored defaults with -22dB and 40ms)
        minSilence: 0.30,
        silenceThreshold: -35,
        silencePadding: 0.05,

        // Single mode file
        singleFile: null,

        // Merge mode files (up to 20 parts, sorted in natural serial order)
        mergeFiles: [],

        // Live Processing state
        isProcessing: false,
        processingStage: '',
        currentPartIndex: 0,
        totalPartsCount: 0,
        currentPartPercent: 0,
        overallPercent: 0,
        errorMessage: null,

        // Result data from cloud FFmpeg
        result: null
    };

    // ── 1. INTELLIGENT SERIAL NUMBER DETECTION & SORTING ────────
    function extractFileIndex(name) {
        if (!name) return { num: Infinity, raw: '' };
        const withoutExt = name.replace(/\.[^/.]+$/, "");

        // Pattern 1: leading number at start of filename (e.g. "1_1080p_20260922...", "01_shot.mp4", "2 - speech.mp4")
        const leadingMatch = withoutExt.match(/^0*(\d{1,4})[\s_#-]+/);
        if (leadingMatch && leadingMatch[1]) {
            return { num: parseInt(leadingMatch[1], 10), raw: withoutExt, explicit: true };
        }

        // Pattern 2: explicit prefix with number (e.g. part 1, part_02, clip-3, ep 4, v5, scene 6)
        const prefixMatch = withoutExt.match(/(?:part|clip|scene|track|audio|video|vid|ep|seg|chunk|file)[\s_#-]*0*(\d{1,4})/i);
        if (prefixMatch && prefixMatch[1]) {
            return { num: parseInt(prefixMatch[1], 10), raw: withoutExt, explicit: true };
        }

        // Pattern 3: parentheses or brackets (e.g. "myvideo (1).mp4", "intro [2].mp4")
        const parenMatch = withoutExt.match(/[\(\[]\s*0*(\d{1,4})\s*[\)\]]/);
        if (parenMatch && parenMatch[1]) {
            return { num: parseInt(parenMatch[1], 10), raw: withoutExt, explicit: true };
        }

        // Pattern 4: trailing number after delimiter (e.g. "my_video_1.mp4", "recording-02.mp4")
        const trailingMatch = withoutExt.match(/[\s_#-]+0*(\d{1,4})$/);
        if (trailingMatch && trailingMatch[1]) {
            return { num: parseInt(trailingMatch[1], 10), raw: withoutExt, explicit: true };
        }

        // Pattern 5: small standalone number (1 to 500) only, ignore 6-digit random IDs (like 329436)
        const anyMatch = withoutExt.match(/(?:^|\D)0*(\d{1,3})(?:\D|$)/);
        if (anyMatch && anyMatch[1]) {
            const val = parseInt(anyMatch[1], 10);
            if (val > 0 && val <= 500) {
                return { num: val, raw: withoutExt, explicit: false };
            }
        }

        return { num: Infinity, raw: withoutExt, explicit: false };
    }

    function smartSortFiles(filesArray) {
        return filesArray.slice().sort((a, b) => {
            const infoA = extractFileIndex(a.name || '');
            const infoB = extractFileIndex(b.name || '');
            if (infoA.num !== infoB.num) {
                return infoA.num - infoB.num;
            }
            return (a.name || '').localeCompare(b.name || '', undefined, { numeric: true, sensitivity: 'base' });
        });
    }

    // ── 2. VIDEO THUMBNAIL CAPTURE & MODAL PREVIEW PLAYER ────────
    function captureVideoThumbnail(file) {
        return new Promise((resolve) => {
            if (!file) return resolve(null);
            const isVideo = (file.type && file.type.startsWith('video')) || /\.(mp4|mov|mkv|webm|m4v|avi)$/i.test(file.name);
            if (!isVideo) return resolve(null);

            const url = URL.createObjectURL(file);
            const video = document.createElement('video');
            video.preload = 'metadata';
            video.muted = true;
            video.playsInline = true;
            video.src = url;

            let finished = false;
            const finalize = (data) => {
                if (finished) return;
                finished = true;
                URL.revokeObjectURL(url);
                resolve(data);
            };

            video.onloadeddata = () => {
                video.currentTime = Math.min(0.5, (video.duration || 1) * 0.25);
            };

            video.onseeked = () => {
                try {
                    const canvas = document.createElement('canvas');
                    const w = 100;
                    const aspect = (video.videoHeight && video.videoWidth) ? (video.videoHeight / video.videoWidth) : (9 / 16);
                    canvas.width = w;
                    canvas.height = Math.round(w * aspect);
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                    finalize(canvas.toDataURL('image/jpeg', 0.7));
                } catch (e) {
                    finalize(null);
                }
            };

            video.onerror = () => finalize(null);
            setTimeout(() => finalize(null), 1800);
        });
    }

    function openPreviewModal(file, title) {
        if (!file) return;
        const url = URL.createObjectURL(file);
        const existing = document.getElementById('m-preview-modal-root');
        if (existing) existing.remove();

        const isVideo = (file.type && file.type.startsWith('video')) || /\.(mp4|mov|mkv|webm|m4v|avi)$/i.test(file.name);

        const modalHTML = `
            <div class="m-preview-modal-overlay" id="m-preview-modal-root">
                <div class="m-preview-modal">
                    <div class="m-preview-modal__header">
                        <span class="m-preview-modal__title">${escapeHTML(title || file.name)}</span>
                        <button type="button" class="m-preview-modal__close" id="btn-close-modal-preview">
                            ${icons.close}
                        </button>
                    </div>
                    <div class="m-preview-modal__body">
                        ${isVideo ? `
                            <video controls autoplay playsinline class="m-preview-modal__video" src="${url}"></video>
                        ` : `
                            <audio controls autoplay class="m-audio-player" src="${url}"></audio>
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
            URL.revokeObjectURL(url);
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
        if (m > 0) {
            return `${m}:${rem.toString().padStart(2, '0')}.${ms}`;
        }
        return `${rem}.${ms}s`;
    }

    // Icons
    const icons = {
        video: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2.5"/><polygon points="10 8 16 12 10 16 10 8" fill="currentColor" stroke="none"/></svg>`,
        audio: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v20M17 5v14M7 5v14M22 9v6M2 9v6"/></svg>`,
        scissors: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/></svg>`,
        back: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>`,
        upload: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`,
        plus: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
        close: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
        download: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`,
        cloud: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/></svg>`,
        check: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
        refresh: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 21h5v-5"/></svg>`,
        bolt: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`,
        alert: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
        up: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>`,
        down: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`,
        play: `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4"/></svg>`
    };

    const rootEl = document.getElementById('autoeditor-global-app-root');

    function render() {
        if (!rootEl) return;

        if (!state.currentTool) {
            renderHomeScreen();
        } else {
            renderToolScreen();
        }
    }

    // ── 3. HOME SCREEN ──────────────────────────────────────────
    function renderHomeScreen() {
        rootEl.innerHTML = `
            <div class="m-app-shell">
                <header class="m-header">
                    <div class="m-header__brand">
                        <span class="m-header__logo">${icons.scissors}</span>
                        <div class="m-header__text">
                            <span class="m-header__title">AutoEditor Pro</span>
                            <span class="m-header__badge">${icons.cloud} Cloud FFmpeg Engine Active</span>
                        </div>
                    </div>
                </header>

                <main class="m-main">
                    <div class="m-server-status-pill">
                        <span class="m-status-dot"></span>
                        <span>Files Manager & Thumbnail Previews Ready</span>
                    </div>

                    <div class="m-tool-selection">
                        <!-- Video Jump-Cut Tool Card -->
                        <div class="m-tool-card" id="btn-select-vjump">
                            <div class="m-tool-card__icon m-icon-video">
                                ${icons.video}
                            </div>
                            <div class="m-tool-card__body">
                                <h2 class="m-tool-card__title">Video Jump-Cut</h2>
                                <p class="m-tool-card__desc">Choose from Files. Auto-sorts serial parts (1, 2, 3...) with video frame previews.</p>
                                <div class="m-tool-card__meta">
                                    <span>Single Video</span>
                                    <span>·</span>
                                    <span>Merge Parts (up to ${MAX_MERGE_FILES})</span>
                                </div>
                            </div>
                            <div class="m-tool-card__arrow">→</div>
                        </div>

                        <!-- Auto Silence Remover Tool Card -->
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
                                    <span>Merge Parts (up to ${MAX_MERGE_FILES})</span>
                                </div>
                            </div>
                            <div class="m-tool-card__arrow">→</div>
                        </div>
                    </div>
                </main>
            </div>
        `;

        document.getElementById('btn-select-vjump').addEventListener('click', () => {
            selectTool('video-jumpcut');
        });

        document.getElementById('btn-select-silence').addEventListener('click', () => {
            selectTool('silence-remover');
        });
    }

    function selectTool(toolKey) {
        state.currentTool = toolKey;
        state.activeMode = 'single';
        state.singleFile = null;
        state.mergeFiles = [];
        state.isProcessing = false;
        state.result = null;
        state.errorMessage = null;
        render();
    }

    // ── 4. TOOL SCREEN ──────────────────────────────────────────
    function renderToolScreen() {
        const isVideo = state.currentTool === 'video-jumpcut';
        const toolTitle = isVideo ? 'Video Jump-Cut' : 'Auto Silence Remover';
        
        // Use extension list + application/octet-stream to prevent Android Chrome from launching Photo Gallery
        const fileAccept = isVideo 
            ? '.mp4,.mov,.mkv,.webm,.m4v,.avi,application/octet-stream' 
            : '.mp3,.wav,.m4a,.aac,.flac,.ogg,audio/*';

        const fileTypeLabel = isVideo ? 'video' : 'audio';

        const hasFiles = state.activeMode === 'single' ? !!state.singleFile : state.mergeFiles.length > 0;
        
        let oversizeFile = null;
        if (state.activeMode === 'single' && state.singleFile) {
            if (state.singleFile.size > SINGLE_PART_MAX_BYTES) {
                oversizeFile = state.singleFile;
            }
        } else if (state.activeMode === 'merge') {
            oversizeFile = state.mergeFiles.find(f => f.size > SINGLE_PART_MAX_BYTES);
        }

        rootEl.innerHTML = `
            <div class="m-app-shell">
                <!-- Top Nav Bar -->
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
                    <!-- Mode Switcher -->
                    <div class="m-mode-tabs" role="tablist">
                        <button type="button" role="tab" class="m-mode-tab ${state.activeMode === 'single' ? 'is-active' : ''}" id="tab-mode-single">
                            Single File
                        </button>
                        <button type="button" role="tab" class="m-mode-tab ${state.activeMode === 'merge' ? 'is-active' : ''}" id="tab-mode-merge">
                            Merge (Up to ${MAX_MERGE_FILES} parts)
                        </button>
                    </div>

                    <!-- Upload Card -->
                    <section class="m-card m-upload-card">
                        ${state.activeMode === 'single' ? renderSingleUploadHTML(fileAccept, fileTypeLabel) : renderMergeUploadHTML(fileAccept, fileTypeLabel)}
                        ${oversizeFile ? `
                            <div class="m-warning-box">
                                ${icons.alert}
                                <span>पार्ट "${escapeHTML(oversizeFile.name)}" का साइज़ (${formatBytes(oversizeFile.size)}) 31 MB से बड़ा है। कृपया इसे 31 MB से कम का रखें।</span>
                            </div>
                        ` : ''}
                    </section>

                    <!-- Original Options Card (Grouped, compact, scrollable) -->
                    <section class="m-card m-options-card">
                        <div class="m-card__header">
                            <span class="m-card__title">Processing Options</span>
                            <span class="m-card__hint">${icons.bolt} Pure Engine</span>
                        </div>

                        <!-- 1. Min Pause Duration -->
                        <div class="m-field">
                            <div class="m-field__label-row">
                                <label for="m-input-min-dur" class="m-field__label">Min Pause Duration</label>
                                <span class="m-field__value-badge" id="m-val-min-dur">${state.minSilence.toFixed(2)}s</span>
                            </div>
                            <input 
                                type="range" 
                                class="m-slider" 
                                id="m-input-min-dur" 
                                min="0.08" 
                                max="1.50" 
                                step="0.02" 
                                value="${state.minSilence}"
                                ${state.isProcessing ? 'disabled' : ''}
                            />
                            <div class="m-field__scale">
                                <span>0.08s (Fast)</span>
                                <span>1.50s (Relaxed)</span>
                            </div>
                        </div>

                        <!-- 2. Sensitivity (dB Threshold) -->
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

                        <!-- 3. Edge Padding (Buffer) -->
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

                    <!-- Process Button & Real-time Progress -->
                    <div class="m-action-area">
                        ${renderProcessButtonHTML(hasFiles, !!oversizeFile)}
                        ${state.isProcessing ? renderProgressIndicatorHTML() : ''}
                        ${state.errorMessage ? `
                            <div class="m-error-banner">
                                <span>${escapeHTML(state.errorMessage)}</span>
                            </div>
                        ` : ''}
                    </div>

                    <!-- Results Area (when processing finishes) -->
                    ${state.result ? renderResultCardHTML(isVideo) : ''}
                </main>
            </div>
        `;

        setupToolScreenEvents();
    }

    // ── Single Upload UI ─────────────────────────────────────────
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
                <div class="m-dropzone__sub">Opens Android File Manager / Downloads (max 31 MB)</div>
            </div>
        `;
    }

    // ── Merge Upload UI with Thumbnails & Play Previews ──────────
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
                        <div class="m-dropzone__sub">Opens File Manager · Preserves real names & previews frames</div>
                    </div>
                ` : `
                    <div class="m-max-parts-hint">Maximum ${MAX_MERGE_FILES} parts added</div>
                `}
            </div>
        `;
    }

    // ── Process Button HTML ─────────────────────────────────────
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

    // ── Progress Indicator HTML ─────────────────────────────────
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

    // ── Result Card HTML with SECURE IN-MEMORY DOWNLOAD ─────────
    function renderResultCardHTML(isVideo) {
        const res = state.result;
        if (!res) return '';

        const downUrl = `${res.download_url}?nocache=${Date.now()}`;
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

                <!-- Stats Grid -->
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

                <!-- Preview Player with Range Streaming -->
                <div class="m-preview-player">
                    ${isVideo ? `
                        <video controls playsinline preload="metadata" src="${downUrl}" class="m-video-player"></video>
                    ` : `
                        <div class="m-audio-player-wrap">
                            <span class="m-player-title">Clean Audio Preview</span>
                            <audio controls preload="metadata" src="${downUrl}" class="m-audio-player"></audio>
                        </div>
                    `}
                </div>

                <!-- Actions: In-Memory Secure Blob Downloader -->
                <div class="m-result-actions">
                    <button type="button" class="m-btn-download" id="btn-secure-download">
                        <span>${icons.download}</span>
                        <span>Download High Quality ${isVideo ? 'MP4 Video' : 'MP3 Audio'}</span>
                    </button>
                    <button type="button" class="m-btn-secondary" id="btn-process-another">
                        <span>${icons.refresh}</span>
                        <span>Process Another</span>
                    </button>
                </div>
            </section>
        `;
    }

    // ── Setup Tool Events ───────────────────────────────────────
    function setupToolScreenEvents() {
        // Back Button
        const backBtn = document.getElementById('m-btn-back');
        if (backBtn) {
            backBtn.addEventListener('click', () => {
                state.currentTool = null;
                state.result = null;
                render();
            });
        }

        // Reset Top Button
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

        // Mode Switching
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

        // Single File Upload
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

                    // Generate thumbnail asynchronously
                    f._thumbUrl = await captureVideoThumbnail(f);
                    if (state.singleFile === f) {
                        render();
                    }
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

        // Merge File Upload (Up to 20 files with Smart Serial Sort)
        const mergeDropzone = document.getElementById('m-merge-dropzone');
        const mergeInput = document.getElementById('m-merge-input');
        if (mergeDropzone && mergeInput) {
            mergeDropzone.addEventListener('click', () => mergeInput.click());
            mergeInput.addEventListener('change', async (e) => {
                if (e.target.files && e.target.files.length > 0) {
                    const newFiles = Array.from(e.target.files);
                    let combined = state.mergeFiles.concat(newFiles);
                    if (combined.length > MAX_MERGE_FILES) {
                        combined = combined.slice(0, MAX_MERGE_FILES);
                    }
                    // Auto-sort strictly by detected serial sequence numbers
                    state.mergeFiles = smartSortFiles(combined);
                    state.result = null;
                    state.errorMessage = null;
                    render();

                    // Generate thumbnails for any new files
                    for (let f of state.mergeFiles) {
                        if (!f._thumbUrl) {
                            f._thumbUrl = await captureVideoThumbnail(f);
                        }
                    }
                    render();
                }
            });
        }

        // Preview / Play item buttons
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

        // Move Part Up / Down Handlers
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

        // Remove Merge Part Buttons
        const removePartBtns = document.querySelectorAll('.m-part-remove');
        removePartBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                const idx = parseInt(btn.getAttribute('data-remove-index'), 10);
                if (!isNaN(idx)) {
                    state.mergeFiles.splice(idx, 1);
                    state.result = null;
                    render();
                }
            });
        });

        // Sliders & Selects
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

        // Process Action Button
        const processBtn = document.getElementById('btn-process-action');
        if (processBtn) {
            processBtn.addEventListener('click', startProcessing);
        }

        // Secure Download Button (In-Memory Blob Fetch)
        const secureDownloadBtn = document.getElementById('btn-secure-download');
        if (secureDownloadBtn) {
            secureDownloadBtn.addEventListener('click', () => {
                const isVideo = state.currentTool === 'video-jumpcut';
                triggerSecureBlobDownload(isVideo);
            });
        }

        // Process Another Button
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

    // ── 5. SECURE IN-MEMORY BLOB DOWNLOADER ─────────────────────
    async function triggerSecureBlobDownload(isVideo) {
        const res = state.result;
        if (!res || !res.download_url) return;

        const btn = document.getElementById('btn-secure-download');
        const originalHTML = btn ? btn.innerHTML : '';

        if (btn) {
            btn.innerHTML = `<span class="m-spinner"></span> <span>Saving Real MP4 Video to Phone...</span>`;
            btn.style.opacity = '0.9';
            btn.disabled = true;
        }

        try {
            const downloadUrl = `${res.download_url}?download=1&nocache=${Date.now()}`;
            
            const resp = await fetch(downloadUrl, {
                credentials: 'include',
                headers: { 'Accept': 'video/mp4,audio/mpeg,*/*' }
            });

            if (!resp.ok) {
                throw new Error(`Download failed with status ${resp.status}`);
            }

            const blob = await resp.blob();

            if (blob.type.includes('text/html')) {
                throw new Error('Received authentication HTML page instead of video. Please refresh.');
            }

            const fileName = isVideo ? 'clean_jumpcut_video.mp4' : 'clean_audio.mp3';
            const blobUrl = window.URL.createObjectURL(blob);

            const a = document.createElement('a');
            a.style.display = 'none';
            a.href = blobUrl;
            a.download = fileName;
            document.body.appendChild(a);
            a.click();

            setTimeout(() => {
                document.body.removeChild(a);
                window.URL.revokeObjectURL(blobUrl);
            }, 30000);

            if (btn) {
                btn.innerHTML = `${icons.check} <span>Downloaded (${fileName})</span>`;
                setTimeout(() => {
                    btn.innerHTML = originalHTML;
                    btn.style.opacity = '1';
                    btn.disabled = false;
                }, 3000);
            }

        } catch (err) {
            console.error('Download error:', err);
            if (btn) {
                btn.innerHTML = originalHTML;
                btn.style.opacity = '1';
                btn.disabled = false;
            }
            alert('Download failed: ' + err.message);
        }
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

    function uploadSinglePartPromise(file, jobId, partIndex, totalParts) {
        return new Promise((resolve, reject) => {
            const formData = new FormData();
            formData.append('file', file, file.name);
            formData.append('jobId', jobId);
            formData.append('partIndex', String(partIndex));
            formData.append('fileName', file.name);

            const xhr = new XMLHttpRequest();
            xhr.open('POST', '/upload-part', true);

            xhr.upload.onprogress = (e) => {
                if (e.lengthComputable && e.total > 0) {
                    const partPct = Math.round((e.loaded / e.total) * 100);
                    const basePct = Math.round((partIndex / totalParts) * 80);
                    const slicePct = Math.round((partPct / totalParts) * 0.8);
                    const overall = Math.min(80, basePct + slicePct);
                    updateProgressDOM(`Uploading Part ${partIndex + 1} of ${totalParts} (${partPct}%)...`, overall);
                }
            };

            xhr.onload = () => {
                const raw = (xhr.responseText || '').trim();
                if (raw.startsWith('<') || raw.toLowerCase().startsWith('<!doctype')) {
                    if (xhr.status === 413 || raw.includes('413')) {
                        reject(new Error(`Part ${partIndex + 1} (${file.name}) का साइज़ 31MB से अधिक है।`));
                    } else {
                        reject(new Error(`सर्वर एरर (${xhr.status}) पार्ट ${partIndex + 1} अपलोड करते समय।`));
                    }
                    return;
                }
                if (xhr.status >= 200 && xhr.status < 300) {
                    try {
                        const res = JSON.parse(raw);
                        if (res.success) resolve(res);
                        else reject(new Error(res.error || `Part ${partIndex + 1} upload failed`));
                    } catch (e) {
                        reject(new Error(`Invalid JSON from server on part ${partIndex + 1}`));
                    }
                } else {
                    reject(new Error(`Server error ${xhr.status} uploading part ${partIndex + 1}`));
                }
            };

            xhr.onerror = () => reject(new Error(`पार्ट ${partIndex + 1} अपलोड करते समय नेटवर्क एरर।`));
            xhr.ontimeout = () => reject(new Error(`पार्ट ${partIndex + 1} अपलोड टाइमआउट हो गया।`));
            xhr.timeout = 600000;
            xhr.send(formData);
        });
    }

    // ── 6. EXECUTION: SERIAL UPLOADER & DEAD-AIR CUT ENGINE ───────
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
                // Upload in the exact serial order as arranged by the user / smart detector
                const orderedParts = state.mergeFiles;
                const totalParts = orderedParts.length;

                for (let i = 0; i < totalParts; i++) {
                    const file = orderedParts[i];
                    updateProgressDOM(`Preparing Part ${i + 1} of ${totalParts}...`, Math.round((i / totalParts) * 80));
                    await uploadSinglePartPromise(file, jobId, i, totalParts);
                }

                updateProgressDOM('Cloud FFmpeg: Merging in exact serial order & cutting dead air...', 85);

                const processResp = await fetch('/process-parts', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        jobId: jobId,
                        minSilence: state.minSilence,
                        threshold: state.silenceThreshold,
                        padding: state.silencePadding,
                        is_video: isVideo
                    })
                });

                const rawProcess = await processResp.text();
                if (rawProcess.trim().startsWith('<') || rawProcess.toLowerCase().startsWith('<!doctype')) {
                    throw new Error('Google AI Studio सत्र रीकनेक्ट हो रहा है। कृपया 2 सेकंड रुककर दोबारा प्रोसेस बटन दबाएं या पेज को रिफ्रेश करें।');
                }

                let data;
                try {
                    data = JSON.parse(rawProcess);
                } catch (e) {
                    throw new Error('सर्वर का रिस्पॉन्स पढ़ने में त्रुटि।');
                }

                if (!processResp.ok || !data.success) {
                    throw new Error(data.error || 'FFmpeg processing failed on server');
                }

                updateProgressDOM('Completed!', 100);
                state.result = data;
                state.isProcessing = false;
                render();

            } else {
                // SINGLE FILE
                const file = state.singleFile;
                if (file.size > SINGLE_PART_MAX_BYTES) {
                    throw new Error(`फ़ाइल का साइज़ (${formatBytes(file.size)}) 31 MB से अधिक है। कृपया 31 MB से छोटी क्लिप अपलोड करें।`);
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

                xhr.upload.onprogress = (e) => {
                    if (e.lengthComputable && e.total > 0) {
                        const pct = Math.round((e.loaded / e.total) * 75);
                        updateProgressDOM(`Uploading ${formatBytes(e.loaded)} of ${formatBytes(e.total)} (${pct}%)...`, pct);
                    }
                };

                xhr.onload = () => {
                    const raw = (xhr.responseText || '').trim();
                    if (raw.startsWith('<') || raw.toLowerCase().startsWith('<!doctype')) {
                        state.isProcessing = false;
                        if (xhr.status === 413) {
                            state.errorMessage = 'फ़ाइल साइज़ 31 MB से अधिक है (Payload Too Large).';
                        } else {
                            state.errorMessage = 'Google AI Studio सत्र रीकनेक्ट हो रहा है। कृपया 2 सेकंड रुककर दोबारा प्रोसेस बटन दबाएं या पेज को रिफ्रेश करें।';
                        }
                        render();
                        return;
                    }

                    if (xhr.status >= 200 && xhr.status < 300) {
                        try {
                            const data = JSON.parse(raw);
                            if (data.success) {
                                updateProgressDOM('Done!', 100);
                                state.result = data;
                                state.isProcessing = false;
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
