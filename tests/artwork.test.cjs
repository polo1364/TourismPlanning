'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const core = require('../artwork-core.js');
const { createImageJobs, validateSubject } = require('../image-jobs.cjs');
const { imageType, imageArgs } = require('../codex-images.cjs');
const { createBridge } = require('../codex-bridge.cjs');
const { createCloud, digest } = require('../cloud-server.cjs');
const { create } = require('../trip-store.js');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jX1cAAAAASUVORK5CYII=', 'base64');
const days = () => [{ date:'2026-11-10', day_title:'台北漫遊', itinerary:[{ title:'台北101',address:'信義區',type:'SPOT',time:'09:00' },{ title:'牛肉麵',address:'台北',type:'FOOD',time:'12:00' }] }];
const subject = () => core.targets('台北',days())[1].subject;
const wait = () => new Promise(resolve => setTimeout(resolve, 10));
async function terminal(jobs, id) { for (let i=0;i<200;i++) { const result=await jobs.get(id); if(result.status!=='running')return result; await wait(); } throw Error('job timeout'); }
async function fixture(t, generate) {
    const directory=await fs.mkdtemp(path.join(os.tmpdir(),'roam-images-test-'));
    let busy=false, calls=0;
    const jobs=createImageJobs({directory,generate:async (...args)=>{calls++;return generate ? generate(...args):{bytes:png};},acquire(){if(busy)throw Object.assign(Error('busy'),{status:409});busy=true;return()=>{busy=false};}});
    t.after(async()=>{jobs.stop();await wait();await fs.rm(directory,{recursive:true,force:true});});
    return {directory,jobs,calls:()=>calls};
}
test('artwork follows actual places; unrelated edits reuse fingerprints and renamed places invalidate only relevant pictures',()=>{
    const original=core.targets('台北',days()); assert.equal(original.length,3);
    const edited=days();edited[0].itinerary[0].time='10:00';edited[0].itinerary[0].cost='500';edited[0].itinerary[0].userNote='note';
    assert.deepEqual(core.targets('台北',edited),original);
    edited[0].itinerary[0].title='故宮';
    const updated=core.targets('台北',edited);
    assert.notEqual(updated[0].fingerprint,original[0].fingerprint);
    assert.notEqual(updated[1].fingerprint,original[1].fingerprint);
    assert.equal(updated[2].fingerprint,original[2].fingerprint);
    assert.equal(core.targets('台北',Array.from({length:15},(_,i)=>({...days()[0],date:`2026-11-${10+i}`}))).length,31);
    const sparse=days();sparse[0].itinerary.pop();assert.equal(core.targets('台北',sparse).length,3);
    assert.equal(core.targets('台北',sparse)[2].subject.places[0].title,'台北101');
});
test('artwork references survive copies and itinerary undo without consuming undo checkpoint',()=>{
    const map=new Map(), storage={getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)};
    const store=create(storage,v=>({i:v.i||{},t:v.t,g:v.g||null}));
    store.init({i:{city:'台北'},t:days()});const original=store.active().id;
    const target=core.targets('台北',days())[1],assetId=crypto.randomUUID();
    store.write({artworkRefs_v1:JSON.stringify(core.attach([],target,assetId))},{undo:false});
    assert.equal(store.active().undo,null);
    const changed=days();changed[0].itinerary[0].title='故宮';
    store.write({myTrip_v27:JSON.stringify(changed)});store.undo();
    assert.equal(core.findRef(store.active().data.a,target).assetId,assetId);
    store.add('copy',store.active().data);assert.equal(store.active().data.a[0].assetId,assetId);
    store.select(original);assert.equal(store.active().data.a[0].assetId,assetId);
    assert.throws(()=>core.refs([{assetId:'../../secret'}]));
});

