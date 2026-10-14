const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createBridge, parseEvents, cliArgs, childEnv } = require('../codex-bridge.cjs');
const origin = 'http://127.0.0.1:8080';
const resultEvents = data => [
    {type:'thread.started',thread_id:'test'},
    {type:'item.completed',item:{type:'agent_message',text:JSON.stringify(data)}},
    {type:'turn.completed',usage:{input_tokens:10,output_tokens:10}}
].map(JSON.stringify).join('\n');
async function fixture(t, generate = async () => ({ok:true}), login = async () => ({ready:true,auth:'chatgpt'})) {
    const server=createBridge({generate,login});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve)}));
    const base=`http://127.0.0.1:${server.address().port}`;
    const status=await fetch(base+'/status',{headers:{Origin:origin}});
    const state=await status.json();
    const headers={Origin:origin,'Content-Type':'application/json','X-Roam-Token':state.token};
    return {base,headers,state,send:(body={prompt:'台北旅遊'},extra={})=>fetch(base+'/generate',{method:'POST',headers,...extra,body:JSON.stringify(body)})};
}
test('Codex bridge only returns completed valid JSON; rejects failed or incomplete events',()=>{
    assert.deepEqual(parseEvents(resultEvents({ok:true})),{ok:true});
    assert.throws(()=>parseEvents(resultEvents([])),/物件/);
    assert.throws(()=>parseEvents(resultEvents({ok:true}).split('\n').slice(0,2).join('\n')),/完整/);
    assert.throws(()=>parseEvents(resultEvents({ok:true})+'\n'+JSON.stringify({type:'turn.failed'})),/未完成/);
    assert.throws(()=>parseEvents('private diagnostic text'),/格式/);
});
test('CLI invocation uses ChatGPT auth, isolated read-only execution and no shell tools',()=>{
    const args=cliArgs('isolated-temp');
    for(const value of ['--ignore-user-config','--ephemeral','read-only','forced_login_method="chatgpt"','model_provider="openai"','shell_tool','plugins','apps','hooks']) assert.ok(args.includes(value));
    assert.equal(args.at(-1),'-');
    assert.equal(childEnv().OPENAI_API_KEY,undefined);
    assert.equal(childEnv().CODEX_API_KEY,undefined);
    assert.equal(childEnv().OPENAI_BASE_URL,undefined);
});
test('bridge validates origin, host and request token before invoking Codex',async t=>{
    let calls=0;const f=await fixture(t,async()=>{calls++;return{ok:true}});
    for(const headers of [{...f.headers,Origin:'https://evil.example'},{...f.headers,Origin:'null'},{...f.headers,'X-Roam-Token':'wrong'}]) {
        assert.equal((await f.send(undefined,{headers})).status,403);
    }
    const hostStatus=await new Promise((resolve,reject)=>{
        const req=http.request(f.base+'/generate',{method:'POST',headers:{...f.headers,Host:'evil.example'}},res=>{res.resume();resolve(res.statusCode)});
        req.on('error',reject);req.end(JSON.stringify({prompt:'host check'}));
    });
    assert.equal(hostStatus,403);
    assert.equal(calls,0);
    const response=await f.send();assert.equal(response.status,200);
    assert.deepEqual(await response.json(),{data:{ok:true}});assert.equal(calls,1);
});
test('bridge rejects invalid prompts and suppresses internal error details',async t=>{
    const f=await fixture(t,async()=>{throw new Error('secret-token-not-for-client')});
    for(const prompt of ['',null,'x'.repeat(60001)]) assert.equal((await f.send({prompt})).status,400);
    const response=await f.send();assert.equal(response.status,500);
    assert.ok(!(await response.text()).includes('secret-token'));
});
test('bridge never generates when ChatGPT login is unavailable',async t=>{
    let allowed=true,calls=0;
    const f=await fixture(t,async()=>{calls++;return{}},async()=>{
        if(!allowed)throw Object.assign(new Error('需要 ChatGPT 登入'),{code:'LOGIN',status:401});
        return{ready:true,auth:'chatgpt'};
    });
    allowed=false;
    assert.equal((await f.send()).status,401);assert.equal(calls,0);
});
test('one active generation is allowed; disconnect aborts it and releases the lock',async t=>{
    let started,aborted;
    const startedPromise=new Promise(r=>{started=r}),abortedPromise=new Promise(r=>{aborted=r});
    const f=await fixture(t,(_prompt,signal)=>new Promise((resolve,reject)=>{
        started();signal.addEventListener('abort',()=>{aborted();reject(Object.assign(new Error('cancel'),{status:499,code:'CANCELLED'}))},{once:true});
    }));
    const controller=new AbortController();
    const pending=f.send(undefined,{signal:controller.signal}).catch(()=>{});
    await startedPromise;assert.equal((await f.send()).status,409);
    controller.abort();await pending;await abortedPromise;
    // Validation proceeds again after the disconnected generation finishes.
    assert.equal((await f.send({prompt:''})).status,400);
});
