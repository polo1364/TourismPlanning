const { test } = require('node:test');
const assert = require('node:assert/strict');
const { create, KEY, stopKeys, cleanProgress, MAX_TRIPS } = require('../trip-store.js');
const day = { date: '2026-11-10', day_title: '散步', itinerary: [{ time:'09:00', title:'公園', address:'台北', type:'SPOT' }, { time:'12:00', title:'午餐', address:'台北', type:'FOOD' }] };
const copy = data => JSON.parse(JSON.stringify(data));
function fixture() {
    const data = new Map(); let fail = null, id = 0;
    const storage = { getItem: key => data.get(key) ?? null, setItem(key,value) { if (key === fail) throw new Error('quota'); data.set(key,value); }, removeItem:key=>data.delete(key) };
    const validate = value => {
        if (!value || !Array.isArray(value.t)) throw new Error('bad backup');
        return { i: copy(value.i || {}), t: copy(value.t), g: copy(value.g || null) };
    };
    const store = create(storage, validate, () => 'trip-'+(++id));
    return { data, storage, store, validate, fail: key => { fail=key; } };
}
const initial = () => ({ i:{city:'台北'}, t:[copy(day)], g:{city:'台北',totalDays:2} });
test('migrates legacy trip once, then restores cache from authoritative library', () => {
    const f=fixture(); f.store.init(initial());
    assert.equal(f.store.list().length,1);
    f.storage.setItem('myTrip_v27','[]');
    const reopened=create(f.storage,f.validate); reopened.init({i:{},t:[],g:null});
    assert.equal(reopened.active().data.t.length,1);
    assert.equal(JSON.parse(f.storage.getItem('myTrip_v27')).length,1);
});
test('migration assigns a valid bounded name even for unusual draft city text', () => {
    for (const city of ['  ', '長'.repeat(100)]) {
        const f=fixture(); f.store.init({i:{city},t:[],g:null});
        const name=f.store.active().name;
        assert.ok(name.trim().length>0 && name.length<=80);
        const reopened=create(f.storage,f.validate); reopened.init({i:{},t:[],g:null});
        assert.equal(reopened.active().name,name);
    }
});
test('trip edits and undo stay isolated when switching or adding a trip', () => {
    const f=fixture(); const first=f.store.init(initial()).id;
    f.store.write({myTrip_v27:JSON.stringify([{...day,day_title:'新版'}])},{label:'修改'});
    const second=f.store.add('另一趟',{i:{city:'東京'},t:[],g:null}).id;
    assert.equal(f.store.active().undo,null);
    f.store.select(first); f.store.undo();
    assert.equal(f.store.active().data.t[0].day_title,'散步');
    assert.equal(f.store.active().undo,null);
    f.store.select(second); assert.equal(f.store.active().data.i.city,'東京');
});
test('ordinary draft autosave does not consume itinerary undo or roll back newer draft', () => {
    const f=fixture(); f.store.init(initial());
    f.store.write({myTrip_v27:JSON.stringify([{...day,day_title:'新版'}])});
    f.store.write({tripDraft_v27:JSON.stringify({city:'大阪'})});
    f.store.undo();
    assert.equal(f.store.active().data.i.city,'大阪');
    assert.equal(f.store.active().data.t[0].day_title,'散步');
});
test('an identical first batch commit captures a fresh undo baseline atomically', () => {
    const f=fixture(); f.store.init(initial());
    const first=[{...day,day_title:'批次起點'}];
    f.store.write({myTrip_v27:JSON.stringify(first)},{label:'先前修改'});
    const before=f.store.active();
    f.fail(KEY);
    assert.throws(()=>f.store.write({myTrip_v27:JSON.stringify(first)},{checkpoint:true,label:'整本生成'}),/無法儲存/);
    assert.deepEqual(f.store.active(),before);
    f.fail(null);
    f.store.write({myTrip_v27:JSON.stringify(first)},{checkpoint:true,label:'整本生成'});
    f.store.write({myTrip_v27:JSON.stringify([...first,{...day,date:'2026-11-11'}])},{undo:false});
    assert.equal(f.store.active().undo.label,'整本生成');
    const reopened=create(f.storage,f.validate); reopened.init(initial());
    reopened.undo();
    assert.deepEqual(reopened.active().data.t,first);
});
test('clear and import undo may explicitly restore settings and progression', () => {
    const f=fixture(); f.store.init(initial());
    f.store.write({tripDraft_v27:null,myTrip_v27:null,generationState_v27:null,journeyProgress_v1:null},{inputs:true,label:'清空'});
    f.store.undo();
    assert.equal(f.store.active().data.i.city,'台北');
    assert.equal(f.store.active().data.g.totalDays,2);
});

