"""UI tests for local Codex routing. No real quota or API requests are made."""
import json
import re
import threading
from functools import partial
from http.server import ThreadingHTTPServer
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright
from browser_smoke import ROOT, ARTIFACTS, Handler, Network, START, END, sample_day, overflow


class LocalNetwork(Network):
    def __init__(self):
        super().__init__()
        self.calls=[]
        self.hold=False
        self.fail=False
        self.ready=True
        self.pending_local=[]
        self.hold_status=False
        self.pending_status=[]

    def route(self,route):
        url=urlparse(route.request.url)
        if url.hostname!='127.0.0.1' or url.port!=8081:
            return super().route(route)
        headers={'Access-Control-Allow-Origin':route.request.headers.get('origin','*'), 'Access-Control-Allow-Headers':'Content-Type, X-Roam-Token'}
        if route.request.method=='OPTIONS':
            return route.fulfill(status=204,headers=headers)
        if url.path=='/status':
            payload={'ready':True,'auth':'chatgpt','token':'mock-local-token'} if self.ready else {'error':'請登入 ChatGPT','code':'LOGIN'}
            if self.hold_status:
                self.pending_status.append((route,headers,payload));return
            return route.fulfill(status=200 if self.ready else 401,content_type='application/json',headers=headers,body=json.dumps(payload))
        body=route.request.post_data_json
        self.calls.append(body)
        if self.fail:
            return route.fulfill(status=502,content_type='application/json',headers=headers,body=json.dumps({'error':'Codex 額度測試失敗','code':'PROVIDER'}))
        day=int(re.search(r'第\s*(\d+)\s*天',body['prompt']).group(1))
        payload={'data':sample_day(START if day==1 else END,title=f'Codex 第 {day} 天')}
        if self.hold:
            self.pending_local.append((route,headers,payload));return
        route.fulfill(status=200,content_type='application/json',headers=headers,body=json.dumps(payload))

    def release(self):
        pending,self.pending_local=self.pending_local,[]
        for route,headers,payload in pending:
            route.fulfill(status=200,content_type='application/json',headers=headers,body=json.dumps(payload))

    def release_status(self):
        pending,self.pending_status=self.pending_status,[]
        for route,headers,payload in pending:
            route.fulfill(status=200,content_type='application/json',headers=headers,body=json.dumps(payload))


