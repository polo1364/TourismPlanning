'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const context = vm.createContext({ window: {}, document: { addEventListener() {} } });
vm.runInContext([...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]).join('\n'), context);
const plain = value => JSON.parse(JSON.stringify(value));
const stop = (title, type = 'SPOT', time = '10:00') => ({ title, type, time, desc: '' });
const hotel = '大阪難波站附近';

test('with a stay, every day starts from the stay instead of yesterday\'s last stop', () => {
    const yesterday = { itinerary: [stop('祇園'), stop('京都祇園四條 → 返回難波住宿', 'TRANSPORT', '19:00')] };
    assert.equal(context.dayStartLocation({ hotel, city: '大阪' }, yesterday), hotel);
    // Without a stay (day trips), the last stop is still the natural next start.
    assert.equal(context.dayStartLocation({ hotel: null, city: '大阪' }, yesterday), '京都祇園四條 → 返回難波住宿');
    assert.equal(context.dayStartLocation({ hotel: '', city: '大阪' }, { itinerary: [] }), '大阪市區');
});

test('the outline must cover every date; otherwise it is dropped and days are planned as before', () => {
    const dates = ['2026-12-14', '2026-12-15'];
    const outline = plain(context.normalizeOutline({ days: [{ area: '難波', theme: '抵達', plan: '道頓堀' }, { date: 'wrong', area: '京都', theme: '古寺', plan: '清水寺', extra: 1 }] }, dates));
    assert.deepEqual(outline, [{ date: '2026-12-14', area: '難波', theme: '抵達', plan: '道頓堀' }, { date: '2026-12-15', area: '京都', theme: '古寺', plan: '清水寺' }]);
    assert.equal(context.normalizeOutline({ days: [{ area: '難波' }] }, dates), null);
    assert.equal(context.normalizeOutline({ days: [{}, {}] }, dates), null);
    assert.equal(context.normalizeOutline({ date: '2026-12-14', itinerary: [] }, dates), null);
    assert.equal(context.normalizeOutline(null, dates), null);
});

test('outline prompt names every date and the requests it must place', () => {
    const state = { city: '大阪', hotel, entryName: '飛機', flightArr: '2026-12-14T08:30', flightDep: '2026-12-19T18:00', transport: '大眾運輸', pace: '悠閒慢活', tags: ['美食探索'], spots: '', foodList: '', combinedPrefs: '一天環球影城，可去京都、神戶、奈良', startDate: new Date(2026, 11, 14), totalDays: 6 };
    const dates = plain(context.tripDates(state));
    assert.deepEqual(dates, ['2026-12-14', '2026-12-15', '2026-12-16', '2026-12-17', '2026-12-18', '2026-12-19']);
    const prompt = context.tripOutlinePrompt(state, dates);
    assert.match(prompt, /一天環球影城，可去京都、神戶、奈良/);
    assert.match(prompt, /days 必須剛好 6 筆/);
    assert.match(prompt, /每個都安排/);
});