test('realistic daily montages include multiple actual places and invalidate when any included place changes',()=>{
    const trip=days();
    trip[0].itinerary.push({title:'象山',address:'信義區象山',type:'SPOT'},{title:'夜市小吃',address:'寧夏路',type:'FOOD'});
    const original=core.targets('台北',trip);
    assert.deepEqual(original[1].subject.places.map(p=>p.title),['台北101','象山']);
    assert.deepEqual(original[2].subject.places.map(p=>p.title),['牛肉麵','夜市小吃']);
    assert.equal(original[2].stop,1);
    assert.match(original[1].fingerprint,/travel-photoreal-montage-v1/);
    const old={assetId:crypto.randomUUID(),fingerprint:JSON.stringify(['travel-watercolor-v1',original[1].subject]),slot:original[1].slot,caption:'old'};
    assert.equal(core.findRef([old],original[1]),undefined);
    trip[0].itinerary[3].address='新地址';
    const updated=core.targets('台北',trip);
    assert.equal(updated[1].fingerprint,original[1].fingerprint);
    assert.notEqual(updated[2].fingerprint,original[2].fingerprint);
    for(let i=0;i<6;i++)trip[0].itinerary.push({title:'景點'+i,address:'地址'+i,type:'SPOT'});
    assert.equal(core.targets('台北',trip)[1].subject.places.length,3);
    assert.equal(core.targets('台北',[trip[0],{...days()[0],date:'2026-11-11'}])[3].subject.places.length,1);
});
test('durable request deduplication survives restart and image reads never generate',async t=>{
    const f=await fixture(t);const body={id:crypto.randomUUID(),subject:subject()};
    await Promise.all([f.jobs.create(body),f.jobs.create(body)]);
    assert.equal((await terminal(f.jobs,body.id)).status,'completed');assert.equal(f.calls(),1);
    const reopened=createImageJobs({directory:f.directory,generate:()=>{throw Error('must not generate');}});
    assert.equal((await reopened.create(body)).status,'completed');
    for(let i=0;i<3;i++)assert.equal((await reopened.image(body.id)).base64,png.toString('base64'));
    await assert.rejects(reopened.create({...body,subject:{...subject(),city:'東京'}}),{status:409});
    assert.equal(f.calls(),1);
});
test('active request is not duplicated, other work is rejected, cancellation retains a terminal record',async t=>{
    const f=await fixture(t,(_subject,signal)=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('cancel')))));
    const body={id:crypto.randomUUID(),subject:subject()};await f.jobs.create(body);await wait();
    assert.equal((await f.jobs.create(body)).status,'running');assert.equal(f.calls(),1);
    await assert.rejects(f.jobs.create({...body,id:crypto.randomUUID()}),{status:409});
    await f.jobs.cancel(body.id);assert.equal((await terminal(f.jobs,body.id)).status,'cancelled');
    assert.equal((await f.jobs.create(body)).status,'cancelled');assert.equal(f.calls(),1);
});
test('unfinished work becomes interrupted after restart; invalid image never becomes completed',async t=>{
    const f=await fixture(t,async()=>({bytes:Buffer.from('not a picture')}));
    const id=crypto.randomUUID();await fs.writeFile(path.join(f.directory,id+'.json'),JSON.stringify({id,status:'running',subject:subject()}));
    assert.equal((await f.jobs.get(id)).status,'interrupted');assert.equal(f.calls(),0);
    const failed=crypto.randomUUID();await f.jobs.create({id:failed,subject:subject()});
    assert.equal((await terminal(f.jobs,failed)).status,'failed');
    await assert.rejects(f.jobs.image(failed),{status:409});
});
test('failed artifact storage does not publish success or automatically retry',async t=>{
    const id=crypto.randomUUID();let finish;
    const f=await fixture(t,()=>new Promise(resolve=>{finish=resolve;}));
    await f.jobs.create({id,subject:subject()});await wait();
    await fs.mkdir(path.join(f.directory,id+'.image.tmp'));
    finish({bytes:png});assert.equal((await terminal(f.jobs,id)).status,'failed');
    await f.jobs.create({id,subject:subject()});assert.equal(f.calls(),1);
});
test('image settings preserve ChatGPT authentication and tool isolation',()=>{
    const args=imageArgs();
    assert.ok(args.includes('forced_login_method="chatgpt"'));
    for(const name of ['shell_tool','plugins','apps','hooks'])assert.equal(args[args.indexOf(name)-1],'--disable');
    for(const name of ['image_generation','code_mode_host'])assert.equal(args[args.indexOf(name)-1],'--enable');
    assert.equal(imageType(png),'image/png');assert.throws(()=>imageType(Buffer.from('<svg/>')));
    assert.throws(()=>validateSubject({city:'x',role:'scene',places:[{title:'x',address:5}]}));
});
for(const cloud of [false,true])test(`${cloud?'cloud':'local'} image routes keep authentication, idempotency and shared text lock`,async t=>{
    let imageCalls=0, finish;
    const f=await fixture(t);
    const options={login:async()=>({ready:true,auth:'chatgpt'}),usage:async()=>({models:[]}),imageDirectory:f.directory,imageGenerate:()=>{imageCalls++;return new Promise(resolve=>{finish=resolve;});},generate:async()=>({ok:true})};
    const server=cloud?createCloud({...options,origin:'https://travel.test',passwordHash:digest('test-pass').toString('hex')}):createBridge(options);
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
    const base=`http://127.0.0.1:${server.address().port}`,prefix=cloud?'/codex':'';
    const headers=cloud?{Host:'travel.test','X-Forwarded-Proto':'https',Authorization:'Basic '+Buffer.from('roam:test-pass').toString('base64'),Origin:'https://travel.test'}:{Origin:'http://127.0.0.1:8080'};
    const request=(url,options={})=>new Promise((resolve,reject)=>{
        const req=require('node:http').request(base+prefix+url,{...options,headers:{...headers,...options.headers}},res=>{
            let text='';res.setEncoding('utf8');res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve({status:res.statusCode,json:()=>JSON.parse(text)}));
        });req.on('error',reject);req.end(options.body);
    });
    const token=(await(await request('/status')).json()).token;
    const body={id:crypto.randomUUID(),subject:subject()};
    assert.equal((await request('/images',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).status,403);
    const post={method:'POST',headers:{'Content-Type':'application/json','X-Roam-Token':token},body:JSON.stringify(body)};
    assert.equal((await request('/images',post)).status,202);await wait();
    assert.equal((await request('/images',post)).status,202);assert.equal(imageCalls,1);
    assert.equal((await request('/generate',{...post,body:JSON.stringify({prompt:'test'})})).status,409);
    if(cloud)assert.equal((await request('/images/'+body.id,{headers:{'X-Roam-Token':token,Authorization:''}})).status,401);
    finish({bytes:png});
    for(let i=0;i<100;i++){const state=await(await request('/images/'+body.id,{headers:{'X-Roam-Token':token}})).json();if(state.status==='completed')break;await wait();}
    assert.equal((await request('/images/'+body.id+'/image',{headers:{'X-Roam-Token':token}})).status,200);assert.equal(imageCalls,1);
});
