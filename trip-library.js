(function () {
    'use strict';
    const $ = id => document.getElementById(id);
    let store = null;
    let ready = false;
    let dialogAction = 'new';
    let lastDay = '';
    function inputs() {
        const data = Object.fromEntries(inputIds.map(id => [id, $(id).value]));
        data.tripTags = Array.from(document.querySelectorAll('input[name="tripTag"]:checked'), el => el.value);
        data.hasHotel = $('hasHotel').checked;
        return data;
    }
    function apply(record) {
        tripData = record.data.t;
        generationState = restoreGenerationState(record.data.g, tripData);
        inputIds.forEach(id => {
            const el = $(id);
            el.value = record.data.i[id] ?? (el.tagName === 'SELECT' ? (Array.from(el.options).find(option => option.defaultSelected) || el.options[0]).value : el.defaultValue);
        });
        document.querySelectorAll('input[name="tripTag"]').forEach(el => { el.checked = (record.data.i.tripTags || []).includes(el.value); });
        $('hasHotel').checked = record.data.i.hasHotel ?? $('hasHotel').defaultChecked;
        $('hotelContainer').style.display = $('hasHotel').checked ? 'block' : 'none';
        updateDuration();
    }
    function error(message) {
        $('libraryError').textContent = message;
        $('libraryError').hidden = false;
    }
    function lockRenderedControls() {
        if (!isBusy) return;
        document.querySelectorAll('#tripLibrary button, #tripLibrary select, #journeyPanel button, #journeyPanel input, #journeyPanel select').forEach(el => {
            if (!el.disabled) { busyControls.push([el, false]); el.disabled = true; }
        });
    }
    function refresh() {
        if (!ready) return;
        const active = store.active();
        $('tripSelect').innerHTML = store.list().map(record => `<option value="${escapeHtml(record.id)}">${escapeHtml(record.name)} · ${record.days} 天</option>`).join('');
        $('tripSelect').value = active.id;
        $('libraryCount').textContent = `${store.list().length} / ${TripStore.MAX_TRIPS} 份 · 自動儲存於此瀏覽器`;
        $('undoTrip').disabled = !active.undo;
        $('undoTrip').textContent = active.undo ? `↶ 復原：${active.undo.label}` : '↶ 沒有可復原的變更';
        $('travelModeButton').disabled = !tripData.length;
        $('travelModeButton').textContent = active.data.p.enabled ? '返回完整行程' : '開啟旅途中模式';
        $('removeTrip').disabled = store.list().length <= 1;
        renderJourney();
        lockRenderedControls();
    }
    function write(values, options) {
        if (!ready) throw new Error('多份旅程資料無法讀取，請先備份並重新載入，原資料未覆寫。');
        store.write(values, options);
        refresh();
    }
    function progress() { return ready ? store.active().data.p : { done: [], date: '', enabled: false }; }
    function select(id) {
        if (isBusy || !ready) return;
        try { saveInputs(); store.select(id); location.reload(); }
        catch (err) { error(err.message); refresh(); }
    }
    function openName(action) {
        if (isBusy || !ready) return;
        dialogAction = action;
        const titles = { new: '新增旅程', duplicate: '複製目前旅程', rename: '重新命名' };
        $('tripNameTitle').textContent = titles[action];
        $('tripName').value = action === 'new' ? '' : (action === 'duplicate' ? store.active().name.slice(0, 76) + '（副本）' : store.active().name);
        $('tripNameError').textContent = '';
        openModal('tripNameModal');
        $('tripName').focus();
    }
    function saveName(event) {
        event.preventDefault();
        if (isBusy || !ready) return;
        const name = $('tripName').value.trim();
        if (!name) { $('tripNameError').textContent = '請填寫旅程名稱。'; return; }
        try {
            saveInputs();
            if (dialogAction === 'rename') { store.rename(name); refresh(); closeModal('tripNameModal'); showSaveStatus('旅程名稱已更新'); }
            else {
                const data = dialogAction === 'duplicate' ? store.active().data : { i: {}, t: [], g: null };
                // A copy is a fresh journey; never inherit completed checkmarks or Undo.
                data.p = { done: [], date: '', enabled: false };
                store.add(name, data);
                location.reload();
            }
        } catch (err) { $('tripNameError').textContent = err.message; }
    }
    function remove() {
        if (isBusy || !ready) return;
        if (!confirm(`移除「${store.active().name}」？此操作無法復原，其他旅程會保留。建議先備份全部旅程。`)) return;
        try { store.remove(); location.reload(); } catch (err) { error(err.message); }
    }
    async function undo() {
        if (isBusy || !ready || !store.active().undo) return;
        setBusy(true);
        try {
            const restored = store.undo();
            window.PlannerUI?.resetContext();
            apply(restored);
            await renderTrip();
            window.PlannerUI?.switchView(tripData.length ? 'itinerary' : 'settings');
            showSaveStatus('已復原上一步；行程與續生資料已儲存');
        } catch (err) { error(err.message); }
        finally { setBusy(false); refresh(); }
    }
    function exportAll() {
        if (isBusy || !ready) return;
        try {
            saveInputs();
            downloadBlob(new Blob([JSON.stringify(store.exportAll(), null, 2)], { type: 'application/json' }), 'all_trips_backup.json');
        } catch (err) { error(err.message); }
    }
    function importCollection(value) {
        if (!ready) throw new Error('旅程收藏尚未就緒。');
        const records = store.validateCollection(value);
        if (!confirm(`將新增 ${records.length} 份旅程，現有旅程會保留。是否繼續？`)) return false;
        store.importCollection(value);
        return true;
    }
    function updateProgress(value, options = {}) {
        if (isBusy || !ready) return;
        try { write({ journeyProgress_v1: JSON.stringify(value) }, options); }
        catch (err) { error(err.message); renderJourney(); }
    }
    function toggleMode() {
        if (isBusy || !ready || !tripData.length) return;
        const value = progress();
        value.enabled = !value.enabled;
        updateProgress(value, { undo: false });
        window.PlannerUI?.switchView('itinerary');
        if (progress().enabled) $('journeyTitle').focus();
    }
    function chooseDate(value) { updateProgress({ ...progress(), date: value }, { undo: false }); }
    function toggleDone(date, index, checked) {
        if (isBusy || !ready) return;
        const day = tripData.find(item => item.date === date);
        const key = day && TripStore.stopKeys(day)[index];
        if (!key) return;
        const value = progress(), done = new Set(value.done);
        if (checked) done.add(key); else done.delete(key);
        value.done = [...done];
        updateProgress(value, { label: checked ? '標記站點完成' : '取消完成標記' });
        $('journeyPanel').querySelector(`[data-stop-index="${index}"] input`)?.focus();
    }
    function today() { return formatLocalDate(new Date()); }
    function route(item) {
        const city = generationState?.city || $('city').value;
        const modes = { '大眾運輸': 'transit', '自駕': 'driving', '自行開車': 'driving', '租車自駕': 'driving', '機車': 'two-wheeler', '全程包車': 'driving', '步行': 'walking' };
        const mode = modes[generationState?.transport || $('transport').value] || 'transit';
        return `https://www.google.com/maps/dir/?api=1&destination=${encodeQuery(item.title + ' ' + (item.address || city))}&travelmode=${mode}`;
    }
    function renderJourney() {
        if (!ready) return;
        const value = progress();
        const enabled = value.enabled && tripData.length > 0;
        document.querySelector('.container').dataset.travelling = String(enabled);
        $('tripLibrary').dataset.travelling = String(enabled);
        $('journeyPanel').hidden = !enabled;
        if (!enabled) return;
        const deviceDate = today();
        const day = tripData.find(item => item.date === value.date) || tripData.find(item => item.date === deviceDate) || tripData.find(item => item.date >= deviceDate) || tripData.at(-1);
        const keys = TripStore.stopKeys(day), done = new Set(value.done);
        const remaining = day.itinerary.map((item, index) => ({ item, index })).filter(({ index }) => !done.has(keys[index]));
        const current = remaining[0], next = remaining[1];
        const card = (entry, title) => entry ? `<article class="journey-stop"><div class="section-kicker">${title}</div><h3>${escapeHtml(entry.item.title)}</h3><p>${escapeHtml(entry.item.time)}${entry.item.endTime ? ` — ${escapeHtml(entry.item.endTime)}` : ''}</p><p>${escapeHtml(entry.item.address || '尚未填寫地址')}</p>${stopNoteHtml(entry.item)}<a href="${route(entry.item)}" class="btn-route" target="_blank" rel="noopener noreferrer">導航到這一站 ↗</a></article>` : '';
        $('journeyPanel').innerHTML = `<div class="journey-heading"><div><div class="eyebrow">ON THE GO</div><h2 id="journeyTitle" tabindex="-1">${day.date === deviceDate ? '今天的旅程' : '旅程預覽'}</h2></div></div>
            <p class="field-hint">裝置日期：${deviceDate}；依未完成順序顯示。海外可手動選日期，不使用 GPS。</p>
            <div class="journey-date"><label for="journeyDate">行程日期</label><select id="journeyDate" onchange="TripLibrary.chooseDate(this.value)">${tripData.map(item => `<option value="${item.date}"${item.date === day.date ? ' selected' : ''}>${item.date} · ${escapeHtml(item.day_title)}</option>`).join('')}</select><button type="button" onclick="TripLibrary.chooseDate('')">依今天選擇</button></div>
            <p id="journeyCompletion" role="status" aria-live="polite">這天已完成 ${day.itinerary.length - remaining.length} / ${day.itinerary.length} 站</p>
            <div class="journey-cards">${card(current, '目前待完成')}${card(next, '下一站')}${!current ? '<div class="journey-finished">這一天全部完成了。可以切換日期，或取消勾選以重新安排。</div>' : ''}</div>
            <h3 class="journey-list-title">當日清單</h3><ol class="journey-checklist">${day.itinerary.map((item, index) => `<li data-stop-index="${index}" class="${done.has(keys[index]) ? 'completed' : ''}"><label><input type="checkbox" ${done.has(keys[index]) ? 'checked' : ''} onchange="TripLibrary.toggleDone('${day.date}', ${index}, this.checked)"><span><span class="journey-time">${escapeHtml(item.time)}</span><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.address)}</span></span></label><a href="${route(item)}" target="_blank" rel="noopener noreferrer" aria-label="導航到${escapeHtml(item.title)}">導航 ↗</a></li>`).join('')}</ol>`;
        lockRenderedControls();
    }
    function init() {
        $('tripLibrary').innerHTML = `<div class="library-heading"><div><div class="eyebrow">MY JOURNEYS</div><label for="tripSelect">我的旅程</label></div><span id="libraryCount"></span></div>
            <div class="library-picker"><select id="tripSelect" onchange="TripLibrary.select(this.value)" aria-label="切換旅程"></select><button type="button" onclick="TripLibrary.openName('new')">＋ 新增旅程</button></div>
            <details id="libraryManagement" class="library-management"><summary>管理與備份</summary><div class="library-actions"><button type="button" onclick="TripLibrary.openName('duplicate')">複製</button><button type="button" onclick="TripLibrary.openName('rename')">重新命名</button><button type="button" id="removeTrip" onclick="TripLibrary.remove()">移除</button><button type="button" onclick="TripLibrary.exportAll()">備份全部</button><button type="button" onclick="document.getElementById('importFile').click()">匯入備份</button></div><p class="field-hint">每份旅程各保留一次行程／完成狀態的復原；一般設定輸入不占用復原紀錄。</p></details>
            <div class="library-tools"><button type="button" id="undoTrip" onclick="TripLibrary.undo()" disabled>↶ 沒有可復原的變更</button><button type="button" id="travelModeButton" onclick="TripLibrary.toggleMode()" disabled>開啟旅途中模式</button></div>
            <p id="libraryError" role="alert" hidden></p>`;
        document.body.insertAdjacentHTML('beforeend', `<div id="tripNameModal" class="modal" role="dialog" aria-modal="true" aria-labelledby="tripNameTitle"><div class="modal-content"><div class="editor-heading"><h3 id="tripNameTitle">新增旅程</h3><button class="modal-close" type="button" aria-label="關閉旅程命名" onclick="closeModal('tripNameModal')">×</button></div><form id="tripNameForm"><label for="tripName">旅程名稱</label><input type="text" id="tripName" required maxlength="80" autocomplete="off"><p id="tripNameError" role="alert"></p><button class="btn-primary" type="submit">儲存</button></form></div></div>`);
        $('tripNameForm').addEventListener('submit', saveName);
        try {
            store = TripStore.create(localStorage, validateBackup);
            // Validate original legacy records before migration instead of persisting a fallback
            // produced by the old reader for corrupt data.
            const legacy = localStorage.getItem(TripStore.KEY) === null ? {
                i: JSON.parse(localStorage.getItem('tripDraft_v27') || JSON.stringify(inputs())),
                t: JSON.parse(localStorage.getItem('myTrip_v27') || '[]'),
                g: JSON.parse(localStorage.getItem('generationState_v27') || 'null'),
                p: JSON.parse(localStorage.getItem('journeyProgress_v1') || 'null')
            } : { i: {}, t: [], g: null };
            const record = store.init(legacy);
            ready = true;
            apply(record);
            refresh();
        } catch (err) {
            error('旅程收藏無法讀取：' + err.message);
            $('tripLibrary').querySelectorAll('button, select').forEach(el => { el.disabled = true; });
        }
        window.addEventListener('storage', event => {
            if (event.key === TripStore.KEY || event.key === null) error('另一個分頁已更新旅程。請重新整理後再編輯；本分頁不會覆蓋新資料。');
        });
        lastDay = today();
        setInterval(() => { const date = today(); if (date !== lastDay) { lastDay = date; renderJourney(); } }, 30000);
    }
    window.TripLibrary = Object.freeze({ init, write, refresh, progress, select, openName, saveName, remove, undo, exportAll, importCollection, toggleMode, chooseDate, toggleDone });
})();
