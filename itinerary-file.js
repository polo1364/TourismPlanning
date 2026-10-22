(function (root, factory) {
    'use strict';
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.ItineraryFile = api;
}(typeof window === 'object' ? window : globalThis, function (root) {
    'use strict';
    const MAX_BYTES = 8 * 1024 * 1024;
    const MAX_PAGES = 60;
    const MAX_CHARACTERS = 30000;
    const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
    const MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024;
    const OCR_SIDE = 2400;
    const OCR_PIXELS = 4000000;
    const RENDER_TIMEOUT_MS = 120000;
    const node = typeof module === 'object' && !!module.exports;
    const scriptURL = !node && (document.currentScript?.src || document.baseURI);
    let pdfModule;

    function failure(code, message) { return Object.assign(new Error(message), { code }); }
    function aborted(signal) {
        if (signal?.aborted) throw Object.assign(new Error('已取消讀取行程檔案。'), { name: 'AbortError' });
    }
    function abortable(operation, signal) {
        if (!signal) return operation;
        return new Promise((resolve, reject) => {
            const finish = (callback, value) => { signal.removeEventListener('abort', cancel); callback(value); };
            const cancel = () => finish(reject, Object.assign(new Error('已取消讀取行程檔案。'), { name: 'AbortError' }));
            Promise.resolve(operation).then(value => finish(resolve, value), error => finish(reject, error));
            if (signal.aborted) cancel();
            else signal.addEventListener('abort', cancel, { once: true });
        });
    }
    function progress(onProgress, data) { if (typeof onProgress === 'function') onProgress(data); }
    function checkLength(text) {
        if (text.length > MAX_CHARACTERS) throw failure('TEXT_LIMIT', '檔案文字超過 30,000 字，請拆成較短的行程再匯入。');
    }
    function clean(text) { return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim(); }
    function textFile(bytes) {
        let encoding = 'utf-8';
        let offset = 0;
        const warnings = [];
        if (bytes[0] === 0xFF && bytes[1] === 0xFE) { encoding = 'utf-16le'; offset = 2; }
        else if (bytes[0] === 0xFE && bytes[1] === 0xFF) { encoding = 'utf-16be'; offset = 2; }
        let text;
        try { text = new TextDecoder(encoding, { fatal: true }).decode(bytes.subarray(offset)); }
        catch {
            if (encoding !== 'utf-8') throw failure('ENCODING', '文字編碼不完整，請另存為 UTF-8 的 TXT 檔後重試。');
            try { text = new TextDecoder('big5', { fatal: true }).decode(bytes); }
            catch { throw failure('ENCODING', '無法辨識文字編碼，請另存為 UTF-8 的 TXT 檔後重試。'); }
            warnings.push('此檔案以 Big5 編碼讀取，請確認預覽文字沒有亂碼。');
        }
        if (/[\u0000-\u0008\u000B\u000E-\u001F\u007F]/.test(text)) {
            throw failure('BINARY', '此檔案包含非文字資料，請選擇 PDF、TXT 或 Markdown 行程檔。');
        }
        text = clean(text);
        checkLength(text);
        if (!text) throw failure('EMPTY', '檔案沒有可讀取的文字，請選擇有內容的行程檔。');
        return { text, warnings };
    }
    function assetURL(relative) {
        if (node) return require('node:path').join(__dirname, 'vendor', 'pdfjs', relative).replaceAll('\\', '/').replace(/\/$/, '') + (relative.endsWith('/') ? '/' : '');
        const url = new URL(`vendor/pdfjs/${relative}`, scriptURL);
        if (url.origin !== location.origin) throw failure('PDF_ASSET', 'PDF 讀取元件必須由本站載入。');
        return url.href;
    }
    async function loadPDF() {
        if (!node && location.protocol === 'file:') throw failure('PDF_LOCAL_FILE', '讀取 PDF 請透過本機服務或網站開啟。請執行「啟動Codex旅遊書.vbs」後重新選檔；直接雙擊 index.html 仍可讀取 TXT／Markdown。');
        if (!pdfModule) {
            pdfModule = import('./vendor/pdfjs/pdf.mjs').catch(() => {
                pdfModule = null;
                throw failure('PDF_ASSET', '無法載入 PDF 讀取元件，請重新整理後再試。');
            });
        }
        const pdf = await pdfModule;
        const worker = assetURL('pdf.worker.mjs');
        pdf.GlobalWorkerOptions.workerSrc = node ? require('node:url').pathToFileURL(worker).href : worker;
        return pdf;
    }
    // Only bundled resources are readable. PDF-supplied links and scripts are never opened.
    class LocalBinaryDataFactory {
        async fetch({ kind, filename }) {
            const directories = { cMapUrl: 'cmaps', standardFontDataUrl: 'standard_fonts', wasmUrl: 'wasm' };
            const extensions = { cMapUrl: /\.bcmap$/, standardFontDataUrl: /\.(?:pfb|ttf)$/, wasmUrl: /\.(?:wasm|js)$/ };
            if (!directories[kind] || typeof filename !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(filename)
                || filename.includes('..') || !extensions[kind].test(filename)) throw new Error('Unsupported local PDF resource.');
            const url = assetURL(`${directories[kind]}/${filename}`);
            if (node) return new Uint8Array(await require('node:fs/promises').readFile(url));
            const response = await fetch(url, { mode: 'same-origin', credentials: 'same-origin', redirect: 'error' });
            if (!response.ok) throw failure('PDF_ASSET', 'PDF 字型資料載入失敗，請重新整理後再試。');
            return new Uint8Array(await response.arrayBuffer());
        }
    }
    function appendItem(state, item, previousLength) {
        if (typeof item.str !== 'string') return;
        const previous = state.previous;
        if (item.str && previous && !state.text.endsWith('\n')) {
            const vertical = item.dir === 'ttb';
            const axis = vertical ? 4 : 5;
            const fontHeight = Math.max(1, Math.abs(item.height || item.transform?.[3] || 0));
            const baselineChanged = previous.transform && item.transform
                && Math.abs(previous.transform[axis] - item.transform[axis]) > Math.max(2, fontHeight * 0.35);
            if (baselineChanged) state.text += '\n';
            else if (previous.transform && item.transform && !/\s$/.test(state.text) && !/^\s/.test(item.str)) {
                const gap = vertical ? previous.transform[5] - item.transform[5] - (previous.height || 0)
                    : item.transform[4] - previous.transform[4] - (previous.width || 0);
                if (gap > Math.max(1, fontHeight * 0.12)) state.text += ' ';
            }
        }
        state.text += item.str;
        if (item.hasEOL && !state.text.endsWith('\n')) state.text += '\n';
        if (item.str) state.previous = item;
        const length = state.text.trim().length;
        if (length && previousLength + length > MAX_CHARACTERS) throw failure('TEXT_LIMIT', '檔案文字超過 30,000 字，請拆成較短的行程再匯入。');
    }
    function hasImages(operators, ops) {
        const imageOps = new Set(['paintImageMaskXObject', 'paintImageMaskXObjectGroup', 'paintImageXObject',
            'paintInlineImageXObject', 'paintInlineImageXObjectGroup', 'paintImageXObjectRepeat',
            'paintImageMaskXObjectRepeat', 'paintSolidColorImageMask'].map(name => ops[name]));
        const pending = [operators];
        while (pending.length) {
            const list = pending.pop();
            if (list.fnArray.some(operation => imageOps.has(operation))) return true;
            // PDF.js expands form XObjects; tiling patterns retain their own operator list.
            for (const args of list.argsArray) {
                if (Array.isArray(args) && args[0] === 'TilingPattern' && args[2]?.fnArray) pending.push(args[2]);
            }
        }
        return false;
    }
    function mergePageText(nativeText, recognizedText) {
        if (!nativeText) return recognizedText;
        const key = line => line.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
        const remaining = new Map();
        for (const line of nativeText.split('\n')) {
            const normalized = key(line);
            if (normalized) remaining.set(normalized, (remaining.get(normalized) || 0) + 1);
        }
        const extra = recognizedText.split('\n').filter(line => {
            const normalized = key(line);
            const copies = remaining.get(normalized) || 0;
            if (copies) { remaining.set(normalized, copies - 1); return false; }
            return true;
        });
        return [nativeText, extra.join('\n')].filter(Boolean).join('\n');
    }
    async function renderPageImage(page, signal) {
        aborted(signal);
        if (typeof document !== 'object' || typeof document.createElement !== 'function') {
            throw failure('PDF_OCR_ASSET', '掃描 PDF 的圖片辨識請透過本機服務或網站開啟後使用。');
        }
        const original = page.getViewport({ scale: 1 });
        if (![original.width, original.height].every(value => Number.isFinite(value) && value > 0)) {
            throw failure('PDF_RENDER', 'PDF 頁面尺寸無效，請重新匯出 PDF 後再試。');
        }
        const scale = Math.min(3, OCR_SIDE / Math.max(original.width, original.height), Math.sqrt(OCR_PIXELS / (original.width * original.height)));
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.floor(viewport.width));
        canvas.height = Math.max(1, Math.floor(viewport.height));
        let renderTask, timer, cancel;
        const interrupted = new Promise((_, reject) => {
            cancel = () => { renderTask?.cancel(); reject(Object.assign(new Error('已取消讀取行程檔案。'), { name: 'AbortError' })); };
            timer = setTimeout(() => { reject(failure('PDF_RENDER_TIMEOUT', 'PDF 頁面轉換超過 120 秒，請拆分頁面或重新匯出 PDF 後再試。')); renderTask?.cancel(); }, RENDER_TIMEOUT_MS);
        });
        signal?.addEventListener('abort', cancel, { once: true });
        try {
            const context = canvas.getContext('2d');
            if (!context) throw failure('PDF_RENDER', '無法準備 PDF 圖片辨識，請重新整理後再試。');
            renderTask = page.render({ canvas, canvasContext: context, viewport, background: 'white' });
            await Promise.race([renderTask.promise, interrupted]);
            aborted(signal);
            const encode = type => Promise.race([new Promise((resolve, reject) => {
                canvas.toBlob(blob => blob ? resolve(blob) : reject(failure('PDF_RENDER', 'PDF 頁面無法轉為圖片，請重新匯出後再試。')), type, 0.95);
            }), interrupted]);
            let blob = await encode('image/png');
            let extension = 'png';
            if (blob.size > MAX_BYTES) { blob = await encode('image/jpeg'); extension = 'jpg'; }
            if (blob.size > MAX_BYTES) throw failure('PDF_RENDER_LIMIT', 'PDF 頁面轉成圖片後仍超過 8 MB，請拆分此頁或降低圖片複雜度後再匯入。');
            const bytes = new Uint8Array(await Promise.race([blob.arrayBuffer(), interrupted]));
            aborted(signal);
            return { bytes, extension };
        } finally {
            clearTimeout(timer);
            signal?.removeEventListener('abort', cancel);
            renderTask?.cancel();
            try { await renderTask?.promise; } catch { /* Rendering cancellation is handled by the caller. */ }
            canvas.width = 0; canvas.height = 0;
        }
    }
    async function pdfFile(bytes, { onProgress, signal, prepareImages = false }) {
        const pdf = await loadPDF();
        aborted(signal);
        let task;
        try { task = pdf.getDocument({
            data: bytes, stopAtErrors: true, isEvalSupported: false,
            enableXfa: false, disableFontFace: true, useSystemFonts: false,
            useWorkerFetch: false, BinaryDataFactory: LocalBinaryDataFactory,
            cMapUrl: assetURL('cmaps/'), cMapPacked: true,
            standardFontDataUrl: assetURL('standard_fonts/'), wasmUrl: assetURL('wasm/'),
            disableAutoFetch: true, disableStream: true, disableRange: true, verbosity: 0
        }); } catch { throw failure('PDF_INVALID', '無法讀取這份 PDF，檔案可能是空白或已損毀。請重新匯出 PDF，或改用 TXT 檔。'); }
        let destroyPromise;
        const destroy = () => { destroyPromise ||= task.destroy().catch(() => {}); return destroyPromise; };
        const cancel = () => { void destroy(); };
        signal?.addEventListener('abort', cancel, { once: true });
        try {
            const document = await task.promise;
            aborted(signal);
            const pages = document.numPages;
            if (pages > MAX_PAGES) throw failure('PAGE_LIMIT', 'PDF 超過 60 頁，請先保留需要的行程頁面再匯入。');
            let text = '';
            const emptyPages = [];
            const ocrPages = [], unreadableImages = [], ocrWarnings = new Set();
            const images = [];
            let imageBytes = 0;
            for (let number = 1; number <= pages; number++) {
                aborted(signal);
                progress(onProgress, { stage: 'pdf', page: number, pages, message: `讀取 PDF 第 ${number} / ${pages} 頁…` });
                const page = await document.getPage(number);
                let reader;
                try {
                    reader = page.streamTextContent().getReader();
                    const state = { text: '', previous: null };
                    const separator = text ? '\n\n' : '';
                    for (;;) {
                        aborted(signal);
                        const chunk = await reader.read();
                        if (chunk.done) break;
                        for (const item of chunk.value.items) appendItem(state, item, text.length + separator.length);
                    }
                    let pageText = clean(state.text);
                    // PDF.js 6.4.299 can leave this promise pending after task.destroy().
                    const operators = await abortable(page.getOperatorList(), signal);
                    aborted(signal);
                    if (!pageText || hasImages(operators, pdf.OPS)) {
                        progress(onProgress, { stage: 'pdf', page: number, pages, message: prepareImages
                            ? `準備 PDF 第 ${number} / ${pages} 頁圖片供 Codex 讀取…`
                            : `PDF 第 ${number} / ${pages} 頁文字辨識：準備頁面圖片…` });
                        const rendered = await renderPageImage(page, signal);
                        ocrPages.push(number);
                        try {
                            const recognized = await imageFile(rendered.bytes, { extension: rendered.extension, signal, prepareImages,
                                onProgress: state => { if (!signal?.aborted) progress(onProgress, { ...state, stage: 'pdf', page: number, pages, message: `PDF 第 ${number} / ${pages} 頁文字辨識：${state.message}` }); }
                            });
                            if (prepareImages) {
                                const attachment = recognized.images[0];
                                imageBytes += attachmentBytes(attachment);
                                if (imageBytes > MAX_TOTAL_IMAGE_BYTES || images.length >= MAX_PAGES) throw failure('ATTACHMENT_LIMIT', 'PDF 圖片附件合計超過 20 MiB 或 60 張，請拆分行程後再匯入。');
                                images.push({ ...attachment, page: number });
                            } else pageText = mergePageText(pageText, recognized.text);
                            for (const warning of recognized.warnings || []) ocrWarnings.add(warning);
                        } catch (error) {
                            aborted(signal);
                            if (prepareImages || error.code !== 'IMAGE_NO_TEXT') throw error;
                            if (pageText) unreadableImages.push(number);
                        }
                    }
                    checkLength(text + (pageText ? separator + pageText : ''));
                    if (pageText) text += separator + pageText;
                    else if (!prepareImages) emptyPages.push(number);
                } finally {
                    try { await reader?.cancel(new Error('Itinerary text reading finished.')); } catch { /* Worker may already be destroyed on cancellation. */ }
                    page.cleanup();
                }
            }
            aborted(signal);
            if (!text.trim() && !images.length) throw failure('PDF_NO_TEXT', '這份 PDF 經文字擷取與圖片辨識後仍沒有可讀文字，請使用較清晰的 PDF 或直接貼上行程文字。');
            const warnings = ['PDF 的欄位、表格或多欄版面可能影響文字順序，請確認預覽內容。'];
            if (ocrPages.length) warnings.push(prepareImages
                ? `第 ${ocrPages.join('、')} 頁已準備為圖片，將交由 Codex 讀取；請核對整理結果。`
                : `第 ${ocrPages.join('、')} 頁已使用圖片文字辨識，小字或模糊內容可能誤判，請核對原始 PDF。`, ...ocrWarnings);
            if (emptyPages.length) warnings.push(`第 ${emptyPages.join('、')} 頁經文字擷取與圖片辨識後沒有可讀文字，已略過；請確認是否為空白頁或遺漏行程。`);
            if (unreadableImages.length) warnings.push(`第 ${unreadableImages.join('、')} 頁的圖片未辨識出文字，已保留原生文字；請核對圖片是否含有遺漏的行程。`);
            return { text, format: 'pdf', pages, warnings, ...(prepareImages ? { images } : {}) };
        } catch (error) {
            aborted(signal);
            if (error.name === 'PasswordException') throw failure('PDF_PASSWORD', '這份 PDF 需要密碼，請先解除密碼保護後再匯入。');
            if (['TEXT_LIMIT', 'PAGE_LIMIT', 'PDF_NO_TEXT', 'PDF_ASSET', 'PDF_OCR_ASSET', 'PDF_RENDER', 'PDF_RENDER_LIMIT', 'PDF_RENDER_TIMEOUT', 'IMAGE_ATTACHMENT_LIMIT', 'ATTACHMENT_LIMIT'].includes(error.code)) throw error;
            if (error.code?.startsWith('IMAGE_')) throw failure(prepareImages ? 'PDF_PREPARE' : 'PDF_OCR', prepareImages
                ? 'PDF 圖片附件準備未能完成，請縮小或拆分頁面後重試。這次未匯入任何部分結果。'
                : 'PDF 圖片文字辨識未能完成，請確認連線、縮小或拆分頁面後重試。這次未匯入任何部分結果。');
            throw failure('PDF_INVALID', '無法完整讀取這份 PDF，檔案可能損毀或格式不支援。請重新匯出 PDF，或改用 TXT 檔。');
        } finally {
            signal?.removeEventListener('abort', cancel);
            await destroy();
        }
    }
    function attachmentBytes(attachment) {
        if (!attachment || !['image/png', 'image/jpeg'].includes(attachment.mime) || typeof attachment.dataBase64 !== 'string'
            || !attachment.dataBase64.length || attachment.dataBase64.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(attachment.dataBase64)) {
            throw failure('IMAGE_RESULT', '圖片附件格式無效，請重新選取圖片後再試。');
        }
        const bytes = attachment.dataBase64.length / 4 * 3 - (attachment.dataBase64.endsWith('==') ? 2 : attachment.dataBase64.endsWith('=') ? 1 : 0);
        if (bytes > MAX_IMAGE_BYTES) throw failure('IMAGE_ATTACHMENT_LIMIT', '圖片附件超過 2 MiB，請裁切或縮小圖片後再匯入。');
        return bytes;
    }
    async function imageFile(bytes, { extension, signal, onProgress, prepareImages = false }) {
        const image = node ? require('./itinerary-image.js') : root.ItineraryImage;
        const method = prepareImages ? 'prepare' : 'read';
        if (typeof image?.[method] !== 'function') throw failure('IMAGE_ASSET', '圖片讀取元件尚未載入，請重新整理後再試。');
        const result = await image[method](bytes, { extension, signal, onProgress });
        aborted(signal);
        if (prepareImages) {
            if (!Array.isArray(result?.images) || result.images.length !== 1) throw failure('IMAGE_RESULT', '圖片附件準備結果無效，請重新選取圖片後再試。');
            attachmentBytes(result.images[0]);
            return { text: '', format: 'image', pages: null, warnings: result.warnings || [], images: result.images };
        }
        if (!result || typeof result.text !== 'string') throw failure('IMAGE_RESULT', '圖片辨識結果無效，請重新選取圖片後再試。');
        const text = clean(result.text);
        checkLength(text);
        if (!text) throw failure('IMAGE_NO_TEXT', '圖片未辨識出文字，請改用較清晰的行程圖片，或直接貼上文字。');
        return { ...result, text, format: 'image', pages: null };
    }
    async function read(file, { onProgress, signal, prepareImages = false } = {}) {
        aborted(signal);
        if (!file || typeof file.name !== 'string' || typeof file.arrayBuffer !== 'function') throw failure('FILE', '請先選擇行程檔案。');
        const extension = /\.([^.]+)$/.exec(file.name)?.[1].toLowerCase();
        if (['heic', 'heif'].includes(extension)) throw failure('FORMAT', '目前不支援 HEIC／HEIF 圖片，請先轉存為 JPG 或 PNG 後匯入。');
        const image = ['png', 'jpg', 'jpeg', 'webp'].includes(extension);
        if (!image && !['pdf', 'txt', 'md', 'markdown'].includes(extension)) throw failure('FORMAT', '目前支援 PDF、TXT、Markdown（.md、.markdown）及 PNG、JPG、JPEG、WebP 行程圖片。');
        if (!Number.isFinite(file.size) || file.size < 0 || file.size > MAX_BYTES) throw failure('FILE_LIMIT', '檔案超過 8 MB，請縮小或拆分後再匯入。');
        progress(onProgress, { stage: 'reading', page: 0, pages: null, message: '正在讀取行程檔案…' });
        let buffer;
        try { buffer = await file.arrayBuffer(); }
        catch { aborted(signal); throw failure('FILE_READ', '無法讀取此檔案，請重新選取後再試。'); }
        aborted(signal);
        if (buffer.byteLength > MAX_BYTES) throw failure('FILE_LIMIT', '檔案超過 8 MB，請縮小或拆分後再匯入。');
        const bytes = new Uint8Array(buffer);
        const result = image ? await imageFile(bytes, { extension, onProgress, signal, prepareImages })
            : extension === 'pdf' ? await pdfFile(bytes, { onProgress, signal, prepareImages })
            : { ...textFile(bytes), format: extension === 'txt' ? 'txt' : 'md', pages: null };
        aborted(signal);
        if (prepareImages && !result.images) result.images = [];
        progress(onProgress, { stage: 'done', page: result.pages, pages: result.pages, message: prepareImages ? '檔案已準備完成，可交由 Codex 讀取與整合。' : '檔案讀取完成，請確認文字。' });
        return result;
    }
    return { read, MAX_BYTES, MAX_PAGES, MAX_CHARACTERS, MAX_IMAGE_BYTES, MAX_TOTAL_IMAGE_BYTES };
}));