def main():
    server=ThreadingHTTPServer(('127.0.0.1',0),partial(Handler,directory=str(ROOT)))
    threading.Thread(target=server.serve_forever,daemon=True).start()
    checks=[]
    def check(name,value):
        checks.append({'name':name,'passed':bool(value)})
        assert value,name
    with sync_playwright() as p:
        browser=p.chromium.launch()
        for label,width in [('desktop',1440),('mobile',390)]:
            context=browser.new_context(viewport={'width':width,'height':950},is_mobile=width==390,has_touch=width==390)
            net=LocalNetwork();context.route('**/*',net.route)
            page=context.new_page();errors=[]
            page.on('pageerror',lambda e:errors.append(str(e)))
            page.on('dialog',lambda d:d.accept())
            net.hold_status=True
            page.goto(f'http://127.0.0.1:{server.server_port}/',wait_until='load')
            page.locator('#apiStatus').click();page.locator('#apiKey').fill('mock-not-a-real-key')
            page.locator('button[onclick="saveAndCloseModal()"]').click();page.locator('#apiModal').wait_for(state='hidden')
            net.hold_status=False;net.release_status()
            page.wait_for_function("document.getElementById('codexStatus').textContent.includes('已連接')")
            check(label+' late connection check cannot overwrite provider saved without changing selector',page.evaluate("!CodexLocal.selected() && localStorage.aiProvider==='deepseek'"))
            page.evaluate("localStorage.removeItem('aiProvider');sessionStorage.removeItem('deepseekApiKey')")
            page.reload(wait_until='networkidle')
            page.wait_for_function("CodexLocal.selected()")
            check(label+' detects available local subscription without API key',page.locator('#apiKey').input_value()=='' and 'Codex' in page.locator('#apiStatus').inner_text())
            page.locator('#apiStatus').click()
            page.evaluate('TripMotion.settle()')
            check(label+' shows local login state and hides API key',page.locator('#codexSettings').is_visible() and not page.locator('#apiKey').is_visible() and '已連接' in page.locator('#codexStatus').inner_text())
            check(label+' connection settings fit the viewport',not overflow(page)['overflow'])
            page.screenshot(path=str(ARTIFACTS/f'codex-settings-{label}.png'))
            page.locator('button[onclick="saveAndCloseModal()"]').click()
            page.locator('#apiModal').wait_for(state='hidden')
            page.locator('#city').fill('台北')
            page.locator('#flightArrival').fill(START+'T08:00')
            page.locator('#flightDeparture').fill(END+'T20:00')
            page.locator('#lodgingSection > summary').click();page.locator('#hasHotel').uncheck()
            page.locator('#planBtn').click();page.wait_for_function('!isBusy && tripData.length===2')
            check(label+' whole book generates through Codex only',len(net.calls)==2 and not net.ai_requests and all(list(body)==['prompt'] for body in net.calls))
            check(label+' book opens first page and completes progress',page.locator('#tripContainer > details:visible').get_attribute('data-date')==START and '100%' in page.locator('#operationText').inner_text())
            check(label+' API credentials never stored for Codex',page.evaluate("!localStorage.deepseekApiKey && !sessionStorage.deepseekApiKey && localStorage.aiProvider==='codex'"))
            page.locator('#undoTrip').click();page.wait_for_function('!isBusy && tripData.length===0')
            check(label+' Codex generation supports whole-book undo',page.locator('#undoTrip').is_disabled())
            net.hold=True;page.locator('#planBtn').click();page.wait_for_function('isBusy')
            page.wait_for_timeout(100)
            check(label+' provider cannot change during generation',page.locator('#aiProvider').is_disabled())
            page.locator('#cancelOperation').click();page.wait_for_function('!isBusy')
            net.hold=False;net.release();page.wait_for_timeout(100)
            check(label+' cancellation ignores late Codex response',page.evaluate('tripData.length===0'))
            net.fail=True;page.locator('#retryOperation').click();page.wait_for_function('!isBusy')
            check(label+' failure is visible and never falls back to paid DeepSeek',not net.ai_requests and 'Codex 額度測試失敗' in page.locator('#operationText').inner_text())
            net.fail=False;page.locator('#retryOperation').click();page.wait_for_function('!isBusy && tripData.length===2')
            check(label+' retry still completes the full book',page.locator('#bookNext').is_enabled())
            page.reload(wait_until='networkidle')
            check(label+' selected provider and completed book survive reload',page.evaluate('CodexLocal.selected() && tripData.length===2'))
            page.locator('#settingsTab').click();page.locator('#apiStatus').click()
            page.locator('#aiProvider').select_option('deepseek')
            check(label+' DeepSeek remains selectable with its original settings',page.locator('#apiKey').is_visible() and not page.locator('#codexSettings').is_visible())
            page.locator('#apiKey').fill('mock-not-a-real-key')
            page.locator('button[onclick="saveAndCloseModal()"]').click();page.locator('#apiModal').wait_for(state='hidden')
            calls=len(net.calls);page.locator('#planBtn').click();page.wait_for_function('!isBusy && tripData.length===2')
            check(label+' explicit DeepSeek selection routes only to DeepSeek',len(net.ai_requests)==2 and len(net.calls)==calls)
            page.reload(wait_until='networkidle')
            check(label+' available Codex never overrides saved DeepSeek selection',not page.evaluate('CodexLocal.selected()'))
            page.locator('#settingsTab').click();page.locator('#apiStatus').click()
            page.locator('#aiProvider').select_option('codex')
            page.locator('button[onclick="saveAndCloseModal()"]').click();page.locator('#apiModal').wait_for(state='hidden')
            net.ready=False;page.reload(wait_until='networkidle')
            page.locator('#settingsTab').click();saved=page.evaluate('JSON.stringify(tripData)');calls=len(net.calls)
            page.locator('#planBtn').click();page.wait_for_function('!isBusy')
            check(label+' missing login preserves trip and calls neither provider',page.evaluate('JSON.stringify(tripData)')==saved and len(net.calls)==calls and len(net.ai_requests)==2 and '請登入 ChatGPT' in page.locator('#operationText').inner_text())
            check(label+' responsive layout fits viewport',not overflow(page)['overflow'])
            check(label+' no uncaught errors',not errors)
            context.close()
        browser.close()
    server.shutdown()
    report={'checks':checks,'passed':all(c['passed'] for c in checks)}
    (ARTIFACTS/'codex-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(report,ensure_ascii=False,indent=2))


if __name__=='__main__':main()
