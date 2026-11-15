const { test } = require('node:test');
const assert = require('node:assert/strict');
const usage = require('../claude-usage.js');

function memory() {
    const values = new Map();
    return { getItem: key => (values.has(key) ? values.get(key) : null), setItem: (key, value) => values.set(key, String(value)) };
}

test('cost follows the per-model token prices', () => {
    assert.equal(usage.cost('claude-opus-5-5', { input_tokens: 1_000_000, output_tokens: 1_000_000 }), 24);
    assert.equal(usage.cost('claude-sonnet-5-5', { input_tokens: 500_000, output_tokens: 100_000 }), 2);
    assert.ok(Math.abs(usage.cost('claude-haiku-5-5', { input_tokens: 50_000, output_tokens: 10_000 }) - 0.01) < 1e-12);
    // Haiku 5.5 is billed at the higher rate once a prompt exceeds 100K tokens.
    assert.ok(Math.abs(usage.cost('claude-haiku-5-5', { input_tokens: 200_000, output_tokens: 10_000 }) - 0.125) < 1e-12);
    // Cache writes cost 1.25x input; cache reads use their own rate.
    assert.ok(Math.abs(usage.cost('claude-opus-5-5', { cache_creation_input_tokens: 1_000_000, cache_read_input_tokens: 1_000_000 }) - 5.2) < 1e-12);
    assert.equal(usage.cost('claude-opus-5', { input_tokens: 10 }), null);
});

test('records are grouped per month, feature and model', () => {
    let now = new Date(2026, 10, 15);
    const counter = usage.create(memory(), () => now);
    counter.record({ model: 'claude-opus-5-5', feature: 'plan', usage: { input_tokens: 1000, output_tokens: 500 } });
    counter.record({ model: 'claude-haiku-5-5', feature: 'artwork', usage: { input_tokens: 2000, output_tokens: 4000 } });
    counter.record({ model: 'claude-opus-5', feature: 'import', usage: { input_tokens: 10, output_tokens: 10 } });
    const month = counter.month();
    assert.equal(month.requests, 3);
    assert.equal(month.input, 3010);
    assert.equal(month.output, 4510);
    assert.equal(month.unpriced, 1);
    assert.ok(Math.abs(month.cost - (0.014 + 0.0022)) < 1e-12);
    assert.deepEqual(Object.keys(month.features).sort(), ['artwork', 'import', 'plan']);
    assert.equal(month.models['claude-opus-5'].cost, 0);
    assert.equal(counter.last().feature, 'import');
    assert.equal(counter.last().cost, null);
    now = new Date(2026, 11, 1);
    assert.equal(counter.month().requests, 0);
    assert.equal(counter.month(new Date(2026, 10, 2)).requests, 3);
});

test('the monthly budget stops new requests once reached, and reset keeps the budget', () => {
    const counter = usage.create(memory(), () => new Date(2026, 10, 15));
    counter.setBudget('0.5');
    counter.guard();
    counter.record({ model: 'claude-opus-5-5', feature: 'plan', usage: { input_tokens: 0, output_tokens: 25_000 } });
    assert.throws(() => counter.guard(), (error) => error.code === 'BUDGET' && /US\$0\.50/.test(error.message));
    counter.reset();
    assert.equal(counter.month().requests, 0);
    assert.equal(counter.budget(), 0.5);
    counter.guard();
    counter.setBudget('');
    assert.equal(counter.budget(), null);
    for (const bad of ['-1', '0', 'abc']) assert.throws(() => counter.setBudget(bad), /預算/);
});

test('damaged or unavailable storage never breaks a request', () => {
    const broken = { getItem: () => '{not json', setItem: () => { throw new Error('quota'); } };
    const counter = usage.create(broken, () => new Date(2026, 10, 15));
    assert.doesNotThrow(() => counter.record({ model: 'claude-opus-5-5', feature: 'plan', usage: { input_tokens: 1, output_tokens: 1 } }));
    assert.doesNotThrow(() => counter.guard());
    assert.equal(counter.month().requests, 0);
    assert.doesNotThrow(() => counter.record({ model: 'claude-opus-5-5' }));
});

test('money formatting shows tiny amounts honestly', () => {
    assert.equal(usage.money(0), 'US$0.00');
    assert.equal(usage.money(0.004), '< US$0.01');
    assert.equal(usage.money(1.236), 'US$1.24');
});
