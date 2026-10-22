(function (root, factory) {
    'use strict';
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.ItineraryImage = api;
}(typeof window === 'object' ? window : globalThis, function () {
    'use strict';
    const MAX_BYTES = 8 * 1024 * 1024;
    const MAX_PIXELS = 24000000;
    const MAX_SIDE = 12000;
    const OCR_PIXELS = 4000000;
    const OCR_SIDE = 2400;
    const MAX_TEXT = 30000;
    const TIMEOUT_MS = 120000;
    const scriptURL = typeof document === 'object' && (document.currentScript?.src || document.baseURI);
    const fail = (code, message) => Object.assign(new Error(message), { code });
    const cancelled = () => Object.assign(new Error('已取消圖片文字辨識。'), { name: 'AbortError' });
    const invalid = () => fail('IMAGE_INVALID', '圖片無法解碼或檔案已損毀，請重新另存為 PNG、JPG 或 WebP 後再試。');
    const uint16 = (bytes, offset) => (bytes[offset] << 8) | bytes[offset + 1];
    function dimensions(bytes, extension) {
        const format = String(extension || '').toLowerCase().replace(/^\./, '');
        if (!['png', 'jpg', 'jpeg', 'webp'].includes(format)) throw fail('IMAGE_FORMAT', '圖片目前支援 PNG、JPG、JPEG 與 WebP。');
        if (!(bytes instanceof Uint8Array) || !bytes.length) throw invalid();
        if (bytes.byteLength > MAX_BYTES) throw fail('IMAGE_LIMIT', '圖片超過 8 MiB，請縮小檔案後再匯入。');
        let width = 0, height = 0, mime;
        if (format === 'png') {
            if (bytes.length < 24 || [137, 80, 78, 71, 13, 10, 26, 10].some((value, index) => bytes[index] !== value)
                || String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR') throw invalid();
            const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            width = view.getUint32(16); height = view.getUint32(20); mime = 'image/png';
        } else if (format === 'jpg' || format === 'jpeg') {
            if (bytes[0] !== 255 || bytes[1] !== 216) throw invalid();
            let position = 2;
            while (position + 3 < bytes.length) {
                if (bytes[position++] !== 255) throw invalid();
                while (bytes[position] === 255) position++;
                const marker = bytes[position++];
                if (marker === 217 || marker === 218) break;
                const length = uint16(bytes, position);
                if (length < 2 || position + length > bytes.length) throw invalid();
                if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
                    if (length < 8) throw invalid();
                    height = uint16(bytes, position + 3); width = uint16(bytes, position + 5); break;
                }
                position += length;
            }
            mime = 'image/jpeg';
        } else {
            if (bytes.length < 30 || String.fromCharCode(...bytes.subarray(0, 4)) !== 'RIFF' || String.fromCharCode(...bytes.subarray(8, 12)) !== 'WEBP') throw invalid();
            const kind = String.fromCharCode(...bytes.subarray(12, 16));
            if (kind === 'VP8X') {
                if (bytes[20] & 2) throw fail('IMAGE_FORMAT', '請將動態 WebP 另存成單張 PNG 或 JPG 後再辨識。');
                width = 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16);
                height = 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16);
            } else if (kind === 'VP8L' && bytes[20] === 47) {
                const bits = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(21, true);
                width = (bits & 0x3FFF) + 1; height = ((bits >>> 14) & 0x3FFF) + 1;
            } else if (kind === 'VP8 ' && bytes[23] === 157 && bytes[24] === 1 && bytes[25] === 42) {
                width = (bytes[26] | (bytes[27] << 8)) & 0x3FFF; height = (bytes[28] | (bytes[29] << 8)) & 0x3FFF;
            }
            mime = 'image/webp';
        }
        if (!width || !height) throw invalid();
        if (width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) throw fail('IMAGE_DIMENSIONS', '圖片尺寸超過 2,400 萬像素或單邊 12,000 像素，請先縮小或分割圖片。');
        return { width, height, mime };
    }
    function asset(relative) {
        const url = new URL(`vendor/tesseract/${relative}`, scriptURL);
        if (url.origin !== location.origin || !['http:', 'https:'].includes(url.protocol)) throw fail('IMAGE_ASSET', '圖片辨識元件必須由本站載入，請透過本機服務或網站開啟。');
        return url.href;
    }
    function read(bytes, { extension, signal, onProgress } = {}) {
        return new Promise((resolve, reject) => {
            let worker, image, canvas, objectURL, timer;
            let finished = false, currentJob = null, jobNumber = 0;
            const warnings = ['圖片文字辨識可能誤字，請核對日期、時間、地址與費用。'];
            function progress(message, detail = {}) {
                if (!finished && typeof onProgress === 'function') onProgress({ stage: 'image', message, ...detail });
            }
            function cleanup() {
                clearTimeout(timer);
                signal?.removeEventListener('abort', abort);
                if (worker) { worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null; worker.terminate(); worker = null; }
                if (image) { image.onload = null; image.onerror = null; image.src = ''; image = null; }
                if (objectURL) { URL.revokeObjectURL(objectURL); objectURL = null; }
                if (canvas) { canvas.width = 0; canvas.height = 0; canvas = null; }
                currentJob = null;
            }
            function finish(error, result) {
                if (finished) return;
                finished = true;
                cleanup();
                if (error) reject(error); else resolve(result);
            }
            function abort() { finish(cancelled()); }
            function job(action, payload) {
                if (finished) return;
                currentJob = { action, id: `image-${++jobNumber}` };
                worker.postMessage({ workerId: 'itinerary-image', jobId: currentJob.id, action, payload });
            }
            function startOCR(data) {
                if (finished) return;
                try {
                    // Direct worker messages mirror createWorker.js in pinned Tesseract.js 7.0.0.
                    // Owning this single worker permits immediate termination even during initialization.
                    // Version/hash checks and real browser tests guard this protocol when updating vendors.
                    worker = new Worker(asset('worker.min.js'));
                    worker.onerror = event => { event.preventDefault?.(); finish(fail('IMAGE_ASSET', '圖片辨識元件載入失敗，請確認連線後重試。')); };
                    worker.onmessageerror = () => finish(fail('IMAGE_INVALID', '圖片辨識失敗，請重新選取圖片後再試。'));
                    worker.onmessage = event => {
                        if (finished || !currentJob || event.data.jobId !== currentJob.id || event.data.action !== currentJob.action) return;
                        const { status, action, data: result } = event.data;
                        try {
                            if (status === 'progress') {
                                const percent = Math.round(Math.max(0, Math.min(1, Number(result?.progress) || 0)) * 100);
                                const messages = { 'loading tesseract core': '載入本機文字辨識元件', 'initializing tesseract': '啟動文字辨識元件', 'loading language traineddata': '載入繁中與英文語言資料（首次需下載）', 'initializing api': '準備繁中與英文辨識', 'recognizing text': '正在辨識圖片文字' };
                                progress(`${messages[result?.status] || '正在處理圖片'}… ${percent}%`, { percent });
                                return;
                            }
                            if (status === 'reject') { finish(fail(action === 'recognize' ? 'IMAGE_INVALID' : 'IMAGE_ASSET', action === 'recognize' ? '圖片辨識失敗，請改用清晰、正向的圖片後重試。' : '文字辨識元件或語言資料載入失敗，請確認連線後重試。')); return; }
                            if (status !== 'resolve') return;
                            if (action === 'load') job('loadLanguage', { langs: ['chi_tra', 'eng'], options: { langPath: asset('lang'), cachePath: 'roam-ocr-7.0.0', cacheMethod: 'write', gzip: true, lstmOnly: true } });
                            else if (action === 'loadLanguage') job('initialize', { langs: ['chi_tra', 'eng'], oem: 1, config: { tessedit_pageseg_mode: '3', preserve_interword_spaces: '1' } });
                            else if (action === 'initialize') job('recognize', { image: data, options: {}, output: { text: true } });
                            else if (action === 'recognize') {
                                const text = typeof result?.text === 'string' ? result.text.replace(/\r\n?/g, '\n').trim() : '';
                                if (!text) { finish(fail('IMAGE_NO_TEXT', '圖片中沒有辨識到文字，請使用清晰、正向的行程截圖或照片。')); return; }
                                if (text.length > MAX_TEXT) { finish(fail('TEXT_LIMIT', '圖片文字超過 30,000 字元，請分割行程後再匯入。')); return; }
                                progress('圖片文字辨識完成，請核對原圖與文字。', { percent: 100 });
                                finish(null, { text, format: 'image', pages: null, warnings });
                            }
                        } catch { finish(fail('IMAGE_INVALID', '圖片辨識失敗，請重新選取圖片後再試。')); }
                    };
                    progress('載入本機文字辨識元件，首次需下載繁中與英文語言資料…');
                    job('load', { options: { lstmOnly: true, corePath: asset('core'), logging: false } });
                } catch { finish(fail('IMAGE_ASSET', '圖片辨識元件無法啟動，請透過本機服務或網站開啟後重試。')); }
            }
            try {
                if (signal?.aborted) { finish(cancelled()); return; }
                const info = dimensions(bytes, extension);
                if (typeof document !== 'object' || typeof Worker !== 'function' || typeof Image !== 'function' || location.protocol === 'file:') {
                    finish(fail('IMAGE_ASSET', '圖片辨識請透過本機服務或網站開啟；可執行「啟動Codex旅遊書.vbs」後重新選檔。')); return;
                }
                signal?.addEventListener('abort', abort, { once: true });
                timer = setTimeout(() => finish(fail('IMAGE_TIMEOUT', '圖片辨識超過 120 秒，已停止處理；請縮小或分割圖片後重試。')), TIMEOUT_MS);
                progress('正在檢查與準備圖片…');
                image = new Image();
                image.onerror = () => finish(invalid());
                image.onload = () => {
                    if (finished) return;
                    try {
                        const width = image.naturalWidth, height = image.naturalHeight;
                        if (!width || !height || width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) { finish(invalid()); return; }
                        const ratio = Math.min(1, OCR_SIDE / Math.max(width, height), Math.sqrt(OCR_PIXELS / (width * height)));
                        canvas = document.createElement('canvas');
                        canvas.width = Math.max(1, Math.round(width * ratio)); canvas.height = Math.max(1, Math.round(height * ratio));
                        const context = canvas.getContext('2d');
                        if (!context) { finish(invalid()); return; }
                        context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(image, 0, 0, canvas.width, canvas.height);
                        if (ratio < 1) warnings.push('圖片已縮小後辨識；小字可能遺漏，可裁切成數張圖片再匯入。');
                        canvas.toBlob(blob => {
                            if (finished) return;
                            if (!blob) { finish(invalid()); return; }
                            blob.arrayBuffer().then(buffer => { if (!finished) startOCR(new Uint8Array(buffer)); }).catch(() => finish(invalid()));
                        }, 'image/png');
                    } catch { finish(invalid()); }
                };
                objectURL = URL.createObjectURL(new Blob([bytes], { type: info.mime }));
                image.src = objectURL;
            } catch (error) {
                finish(['IMAGE_FORMAT', 'IMAGE_LIMIT', 'IMAGE_DIMENSIONS', 'IMAGE_INVALID'].includes(error.code) ? error : invalid());
            }
        });
    }
    return { read, MAX_BYTES, MAX_PIXELS, MAX_SIDE, OCR_PIXELS, OCR_SIDE, MAX_TEXT, TIMEOUT_MS };
}));
