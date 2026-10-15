(function () {
    'use strict';
    const cloudPage = window.ROAM_CLOUD === true && location.protocol === 'https:';
    const BASE = cloudPage ? '/codex' : 'http://127.0.0.1:8081';
    const localPage = location.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(location.hostname);
    const localOnlyMessage = 'Codex 額度僅供本機版使用。請下載專案並執行「啟動Codex旅遊書.vbs」；線上版可手動選用自己的 DeepSeek API Key。';
    const $ = id => document.getElementById(id);
    let token = '';
    let touched = false;
    let usagePending = null, quota = null, chosenModel = '', modelIds = new Set();
    let totalTokens = 0, measuredCalls = 0, missingCalls = 0;
    try { chosenModel = localStorage.getItem('codexModel') || ''; } catch (_) { /* Optional preference. */ }
    const number = value => value.toLocaleString('zh-TW', { maximumFractionDigits: 1 });
    const selected = () => $('aiProvider').value === 'codex';
    function summary() {
        const button = $('codexUsageSummary');
        if (!button) return;
        button.hidden = !selected() || (!localPage && !cloudPage);
        const bucket = quota?.limits?.find(item => item.id === 'codex') || quota?.limits?.[0];
        const remaining = bucket?.windows?.map(item => item.remainingPercent);
        button.textContent = quota?.available && remaining?.length ? `Codex 剩餘 ${number(Math.min(...remaining))}% ↗` : 'Codex 額度待查 ↗';
    }
    function chooseModel() {
        if (isBusy) { $('codexModel').value = chosenModel; return; }
        chosenModel = $('codexModel').value;
        try { localStorage.setItem('codexModel', chosenModel); } catch (_) { /* Optional preference. */ }
    }
    function renderModels(models) {
        const select = $('codexModel');
        if (!select) return;
        modelIds = new Set((models || []).map(model => model.id));
        select.replaceChildren(new Option('官方預設模型', ''));
        for (const model of models || []) select.add(new Option(model.name + (model.isDefault ? ' · 預設' : ''), model.id));
        if (chosenModel && !modelIds.has(chosenModel)) {
            const missing = new Option(chosenModel + ' · 目前無法確認，請重選', chosenModel);
            missing.disabled = true; select.add(missing);
        }
        select.value = chosenModel;
        select.disabled = isBusy;
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
        renderModels(info.models);
        summary();
    }
    async function refreshUsage() {
        if (!$('codexUsageWindows') || (!localPage && !cloudPage)) return;
        if (!token) { $('codexUsageStatus').textContent = '請先檢查 Codex 連線。'; return; }
        if (usagePending) return usagePending;
        const requestToken = token;
        $('codexUsageRefresh').disabled = true;
        $('codexUsageStatus').textContent = '正在讀取帳戶額度與模型…';
        usagePending = (async () => {
            try {
                const response = await fetch(BASE + '/usage', { headers: { 'X-Roam-Token': requestToken }, signal: AbortSignal.timeout(15000) });
                const info = await response.json();
                if (!response.ok || typeof info.available !== 'boolean') throw new Error('usage');
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
        if (!localPage && !cloudPage) { $('codexStatus').textContent = localOnlyMessage; return false; }
        $('codexStatus').textContent = cloudPage ? '正在檢查雲端 Codex…' : '正在檢查本機 Codex…';
        try {
            const response = await fetch(BASE + '/status', { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12000)]) : AbortSignal.timeout(12000) });
            const data = await response.json();
            if (!response.ok || !data.ready || data.auth !== 'chatgpt' || typeof data.token !== 'string') throw new Error(data.error || '請使用 ChatGPT 帳號登入 Codex。');
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
    async function generate(prompt, signal) {
        if (signal?.aborted) throw Object.assign(new Error('已取消生成。'), { code: 'CANCELLED' });
        if (!token && !await check(signal)) throw new Error($('codexStatus').textContent);
        if (chosenModel && !modelIds.has(chosenModel)) {
            await refreshUsage();
            if (!modelIds.has(chosenModel)) throw new Error('請在服務設定更新模型清單，或改選官方預設模型。');
        }
        let recorded = false;
        try {
            const response = await fetch(BASE + '/generate', {
                method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Roam-Token': token },
                body: JSON.stringify({ prompt, model: chosenModel }),
                signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(195000)]) : AbortSignal.timeout(195000)
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
    async function init() {
        let saved = null;
        try { saved = localStorage.getItem('aiProvider'); } catch (_) { /* Optional preference. */ }
        if (saved === 'codex' || saved === 'deepseek') $('aiProvider').value = saved;
        update();
        $('hostedNotice').hidden = localPage || cloudPage;
        if (cloudPage) {
            $('aiProvider').querySelector('option[value="codex"]').textContent = '雲端 Codex · 使用現有額度';
            $('codexSettings').querySelector('button').textContent = '檢查雲端 Codex 連線';
            $('codexHelp').textContent = '由你的 Oracle 主機生成，電腦關機也能使用。生成時請保持手機頁面開啟；中斷後可手動接續。';
        }
        const connected = await check();
        if (!saved && !touched && connected && !isBusy) { $('aiProvider').value = 'codex'; update(); }
    }
    async function imageRequest(path, body) {
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
    window.CodexLocal = Object.freeze({ selected, update, check, generate, init, refreshUsage, chooseModel, imageRequest, imagesAvailable: () => localPage || cloudPage });
})();
