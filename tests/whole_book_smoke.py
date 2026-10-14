"""Full book generation uses actual UI clicks, isolated storage and deterministic APIs."""
import json
import re
import threading
from functools import partial
from http.server import ThreadingHTTPServer
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright
from browser_smoke import ROOT, ARTIFACTS, Handler, Network, START, sample_day, overflow


class BookNetwork(Network):
    def __init__(self):
        super().__init__()
        self.hold_day = None
        self.fail_day = None
        self.days = []
        self.prompts = []
        self.pending_books = []

    def route(self, route):
        if urlparse(route.request.url).hostname != 'api.deepseek.com':
            return super().route(route)
        body = route.request.post_data_json
        prompt = body['messages'][-1]['content']
        day = int(re.search(r'第\s*(\d+)\s*天', prompt).group(1))
        self.days.append(day)
        self.prompts.append(prompt)
        result = sample_day(title=f'第 {day} 天的旅程')
        result['itinerary'][0]['title'] = f'第{day}天獨有景點'
        result['itinerary'][1]['title'] = f'第{day}天特色餐廳'
        payload = {'choices':[{'finish_reason':'stop','message':{'content':json.dumps(result,ensure_ascii=False)}}]}
        if self.fail_day == day:
            return route.fulfill(status=503,content_type='application/json',body='{"error":{"message":"Mock unavailable"}}')
        if self.hold_day == day:
            self.pending_books.append((route,payload))
            return
        route.fulfill(status=200,content_type='application/json',body=json.dumps(payload))

    def release(self):
        pending, self.pending_books = self.pending_books, []
        for route,payload in pending:
            route.fulfill(status=200,content_type='application/json',body=json.dumps(payload))


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
            context.add_init_script("sessionStorage.setItem('deepseekApiKey','mock-not-a-real-key')")
            net=BookNetwork();context.route('**/*',net.route)
            page=context.new_page();errors=[]
            page.on('pageerror',lambda e:errors.append(str(e)))
            page.on('dialog',lambda d:d.accept())
            page.goto(f'http://127.0.0.1:{server.server_port}/',wait_until='networkidle')
            page.locator('#customPrefs').fill('三天放慢步調，不走太多階梯')
            page.locator('#city').fill('台北')
            page.locator('#flightArrival').fill(START+'T08:00')
            page.locator('#flightDeparture').fill('2026-11-12T20:00')
            page.locator('#lodgingSection > summary').click()
            page.locator('#hasHotel').uncheck()
            net.hold_day=2
            page.locator('#planBtn').click()
            page.wait_for_function("isBusy && tripData.length===1 && document.getElementById('dayProgress').value===1")
            page.wait_for_function("document.getElementById('operationText').textContent.includes('2 / 3')")
            check(label+' one click automatically requests second day',net.days==[1,2])
            check(label+' progress counts saved days',page.locator('#dayProgress').get_attribute('max')=='3' and '33%' in page.locator('#operationText').inner_text())
            check(label+' first day persisted while next request waits',page.evaluate('JSON.parse(localStorage.myTrip_v27).length===1'))
            check(label+' lock stays active across days',page.locator('#planBtn').is_disabled() and page.locator('#tripSelect').is_disabled() and page.locator('#undoTrip').is_disabled())
            page.evaluate('planTrip(true);finishBook();generateNextDay()')
            check(label+' duplicate entry points cannot start extra requests',net.days==[1,2])
            page.locator('#operationStatus').scroll_into_view_if_needed()
            page.screenshot(path=str(ARTIFACTS/f'whole-book-progress-{label}.png'))
            net.hold_day=None;net.release()
            page.wait_for_function('!isBusy && tripData.length===3')
            check(label+' all dates are generated once in order',net.days==[1,2,3] and page.evaluate("tripData.map(d=>d.date).join(',')==='2026-11-10,2026-11-11,2026-11-12'"))
            check(label+' later days receive prior places and original preferences','第1天獨有景點' in net.prompts[1] and '第2天特色餐廳' in net.prompts[2] and all('不走太多階梯' in prompt for prompt in net.prompts))
            check(label+' completed book opens first chapter',page.locator('#tripContainer > details:visible').get_attribute('data-date')==START and page.locator('#itineraryPanel').is_visible())
            check(label+' completion shows 100 percent',page.locator('#dayProgress').get_attribute('value')=='3' and '100%' in page.locator('#operationText').inner_text() and page.locator('#generateNextDayBtn').count()==0)
            page.locator('#bookNext').click()
            check(label+' completed book can be paged immediately',page.locator('#tripContainer > details:visible').get_attribute('data-date')=='2026-11-11')
            page.locator('#undoTrip').click();page.wait_for_function('!isBusy')
            check(label+' whole generation is one undo step',page.evaluate('tripData.length===0') and page.locator('#undoTrip').is_disabled())
            # Failure stops the sequence and reload can resume from its persisted checkpoint.
            page.locator('#settingsTab').click();net.fail_day=2
            calls=len(net.days);page.locator('#planBtn').click();page.wait_for_function('!isBusy && tripData.length===1')
            check(label+' second-day failure stops without day three',net.days[calls:]==[1,2] and page.locator('#retryOperation').is_visible())
            check(label+' failure retains resumable state',page.evaluate('JSON.parse(localStorage.myTrip_v27).length===1 && JSON.parse(localStorage.generationState_v27).totalDays===3'))
            net.fail_day=None;page.locator('#settingsTab').click()
            page.locator('#planBtn').click();page.wait_for_function('!isBusy && tripData.length===3')
            page.locator('#undoTrip').click();page.wait_for_function('!isBusy')
            check(label+' identical first-day regeneration still captures a new batch undo',page.evaluate('tripData.length===1'))
            page.reload(wait_until='networkidle');net.fail_day=None;calls=len(net.days)
            page.locator('#generateNextDayBtn').click();page.wait_for_function('!isBusy && tripData.length===3')
            check(label+' reload resumes only unfinished days',net.days[calls:]==[2,3])
            page.locator('#undoTrip').click();page.wait_for_function('!isBusy')
            check(label+' resumed batch has one undo checkpoint',page.evaluate('tripData.length===1'))
            # Cancellation retains checkpoint and ignores the delayed provider response.
            net.hold_day=2;page.locator('#generateNextDayBtn').click()
            page.wait_for_function('isBusy')
            page.locator('#cancelOperation').click();page.wait_for_function('!isBusy')
            net.hold_day=None;net.release()
            page.wait_for_timeout(100)
            check(label+' cancelled continuation preserves first day',page.evaluate('tripData.length===1 && JSON.parse(localStorage.myTrip_v27).length===1'))
            calls=len(net.days);page.locator('#retryOperation').click();page.wait_for_function('!isBusy && tripData.length===3')
            check(label+' retry after cancellation completes remaining book',net.days[calls:]==[2,3])
            # A first-day failure while replacing a complete book must preserve the whole old book.
            saved=page.evaluate('JSON.stringify(tripData)');net.fail_day=1
            page.locator('#settingsTab').click();page.locator('#planBtn').click();page.wait_for_function('!isBusy')
            check(label+' first-day failure preserves previous complete book',page.evaluate('JSON.stringify(tripData)')==saved)
            net.fail_day=None;calls=len(net.days)
            page.locator('#retryOperation').click();page.wait_for_function('!isBusy && tripData.length===3')
            check(label+' retry of first day still completes the whole book',net.days[calls:]==[1,2,3])
            # A failed daily storage commit must roll back only that day and stop the loop.
            page.evaluate("""() => {
                window.originalSetItem=Storage.prototype.setItem;
                window.storageFaultFired=false;
                Storage.prototype.setItem=function(key,value) {
                    if (this===localStorage && key==='myTrip_v27' && !window.storageFaultFired && JSON.parse(value).length===2) {
                        window.storageFaultFired=true;
                        throw new DOMException('Injected full-book quota failure','QuotaExceededError');
                    }
                    return window.originalSetItem.call(this,key,value);
                };
            }""")
            page.locator('#settingsTab').click();calls=len(net.days)
            page.locator('#planBtn').click();page.wait_for_function('!isBusy && window.storageFaultFired')
            check(label+' failed storage stops at last saved day',net.days[calls:]==[1,2] and page.evaluate('tripData.length===1 && JSON.parse(localStorage.myTrip_v27).length===1'))
            page.evaluate('() => { Storage.prototype.setItem=window.originalSetItem; }')
            calls=len(net.days);page.locator('#retryOperation').click();page.wait_for_function('!isBusy && tripData.length===3')
            check(label+' storage failure retry resumes unfinished days',net.days[calls:]==[2,3])
            page.locator('#travelModeButton').click()
            check(label+' travel mode active before generating a new book',page.evaluate('TripLibrary.progress().enabled'))
            page.locator('#settingsTab').click();page.locator('#flightDeparture').fill(START+'T20:00')
            calls=len(net.days);page.locator('#planBtn').click();page.wait_for_function('!isBusy && tripData.length===1')
            check(label+' one-day book completes with one request',net.days[calls:]==[1] and '100%' in page.locator('#operationText').inner_text())
            check(label+' completed generation returns from travel mode to readable book',not page.evaluate('TripLibrary.progress().enabled') and page.locator('#bookNavigation').is_visible())
            page.locator('#settingsTab').click();page.locator('#flightDeparture').fill('2026-11-24T20:00')
            calls=len(net.days);page.locator('#planBtn').click();page.wait_for_function('!isBusy && tripData.length===15')
            check(label+' maximum book completes all fifteen ordered dates',net.days[calls:]==list(range(1,16)) and page.evaluate("new Set(tripData.map(d=>d.date)).size===15 && tripData[14].date==='2026-11-24'"))
            check(label+' maximum book opens first page at full progress',page.locator('#tripContainer > details:visible').get_attribute('data-date')==START and page.locator('#dayProgress').get_attribute('value')=='15')
            page.locator('#operationStatus').scroll_into_view_if_needed()
            page.screenshot(path=str(ARTIFACTS/f'whole-book-complete-{label}.png'))
            check(label+' layout fits viewport',not overflow(page)['overflow'])
            check(label+' no uncaught errors',not errors)
            context.close()
        browser.close()
    server.shutdown()
    report={'checks':checks,'passed':all(c['passed'] for c in checks)}
    (ARTIFACTS/'whole-book-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(report,ensure_ascii=False,indent=2))


if __name__=='__main__': main()
