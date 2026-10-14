const { test } = require('node:test');
const assert = require('node:assert/strict');
const { minutes, timing, inspect } = require('../planner-checks.js');
const stop = (title, time, endTime, travelMinutes) => ({ title, time, endTime, travelMinutes, type: 'SPOT' });
const day = itinerary => ({ date: '2026-11-10', itinerary });
test('times reject impossible clock values and preserve unknown durations', () => {
    assert.equal(minutes('24:00'), null);
    assert.equal(minutes('09:60'), null);
    assert.equal(minutes('09:15'), 555);
    assert.equal(timing(stop('A', '09:00')).duration, null);
    assert.equal(timing(stop('A', '09:00–10:30')).duration, 90);
    assert.equal(timing({ time: '09:00', durationMinutes: 45 }).end, 585);
});
test('reports overlapping and out-of-order activities including nested intervals', () => {
    const r = inspect([day([stop('A', '09:00', '12:00'), stop('B', '10:00', '10:30', 0), stop('C', '11:00', '11:30', 0)])]);
    assert.equal(r.issues.filter(x => x.code === 'OVERLAP').length, 2);
});
test('travel checks use arrival duration and permit an exact boundary', () => {
    const good = day([stop('A', '09:00', '10:00'), stop('B', '10:20', '11:00', 20)]);
    assert.equal(inspect([good]).issues.length, 0);
    good.itinerary[1].travelMinutes = 21;
    assert.equal(inspect([good]).issues[0].code, 'TRAVEL');
});
test('unknown timing is reported as coverage rather than a fabricated conflict', () => {
    const r = inspect([day([stop('A', '09:00'), stop('B', '10:00')])]);
    assert.equal(r.issues.length, 0);
    assert.equal(r.missingTime, 2);
    assert.equal(r.missingTravel, 1);
});
test('detects duplicate places across days while ignoring repeated transport titles', () => {
    const r = inspect([day([stop('Ａ B', '09:00', '10:00')]), { date:'2026-11-11', itinerary:[stop('a b', '09:00', '10:00')] }]);
    assert.equal(r.issues[0].code, 'DUPLICATE');
    const transport = { ...stop('車站', '09:00', '10:00'), type: 'TRANSPORT' };
    assert.equal(inspect([day([transport]), day([transport])]).issues.length, 0);
});
test('budget comparison is optional and compares numeric same-currency amounts', () => {
    assert.equal(inspect([], { budget: 100, totalCost: 101 }).issues[0].code, 'BUDGET');
    assert.equal(inspect([], { budget: 100, totalCost: 100 }).issues.length, 0);
    assert.equal(inspect([], { budget: 0, totalCost: 100 }).issues.length, 0);
});
test('invalid and cross-midnight timing does not masquerade as a positive duration', () => {
    assert.equal(inspect([day([stop('A', '12:00', '10:00')])]).issues[0].code, 'INVALID_TIME');
    assert.equal(inspect([day([{ time:'23:30', durationMinutes:90, title:'A' }])]).issues[0].code, 'INVALID_TIME');
});
