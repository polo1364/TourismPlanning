(function () {
    'use strict';
    const BASE = 'http://127.0.0.1:8081';
    const localPage = location.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(location.hostname);
    const localOnlyMessage = 'Codex 額度僅供本機版使用。請下載專案並執行「啟動Codex旅遊書.vbs」；線上版可手動選用自己的 DeepSeek API Key。';
    const $ = id => document.getElementById(id);
    let token = '';
    let touched = false;
    const selected = () => $('aiProvider').value === 'codex';
    function update(manual = false) {
        if (manual) touched = true;
        $('deepseekSettings').hidden = selected();
        $('codexSettings').hidden = !selected();
        updateApiStatus();
    }
    async function check(signal) {
        token = '';
        if (!localPage) { $('codexStatus').textContent = localOnlyMessage; return false; }
        $('codexStatus').textContent = '正在檢查本機 Codex…';
        try {
            const response = await fetch(BASE + '/status', { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12000)]) : AbortSignal.timeout(12000) });
            const data = await response.json();
            if (!response.ok || !data.ready || data.auth !== 'chatgpt' || typeof data.token !== 'string') throw new Error(data.error || '請使用 ChatGPT 帳號登入 Codex。');
            token = data.token;
            $('codexStatus').textContent = '已連接本機 Codex · 使用 ChatGPT 登入額度';
            return true;
        } catch (error) {
            if (signal?.aborted) throw Object.assign(new Error('已取消生成。'), { code: 'CANCELLED' });
            $('codexStatus').textContent = error instanceof TypeError ? '尚未連接。請執行「啟動Codex旅遊書.vbs」，再按檢查連線。' : error.message;
            return false;
        }
    }
    async function generate(prompt, signal) {
        if (signal?.aborted) throw Object.assign(new Error('已取消生成。'), { code: 'CANCELLED' });
        if (!token && !await check(signal)) throw new Error($('codexStatus').textContent);
        try {
            const response = await fetch(BASE + '/generate', {
                method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Roam-Token': token },
                body: JSON.stringify({ prompt }),
                signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(195000)]) : AbortSignal.timeout(195000)
            });
            const result = await response.json();
            if (!response.ok) {
                if (result.code === 'TOKEN' || result.code === 'LOGIN') token = '';
                throw Object.assign(new Error(result.error || 'Codex 請求失敗。'), { code: result.code });
            }
            if (!result.data || typeof result.data !== 'object' || Array.isArray(result.data)) throw new Error('Codex 回應格式無效，結果未儲存。');
            return result.data;
        } catch (error) {
            if (signal?.aborted) throw Object.assign(new Error('已取消 Codex 生成，已完成內容保留。'), { code: 'CANCELLED' });
            if (error.name === 'TimeoutError') throw new Error('本機 Codex 等待逾時，請稍後手動接續。');
            if (error instanceof TypeError) { token = ''; throw new Error('無法連接本機 Codex，請確認啟動程式仍在執行。'); }
            throw error;
        }
    }
    async function init() {
        let saved = null;
        try { saved = localStorage.getItem('aiProvider'); } catch (_) { /* Optional preference. */ }
        if (saved === 'codex' || saved === 'deepseek') $('aiProvider').value = saved;
        update();
        $('hostedNotice').hidden = localPage;
        const connected = await check();
        if (!saved && !touched && connected && !isBusy) { $('aiProvider').value = 'codex'; update(); }
    }
    window.CodexLocal = Object.freeze({ selected, update, check, generate, init });
})();