test('flow check catches a day that does not start or end at the stay, misses the airport, or runs backwards', () => {
    const good = { itinerary: [stop('難波住宿 → 京都', 'TRANSPORT', '08:30'), stop('清水寺', 'SPOT', '10:00'), stop('京都 → 返回難波住宿', 'TRANSPORT', '19:00')] };
    assert.deepEqual(plain(context.dayFlowProblems(good, { hotel, isFirstDay: false, isLastDay: false })), []);
    const fromKyoto = { itinerary: [stop('祇園四條前往嵐山', 'TRANSPORT', '09:00'), stop('渡月橋', 'SPOT', '10:00'), stop('嵐山商店街', 'SPOT', '15:00')] };
    const problems = plain(context.dayFlowProblems(fromKyoto, { hotel, isFirstDay: false, isLastDay: false }));
    assert.equal(problems.length, 2);
    assert.match(problems[0], /從住宿「大阪難波站附近」出發/);
    assert.match(problems[1], /回到住宿/);
    // Arrival day need not start at the stay; departure day must reach the airport, not the stay.
    assert.deepEqual(plain(context.dayFlowProblems({ itinerary: [stop('抵達關西機場', 'TRANSPORT', '12:00'), stop('步行返回難波住宿', 'TRANSPORT', '21:00')] }, { hotel, isFirstDay: true, isLastDay: false })), []);
    const lastDay = { itinerary: [stop('難波住宿退房', 'TRANSPORT', '08:00'), stop('大阪城', 'SPOT', '09:00'), stop('黑門市場', 'FOOD', '12:00')] };
    assert.match(plain(context.dayFlowProblems(lastDay, { hotel, isFirstDay: false, isLastDay: true, entryType: 'flight' })).join(''), /機場/);
    assert.deepEqual(plain(context.dayFlowProblems(lastDay, { hotel, isFirstDay: false, isLastDay: true, entryType: 'car' })), []);
    const backwards = { itinerary: [stop('難波住宿出發', 'TRANSPORT', '09:00'), stop('景點', 'SPOT', '08:00'), stop('返回住宿', 'TRANSPORT', '20:00')] };
    assert.ok(plain(context.dayFlowProblems(backwards, { hotel, isFirstDay: false, isLastDay: false })).some(problem => /由早到晚/.test(problem)));
});

test('each day prompt carries the outline with today marked, and the stay rules', () => {
    const outline = [{ date: '2026-12-14', area: '難波', theme: '抵達', plan: '道頓堀' }, { date: '2026-12-15', area: '神戶', theme: '港町', plan: '北野異人館' }, { date: '2026-12-16', area: '關西機場', theme: '返程', plan: '黑門市場' }];
    const base = { city: '大阪', hotel, dateStr: '2026-12-15', totalDays: 3, flightArr: '2026-12-14T08:30', flightDep: '2026-12-16T18:00', transport: '大眾運輸', pace: '悠閒慢活', tags: '', previousLocation: hotel, visitedSpots: [], entryType: 'flight', entryName: '飛機', outline };
    const middle = context.generateSingleDayPrompt({ ...base, dayIndex: 2, isFirstDay: false, isLastDay: false });
    assert.match(middle, /▶ 第 2 天 2026-12-15：神戶｜港町｜北野異人館/);
    assert.match(middle, /・ 第 1 天 2026-12-14：難波/);
    assert.match(middle, /今天從住宿「大阪難波站附近」出發/);
    assert.match(middle, /今天結束時回到住宿/);
    const last = context.generateSingleDayPrompt({ ...base, dateStr: '2026-12-16', dayIndex: 3, isFirstDay: false, isLastDay: true });
    assert.match(last, /退房並寄放行李/);
    assert.doesNotMatch(last, /今天結束時回到住宿/);
    const withoutOutline = context.generateSingleDayPrompt({ ...base, outline: null, dayIndex: 2, isFirstDay: false, isLastDay: false });
    assert.doesNotMatch(withoutOutline, /全程大綱/);
});

test('a saved generation keeps its outline and resumes from the stay', () => {
    const outline = [{ date: '2026-11-10', area: '台北', theme: '老城', plan: '大稻埕' }, { date: '2026-11-11', area: '北投', theme: '溫泉', plan: '地熱谷' }];
    const days = [{ date: '2026-11-10', day_title: '第一天', summary: '', itinerary: [stop('台北車站'), stop('返回旅館', 'TRANSPORT', '20:00')] }];
    const state = context.restoreGenerationState({ city: '台北', flightArr: '2026-11-10T08:00', flightDep: '2026-11-11T20:00', hotel: '台北車站附近', outline }, days);
    assert.deepEqual(plain(state.outline), outline);
    assert.equal(state.previousLocation, '台北車站附近');
    const older = context.restoreGenerationState({ city: '台北', flightArr: '2026-11-10T08:00', flightDep: '2026-11-11T20:00' }, days);
    assert.equal(older.outline, null);
    assert.equal(older.previousLocation, '返回旅館');
});
