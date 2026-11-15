(function (root) {
    'use strict';

    // Per-browser Claude usage: the API key cannot read the account balance, so requests are counted here
    // and priced from the official per-token rates. Real charges are on the Claude Console bill.
    const KEY = 'claudeUsage_v1';
    const PRICED_AT = '2026-11';
    // USD per million tokens. Cache writes are 1.25x input. Haiku 5.5 prices change above 100K prompt tokens.
    const PRICES = Object.freeze({
        'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.20 },
        'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.10 },
        'claude-haiku-5-5': { input: 0.10, output: 0.50, cacheRead: 0.01, longInput: 0.50, longOutput: 2.50 }
    });
    const FEATURES = Object.freeze({ plan: '排行程', import: '匯入行程', artwork: '行程插圖' });
    const MODEL_NAMES = Object.freeze({ 'claude-opus-5-5': 'Opus 5.5', 'claude-sonnet-5-5': 'Sonnet 5.5', 'claude-haiku-5-5': 'Haiku 5.5' });
    const count = value => (Number.isSafeInteger(value) && value > 0 ? value : 0);

    function cost(model, usage) {
        const price = PRICES[model];
        if (!price) return null;
        const input = count(usage.input_tokens), output = count(usage.output_tokens);
        const cacheRead = count(usage.cache_read_input_tokens), cacheWrite = count(usage.cache_creation_input_tokens);
        const long = price.longInput && input + cacheRead + cacheWrite > 100000;
        const inputRate = long ? price.longInput : price.input, outputRate = long ? price.longOutput : price.output;
        return (input * inputRate + cacheWrite * inputRate * 1.25 + cacheRead * price.cacheRead + output * outputRate) / 1e6;
    }

    const empty = () => ({ requests: 0, input: 0, output: 0, cache: 0, cost: 0, unpriced: 0, features: {}, models: {} });
    const monthKey = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

    function create(storage, now = () => new Date()) {
        const listeners = new Set();
        function read() {
            try {
                const value = JSON.parse(storage.getItem(KEY) || 'null');
                if (value && value.version === 1 && value.months && typeof value.months === 'object') return value;
            } catch { /* A damaged or blocked record starts a fresh count. */ }
            return { version: 1, budget: null, months: {} };
        }
        function write(value) {
            try { storage.setItem(KEY, JSON.stringify(value)); } catch { /* Counting is best-effort when storage is unavailable. */ }
            listeners.forEach(listener => { try { listener(); } catch { /* A broken view must not stop counting. */ } });
        }
        function record({ model, feature, usage } = {}) {
            if (!usage || typeof usage !== 'object') return;
            const data = read(), key = monthKey(now());
            const month = data.months[key] || (data.months[key] = empty());
            const price = cost(model, usage);
            const tokens = { input: count(usage.input_tokens) + count(usage.cache_creation_input_tokens), output: count(usage.output_tokens), cache: count(usage.cache_read_input_tokens) };
            month.requests++;
            month.input += tokens.input; month.output += tokens.output; month.cache += tokens.cache;
            if (price === null) month.unpriced++; else month.cost += price;
            const name = Object.hasOwn(FEATURES, feature) ? feature : 'plan';
            const bucket = month.features[name] || (month.features[name] = { requests: 0, cost: 0 });
            bucket.requests++; bucket.cost += price || 0;
            const modelName = typeof model === 'string' ? model.slice(0, 60) : 'unknown';
            const byModel = month.models[modelName] || (month.models[modelName] = { requests: 0, cost: 0 });
            byModel.requests++; byModel.cost += price || 0;
            data.last = { at: now().toISOString(), model: modelName, feature: name, ...tokens, cost: price };
            write(data);
        }
        function month(date = now()) { return read().months[monthKey(date)] || empty(); }
        function budget() { return read().budget; }
        function setBudget(value) {
            const number = value === '' || value === null || value === undefined ? null : Number(value);
            if (number !== null && (!Number.isFinite(number) || number <= 0 || number > 100000)) throw new Error('預算請填 0 以上的金額，或留空表示不限制。');
            const data = read(); data.budget = number; write(data);
        }
        // Called before every paid request; a reached budget stops sending.
        function guard() {
            const limit = budget();
            if (limit !== null && month().cost >= limit) {
                throw Object.assign(new Error(`本月 Claude 估計費用已達預算上限 US$${limit.toFixed(2)}，已停止送出新的請求。可在服務設定的「用量與額度」調整預算。`), { code: 'BUDGET' });
            }
        }
        function reset() { const data = read(); data.months = {}; delete data.last; write(data); }
        function last() { return read().last || null; }
        function subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
        return { record, month, budget, setBudget, guard, reset, last, subscribe };
    }

    const money = value => (value > 0 && value < 0.01 ? '< US$0.01' : `US$${value.toFixed(2)}`);
    const tokens = value => value.toLocaleString('zh-TW');
    const api = { create, cost, money, PRICES, FEATURES, MODEL_NAMES, PRICED_AT, KEY };
    if (typeof module === 'object' && module.exports) { module.exports = api; return; }

    // Browser: one shared counter plus the 用量與額度 panel in 服務與資料設定.
    let storage;
    try { storage = root.localStorage; } catch { storage = null; }
    const usage = create(storage || { getItem: () => null, setItem() {} });
    const $ = id => root.document.getElementById(id);
    function render() {
        if (!$('claudeUsageMonth')) return;
        const current = usage.month(), limit = usage.budget();
        // The collapsed heading already shows this month's estimate, so the panel rarely needs opening.
        const summary = $('claudeUsageSummary');
        if (summary) {
            summary.textContent = current.requests || limit !== null ? `本月 ${money(current.cost)}${limit !== null ? ` / US$${limit.toFixed(2)}` : ''}` : '';
            summary.dataset.low = String(limit !== null && current.cost >= limit * 0.8);
        }
        const box = $('claudeUsageMonth');
        box.replaceChildren();
        const row = root.document.createElement('div'); row.className = 'codex-quota';
        const line = root.document.createElement('div'); line.className = 'codex-quota-line';
        const label = root.document.createElement('span'); label.textContent = '本月估計費用';
        const amount = root.document.createElement('strong'); amount.textContent = money(current.cost) + (limit !== null ? ` / 上限 US$${limit.toFixed(2)}` : '');
        line.append(label, amount); row.append(line);
        if (limit !== null) {
            const bar = root.document.createElement('progress'); bar.max = limit; bar.value = Math.min(current.cost, limit);
            bar.setAttribute('aria-label', '本月預算使用比例'); row.append(bar);
            row.dataset.low = String(current.cost >= limit * 0.8);
        }
        const note = root.document.createElement('small');
        note.textContent = `${current.requests} 次請求 · 輸入 ${tokens(current.input)} · 輸出 ${tokens(current.output)} Token${current.unpriced ? ` · ${current.unpriced} 次為未列價模型（未計入金額）` : ''}`;
        row.append(note); box.append(row);
        const parts = Object.entries(current.features).map(([key, value]) => `${FEATURES[key]} ${value.requests} 次 ${money(value.cost)}`);
        const models = Object.entries(current.models).map(([key, value]) => `${MODEL_NAMES[key] || key} ${value.requests} 次`);
        $('claudeUsageDetail').textContent = current.requests ? `${parts.join('、')}（${models.join('、')}）` : '本月尚未送出 Claude 請求。';
        if (root.document.activeElement !== $('claudeBudget')) $('claudeBudget').value = limit === null ? '' : String(limit);
    }
    function init() {
        if (!$('claudeUsageMonth')) return;
        $('claudeBudget').addEventListener('change', () => {
            const message = $('claudeBudgetError');
            try { usage.setBudget($('claudeBudget').value.trim()); message.textContent = ''; message.hidden = true; }
            catch (error) { message.textContent = error.message; message.hidden = false; }
        });
        $('claudeUsageReset').addEventListener('click', () => {
            if (root.confirm('清除這個瀏覽器的 Claude 用量紀錄？預算設定會保留，實際帳單不受影響。')) usage.reset();
        });
        usage.subscribe(render);
        usage.subscribe(() => root.updateApiStatus?.());
        render();
    }
    root.ClaudeUsage = Object.freeze({ ...usage, render, money, cost, FEATURES });
    if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', init);
    else init();
})(typeof globalThis !== 'undefined' ? globalThis : window);
