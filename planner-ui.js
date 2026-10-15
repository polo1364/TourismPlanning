(function () {
    'use strict';
    const $ = id => document.getElementById(id);
    const mobile = matchMedia('(max-width: 760px)');
    let initialized = false;
    let operation = null;
    let retryAction = null;
    let editing = null;
    let editingNote = null;
    let progressTimer = null;

    function updateElapsed() {
        if (!operation) return;
        const seconds = Math.floor((performance.now() - operation.startedAt) / 1000);
        $('operationElapsed').textContent = `已用時 ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
        const waiting = Math.floor((performance.now() - operation.stageStartedAt) / 1000);
        $('operationHint').textContent = operation.waitingForAI
            ? `本次 AI 回覆已等待 ${waiting} 秒。${waiting >= 60 ? '等待較久，仍未收到完整回覆；可取消後手動重試。' : '完整回覆到達後才會更新完成天數，請勿重複送出。'}`
            : '完成一天就儲存一天；進度只計算已完成的天數。';
    }
    function stage(label, waitingForAI = false) {
        if (!operation || operation.controller.signal.aborted) return;
        operation.stageStartedAt = performance.now();
        operation.waitingForAI = waitingForAI;
        $('operationStage').textContent = label;
        updateElapsed();
    }
    function stopProgress(label) {
        updateElapsed();
        clearInterval(progressTimer);
        progressTimer = null;
        $('operationStatus').dataset.active = 'false';
        $('operationStage').textContent = label;
        $('operationHint').textContent = '';
    }

    function switchView(view, scroll = true) {
        window.TripMotion?.settle();
        document.querySelector('.container').dataset.view = view;
        for (const name of ['settings', 'itinerary']) {
            $(`${name}Tab`).setAttribute('aria-pressed', String(name === view));
            $(`${name}Panel`).inert = name !== view;
        }
        window.TripBook?.refresh();
        if (scroll) document.querySelector('.workspace-tabs').scrollIntoView({ block: 'start' });
    }
    function signal() { return operation?.controller.signal; }
    function networkSignal() {
        return signal() ? AbortSignal.any([signal(), AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000);
    }
    function throwIfCancelled() {
        if (signal()?.aborted) throw Object.assign(new Error('已取消本次生成，原有行程已保留。'), { code: 'CANCELLED' });
    }
    function begin(action, label, itinerary = true) {
        operation = { controller: new AbortController(), action, itinerary, completed: tripData.length, total: generationState?.totalDays || getTripDayCount($('flightArrival').value, $('flightDeparture').value) || 1 };
        // A fresh plan has no completed days yet; the old trip remains visible until success.
        if (action === planTrip) { operation.completed = 0; operation.total = getTripDayCount($('flightArrival').value, $('flightDeparture').value); }
        operation.startedAt = performance.now();
        clearInterval(progressTimer);
        $('operationStatus').dataset.active = 'true';
        stage('正在準備生成');
        progressTimer = setInterval(updateElapsed, 1000);
        retryAction = null;
        $('operationStatus').hidden = false;
        $('operationText').textContent = `${label}。已完成 ${operation.completed} / ${operation.total} 天；正在等待服務回應。`;
        $('dayProgress').max = operation.total;
        $('dayProgress').value = operation.completed;
        $('cancelOperation').hidden = false;
        $('cancelOperation').disabled = false;
        $('retryOperation').hidden = true;
        $('retryOperation').textContent = '重試這一步';
        switchView('itinerary');
        $('operationStatus').scrollIntoView({ block: 'start', behavior: 'instant' });
    }
    function cancel() {
        if (!operation) return;
        operation.controller.abort();
        stopProgress('正在取消');
        $('cancelOperation').disabled = true;
        $('operationText').textContent = '正在取消並保留原有資料…';
    }
    function complete() {
        stopProgress('生成完成');
        retryAction = null;
        $('operationText').textContent = operation?.itinerary
            ? `已完成 ${tripData.length} / ${generationState?.totalDays || tripData.length} 天，已儲存。${tripData.length < (generationState?.totalDays || 0) ? '可繼續完成旅遊書。' : '整本旅遊書已完成（100%），可直接翻閱。'}`
            : '景點與美食建議已填入旅行偏好。';
        $('dayProgress').value = tripData.length;
        if (operation && !operation.itinerary) { $('preferencesSection').open = true; switchView('settings'); }
        else if (operation?.itinerary) window.TripBook?.showCurrent();
    }
    function bookProgress() {
        stage('正在準備下一天');
        const total = generationState.totalDays;
        const completed = tripData.length;
        $('dayProgress').max = total;
        $('dayProgress').value = completed;
        $('operationText').textContent = `正在編排第 ${completed + 1} / ${total} 天。已儲存 ${completed} / ${total} 天（${Math.round(completed / total * 100)}%），完成後將開啟旅遊書。`;
    }
    function failed(error, retryOverride) {
        stopProgress(error.code === 'CANCELLED' ? '已取消生成' : '生成未完成');
        retryAction = retryOverride || operation?.action || null;
        $('operationText').textContent = `${error.code === 'CANCELLED' ? '已取消' : '這一步未完成'}：${error.message} 已保留原資料；可重試這一步。${error.code === 'CANCELLED' ? '取消不保證服務端停止計費。' : ''}`;
        $('dayProgress').max = generationState?.totalDays || Math.max(tripData.length, operation?.total || 1);
        $('dayProgress').value = tripData.length;
        $('retryOperation').hidden = !retryAction;
        $('retryOperation').textContent = retryAction === finishBook ? '繼續完成旅遊書' : '重試這一步';
    }
    function end() {
        clearInterval(progressTimer);
        progressTimer = null;
        $('operationStatus').dataset.active = 'false';
        operation = null;
        $('cancelOperation').hidden = true;
        $('retryOperation').disabled = false;
        afterRender();
    }
    function retry() {
        if (isBusy || !retryAction) return;
        const action = retryAction;
        retryAction = null;
        action();
    }
    function invalidateRetry() {
        if (operation) return;
        retryAction = null;
        $('retryOperation').hidden = true;
        $('operationStatus').hidden = true;
    }
    function timingHtml(day, index) {
        const item = day.itinerary[index];
        const duration = PlannerChecks.timing(item).duration;
        const travel = Number.isFinite(item.travelMinutes) ? `站間移動約 ${item.travelMinutes} 分鐘` : '移動時間待確認';
        return `<div class="stop-meta"><span>${duration ? `停留 ${duration} 分鐘` : '停留時間待補'}</span>${index ? `<span>${travel}</span>` : ''}</div>`;
    }
    function afterRender() {
        window.TripLibrary?.refresh();
        window.TripBook?.refresh();
        if (!$('tripReview')) return;
        const overview = $('tripOverview');
        if (overview) {
            overview.hidden = !tripData.length;
            $('overviewCity').textContent = generationState?.city || $('city').value.trim() || '未命名目的地';
            $('overviewDates').textContent = tripData.length ? `${tripData[0].date} — ${tripData.at(-1).date}${generationState?.totalDays > tripData.length ? ' · 旅程持續規劃中' : ''}` : '';
            $('overviewDays').textContent = tripData.length;
            $('overviewStops').textContent = tripData.reduce((sum, day) => sum + day.itinerary.length, 0);
            $('overviewTransport').textContent = generationState?.transport || $('transport').value;
            $('dayIndex').innerHTML = tripData.map((day, index) => `<button type="button" onclick="PlannerUI.jumpToDay(${index})" aria-label="跳至第 ${index + 1} 天 ${day.date}"><span>${String(index + 1).padStart(2, '0')}</span> ${day.date.slice(5).replace('-', '/')}</button>`).join('');
            window.TripBook?.refresh();
        }
        $('tripCount').textContent = tripData.length ? `${tripData.length} 天` : '';
        const city = generationState?.city || $('city').value;
        const currency = getCurrencyInfo(city);
        $('budgetCurrency').textContent = `幣別：${getCurrencyInfo($('city').value).code}。僅比較已列費用，不含未列項目。`;
        const review = $('tripReview');
        review.hidden = !tripData.length;
        if (!tripData.length) { review.replaceChildren(); return; }
        const costs = tripData.map(day => calculateTotalCost(day, currency));
        const total = costs.reduce((sum, cost) => sum + cost.amount, 0);
        const unpriced = costs.reduce((sum, cost) => sum + cost.unpriced, 0);
        const budget = Number(generationState ? generationState.budget : $('budget').value) || 0;
        const report = PlannerChecks.inspect(tripData, { budget, totalCost: total });
        const reviewOpen = review.querySelector('details')?.open === true;
        review.innerHTML = `<details class="review-disclosure"${reviewOpen ? ' open' : ''}><summary class="review-heading"><strong>出發前檢查</strong><span>${report.issues.length ? `${report.issues.length} 項提醒` : '未發現已知衝突'}${unpriced ? ` · ${unpriced} 站費用待確認` : ''} · 展開查看</span></summary><div class="review-body">
            <p class="field-hint">依已填時間與預估費用檢查，並非現場查證。營業時間、票價與路線仍需確認。</p>
            ${report.issues.length ? `<ul>${report.issues.map(issue => `<li>${escapeHtml(issue.message)}${issue.day !== null ? ` <button class="review-link" onclick="PlannerUI.edit(${issue.day}, ${issue.item})">查看／修改</button>` : ''}</li>`).join('')}</ul>` : ''}
            <p class="review-coverage">${report.missingTime ? `${report.missingTime} 站缺少完整停留時間；` : ''}${report.missingTravel ? `${report.missingTravel} 段移動時間尚無法檢查；` : ''}${unpriced ? `${unpriced} 站金額不明、價格條件或幣別不一致，未計入；` : ''}已列費用 ${currency.code} ${total.toLocaleString()}${budget > 0 ? `／預算 ${budget.toLocaleString()}` : '（尚未設定預算）'}。</p>
            <form id="reviewBudgetForm" class="review-budget"><label for="reviewBudget">本行程預算（${currency.code}）</label><div><input id="reviewBudget" type="number" min="0" step="0.01" value="${budget || ''}" placeholder="留空表示未設定"><button type="submit">更新預算</button></div><p id="budgetError" role="alert"></p></form></div></details>`;
        $('reviewBudgetForm').addEventListener('submit', updateBudget);
        if (editing && $('stopModal')?.style.display === 'block') {
            const buttons = document.querySelectorAll('#tripContainer > details')[editing.dayIndex]?.querySelectorAll('.stop-edit');
            if (buttons?.length) modalReturnFocus = buttons[Math.min(editing.itemIndex, buttons.length - 1)];
        }
        if (editingNote && $('noteModal')?.style.display === 'block') {
            modalReturnFocus = document.querySelector(`#tripContainer [data-note-day="${editingNote.dayIndex}"][data-note-item="${editingNote.itemIndex}"]`);
        }
        // New controls can be rendered while an existing API request still owns the lock.
        if (isBusy) document.querySelectorAll('#tripContainer button, #tripReview button, #tripReview input').forEach(button => {
            if (!button.disabled) { busyControls.push([button, false]); button.disabled = true; }
        });
    }
    async function updateBudget(event) {
        event.preventDefault();
        if (isBusy) return;
        const budget = Number($('reviewBudget').value);
        if (!Number.isFinite(budget) || budget < 0) { $('budgetError').textContent = '請填寫有效的非負數字。'; return; }
        const previousState = generationState, previousValue = $('budget').value;
        setBusy(true);
        try {
            if (generationState) {
                generationState = { ...generationState, budget };
                const values = { generationState_v27: JSON.stringify(generationState) };
                if ($('city').value === generationState.city && $('flightArrival').value === generationState.flightArr && $('flightDeparture').value === generationState.flightDep) {
                    $('budget').value = String(budget);
                    const draft = Object.fromEntries(inputIds.map(id => [id, $(id).value]));
                    draft.tripTags = Array.from(document.querySelectorAll('input[name="tripTag"]:checked'), input => input.value);
                    draft.hasHotel = $('hasHotel').checked;
                    values.tripDraft_v27 = JSON.stringify(draft);
                }
                writeStoredValues(values, { label: '更新旅程預算', budget: !!values.tripDraft_v27 });
            }
            else { $('budget').value = String(budget); saveInputs({ label: '更新旅程預算', budget: true }); }
            invalidateRetry();
            afterRender();
            showSaveStatus('本行程預算已更新');
        } catch (error) {
            generationState = previousState; $('budget').value = previousValue;
            $('budgetError').textContent = error.message;
        } finally { setBusy(false); }
    }
    function edit(dayIndex, itemIndex) {
        if (isBusy || !tripData[dayIndex]?.itinerary[itemIndex]) return;
        editing = { dayIndex, itemIndex };
        invalidateRetry();
        const item = tripData[dayIndex].itinerary[itemIndex];
        const times = PlannerChecks.timing(item);
        const format = value => value === null || value >= 1440 ? '' : `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
        for (const key of ['title', 'address', 'desc', 'cost', 'type']) $(`stop_${key}`).value = item[key] || '';
        $('stop_time').value = format(times.start);
        $('stop_endTime').value = format(times.end);
        $('stop_travelMinutes').value = item.travelMinutes ?? '';
        $('stop_position').textContent = `${tripData[dayIndex].date} · 第 ${itemIndex + 1} / ${tripData[dayIndex].itinerary.length} 站`;
        $('stop_error').textContent = '';
        $('stop_replaceInstruction').value = '';
        $('moveUp').disabled = itemIndex === 0;
        $('moveDown').disabled = itemIndex === tripData[dayIndex].itinerary.length - 1;
        $('deleteStop').disabled = tripData[dayIndex].itinerary.length <= 1;
        if ($('stopModal').style.display === 'block') {
            modalReturnFocus = document.querySelectorAll('#tripContainer > details')[dayIndex]?.querySelectorAll('.stop-edit')[itemIndex];
            $('stop_title').focus();
        } else openModal('stopModal');
    }
    // Route descriptions belong to adjacent locations; don't retain them after a reorder.
    function clearRoute(items, index) {
        if (!items[index]) return;
        items[index].transit = [];
        delete items[index].travelMinutes;
    }
    async function commitDays(days) {
        const oldDays = tripData, oldState = generationState;
        try {
            tripData = validateTrip(days);
            generationState = restoreGenerationState(generationState, tripData);
            await renderTrip();
            throwIfCancelled();
            persistTrip();
        } catch (error) {
            tripData = oldDays; generationState = oldState;
            await renderTrip();
            throw error;
        }
    }
    async function saveStop(event) {
        event.preventDefault();
        if (isBusy || !editing) return;
        const { dayIndex, itemIndex } = editing;
        const days = structuredClone(tripData);
        const item = days[dayIndex].itinerary[itemIndex];
        const locationChanged = item.title !== $('stop_title').value.trim() || item.address !== $('stop_address').value.trim();
        for (const key of ['title', 'address', 'desc', 'cost', 'type', 'time', 'endTime']) item[key] = $(`stop_${key}`).value.trim();
        const { start, end } = PlannerChecks.timing(item);
        if (!item.title || start === null || (item.endTime && (end === null || end <= start))) { $('stop_error').textContent = '請填寫名稱與開始時間；結束時間須晚於開始時間。'; return; }
        delete item.durationMinutes;
        if (locationChanged) { clearRoute(days[dayIndex].itinerary, itemIndex); clearRoute(days[dayIndex].itinerary, itemIndex + 1); }
        const travel = $('stop_travelMinutes').value;
        if (travel === '') delete item.travelMinutes;
        else if (!Number.isFinite(+travel) || +travel < 0 || +travel > 1440) { $('stop_error').textContent = '移動時間請填 0 至 1440 分鐘。'; return; }
        else item.travelMinutes = +travel;
        setBusy(true);
        try { await commitDays(days); closeModal('stopModal'); invalidateRetry(); showSaveStatus('單站修改已儲存'); }
        catch (error) { $('stop_error').textContent = error.message; }
        finally { setBusy(false); }
    }
    function editNote(dayIndex, itemIndex) {
        const item = tripData[dayIndex]?.itinerary[itemIndex];
        if (isBusy || !item) return;
        editingNote = { dayIndex, itemIndex };
        $('noteStopTitle').textContent = item.title;
        $('noteText').value = item.userNote || '';
        $('noteError').textContent = '';
        $('deleteNote').hidden = !item.userNote;
        openModal('noteModal');
        $('noteText').focus();
    }
    async function saveNote(remove = false) {
        if (isBusy || !editingNote) return;
        const { dayIndex, itemIndex } = editingNote;
        if (!tripData[dayIndex]?.itinerary[itemIndex]) return;
        const text = $('noteText').value.trim();
        if (!remove && (!text || text.length > 1000)) { $('noteError').textContent = '請填寫 1 至 1000 字；移除便利貼請按「刪除便利貼」。'; return; }
        if (remove && !confirm('刪除這一站的便利貼？行程內容會保留。')) return;
        const days = structuredClone(tripData);
        if (remove) delete days[dayIndex].itinerary[itemIndex].userNote;
        else days[dayIndex].itinerary[itemIndex].userNote = text;
        setBusy(true);
        try {
            await commitDays(days);
            setBusy(false);
            closeModal('noteModal');
            editingNote = null;
            invalidateRetry();
            showSaveStatus(remove ? '便利貼已刪除，可復原上一步' : '便利貼已隨行程儲存');
        } catch (error) { $('noteError').textContent = error.message; }
        finally { if (isBusy) setBusy(false); }
    }
    async function move(direction) {
        if (isBusy || !editing) return;
        const { dayIndex, itemIndex } = editing;
        const days = structuredClone(tripData), items = days[dayIndex].itinerary;
        const target = itemIndex + direction;
        if (target < 0 || target >= items.length) return;
        [items[itemIndex], items[target]] = [items[target], items[itemIndex]];
        for (let i = Math.min(itemIndex, target); i <= Math.max(itemIndex, target) + 1; i++) clearRoute(items, i);
        setBusy(true);
        try { await commitDays(days); setBusy(false); edit(dayIndex, target); showSaveStatus('順序已儲存，請確認時間與新的移動路線'); }
        catch (error) { $('stop_error').textContent = error.message; }
        finally { if (isBusy) setBusy(false); }
    }
    async function remove() {
        if (isBusy || !editing) return;
        const { dayIndex, itemIndex } = editing;
        if (tripData[dayIndex].itinerary.length <= 1 || !confirm('刪除這一站？其他站點與時間會保留。')) return;
        const days = structuredClone(tripData);
        days[dayIndex].itinerary.splice(itemIndex, 1);
        clearRoute(days[dayIndex].itinerary, itemIndex);
        setBusy(true);
        try { await commitDays(days); closeModal('stopModal'); invalidateRetry(); showSaveStatus('已刪除這一站，請確認相鄰路線'); }
        catch (error) { $('stop_error').textContent = error.message; }
        finally { setBusy(false); }
    }
    async function replaceStop(target = editing, instruction = $('stop_replaceInstruction').value.trim()) {
        if (isBusy || !target || !instruction) { if (!instruction) $('stop_error').textContent = '請填寫想替換成什麼活動。'; return; }
        const key = getApiKey(); if (!key) return;
        const { dayIndex, itemIndex } = target;
        const day = tripData[dayIndex], original = day?.itinerary[itemIndex];
        if (!original) return;
        closeModal('stopModal');
        begin(() => replaceStop(target, instruction), `正在替換 ${original.title}`);
        setBusy(true);
        try {
            const result = await callDeepSeek(key, `只替換單一站點，其他站點由程式保留。城市：${generationState?.city || $('city').value}。日期：${day.date}。原站點：${JSON.stringify(original)}。相鄰站點：${JSON.stringify(day.itinerary.slice(Math.max(0, itemIndex - 1), itemIndex + 2))}。需求：${instruction}。旅人偏好：${generationState?.combinedPrefs || ''}。回傳 JSON {"item":{"title":"名稱","type":"SPOT","desc":"介紹","address":"地址","cost":"預估費用","tips":"提醒","booking":false}}。不要宣稱營業資訊已查證。`);
            if (!result?.item || typeof result.item.title !== 'string' || !result.item.title.trim()) throw new Error('單站回應格式不完整，原行程已保留。');
            const days = structuredClone(tripData);
            const replacement = normalizeDay({ date: day.date, day_title: day.day_title, itinerary: [result.item] }).itinerary[0];
            replacement.time = original.time;
            replacement.endTime = original.endTime || '';
            delete replacement.userNote;
            if (original.userNote) replacement.userNote = original.userNote;
            if (original.durationMinutes !== undefined) replacement.durationMinutes = original.durationMinutes;
            days[dayIndex].itinerary[itemIndex] = replacement;
            clearRoute(days[dayIndex].itinerary, itemIndex);
            clearRoute(days[dayIndex].itinerary, itemIndex + 1);
            await commitDays(days);
            complete();
            showSaveStatus('已替換這一站；請確認相鄰移動時間');
        } catch (error) { failed(error); }
        finally { setBusy(false); end(); }
    }
    function init() {
        if (initialized) return;
        initialized = true;
        document.body.insertAdjacentHTML('beforeend', `<div id="noteModal" class="modal" role="dialog" aria-modal="true" aria-labelledby="noteTitle"><div class="modal-content note-editor">
            <div class="editor-heading"><h3 id="noteTitle">我的便利貼</h3><button type="button" class="modal-close" aria-label="關閉便利貼" onclick="closeModal('noteModal')">×</button></div>
            <p id="noteStopTitle"></p><form id="noteForm"><label for="noteText">這一站要特別留意什麼？</label><textarea id="noteText" rows="6" maxlength="1000" placeholder="例如：已訂位 12:00，提前 10 分鐘到。\n記得帶訂位簡訊；只收現金。" aria-describedby="noteHelp noteError"></textarea>
            <p id="noteHelp">最多 1000 字，按儲存後隨行程保留。</p><p id="noteError" role="alert"></p><div class="note-editor-actions"><button type="submit" class="btn-primary">儲存便利貼</button><button type="button" class="btn-outline" onclick="closeModal('noteModal')">取消</button><button type="button" id="deleteNote" class="btn-danger" onclick="PlannerUI.deleteNote()">刪除便利貼</button></div></form></div></div>`);
        $('noteForm').addEventListener('submit', event => { event.preventDefault(); void saveNote(); });
        document.body.insertAdjacentHTML('beforeend', `<div id="stopModal" class="modal" role="dialog" aria-modal="true" aria-labelledby="stopTitle"><div class="modal-content stop-editor">
            <div class="editor-heading"><h3 id="stopTitle">編輯這一站</h3><button type="button" class="modal-close" aria-label="關閉站點編輯" onclick="closeModal('stopModal')">×</button></div><p id="stop_position" class="field-hint"></p>
            <form id="stopForm"><label for="stop_title">活動名稱</label><input id="stop_title" required maxlength="200">
            <div class="editor-grid"><div><label for="stop_time">開始時間</label><input id="stop_time" type="time" required></div><div><label for="stop_endTime">結束時間</label><input id="stop_endTime" type="time"></div></div>
            <div class="editor-grid"><div><label for="stop_type">類型</label><select id="stop_type"><option value="SPOT">景點</option><option value="FOOD">美食</option><option value="TRANSPORT">交通</option></select></div><div><label for="stop_travelMinutes">從上一站移動（分鐘）</label><input id="stop_travelMinutes" type="number" min="0" max="1440" step="1" placeholder="未知請留空"></div></div>
            <label for="stop_address">地址</label><input id="stop_address" maxlength="500"><label for="stop_cost">預估費用（目的地幣別）</label><input id="stop_cost" maxlength="100"><label for="stop_desc">活動說明</label><textarea id="stop_desc" rows="3"></textarea>
            <p id="stop_error" role="alert"></p><button type="submit" class="btn-primary">儲存這一站</button></form>
            <div class="editor-actions"><button id="moveUp" onclick="PlannerUI.move(-1)">↑ 上移一站</button><button id="moveDown" onclick="PlannerUI.move(1)">↓ 下移一站</button><button id="deleteStop" class="btn-danger" onclick="PlannerUI.remove()">刪除這一站</button></div>
            <p class="field-hint">上移、下移與刪除會立即儲存；時間保持原值，相鄰路線需重新確認。</p>
            <details class="form-disclosure"><summary>用 AI 替換這一站</summary><label for="stop_replaceInstruction">替換需求</label><textarea id="stop_replaceInstruction" placeholder="例如：改成適合下雨天的室內景點"></textarea><button type="button" onclick="PlannerUI.replaceStop()">產生替代站點</button><p class="field-hint">保留其他站點與原時間；只傳送替換所需的行程內容。</p></details>
            </div></div>`);
        $('stopForm').addEventListener('submit', saveStop);
        for (const id of ['stop_title', 'stop_address']) $(id).addEventListener('input', () => { $('stop_travelMinutes').value = ''; });
        mobile.addEventListener('change', () => switchView(document.querySelector('.container').dataset.view, false));
        $('settingsPanel').addEventListener('input', () => { invalidateRetry(); afterRender(); });
        switchView(tripData.length ? 'itinerary' : 'settings', false);
        afterRender();
        delete document.documentElement.dataset.booting;
    }
    function resetContext() {
        editing = null;
        editingNote = null;
        currentModifyIndex = null;
        invalidateRetry();
        for (const id of ['stopModal', 'modifyModal', 'noteModal']) if ($(id)?.style.display === 'block') closeModal(id);
    }
    function jumpToDay(index) {
        window.TripBook?.select(index, false);
        const day = document.querySelectorAll('#tripContainer > details')[index];
        if (!day) return;
        window.TripMotion?.settle(day);
        if (!day.open) day.open = true;
        day.scrollIntoView({ block: 'start' });
        day.querySelector('summary').focus({ preventScroll: true });
    }
    window.PlannerUI = Object.freeze({ init, switchView, signal, networkSignal, throwIfCancelled, begin, stage, cancel, complete, failed, bookProgress, end, retry, afterRender, timingHtml, edit, editNote, deleteNote: () => saveNote(true), move, remove, replaceStop, resetContext, jumpToDay });
})();
