const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const source = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');

function setup(results, ok = true) {
    const calls = [];
    const context = vm.createContext({
        console, URL, AbortSignal, window: {}, document: { addEventListener() {} },
        fetch: async url => { calls.push(new URL(url)); return { ok, json: async () => ({ results }) }; }
    });
    vm.runInContext(source, context);
    return { calls, run: expression => vm.runInContext(expression, context) };
}
const taiwan = { name: '高雄市', country_code: 'TW', latitude: 22.61626, longitude: 120.31333 };
const china = { name: '高雄', country_code: 'CN', latitude: 31.3664, longitude: 105.372 };

for (const city of ['高雄', '高雄市', '台灣高雄', '臺灣 高雄市', '高雄, Taiwan', 'Kaohsiung']) {
    test(`Taiwan alias and country validation: ${city}`, async () => {
        const a = setup([china, taiwan]);
        const result = await a.run(`getCoordinates(${JSON.stringify(city)})`);
        assert.equal(a.calls[0].searchParams.get('name'), 'Kaohsiung');
        assert.equal(a.calls[0].searchParams.get('countryCode'), 'TW');
        assert.equal(result.lat, taiwan.latitude);
        assert.equal(result.lon, taiwan.longitude);
        assert.equal(a.calls.length, 1);
    });
}
test('does not silently fall back to a wrong country', async () => {
    const a = setup([china]);
    assert.equal(await a.run("getCoordinates('高雄')"), null);
});
test('retains overseas cities and explicit country qualifiers', async () => {
    for (const city of ['東京', 'Paris, France', '高雄, China']) {
        const a = setup([{ name: 'Result', country_code: 'JP', latitude: 35.6895, longitude: 139.69171 }]);
        assert.ok(await a.run(`getCoordinates(${JSON.stringify(city)})`));
        assert.equal(a.calls[0].searchParams.get('name'), city);
        assert.equal(a.calls[0].searchParams.get('countryCode'), null);
    }
});
test('ambiguous countries and invalid coordinates are rejected', async () => {
    for (const rows of [[china, taiwan], [{ ...taiwan, latitude: 200 }], [{ ...taiwan, longitude: null }], [{ ...taiwan, country_code: undefined }], []]) {
        assert.equal(await setup(rows).run("getCoordinates('Unknown')"), null);
    }
});
test('failed responses and empty destinations cannot supply weather coordinates', async () => {
    assert.equal(await setup([taiwan], false).run("getCoordinates('高雄')"), null);
    const a = setup([taiwan]);
    assert.equal(await a.run("getCoordinates('  ')"), null);
    assert.equal(a.calls.length, 0);
});