test('budget undo survives reload and preserves unrelated newer draft settings', () => {
    const f=fixture(); f.store.init({...initial(), i:{city:'台北',budget:'200'}});
    f.store.write({tripDraft_v27:JSON.stringify({city:'台北',budget:'900'})},{budget:true,label:'更新旅程預算'});
    f.store.write({tripDraft_v27:JSON.stringify({city:'大阪',budget:'900'})});
    const reopened=create(f.storage,f.validate); reopened.init({i:{},t:[],g:null});
    reopened.undo();
    assert.equal(reopened.active().data.i.budget,'200');
    assert.equal(reopened.active().data.i.city,'大阪');
});
test('quota failure rolls back caches, library, undo and memory', () => {
    const f=fixture(); f.store.init(initial());
    const before=JSON.stringify([...f.data]), active=f.store.active();
    f.fail(KEY);
    assert.throws(()=>f.store.write({myTrip_v27:'[]'}),/無法儲存/);
    assert.equal(JSON.stringify([...f.data]),before);
    assert.deepEqual(f.store.active(),active);
});
test('failed undo preserves its snapshot for a later successful retry', () => {
    const f=fixture(); f.store.init(initial());
    f.store.write({myTrip_v27:JSON.stringify([{...day,day_title:'新版'}])});
    f.fail(KEY); assert.throws(()=>f.store.undo(),/無法儲存/);
    assert.equal(f.store.active().data.t[0].day_title,'新版');
    assert.ok(f.store.active().undo);
    f.fail(null); f.store.undo(); assert.equal(f.store.active().data.t[0].day_title,'散步');
});
test('stale tabs cannot overwrite newer trip selections or edits', () => {
    const f=fixture(); f.store.init(initial());
    const second=create(f.storage,f.validate); second.init(initial());
    f.store.rename('新名字');
    assert.throws(()=>second.write({myTrip_v27:'[]'}),/另一個分頁/);
    assert.equal(JSON.parse(f.storage.getItem(KEY)).trips[0].name,'新名字');
});
test('malformed library is preserved rather than overwritten during migration', () => {
    const f=fixture(); f.storage.setItem(KEY,'{broken');
    assert.throws(()=>f.store.init(initial()));
    assert.equal(f.storage.getItem(KEY),'{broken');
});
test('completed keys follow unchanged stops through reorder but not changed places', () => {
    const key=stopKeys(day)[0];
    const reversed={...day,itinerary:[...day.itinerary].reverse()};
    assert.ok(stopKeys(reversed).includes(key));
    assert.deepEqual(cleanProgress({done:[key,key,'bogus'],date:day.date,enabled:true},[reversed]).done,[key]);
    reversed.itinerary[1]={...reversed.itinerary[1],title:'新景點'};
    assert.deepEqual(cleanProgress({done:[key]},[reversed]).done,[]);
});
test('identical repeated stops get separate completion keys', () => {
    const repeated={...day,itinerary:[day.itinerary[0],day.itinerary[0]]};
    assert.equal(new Set(stopKeys(repeated)).size,2);
});
test('view preferences do not replace undo, completion changes do', () => {
    const f=fixture(); f.store.init(initial());
    f.store.write({myTrip_v27:JSON.stringify([{...day,day_title:'新版'}])},{label:'行程'});
    f.store.write({journeyProgress_v1:JSON.stringify({enabled:true,done:[]})},{undo:false});
    assert.equal(f.store.active().undo.label,'行程');
    f.store.write({journeyProgress_v1:JSON.stringify({enabled:true,done:[stopKeys(day)[0]]})},{label:'完成'});
    assert.equal(f.store.active().undo.label,'完成');
    f.store.undo(); assert.equal(f.store.active().data.p.done.length,0);
});
test('collection import adds independent records and validates everything before writing', () => {
    const f=fixture(); f.store.init(initial());
    const backup=f.store.exportAll(); f.store.importCollection(backup);
    assert.equal(f.store.list().length,2);
    assert.equal(new Set(f.store.list().map(x=>x.id)).size,2);
    const before=f.storage.getItem(KEY);
    backup.trips.push({name:'bad',data:{t:'invalid'}});
    assert.throws(()=>f.store.importCollection(backup));
    assert.equal(f.storage.getItem(KEY),before);
});
test('capacity limit and final-trip guard never evict existing records', () => {
    const f=fixture(); f.store.init(initial());
    assert.throws(()=>f.store.remove(),/至少保留/);
    for(let i=1;i<MAX_TRIPS;i++) f.store.add('旅程'+i,{i:{},t:[],g:null});
    assert.throws(()=>f.store.add('超額',{i:{},t:[],g:null}),/最多/);
    assert.equal(f.store.list().length,MAX_TRIPS);
});
