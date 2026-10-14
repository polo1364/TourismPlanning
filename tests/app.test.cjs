const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const source = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');

function app() {
    const elements = new Map();
    const data = new Map();
    const context = vm.createContext({
        console, URL, Date, setTimeout, clearTimeout, setInterval, clearInterval,
        window: {}, alert() {}, confirm: () => true, location: { reload() {} },
        localStorage: { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) },
        document: { getElementById: id => { if (!elements.has(id)) elements.set(id, { value: '', style: {} }); return elements.get(id); }, addEventListener() {}, querySelectorAll: () => [] }
    });
    vm.runInContext(source, context);
    return { context, run: expression => vm.runInContext(expression, context), elements, data };
}

test('calendar days include both dates even when less than 24 hours', () => {
    assert.equal(app().run("getTripDayCount('2026-10-14T18:00', '2026-10-15T09:00')"), 2);
});
test('same-time or reversed trips are invalid', () => {
    const a = app();
    assert.equal(a.run("getTripDayCount('2026-10-14T18:00', '2026-10-14T18:00')"), 0);
    assert.equal(a.run("getTripDayCount('2026-10-14T18:00', '2026-10-14T09:00')"), 0);
});
test('prompt contains user constraints', () => {
    const prompt = app().run("generateSingleDayPrompt({spots:'測試必去', foodList:'測試必吃', combinedPrefs:'不能吃牛', tags:'親子', foodInstruction:'素食餐廳', visitedSpots:[]})");
    for (const text of ['測試必去', '測試必吃', '不能吃牛', '親子', '素食餐廳']) assert.ok(prompt.includes(text), text);
});
test('AI ideas formatting handles arrays and strings', () => {
    assert.equal(app().run("formatAIOutput(['甲','乙'])"), '甲\n乙');
});

test('day planning uses current total budget and spent amount', () => {
    const prompt = app().run("generateSingleDayPrompt({budget:500, spent:200, visitedSpots:[]})");
    assert.ok(prompt.includes('全旅程預算：500'));
    assert.ok(prompt.includes('剩餘預算約 300'));
    assert.ok(prompt.includes('travelMinutes'));
});

test('new stop timing fields survive validation while invalid numeric durations are discarded', () => {
    const a = app();
    const result = JSON.parse(a.run(`JSON.stringify(normalizeDay({date:'2026-11-10',day_title:'旅程',itinerary:[{title:'景點',time:'09:00',endTime:'10:00',durationMinutes:60,travelMinutes:20},{title:'另一站',travelMinutes:-1,durationMinutes:Infinity}]}))`));
    assert.equal(result.itinerary[0].endTime, '10:00');
    assert.equal(result.itinerary[0].travelMinutes, 20);
    assert.equal(result.itinerary[0].durationMinutes, 60);
    assert.equal(result.itinerary[1].travelMinutes, undefined);
    assert.equal(result.itinerary[1].durationMinutes, undefined);
});
test('costs keep thousand separators and decimals and only average ranges', () => {
    const a = app();
    assert.equal(a.run("calculateTotalCost({itinerary:[{cost:'¥1,500'},{cost:'$12.50'},{cost:'100-200元'},{cost:'免費'}]}).amount"), 1662.5);
});

test('explicit foreign currency is excluded instead of counted as destination currency', () => {
    const result = app().run("calculateTotalCost({itinerary:[{cost:'USD 20'},{cost:'JPY 1000'}]}, {code:'JPY'})");
    assert.equal(result.amount, 1000);
    assert.equal(result.unpriced, 1);
});

test('unclear pricing and quantities are not silently treated as zero or ticket prices', () => {
    const result = app().run("calculateTotalCost({itinerary:[{cost:'兒童免費，成人300元'},{cost:'2人共 NT$500'},{cost:'待確認'},{cost:'免費'},{cost:'NT$100-200'}]}, {code:'TWD'})");
    assert.equal(result.amount, 150);
    assert.equal(result.unpriced, 3);
});

test('spaced ranges remain estimates while negative prices are not made positive', () => {
    const result = app().run("calculateTotalCost({itinerary:[{cost:'100 元 - 200 元'},{cost:'USD 10 - USD 20'},{cost:'NT$-500'}]})");
    assert.equal(result.amount, 165);
    assert.equal(result.unpriced, 1);
});

test('written group counts and conditional discounts do not masquerade as fixed prices', () => {
    const result = app().run("calculateTotalCost({itinerary:[{cost:'成人300元，兒童半價'},{cost:'雙人套票500元'},{cost:'300元起'},{cost:'門票200，交通另計'}]}, {code:'TWD'})");
    assert.equal(result.amount, 0);
    assert.equal(result.unpriced, 4);
});

test('unknown destinations do not silently become JPY and Taiwan districts keep TWD', () => {
    const a = app();
    assert.equal(a.run("getCurrencyInfo('未知目的地').unknown"), true);
    assert.equal(a.run("getCurrencyInfo('臺北松山').code"), 'TWD');
});
test('clear removes continuation state with the itinerary', () => {
    const a = app();
    a.data.set('generationState_v27', '{}');
    a.run('clearAll()');
    assert.equal(a.data.has('generationState_v27'), false);
});

