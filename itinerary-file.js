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
    const node = typeof module === 'object' && !!module.exports;
    const scriptURL = !node && (document.currentScript?.src || document.baseURI);
    let pdfModule;

    function failure(code, message) { return Object.assign(new Error(message), { code }); }
    function aborted(signal) {
        if (signal?.aborted) throw Object.assign(new Error('已取消讀取行程檔案。'), { name: 'AbortError' });
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
    async function pdfFile(bytes, { onProgress, signal }) {
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
                    const pageText = clean(state.text);
                    if (pageText) text += separator + pageText;
                    else emptyPages.push(number);
                } finally {
                    try { await reader?.cancel(new Error('Itinerary text reading finished.')); } catch { /* Worker may already be destroyed on cancellation. */ }
                    page.cleanup();
                }
            }
            aborted(signal);
            if (!text.trim()) throw failure('PDF_NO_TEXT', '這份 PDF 沒有可擷取的文字，可能是掃描或圖片檔。可將需要的頁面匯出為 JPG／PNG 圖片後匯入進行 OCR，或改用 TXT 檔。');
            const warnings = ['PDF 的欄位、表格或多欄版面可能影響文字順序，請確認預覽內容。'];
            if (emptyPages.length) warnings.push(`第 ${emptyPages.join('、')} 頁沒有可擷取文字，可能是空白頁或圖片，請確認是否遺漏行程。`);
            return { text, format: 'pdf', pages, warnings };
        } catch (error) {
            aborted(signal);
            if (error.name === 'PasswordException') throw failure('PDF_PASSWORD', '這份 PDF 需要密碼，請先解除密碼保護後再匯入。');
            if (['TEXT_LIMIT', 'PAGE_LIMIT', 'PDF_NO_TEXT', 'PDF_ASSET'].includes(error.code)) throw error;
            throw failure('PDF_INVALID', '無法完整讀取這份 PDF，檔案可能損毀或格式不支援。請重新匯出 PDF，或改用 TXT 檔。');
        } finally {
            signal?.removeEventListener('abort', cancel);
            await destroy();
        }
    }
    async function imageFile(bytes, { extension, signal, onProgress }) {
        const image = node ? require('./itinerary-image.js') : root.ItineraryImage;
        if (typeof image?.read !== 'function') throw failure('IMAGE_ASSET', '圖片文字辨識元件尚未載入，請重新整理後再試。');
        const result = await image.read(bytes, { extension, signal, onProgress });
        aborted(signal);
        if (!result || typeof result.text !== 'string') throw failure('IMAGE_RESULT', '圖片辨識結果無效，請重新選取圖片後再試。');
        const text = clean(result.text);
        checkLength(text);
        if (!text) throw failure('IMAGE_NO_TEXT', '圖片未辨識出文字，請改用較清晰的行程圖片，或直接貼上文字。');
        return { ...result, text, format: 'image', pages: null };
    }
    async function read(file, { onProgress, signal } = {}) {
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
        const result = image ? await imageFile(bytes, { extension, onProgress, signal })
            : extension === 'pdf' ? await pdfFile(bytes, { onProgress, signal })
            : { ...textFile(bytes), format: extension === 'txt' ? 'txt' : 'md', pages: null };
        aborted(signal);
        progress(onProgress, { stage: 'done', page: result.pages, pages: result.pages, message: '檔案讀取完成，請確認文字。' });
        return result;
    }
    return { read, MAX_BYTES, MAX_PAGES, MAX_CHARACTERS };
}));
