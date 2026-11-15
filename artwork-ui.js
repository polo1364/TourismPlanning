(function () {
    'use strict';
    const core = window.TripArtworkCore, storage = window.TripArtworkStore;
    const $ = id => document.getElementById(id);
    let running = false, preparing = false, stopping = false, currentJob = null, refreshVersion = 0;
    const active = () => window.TripLibrary?.active();
    const city = () => String(generationState?.city || $('city').value || '');
    const targets = () => core.targets(city(), tripData);
    const status = text => { $('artworkStatus').textContent = text; };
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    // Claude API mode (the Claude option in 服務設定): Claude draws a flat SVG, stored as an ordinary picture.
    const claudeMode = () => !window.CodexLocal?.selected();
    const claudeKey = () => ($('apiKey')?.value || '').trim();
    const canGenerate = () => claudeMode() ? !!claudeKey() && !!window.ClaudeClient : !!window.CodexLocal?.imagesAvailable();
    let claudeController = null;
    // Model output is untrusted: keep plain drawing elements only. Pictures are also only ever shown through <img>.
    const SVG_TAGS = new Set(['svg', 'g', 'defs', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'lineargradient', 'radialgradient', 'stop', 'clippath', 'mask', 'pattern', 'title', 'desc', 'use', 'symbol']);
    function sanitizeSvg(text) {
        const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
        const svg = doc.documentElement;
        if (doc.querySelector('parsererror') || svg.localName !== 'svg' || svg.namespaceURI !== 'http://www.w3.org/2000/svg') throw new Error('Claude 回傳的 SVG 無法解析，這張未儲存。');
        for (const node of [...svg.querySelectorAll('*')]) if (!SVG_TAGS.has(node.localName.toLowerCase())) node.remove();
        for (const node of [svg, ...svg.querySelectorAll('*')]) {
            for (const { name, value } of [...node.attributes]) {
                const lower = name.toLowerCase();
                if (lower.startsWith('on') || lower === 'style' || (lower.endsWith('href') && !value.startsWith('#')) || /url\s*\(\s*['"]?(?!#)/i.test(value)) node.removeAttribute(name);
            }
        }
        if (!svg.getAttribute('viewBox')) svg.setAttribute('viewBox', '0 0 1536 1024');
        svg.setAttribute('width', '1536'); svg.setAttribute('height', '1024');
        return new XMLSerializer().serializeToString(svg);
    }
    async function svgPicture(text) {
        const url = URL.createObjectURL(new Blob([sanitizeSvg(text)], { type: 'image/svg+xml' }));
        try {
            const picture = new Image();
            picture.src = url;
            await picture.decode();
            const canvas = document.createElement('canvas');
            canvas.width = 1536; canvas.height = 1024;
            const context = canvas.getContext('2d');
            context.fillStyle = '#fbf6ea'; context.fillRect(0, 0, canvas.width, canvas.height);
            context.drawImage(picture, 0, 0, canvas.width, canvas.height);
            return await storage.compress(canvas.toDataURL('image/png'));
        } catch { throw new Error('SVG 插圖無法轉成圖片，這張未儲存。'); }
        finally { URL.revokeObjectURL(url); }
    }
    async function drawWithClaude(selected, tripId) {
        running = true; stopping = false; claudeController = new AbortController();
        $('stopArtwork').disabled = false; $('stopArtwork').hidden = false;
        let completed = 0;
        try {
            for (const target of selected) {
                if (stopping) break;
                status(`已完成 ${completed} / ${selected.length} 張 · Claude 正在畫 ${target.caption}`);
                const svg = await ClaudeClient.drawSvg({ key: claudeKey(), model: $('modelSelect').value, subject: target.subject, signal: claudeController.signal });
                const image = { id: crypto.randomUUID(), ...await svgPicture(svg) };
                await storage.put([image]);
                if (active()?.id !== tripId) throw new Error('目前旅程已改變，已畫好的圖片已保存，請返回原旅程再生成。');
                TripLibrary.write({ artworkRefs_v1: JSON.stringify(core.attach(active().data.a, target, image.id)) }, { undo: false });
                completed++;
                await refresh();
            }
            status(stopping ? `已停止。完成 ${completed} 張，已存圖片保留。` : `已保存 ${completed} 張 Claude 插圖，下載小冊時直接重用。`);
        } catch (error) {
            status(error.code === 'CANCELLED' ? `已停止。完成 ${completed} 張，已存圖片保留。` : `${error.message} 已完成的 ${completed} 張保留，可再按「生成行程插圖」補齊。`);
        } finally {
            running = false; claudeController = null; setBusy(false);
            $('stopArtwork').disabled = true; $('stopArtwork').hidden = true;
            await refresh();
        }
    }
    async function available(target, refs = active()?.data.a || []) {
        const ref = core.findRef(refs, target);
        return ref ? storage.get(ref.assetId) : null;
    }
    async function refresh() {
        const version = ++refreshVersion;
        try {
            const list = targets(), refs = active()?.data.a || [];
            const states = await Promise.all(list.map(async target => ({ target, image: await available(target, refs) })));
            if (version !== refreshVersion) return;
            $('artworkList').replaceChildren();
            for (const { target, image } of states) {
                const card = document.createElement('article'); card.className = 'artwork-card';
                if (image) { const img = new Image(); img.src = image.dataUrl; img.alt = target.caption + '・AI 行程示意圖'; img.width = image.width; img.height = image.height; card.append(img); }
                const caption = document.createElement('p');
                const stale = !image && refs.some(item => item.slot === target.slot);
                caption.textContent = `${target.day < 0 ? '封面' : '第 ' + (target.day + 1) + ' 天'} · ${target.caption} · ${image ? '已保存' : stale ? '待更新' : '尚未生成'}`;
                const button = document.createElement('button'); button.type = 'button'; button.textContent = image ? '重新生成這張' : '生成這張';
                button.disabled = isBusy || !canGenerate();
                button.addEventListener('click', () => start(target.fingerprint, !!image));
                card.append(caption, button); $('artworkList').append(card);
            }
            $('artworkCount').textContent = `已保存 ${states.filter(item => item.image).length} / ${list.length} 張 · 封面＋每天景點與美食／活動插圖`;
            $('generateArtwork').disabled = isBusy || !list.length || !canGenerate();
            $('artworkHelp').textContent = claudeMode()
                ? (canGenerate() ? '手動生成才使用 Claude API 額度：Claude 會畫扁平向量插畫（不是寫實照片），存成圖片後下載小冊直接重用。行程更動後可重新生成。'
                    : '在服務設定填入 Claude API Key 後，即可請 Claude 畫行程插圖；這裡也可以匯入、閱讀及下載已存圖片。')
                : window.CodexLocal?.imagesAvailable()
                    ? '手動生成才使用額度；下載重用已存圖片。行程更動後可重新生成。圖片為 AI 旅行示意，非景點實拍。'
                    : '生成插圖需使用本機或私人雲端版；這裡可以匯入、閱讀及下載已存圖片。';
        } catch (error) { status(error.message); }
    }
    async function adopt(target, id, tripId) {
        let image = await storage.get(id);
        if (!image) {
            const response = await CodexLocal.imageRequest('/' + id + '/image');
            image = { id, ...await storage.compress('data:' + response.mime + ';base64,' + response.base64) };
            await storage.put([image]);
        }
        if (active()?.id !== tripId) throw new Error('目前旅程已改變，圖片已保存，請返回原旅程接續。');
        const refs = core.attach(active().data.a, target, id);
        TripLibrary.write({ artworkRefs_v1: JSON.stringify(refs) }, { undo: false });
    }
    async function start(fingerprint, force = false) {
        if (isBusy || running || preparing || !active()) return;
        preparing = true;
        setBusy(true);
        let confirmed = false;
        const tripId = active().id;
        let selected = targets().filter(target => !fingerprint || target.fingerprint === fingerprint);
        try {
            if (!force) {
                const missing = await Promise.all(selected.map(async target => {
                    const image = await available(target), request = await storage.job(JSON.stringify([tripId, target.fingerprint]));
                    return { target, image, pending: request && request.id !== image?.id };
                }));
                selected = missing.filter(item => !item.image || item.pending).map(item => item.target);
            }
            if (!selected.length) { status('圖片已齊全。下載小冊會直接重用，不需要重新生成。'); return; }
            confirmed = claudeMode()
                ? confirm(`將${force ? '重新生成' : '生成'} ${selected.length} 張 Claude 向量插畫（扁平插畫風，非寫實照片），使用你的 Claude API 額度。\n主題：${selected.map(item => item.caption).join('、')}\n下載小冊不會再次計費。`)
                : confirm(`將${force ? '重新生成' : '生成或接續'} ${selected.length} 張寫實旅行示意圖，可合併當天多個景點或美食，使用${CodexLocal.billing?.() === 'api' ? ' OpenAI API 額度' : ' Codex 共用額度'}。\n主題：${selected.map(item => item.caption).join('、')}\n下載小冊不會消耗生圖額度。`);
            if (!confirmed) return;
        } catch (error) { status(error.message); return; }
        finally { preparing = false; if (!confirmed) { setBusy(false); void refresh(); } }
        if (active()?.id !== tripId) { setBusy(false); void refresh(); return; }
        if (claudeMode()) { await drawWithClaude(selected, tripId); return; }
        running = true; stopping = false; $('stopArtwork').disabled = false; $('stopArtwork').hidden = false;
        let completed = 0;
        try {
            for (const target of selected) {
                if (stopping) break;
                const key = JSON.stringify([tripId, target.fingerprint]);
                let request = await storage.job(key);
                let replaceId;
                // Re-clicking after an uncertain regeneration resumes that request first.
                if (force && request && request.id === core.findRef(active().data.a, target)?.assetId) { replaceId = request.id; request = null; }
                let state;
                if (request) {
                    try { state = await CodexLocal.imageRequest('/' + request.id); }
                    catch (error) { if (error.code !== 'NOT_FOUND') throw error; }
                    if (state && ['failed','cancelled','interrupted'].includes(state.status)) {
                        if (!confirm(`${target.caption}：${state.error || '先前工作已停止'}\n重新送出這張會使用額度，是否繼續？`)) { stopping = true; break; }
                        replaceId = request.id; request = null;
                    }
                }
                if (!request) {
                    request = await storage.reserveJob(key, target.subject, replaceId); // Atomic across tabs, before POST.
                    state = null;
                }
                currentJob = request.id;
                status(`已完成 ${completed} / ${selected.length} 張 · 正在處理 ${target.caption}`);
                if (!state) state = await CodexLocal.imageRequest('', { id: request.id, subject: target.subject });
                if (stopping && state.status === 'running') await CodexLocal.imageRequest('/' + request.id + '/cancel', {});
                while (state.status === 'running' && !stopping) {
                    await sleep(1500);
                    state = await CodexLocal.imageRequest('/' + request.id);
                }
                if (stopping && state.status !== 'completed') break;
                if (state.status !== 'completed') throw new Error(state.error || '插圖未完成，請手動接續。');
                await adopt(target, request.id, tripId);
                completed++; currentJob = null;
                await refresh();
            }
            status(stopping ? `已停止接續新圖片。完成 ${completed} 張，已存圖片保留；下次接續會先查詢已送出的工作。` : `已保存 ${completed} 張圖片，下載時直接重用。`);
        } catch (error) { status(`${error.message} 已完成圖片保留；請按「生成行程插圖」查詢原工作並接續。`); }
        finally { running = false; currentJob = null; setBusy(false); $('stopArtwork').disabled = true; $('stopArtwork').hidden = true; await refresh(); }
    }
    async function stop() {
        stopping = true; $('stopArtwork').disabled = true;
        if (claudeController) { claudeController.abort(); return; }
        if (currentJob) {
            try { await CodexLocal.imageRequest('/' + currentJob + '/cancel', {}); }
            catch (error) { status('停止請求未確認：' + error.message + '。下次接續會先查詢原工作。'); }
        }
    }
    async function snapshot(width = 1440, quality = .82) {
        const refs = active()?.data.a || [], images = [];
        for (const target of targets()) {
            const image = await available(target, refs);
            if (image) {
                await storage.validateImage(image.dataUrl);
                images.push({ ...target, ...(width < image.width || quality < .82 ? await storage.compress(image.dataUrl, width, quality) : image) });
            }
        }
        return images;
    }
    async function backup(all = false) {
        if (isBusy || !active()) return;
        setBusy(true);
        try {
            saveInputs();
            const collection = all ? TripLibrary.collection() : { format: 'tourism-library', version: 1, trips: [{ name: active().name, data: active().data }] };
            const ids = new Set(collection.trips.flatMap(trip => trip.data.a.map(ref => ref.assetId)));
            const assets = [], present = new Set();
            for (const id of ids) { const image = await storage.get(id); if (image) { assets.push(image); present.add(id); } }
            let missingHistory = 0;
            for (const trip of collection.trips) {
                const current = new Set(core.targets(trip.data.g?.city || trip.data.i.city, trip.data.t).map(target => target.fingerprint));
                trip.data.a = trip.data.a.filter(ref => {
                    if (present.has(ref.assetId)) return true;
                    if (current.has(ref.fingerprint)) throw new Error('目前行程的部分插圖已不在此瀏覽器；請先補齊圖片或使用純文字備份。');
                    missingHistory++; return false;
                });
            }
            const blob = new Blob([JSON.stringify({ format: 'tourism-artwork', version: 1, collection, assets })], { type: 'application/json' });
            if (blob.size > storage.MAX_BACKUP) throw new Error('含插圖備份超過 100 MiB，請改為逐份旅程備份。');
            downloadBlob(blob, all ? 'all_trips_with_artwork.json' : 'trip_with_artwork.json');
            status('含插圖備份已下載；匯入時會新增旅程，保留現有收藏。' + (missingHistory ? ` ${missingHistory} 筆缺少成品的舊景點圖片索引未納入備份，原旅程資料保留。` : ''));
        } catch (error) { status(error.message); }
        finally { setBusy(false); await refresh(); }
    }
    async function importBackup(value) {
        if (value.version !== 1 || !value.collection || !Array.isArray(value.assets) || value.assets.length > 10000) throw new Error('含插圖備份格式無效。');
        const collection = value.collection;
        if (collection.format !== 'tourism-library' || collection.version !== 1 || !Array.isArray(collection.trips) || !collection.trips.length || collection.trips.length > 20) throw new Error('旅程收藏格式無效。');
        const count = TripLibrary.validateCollection(collection);
        if (!confirm(`將新增 ${count} 份含插圖旅程，現有旅程會保留。是否繼續？`)) return false;
        const assets = [], mapping = new Map();
        for (const image of value.assets) {
            if (!image || !core.ID.test(image.id) || mapping.has(image.id)) throw new Error('備份圖片識別碼無效或重複。');
            const dimensions = await storage.validateImage(image.dataUrl);
            const id = crypto.randomUUID(); mapping.set(image.id, id);
            assets.push({ id, dataUrl: image.dataUrl, ...dimensions });
        }
        const next = structuredClone(collection);
        for (const trip of next.trips) trip.data.a = core.refs(trip.data.a).map(ref => {
            if (!mapping.has(ref.assetId)) throw new Error('備份缺少插圖成品，原旅程未變更。');
            return { ...ref, assetId: mapping.get(ref.assetId) };
        });
        // Staging is atomic and uses new IDs; failure cannot overwrite existing pictures.
        await storage.put(assets);
        return TripLibrary.importCollection(next, true);
    }
    function init() {
        $('generateArtwork').addEventListener('click', () => start());
        $('stopArtwork').addEventListener('click', stop);
        $('backupArtwork').addEventListener('click', () => backup(false));
        $('backupAllArtwork').addEventListener('click', () => backup(true));
        $('artworkPanel').addEventListener('toggle', () => { if ($('artworkPanel').open) void refresh(); });
        new MutationObserver(() => { if ($('artworkPanel').open && !running) void refresh(); }).observe($('tripContainer'), { childList: true });
        void refresh();
    }
    window.TripArtwork = Object.freeze({ refresh, start, stop, snapshot, backup, importBackup });
    window.addEventListener('load', init);
})();
