'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const context = vm.createContext({ window: {}, document: { addEventListener() {} } });
vm.runInContext([...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]).join('\n'), context);
const classify = text => JSON.parse(JSON.stringify(context.classifyItineraryNotes(text)));
const fragments = texts => texts.flatMap(text => text.split(/\r?\n+|(?<=[。；！？·])\s*/u)).map(text => text.replace(/\s/g, '')).filter(Boolean).sort();

test('topic cards classify facts and keep qualifiers, amounts and unknown content', () => {
    const text = '團費：成人 38,500 元；兒童 35,500 元；未含小費。住宿：兩人一室，單人房另加價；房型待確認。交通：遊覽車接送；班機時間未提供。注意事項：護照效期至少六個月。日期暫定：2027-05-11。\n未知資訊 ABC。';
    const groups = classify(text);
    const byKey = Object.fromEntries(groups.map(group => [group.key, group.items.join('')]));
    assert.match(byKey.cost, /38,500.*35,500.*未含小費/);
    assert.match(byKey.stay, /兩人一室.*單人房另加價.*房型待確認/);
    assert.match(byKey.transport, /遊覽車接送.*班機時間未提供/);
    assert.match(byKey.attention, /護照效期至少六個月/);
    assert.match(byKey.source, /2027-05-11/);
    assert.equal(byKey.other, '未知資訊 ABC。');
    assert.deepEqual(fragments(groups.flatMap(group => group.items)), fragments([text]));
});

test('mixed subjects remain intact, source text cannot change markup, repeated facts are not deleted', () => {
    const text = '飯店與機場接送均待確認。\n人工補充：團費包含住宿。\n團費：12,000 元。團費：12,000 元。\n<img src=x onerror="alert(1)">';
    const groups = classify(text);
    assert.ok(groups.find(group => group.key === 'other').items.includes('飯店與機場接送均待確認。'));
    assert.equal(groups.find(group => group.key === 'cost').items.length, 2);
    assert.equal(groups.find(group => group.key === 'source').items[0], '人工補充：團費包含住宿。');
    assert.deepEqual(fragments(groups.flatMap(group => group.items)), fragments([text]));
    const rendered = context.renderItineraryNoteGroups(text, { itinerary: [] });
    assert.ok(!rendered.includes('<img'));
    assert.match(rendered, /&lt;img/);
});

test('empty notes render no invented facts and grouping never mutates stored summaries', () => {
    assert.deepEqual(classify(''), []);
    const day = { summary: '交通：機場接送。\n匯入核對事項\n團費：尚未提供。', itinerary: [] };
    const before = JSON.stringify(day);
    const rendered = context.renderDaySummary(day);
    assert.match(rendered, /summary-category-transport/);
    assert.match(rendered, /summary-category-cost/);
    assert.equal(JSON.stringify(day), before);
});
