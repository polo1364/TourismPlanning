(function (root) {
    'use strict';
    const KEY = 'tourismTrips_v1';
    const CACHE = { i: 'tripDraft_v27', t: 'myTrip_v27', g: 'generationState_v27', p: 'journeyProgress_v1' };
    const MAX_TRIPS = 20;
    const clone = value => JSON.parse(JSON.stringify(value));
    function stopKeys(day) {
        const occurrences = new Map();
        return day.itinerary.map(item => {
            const base = JSON.stringify([day.date, item.time || '', item.title, item.address || '', item.type]);
            const ordinal = occurrences.get(base) || 0;
            occurrences.set(base, ordinal + 1);
            return JSON.stringify([base, ordinal]);
        });
    }
    function cleanProgress(value, days) {
        if (value != null && (typeof value !== 'object' || Array.isArray(value))) throw new Error('旅途進度格式無效。');
        if (value?.done !== undefined && (!Array.isArray(value.done) || value.done.some(key => typeof key !== 'string'))) throw new Error('完成站點格式無效。');
        const valid = new Set(days.flatMap(stopKeys));
        return {
            done: [...new Set(value?.done || [])].filter(key => valid.has(key)),
            date: days.some(day => day.date === value?.date) ? value.date : '',
            enabled: value?.enabled === true
        };
    }
    function cacheFor(data) {
        return {
            [CACHE.i]: Object.keys(data.i).length ? JSON.stringify(data.i) : null,
            [CACHE.t]: data.t.length ? JSON.stringify(data.t) : null,
            [CACHE.g]: data.g ? JSON.stringify(data.g) : null,
            [CACHE.p]: JSON.stringify(data.p)
        };
    }
    function create(storage, validateBackup, makeId = () => root.crypto.randomUUID()) {
        let book = null, raw = null;
        const normalize = data => {
            const value = validateBackup(data);
            return { i: value.i, t: value.t, g: value.g, p: cleanProgress(data.p, value.t) };
        };
        function checkFresh() {
            if (!book) throw new Error('旅程資料尚未就緒，請備份後重新載入。');
            if (storage.getItem(KEY) !== raw) throw new Error('另一個分頁已更新旅程。請重新載入後再操作，避免覆蓋新資料。');
        }
        function batch(values) {
            const previous = Object.fromEntries(Object.keys(values).map(key => [key, storage.getItem(key)]));
            try {
                for (const [key, value] of Object.entries(values)) {
                    if (value === null) storage.removeItem(key);
                    else storage.setItem(key, value);
                }
            } catch (_) {
                for (const [key, value] of Object.entries(previous)) {
                    try { if (value === null) storage.removeItem(key); else storage.setItem(key, value); } catch (_) { /* Preserve the in-memory copy for backup. */ }
                }
                throw new Error('無法儲存旅程，請確認瀏覽器空間與權限，或先備份資料。');
            }
        }
        function commit(next, values = {}) {
            checkFresh();
            const nextRaw = JSON.stringify(next);
            // Write the authoritative library last; startup restores caches from this record.
            batch({ ...values, [KEY]: nextRaw });
            book = next; raw = nextRaw;
        }
        function parseBook(value) {
            if (!value || value.version !== 1 || !Array.isArray(value.trips) || !value.trips.length || value.trips.length > MAX_TRIPS) throw new Error('旅程收藏格式無效，原資料未覆寫。');
            const ids = new Set();
            const trips = value.trips.map(record => {
                if (!record || typeof record.id !== 'string' || !record.id || ids.has(record.id) || typeof record.name !== 'string' || !record.name.trim() || record.name.length > 80) throw new Error('旅程識別或名稱無效。');
                ids.add(record.id);
                const undo = record.undo ? { data: normalize(record.undo.data), label: String(record.undo.label || '行程修改').slice(0, 80), inputs: record.undo.inputs === true, budget: record.undo.budget === true } : null;
                return { id: record.id, name: record.name, data: normalize(record.data), undo };
            });
            if (!ids.has(value.activeId)) throw new Error('找不到目前旅程，原資料未覆寫。');
            return { version: 1, activeId: value.activeId, trips };
        }
        function init(legacy) {
            raw = storage.getItem(KEY);
            if (raw !== null) {
                book = parseBook(JSON.parse(raw));
                // Restore from the library after an interrupted cache write or a legacy tab.
                batch(cacheFor(active().data));
            } else {
                const data = normalize(legacy);
                const name = String(data.g?.city || data.i.city || '').trim().slice(0, 80) || '我的旅程';
                const record = { id: makeId(), name, data, undo: null };
                book = { version: 1, activeId: record.id, trips: [record] };
                try { commit(clone(book)); } catch (error) { book = null; throw error; }
            }
            return active();
        }
        function active() { return clone(book.trips.find(record => record.id === book.activeId)); }
        function list() { return book.trips.map(({ id, name, data, undo }) => ({ id, name, days: data.t.length, canUndo: !!undo })); }
        function write(values, options = {}) {
            checkFresh();
            const next = clone(book), record = next.trips.find(record => record.id === next.activeId);
            const old = record.data;
            const candidate = clone(old);
            for (const [field, key] of Object.entries(CACHE)) {
                if (Object.hasOwn(values, key)) candidate[field] = values[key] === null ? ({ i: {}, t: [], g: null, p: null })[field] : JSON.parse(values[key]);
            }
            record.data = normalize(candidate);
            const itineraryChanged = JSON.stringify([old.t, old.g]) !== JSON.stringify([record.data.t, record.data.g]);
            const progressChanged = JSON.stringify(old.p.done) !== JSON.stringify(record.data.p.done);
            const inputsChanged = options.inputs === true && JSON.stringify(old.i) !== JSON.stringify(record.data.i);
            const budgetChanged = options.budget === true && old.i.budget !== record.data.i.budget;
            // A batch needs a fresh baseline even when its first saved day is identical.
            if (options.undo !== false && (options.checkpoint === true || itineraryChanged || progressChanged || inputsChanged || budgetChanged)) record.undo = { data: old, label: options.label || '行程修改', inputs: options.inputs === true, budget: options.budget === true };
            commit(next, { ...values, [CACHE.p]: JSON.stringify(record.data.p) });
            return active();
        }
        function add(name, data) {
            checkFresh();
            if (book.trips.length >= MAX_TRIPS) throw new Error(`最多可保存 ${MAX_TRIPS} 份旅程，請先備份並移除不需要的旅程。`);
            name = String(name || '').trim();
            if (!name || name.length > 80) throw new Error('旅程名稱請填寫 1 至 80 個字。');
            const next = clone(book);
            const record = { id: makeId(), name, data: normalize(data), undo: null };
            next.trips.push(record); next.activeId = record.id;
            commit(next, cacheFor(record.data));
            return active();
        }
        function select(id) {
            checkFresh();
            const next = clone(book), record = next.trips.find(record => record.id === id);
            if (!record) throw new Error('找不到這份旅程。');
            next.activeId = id;
            commit(next, cacheFor(record.data));
            return active();
        }
        function rename(name) {
            checkFresh(); name = String(name || '').trim();
            if (!name || name.length > 80) throw new Error('旅程名稱請填寫 1 至 80 個字。');
            const next = clone(book);
            next.trips.find(record => record.id === next.activeId).name = name;
            commit(next);
        }
        function remove() {
            checkFresh();
            if (book.trips.length === 1) throw new Error('請至少保留一份旅程；可使用清空目前旅程。');
            const next = clone(book);
            next.trips = next.trips.filter(record => record.id !== next.activeId);
            next.activeId = next.trips[0].id;
            commit(next, cacheFor(next.trips[0].data));
            return active();
        }
        function undo() {
            checkFresh();
            const next = clone(book), record = next.trips.find(record => record.id === next.activeId);
            if (!record.undo) throw new Error('這份旅程沒有可復原的變更。');
            const previous = record.undo;
            const restoredInputs = previous.inputs ? previous.data.i : previous.budget ? { ...record.data.i, budget: previous.data.i.budget ?? '' } : record.data.i;
            record.data = normalize({ ...previous.data, i: restoredInputs,
                p: previous.inputs ? previous.data.p : { ...record.data.p, done: previous.data.p.done } });
            record.undo = null;
            commit(next, cacheFor(record.data));
            return active();
        }
        function exportAll() {
            return { format: 'tourism-library', version: 1, trips: book.trips.map(record => ({ name: record.name, data: clone(record.data) })) };
        }
        function validateCollection(value) {
            if (!value || value.format !== 'tourism-library' || value.version !== 1 || !Array.isArray(value.trips) || !value.trips.length || value.trips.length > MAX_TRIPS) throw new Error('旅程收藏備份格式無效。');
            return value.trips.map(record => {
                if (!record || typeof record.name !== 'string' || !record.name.trim() || record.name.length > 80) throw new Error('備份旅程名稱無效。');
                return { name: record.name, data: normalize(record.data) };
            });
        }
        function importCollection(value) {
            checkFresh();
            const records = validateCollection(value);
            if (book.trips.length + records.length > MAX_TRIPS) throw new Error(`匯入後超過 ${MAX_TRIPS} 份旅程上限，原資料已保留。`);
            const next = clone(book);
            const added = records.map(record => ({ ...record, id: makeId(), undo: null }));
            next.trips.push(...added); next.activeId = added[0].id;
            commit(next, cacheFor(added[0].data));
        }
        return Object.freeze({ init, active, list, write, add, select, rename, remove, undo, exportAll, validateCollection, importCollection, checkFresh });
    }
    const api = Object.freeze({ create, KEY, CACHE, MAX_TRIPS, stopKeys, cleanProgress });
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.TripStore = api;
})(typeof globalThis !== 'undefined' ? globalThis : window);
