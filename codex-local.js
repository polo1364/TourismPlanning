(function () {
    'use strict';
    const cloudPage = window.ROAM_CLOUD === true && location.protocol === 'https:';
    const browserApi = !cloudPage && location.protocol === 'https:' ? window.OpenAIBrowser : null;
    const BASE = cloudPage ? '/codex' : 'http://127.0.0.1:8081';
    const localPage = location.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(location.hostname);
    const localOnlyMessage = 'Codex 額度僅供本機版使用。請下載專案並執行「啟動Codex旅遊書.vbs」；線上版可手動選用自己的 DeepSeek API Key。';
    const $ = id => document.getElementById(id);
    let token = '';
    let authMode = browserApi ? 'api' : 'chatgpt';
    let touched = false;
    let usagePending = null, quota = null, chosenModel = '', modelIds = new Set();
    let totalTokens = 0, measuredCalls = 0, missingCalls = 0;
    try { chosenModel = localStorage.getItem(browserApi ? 'openaiModel' : 'codexModel') || ''; } catch (_) { /* Optional preference. */ }
    const number = value => value.toLocaleString('zh-TW', { maximumFractionDigits: 1 });
    const selected = () => $('aiProvider').value === 'codex';
    function summary() {
        const button = $('codexUsageSummary');
        if (!button) return;
        button.hidden = !selected() || (!localPage && !cloudPage && !browserApi);
        const bucket = quota?.limits?.find(item => item.id === 'codex') || quota?.limits?.[0];
        const remaining = bucket?.windows?.map(item => item.remainingPercent);
        if (authMode === 'api') { button.textContent = 'OpenAI API 用量 ↗'; return; }
        button.textContent = quota?.available && remaining?.length ? `Codex 剩餘 ${number(Math.min(...remaining))}% ↗` : 'Codex 額度待查 ↗';
    }
    function chooseModel() {
        if (isBusy) { $('codexModel').value = chosenModel; return; }
        chosenModel = $('codexModel').value;
        try { localStorage.setItem(authMode === 'api' ? 'openaiModel' : 'codexModel', chosenModel); } catch (_) { /* Optional preference. */ }
    }
    function renderModels(models) {
        const select = $('codexModel');
        if (!select) return;
        modelIds = new Set((models || []).map(model => model.id));
        select.replaceChildren(new Option(authMode === 'api' ? '預設可用模型' : '官方預設模型', ''));
        for (const model of models || []) select.add(new Option(model.name + (model.isDefault ? ' · 預設' : ''), model.id));
        if (chosenModel && !modelIds.has(chosenModel)) {
            const missing = new Option(chosenModel + ' · 目前無法確認，請重選', chosenModel);
            missing.disabled = true; select.add(missing);
        }
        select.value = chosenModel;
        select.disabled = isBusy;
        if (authMode === 'api') { $('codexModelHint').textContent = modelIds.size ? `已列出 ${modelIds.size} 個支援圖片輸入的行程模型（依此 API Key 的模型清單）。各模型費用不同；實際使用仍依專案權限與額度。` : '尚未取得本站支援的行程模型；請先檢查 API Key，再更新可用模型。'; return; }
        $('codexModelHint').textContent = modelIds.size ? '依目前登入的 Codex 提供模型；生成期間鎖定選擇。不同模型的速度與額度消耗可能不同。' : '模型清單暫時無法取得；可更新重試，或選擇官方預設模型。';
    }
    function renderQuota(info) {
        quota = info;
        const area = $('codexUsageWindows');
        area.replaceChildren();
        for (const bucket of info.limits || []) for (const window of bucket.windows) {
            const row = document.createElement('div'); row.className = 'codex-quota';
            row.dataset.low = String(window.remainingPercent <= 20);
            const heading = document.createElement('div'); heading.className = 'codex-quota-line';
            const label = document.createElement('span'), value = document.createElement('strong');
            const mins = window.windowDurationMins;
            const duration = mins > 0 ? (mins % 1440 === 0 ? `${mins / 1440} 天` : mins % 60 === 0 ? `${mins / 60} 小時` : `${mins} 分鐘`) : '額度週期';
            label.textContent = `${bucket.name} · ${duration}`;
            value.textContent = `剩餘 ${number(window.remainingPercent)}%`;
            heading.append(label, value);
            const bar = document.createElement('progress'); bar.max = 100; bar.value = window.remainingPercent;
            bar.setAttribute('aria-label', `${label.textContent}剩餘額度`);
            const detail = document.createElement('small');
            const reset = window.resetsAt ? new Date(window.resetsAt * 1000) : null;
            detail.textContent = `已用 ${number(window.usedPercent)}% · ` + (reset && Number.isFinite(reset.getTime()) ? `重置：${reset.toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}（裝置時間）` : '重置時間未提供');
            row.append(heading, bar, detail); area.append(row);
        }
        $('codexUsageStatus').textContent = info.available ? `帳戶共用額度 · 更新於 ${new Date(info.checkedAt).toLocaleTimeString('zh-TW')} · 最多快取 30 秒` : '暫時無法取得額度，不代表剩餘 0；可以稍後更新。';
        if (authMode === 'api') $('codexUsageStatus').textContent = 'API 依使用量計費；餘額與費用請至 OpenAI 平台查詢。本頁不推算剩餘百分比。';
        renderModels(info.models);
        summary();
    }
    async function refreshUsage() {
        if (!$('codexUsageWindows') || (!localPage && !cloudPage && !browserApi)) return;
        if (!token) { $('codexUsageStatus').textContent = '請先檢查 Codex 連線。'; return; }
        if (usagePending) return usagePending;
        const requestToken = token;
        $('codexUsageRefresh').disabled = true;
        $('codexUsageStatus').textContent = '正在讀取帳戶額度與模型…';
        usagePending = (async () => {
            try {
                const response = browserApi ? null : await fetch(BASE + '/usage', { headers: { 'X-Roam-Token': requestToken }, signal: AbortSignal.timeout(15000) });
                const info = browserApi ? await browserApi.usage() : await response.json();
                if ((!browserApi && !response.ok) || typeof info.available !== 'boolean') throw new Error('usage');
                if (token === requestToken) renderQuota(info);
            } catch (_) {
                if (token === requestToken) renderQuota({ available: false, limits: [], models: [] });
            } finally { $('codexUsageRefresh').disabled = false; usagePending = null; }
        })();
        return usagePending;
    }
    function recordUsage(usage) {
        if (!$('codexTokenUsage')) return;
        const valid = usage && ['inputTokens', 'outputTokens', 'totalTokens'].every(key => Number.isSafeInteger(usage[key]) && usage[key] >= 0);
        let last = '最近一次：未取得 Token 用量（不代表沒有消耗）。';
        if (valid) {
            measuredCalls++; totalTokens += usage.totalTokens;
            const cache = Number.isSafeInteger(usage.cachedInputTokens) ? number(usage.cachedInputTokens) : '未提供';
            last = `最近一次：${number(usage.totalTokens)} Token\n輸入 ${number(usage.inputTokens)}（含快取 ${cache}）／輸出 ${number(usage.outputTokens)}`;
        } else missingCalls++;
        $('codexTokenUsage').textContent = `${last}\n本分頁已回報累計：${number(totalTokens)} Token（${measuredCalls} 次；${missingCalls} 次未回報）\n重新整理會清除此分頁統計。`;
    }
    function update(manual = false) {
        if (manual) touched = true;
        $('deepseekSettings').hidden = selected();
        $('codexSettings').hidden = !selected();
        summary();
        updateApiStatus();
    }
    async function check(signal) {
        token = '';
        if (!localPage && !cloudPage && !browserApi) { $('codexStatus').textContent = localOnlyMessage; return false; }
        $('codexStatus').textContent = cloudPage ? '正在檢查雲端 Codex…' : '正在檢查本機 Codex…';
        try {
            const response = browserApi ? null : await fetch(BASE + '/status', { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12000)]) : AbortSignal.timeout(12000) });
            const data = browserApi ? { auth: 'api', ready: browserApi.ready(), token: browserApi.ready() ? 'browser-api' : '' } : await response.json();
            if ((!browserApi && !response.ok) || !['chatgpt', 'api'].includes(data.auth) || typeof data.token !== 'string') throw new Error(data.error || '無法確認生成服務。');
            if (authMode !== data.auth) {
                authMode = data.auth;
                try { chosenModel = localStorage.getItem(authMode === 'api' ? 'openaiModel' : 'codexModel') || ''; } catch (_) { chosenModel = ''; }
                quota = null; modelIds = new Set();
            }
            if (authMode === 'api') {
                token = data.token;
                $('openaiKeySettings').hidden = false;
                $('codexBillingHint').textContent = '行程生成、檔案整合與插圖使用 OpenAI API 額度，不使用 ChatGPT 訂閱額度。掃描 PDF 會以頁面圖片送出。';
                $('aiProvider').querySelector('option[value="codex"]').textContent = 'OpenAI API · 使用 API 額度';
                $('codexUsageTitle').textContent = 'OpenAI API 用量';
                $('codexUsageRefresh').textContent = '更新可用模型';
                $('codexUsageExplanation').textContent = 'Token 為本分頁收到的行程生成用量，費用以 OpenAI 帳單為準；圖片生成及中斷請求可能未計入。';
                $('codexHelp').textContent = browserApi ? '此頁直接連接 OpenAI 官方 API，不需要私人站或本機服務。勾選記住後，下次可直接使用；原有檔案與手動補充可繼續整合。' : '由目前連接的伺服器呼叫 OpenAI 官方 API。更換 API Key 不會清除旅程或草稿。插圖使用 gpt-image-1.5，只有按下生成時才呼叫。';
                if (browserApi) {
                    $('openaiSaveKey').textContent = '檢查並使用 API Key';
                    $('openaiRememberOption').hidden = false;
                    $('openaiRememberKey').checked = browserApi.remembered();
                    $('openaiForgetKey').hidden = false;
                    $('openaiKeyPrivacy').textContent = '預設 Key 僅在本分頁使用；勾選記住後，會保存在這個瀏覽器的網站設定，重整或下次開啟可繼續使用。Key 只傳給 OpenAI，不上傳 GitHub、不放進草稿、備份或小冊。此儲存不是加密保管，請勿在共用裝置勾選；擴充套件或惡意程式仍可能讀取 Key。';
                }
                $('codexSettings').querySelector('button').textContent = '檢查 API 連線';
                document.querySelector('label[for="codexModel"]').textContent = 'OpenAI API 模型';
                $('codexStatus').textContent = data.ready ? '已設定 OpenAI API · 使用 API 額度' : '尚未設定 API Key，請在下方輸入並檢查。';
                if (data.ready) await refreshUsage();
                else renderQuota({ available: false, limits: [], models: [] });
                return data.ready;
            }
            if (!data.ready) throw new Error(data.error || '請使用 ChatGPT 帳號登入 Codex。');
            token = data.token;
            $('codexStatus').textContent = cloudPage ? '已連接雲端 Codex · 使用 ChatGPT 登入額度' : '已連接本機 Codex · 使用 ChatGPT 登入額度';
            void refreshUsage();
            return true;
        } catch (error) {
            if (signal?.aborted) throw Object.assign(new Error('已取消生成。'), { code: 'CANCELLED' });
            $('codexStatus').textContent = cloudPage ? '雲端 Codex 目前無法連線，請稍後重新檢查。' : (error instanceof TypeError ? '尚未連接。請執行「啟動Codex旅遊書.vbs」，再按檢查連線。' : error.message);
            if ($('codexUsageWindows')) renderQuota({ available: false, limits: [], models: [] });
            return false;
        }
    }
    async function generate(prompt, signal, { images, itinerary = false } = {}) {
        if (signal?.aborted) throw Object.assign(new Error('已取消生成。'), { code: 'CANCELLED' });
        if (!token && !await check(signal)) throw new Error($('codexStatus').textContent);
        if (chosenModel && !modelIds.has(chosenModel)) {
            await refreshUsage();
            if (!modelIds.has(chosenModel)) throw new Error('請在服務設定更新模型清單，或改選官方預設模型。');
        }
        let recorded = false;
        try {
            if (browserApi) return await browserApi.generate(prompt, signal, { model: chosenModel, images: images || [], onUsage: usage => { recordUsage(usage); recorded = true; } });
            const timeout = 195000;
            const response = await fetch(BASE + (itinerary ? '/import-itinerary' : '/generate'), {
                method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Roam-Token': token },
                body: JSON.stringify({ prompt, model: chosenModel, ...(itinerary ? { images } : {}) }),
                signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout)
            });
            const result = await response.json();
            recordUsage(result.usage); recorded = true;
            if (!response.ok) {
                if (result.code === 'TOKEN' || result.code === 'LOGIN') token = '';
                throw Object.assign(new Error(result.error || 'Codex 請求失敗。'), { code: result.code });
            }
            if (!result.data || typeof result.data !== 'object' || Array.isArray(result.data)) throw new Error('Codex 回應格式無效，結果未儲存。');
            return result.data;
        } catch (error) {
            if (signal?.aborted) throw Object.assign(new Error('已取消 Codex 生成，已完成內容保留。'), { code: 'CANCELLED' });
            if (error.name === 'TimeoutError') throw new Error('Codex 等待逾時，請稍後手動接續。');
            if (error instanceof TypeError) { token = ''; throw new Error(cloudPage ? '雲端連線中斷，請確認網路後再手動接續。' : '無法連接本機 Codex，請確認啟動程式仍在執行。'); }
            throw error;
        } finally {
            if (!recorded) recordUsage(null);
            void refreshUsage();
        }
    }
    async function importItinerary(prompt, images, signal) {
        if (!localPage && !cloudPage && !browserApi) throw new Error('請使用 HTTPS 開啟 GitHub 版並設定 OpenAI API Key；已準備的來源會保留。');
        return generate(prompt, signal, { images, itinerary: true });
    }
    async function init() {
        if (browserApi) $('openaiKeyStatus').textContent = browserApi.restore();
        let saved = null;
        try { saved = localStorage.getItem('aiProvider'); } catch (_) { /* Optional preference. */ }
        if (saved === 'codex' || saved === 'deepseek') $('aiProvider').value = saved;
        update();
        $('hostedNotice').hidden = localPage || cloudPage;
        if (browserApi) $('hostedNotice').textContent = 'GitHub 版可直接使用自己的 OpenAI API Key 讀取檔案與整合行程。不同網址的資料不會自動同步；既有行程可用 JSON 備份搬移。';
        if (cloudPage) {
            $('aiProvider').querySelector('option[value="codex"]').textContent = '雲端 Codex · 使用現有額度';
            $('codexSettings').querySelector('button').textContent = '檢查雲端 Codex 連線';
            $('codexHelp').textContent = '由你的 Oracle 主機生成，電腦關機也能使用。生成時請保持手機頁面開啟；中斷後可手動接續。';
        }
        const connected = await check();
        if ((authMode === 'api' || !saved) && !touched && (connected || authMode === 'api') && !isBusy) { $('aiProvider').value = 'codex'; update(); }
    }
    async function saveApiKey() {
        if (isBusy || $('openaiSaveKey').disabled) return;
        const input = $('openaiApiKey'), button = $('openaiSaveKey'), status = $('openaiKeyStatus');
        const apiKey = input.value.trim();
        input.value = '';
        if (!apiKey) { status.textContent = '請輸入 API Key。'; return; }
        button.disabled = true; status.textContent = browserApi ? '正在驗證 API Key…' : '正在驗證並儲存…';
        try {
            if (browserApi) await browserApi.save(apiKey, $('openaiRememberKey').checked);
            else {
                if (!token) await check();
                if (!token || authMode !== 'api') throw new Error('請先連接已更新的 API 服務。');
                const response = await fetch(BASE + '/settings', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Roam-Token': token }, body: JSON.stringify({ apiKey }), signal: AbortSignal.timeout(20000) });
                const result = await response.json();
                if (!response.ok || !result.saved) throw new Error(result.error || 'API Key 未儲存。');
            }
            chosenModel = '';
            try { localStorage.removeItem('openaiModel'); } catch (_) { /* Optional preference. */ }
            await check();
            status.textContent = browserApi ? (browserApi.remembered() ? 'API Key 已驗證並記住在這個瀏覽器，下次開啟不用再填。' : 'API Key 已驗證，僅在本分頁使用；可繼續整合原有草稿。') : 'API Key 已儲存，可直接繼續整合原有草稿。';
            update();
        } catch (error) { status.textContent = error instanceof TypeError ? '連線失敗，請重新檢查。' : error.message; }
        finally { input.value = ''; button.disabled = false; }
    }
    function rememberApiKey() {
        if (!browserApi) return;
        const checkbox = $('openaiRememberKey'), status = $('openaiKeyStatus');
        if (isBusy || $('openaiSaveKey').disabled) { checkbox.checked = browserApi.remembered(); return; }
        if (checkbox.checked && !browserApi.ready()) { status.textContent = '輸入 Key 並按「檢查並使用 API Key」後，就會記住在這個瀏覽器。'; return; }
        try {
            browserApi.setRemember(checkbox.checked);
            status.textContent = checkbox.checked ? '已在這個瀏覽器記住 API Key，下次開啟不用再填。' : '已移除記住的 Key，目前分頁仍可使用；重整後需重新輸入。';
        } catch (error) { checkbox.checked = browserApi.remembered(); status.textContent = error.message; }
    }
    function forgetApiKey() {
        if (!browserApi || isBusy || $('openaiSaveKey').disabled) return;
        token = ''; $('openaiApiKey').value = '';
        try {
            browserApi.clear();
            $('openaiKeyStatus').textContent = '已清除此分頁與瀏覽器記住的 API Key，檔案、補充與草稿保留。';
        } catch (_) { $('openaiKeyStatus').textContent = '本分頁的 Key 已清除，但無法移除瀏覽器記住的設定；請檢查網站儲存權限後再按清除。'; }
        void check();
    }
    async function imageRequest(path, body) {
        if (browserApi) return browserApi.imageRequest(path, body);
        if (!localPage && !cloudPage) throw new Error('生成插圖需使用本機或私人雲端版；此版本可匯入、閱讀與下載已存圖片。');
        if (!token && !await check()) throw new Error('請先檢查 Codex 連線與登入。');
        const response = await fetch(BASE + '/images' + path, {
            method: body === undefined ? 'GET' : 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Roam-Token': token },
            body: body === undefined ? undefined : JSON.stringify({ ...body, model: chosenModel }),
            signal: AbortSignal.timeout(45000)
        });
        const value = await response.json();
        if (!response.ok) {
            if (value.code === 'TOKEN' || value.code === 'LOGIN') token = '';
            throw Object.assign(new Error(value.error || '圖片請求失敗。'), { code: value.code, status: response.status });
        }
        return value;
    }
    if (browserApi) {
        window.addEventListener('pageshow', event => { if (event.persisted) { $('openaiKeyStatus').textContent = browserApi.restore(); void check().then(() => update()); } });
        window.addEventListener('roam-openai-key-change', () => { $('openaiKeyStatus').textContent = 'API Key 設定已在另一個分頁變更。'; void check().then(() => update()); });
    }
    window.CodexLocal = Object.freeze({ selected, update, check, generate, saveApiKey, rememberApiKey, forgetApiKey, billing: () => authMode, importItinerary, importsAvailable: () => localPage || cloudPage || !!browserApi, init, refreshUsage, chooseModel, imageRequest, imagesAvailable: () => localPage || cloudPage || !!browserApi });
})();
