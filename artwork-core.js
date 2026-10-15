(function (root) {
    'use strict';
    const STYLE = 'travel-photoreal-montage-v1';
    const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
    const clean = (value, max) => String(value || '').trim().slice(0, max);
    function targets(city, days) {
        city = clean(city, 200);
        if (!city || !days.length) return [];
        const place = item => ({ title: clean(item.title, 400), address: clean(item.address, 600) });
        const make = (slot, role, places, caption, day = -1, stop = -1) => {
            const subject = { city, role, places };
            return { slot, subject, caption, day, stop, fingerprint: JSON.stringify([STYLE, subject]) };
        };
        const highlights = [];
        const daily = days.flatMap((day, index) => {
            const named = day.itinerary.map((item, stop) => ({ item, stop })).filter(({ item }) => clean(item.title, 400));
            const destinations = named.filter(({ item }) => ['SPOT','FOOD'].includes(item.type));
            const usable = destinations.length ? destinations : named;
            const distinct = entries => entries.filter((entry, position) => entries.findIndex(other => JSON.stringify(place(other.item)) === JSON.stringify(place(entry.item))) === position).slice(0, 3);
            const spots = usable.filter(({ item }) => item.type === 'SPOT');
            const scene = distinct(spots.length ? spots : usable);
            if (!scene.length) return [];
            highlights.push(place(scene[0].item));
            const food = usable.filter(({ item }) => item.type === 'FOOD');
            const remaining = usable.filter(entry => !scene.includes(entry));
            const detail = distinct(food.length ? food : remaining.length ? remaining : scene);
            const picture = (role, entries) => make(day.date + ':' + role, role, entries.map(entry => place(entry.item)), clean(entries.map(entry => entry.item.title).join('・'), 500), index, entries[0].stop);
            return [picture('scene', scene), picture('detail', detail)];
        });
        // Sparse days show a detail of their actual activity, not an invented second stop.
        return highlights.length ? [make('cover', 'cover', highlights.slice(0, 5), city + '・旅程精選'), ...daily] : [];
    }
    function refs(value) {
        if (value == null) return [];
        if (!Array.isArray(value) || value.length > 500) throw new Error('插圖索引格式無效或超過 500 筆。');
        return value.map(item => {
            if (!item || !ID.test(item.assetId) || typeof item.fingerprint !== 'string' || item.fingerprint.length > 8000 || typeof item.slot !== 'string' || item.slot.length > 80 || typeof item.caption !== 'string' || item.caption.length > 500) throw new Error('插圖索引格式無效。');
            return { assetId: item.assetId, fingerprint: item.fingerprint, slot: item.slot, caption: item.caption };
        });
    }
    function findRef(items, target) { return [...items].reverse().find(item => item.fingerprint === target.fingerprint); }
    function attach(items, target, assetId) {
        return refs([...items.filter(item => item.fingerprint !== target.fingerprint), { assetId, fingerprint: target.fingerprint, slot: target.slot, caption: clean(target.caption, 500) }]);
    }
    const api = Object.freeze({ targets, refs, findRef, attach, STYLE, ID });
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.TripArtworkCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