const day = { date: '2026-10-14', day_title: '旅程', itinerary: [{ type: 'SPOT', title: '景點', cost: '1,500円' }] };

test('AI day validation rejects incomplete output before saving', () => {
    const a = app();
    for (const value of [null, {}, { day_title: '錯誤', itinerary: {} }, { day_title: '錯誤', itinerary: [null] }]) {
        assert.throws(() => a.run(`normalizeDay(${JSON.stringify(value)}, '2026-10-14')`));
    }
});
test('normalization preserves the requested day and safe structured fields', () => {
    const a = app();
    const normalized = a.run(`normalizeDay(${JSON.stringify({ ...day, itinerary: [{ title: '<img onerror=x>', type: 'bad" onclick="x', booking: 'false' }] })}, '2026-10-15')`);
    assert.equal(normalized.date, '2026-10-15');
    assert.equal(normalized.itinerary[0].type, 'SPOT');
    assert.equal(normalized.itinerary[0].booking, false);
    assert.equal(normalized.itinerary[0].title, '<img onerror=x>');
    assert.equal(a.run(`escapeHtml('<img onerror="x">&')`), '&lt;img onerror=&quot;x&quot;&gt;&amp;');
});
test('invalid backups and duplicate dates are rejected', () => {
    const a = app();
    for (const value of [{}, { i: 'bad' }, { i: { tripTags: 'bad' } }, { i: { hasHotel: 'false' } }, { t: [day, day] }]) {
        assert.throws(() => a.run(`validateBackup(${JSON.stringify(value)})`));
    }
});
test('legacy backups do not keep unrelated continuation state', () => {
    const backup = app().run(`validateBackup(${JSON.stringify({ i: { city: '大阪' }, t: [day] })})`);
    assert.equal(backup.g, null);
    assert.equal(backup.t.length, 1);
});

test('backup normalization strips unrelated continuation properties', () => {
    const a = app();
    const result = a.run(`restoreGenerationState({city:'台北',flightArr:'2026-10-14T08:00',flightDep:'2026-10-15T20:00',apiKey:'mock-secret',extra:{token:'mock-token'}}, [])`);
    assert.equal(result.apiKey, undefined);
    assert.equal(result.extra, undefined);
    assert.equal(result.city, '台北');
});
test('continuation state verifies trip dates and rebuilds visited places', () => {
    const a = app();
    const state = { city: '大阪', flightArr: '2026-10-14T18:00', flightDep: '2026-10-15T09:00', allVisitedSpots: ['舊景點'], tags: [] };
    const result = a.run(`restoreGenerationState(${JSON.stringify(state)}, validateTrip(${JSON.stringify([day])}))`);
    assert.equal(result.totalDays, 2);
    assert.deepEqual(Array.from(result.allVisitedSpots), ['景點']);
    assert.throws(() => a.run(`restoreGenerationState(${JSON.stringify(state)}, validateTrip(${JSON.stringify([{ ...day, date: '2026-10-16' }])}))`));
});
test('storage transaction restores the old records when a later write fails', () => {
    const a = app();
    a.data.set('myTrip_v27', 'old-trip');
    a.data.set('generationState_v27', 'old-state');
    const setItem = a.context.localStorage.setItem;
    a.context.localStorage.setItem = (key, value) => {
        if (value === 'new-state') throw new Error('QuotaExceeded');
        setItem(key, value);
    };
    assert.throws(() => a.run("writeStoredValues({myTrip_v27:'new-trip', generationState_v27:'new-state'})"));
    assert.equal(a.data.get('myTrip_v27'), 'old-trip');
    assert.equal(a.data.get('generationState_v27'), 'old-state');
});

test('malformed continuation tags fail validation and missing weather is discarded', () => {
    const a = app();
    const state = { city: '大阪', flightArr: '2026-10-14T18:00', flightDep: '2026-10-15T09:00' };
    assert.throws(() => a.run(`restoreGenerationState(${JSON.stringify({ ...state, tags: null })}, [])`));
    const result = a.run(`restoreGenerationState(${JSON.stringify({ ...state, weatherInfo: { daily: {} } })}, [])`);
    assert.equal(result.weatherInfo, null);
    assert.deepEqual(Array.from(result.tags), []);
});
test('map queries tolerate a lone Unicode surrogate without breaking rendering', () => {
    const encoded = app().run('encodeQuery(String.fromCharCode(0xd800))');
    assert.equal(encoded, '%EF%BF%BD');
});
test('invalid calendar dates are not accepted as trip boundaries', () => {
    assert.equal(app().run("getTripDayCount('2026-02-30T08:00', '2026-03-05T18:00')"), 0);
});
test('route links honor transport and encode waypoint separators', () => {
    const a = app();
    a.run("document.getElementById('city').value='台北'; document.getElementById('transport').value='大眾運輸'");
    const url = a.run("generateDayRouteUrl({itinerary:[{title:'甲',type:'SPOT'},{title:'乙',type:'FOOD'},{title:'丙',type:'SPOT'},{title:'丁',type:'SPOT'}]}, '')");
    assert.ok(url.includes('%7C'));
    assert.equal(new URL(url).searchParams.get('travelmode'), 'transit');
});
