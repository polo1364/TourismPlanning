"""Exercise real UI flows with deterministic network responses and isolated storage."""
import json
import sys
import threading
import traceback
from functools import partial
from http.server import ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright
from browser_smoke import ROOT, ARTIFACTS, Handler, Network, START, END, sample_day, overflow, workspace_view

KEY='tourismTrips_v1'

def main():
    sys.stdout.reconfigure(encoding='utf-8')
    server=ThreadingHTTPServer(('127.0.0.1',0),partial(Handler,directory=str(ROOT)))
    threading.Thread(target=server.serve_forever,daemon=True).start()
    checks, failures=[],[]
    def check(name, result):
        checks.append({'name':name,'passed':bool(result)})
        assert result,name
    legacy={'i':{'city':'台北','flightArrival':START+'T08:00','flightDeparture':END+'T20:00','hasHotel':False,'transport':'自駕'},'t':[sample_day()], 'g':{'city':'台北','flightArr':START+'T08:00','flightDep':END+'T20:00','tags':[],'transport':'自駕'}}
    try:
        with sync_playwright() as p:
            browser=p.chromium.launch()
            for label,width in [('desktop',1440),('mobile',390)]:
                context=browser.new_context(viewport={'width':width,'height':950},timezone_id='Asia/Taipei',accept_downloads=True)
                network=Network(); context.route('**/*',network.route)
                context.add_init_script("""window.testNow='2026-11-10T02:00:00Z'; const RealDate=Date; window.Date=class extends RealDate {constructor(...a){super(...(a.length?a:[window.testNow]));} static now(){return new RealDate(window.testNow).getTime();}}; sessionStorage.setItem('deepseekApiKey','mock-not-a-real-key');""")
                context.add_init_script("""if(!localStorage.testSeeded){const data=PAYLOAD;localStorage.setItem('tripDraft_v27',JSON.stringify(data.i));localStorage.setItem('myTrip_v27',JSON.stringify(data.t));localStorage.setItem('generationState_v27',JSON.stringify(data.g));localStorage.testSeeded='true';}""".replace('PAYLOAD',json.dumps(legacy,ensure_ascii=False)))
                page=context.new_page(); page.set_default_timeout(12000)
                errors=[]; page.on('pageerror',lambda e:errors.append(str(e))); page.on('dialog',lambda d:d.accept())
                def management():
                    if not page.locator('#libraryManagement').evaluate('el=>el.open'): page.locator('#libraryManagement > summary').click()
                def name_action(action, name, reload=True):
                    if action!='new': management()
                    page.locator(f'#tripLibrary button[onclick="TripLibrary.openName(\'{action}\')"]').click()
                    page.locator('#tripName').fill(name)
                    if reload:
                        with page.expect_navigation(wait_until='load'): page.locator('#tripNameForm button').click()
                    else:
                        page.locator('#tripNameForm button').click(); page.locator('#tripNameModal').wait_for(state='hidden')
                def select(trip_id):
                    with page.expect_navigation(wait_until='load'): page.locator('#tripSelect').select_option(trip_id)
                    page.wait_for_function('!isBusy')
                def edit_title(title):
                    page.locator('.stop-edit').first.click(); page.locator('#stop_title').fill(title)
                    page.locator('#stopForm button').click(); page.wait_for_function('!isBusy'); page.locator('#stopModal').wait_for(state='hidden')
                try:
                    page.goto(f'http://127.0.0.1:{server.server_port}/',wait_until='networkidle')
                    page.wait_for_selector('#generateNextDayBtn')
                    source=page.locator('#tripSelect').input_value()
                    check(label+' migrates existing trip and continuation',page.locator('#tripSelect option').count()==1 and page.evaluate('tripData.length===1 && generationState.startDate instanceof Date'))
                    name_action('rename','台北慢遊',False)
                    check(label+' rename persists',page.evaluate("JSON.parse(localStorage.tourismTrips_v1).trips[0].name==='台北慢遊'"))
                    edit_title('編輯後的公園')
                    check(label+' edit creates Undo',page.locator('#undoTrip').is_enabled())
                    page.reload(wait_until='networkidle'); page.locator('#undoTrip').click(); page.wait_for_function('!isBusy')
                    check(label+' Undo survives reload and restores original stop',page.evaluate("tripData[0].itinerary[0].title==='大稻埕街區'") and page.locator('#undoTrip').is_disabled())
                    page.locator('#travelModeButton').click()
                    check(label+' journey shows today and first pending stop',page.locator('#journeyTitle').inner_text()=='今天的旅程' and '大稻埕街區' in page.locator('.journey-stop').first.inner_text())
                    query=parse_qs(urlparse(page.locator('.journey-stop a').first.get_attribute('href')).query)
                    check(label+' navigation includes destination and driving mode',query['travelmode']==['driving'] and '大稻埕街區' in query['destination'][0])
                    page.locator('.journey-checklist input').first.check()
                    check(label+' completion advances current stop',page.locator('.journey-stop').count()==1 and '在地小吃午餐' in page.locator('.journey-stop').inner_text())
                    page.locator('.journey-checklist input').nth(1).check()
                    check(label+' all done state has no fake next stop',page.locator('.journey-finished').is_visible() and page.locator('.journey-stop').count()==0)
                    page.locator('#undoTrip').click(); page.wait_for_function('!isBusy')
                    check(label+' Undo completion restores previous pending stop',not page.locator('.journey-checklist input').nth(1).is_checked() and page.locator('.journey-checklist input').first.is_checked())
                    page.reload(wait_until='networkidle')
                    check(label+' travel mode and checks survive reload',page.locator('#journeyPanel').is_visible() and page.locator('.journey-checklist input').first.is_checked())
                    page.evaluate("window.testNow='2026-12-01T02:00:00Z'")
                    page.locator('#journeyPanel button[onclick="TripLibrary.chooseDate(\'\')"]').click()
                    check(label+' outside trip dates is explicitly a preview',page.locator('#journeyTitle').inner_text()=='旅程預覽')
                    page.evaluate("window.testNow='2026-11-10T02:00:00Z'")
                    page.locator('#journeyPanel button[onclick="TripLibrary.chooseDate(\'\')"]').click()
                    page.evaluate('window.scrollTo(0,0)')
                    page.screenshot(path=str(ARTIFACTS/f'journeys-travel-{label}.png'),full_page=True)
                    page.locator('#travelModeButton').click()
                    name_action('duplicate','台北副本')
                    duplicate=page.locator('#tripSelect').input_value()
                    check(label+' duplicate has independent identity and fresh completion',duplicate!=source and page.evaluate('tripData.length===1 && TripLibrary.progress().done.length===0') and page.locator('#undoTrip').is_disabled())
                    edit_title('副本專屬景點')
                    select(source)
                    check(label+' editing copy leaves source unchanged',page.evaluate("tripData[0].itinerary[0].title==='大稻埕街區' && TripLibrary.progress().done.length===1"))
                    network.hold_ai=True
                    original=page.evaluate('JSON.stringify(tripData)')
                    page.locator('#generateNextDayBtn').click(); page.wait_for_timeout(100)
                    check(label+' pending AI locks switching and Undo',page.locator('#tripSelect').is_disabled() and page.locator('#undoTrip').is_disabled())
                    page.evaluate('id=>TripLibrary.select(id)',duplicate)
                    check(label+' guarded switching cannot change pending trip',page.locator('#tripSelect').input_value()==source)
                    page.locator('#cancelOperation').click(); page.wait_for_function('!isBusy'); network.hold_ai=False; network.release_ai()
                    check(label+' cancelling generation keeps trip and completion',page.evaluate('JSON.stringify(tripData)')==original and page.evaluate('TripLibrary.progress().done.length===1'))
                    page.locator('#generateNextDayBtn').click(); page.wait_for_function('!isBusy && tripData.length===2')
                    page.locator('#undoTrip').click(); page.wait_for_function('!isBusy')
                    check(label+' Undo next-day generation restores continuation',page.evaluate('tripData.length===1 && generationState.startDate instanceof Date') and page.locator('#generateNextDayBtn').is_visible())
                    page.locator('#generateNextDayBtn').click(); page.wait_for_function('!isBusy && tripData.length===2')
                    check(label+' can generate next day after Undo',page.evaluate('tripData[1].date')==END)
                    workspace_view(page,'settings')
                    with page.expect_navigation(wait_until='load'): page.locator('button[onclick="clearAll()"]').click()
                    check(label+' clear affects only active trip',page.evaluate('tripData.length===0') and page.locator('#tripSelect option').count()==2 and page.locator('#undoTrip').is_enabled())
                    page.locator('#undoTrip').click(); page.wait_for_function('!isBusy && tripData.length===2')
                    check(label+' Undo clear restores settings and checkmarks',page.locator('#city').input_value()=='台北' and page.evaluate('TripLibrary.progress().done.length===1'))
                    name_action('new','東京草稿')
                    draft=page.locator('#tripSelect').input_value()
                    check(label+' new trip is blank and keeps other trips',page.locator('#city').input_value()=='' and page.evaluate('tripData.length===0') and page.locator('#tripSelect option').count()==3)
                    page.locator('#city').fill('東京')
                    select(source); select(draft)
                    check(label+' draft settings isolated across switches',page.locator('#city').input_value()=='東京')
                    select(source)
                    management()
                    with page.expect_download() as download: page.locator('#tripLibrary button[onclick="TripLibrary.exportAll()"]').click()
                    backup_path=ARTIFACTS/f'journeys-backup-{label}.json'; download.value.save_as(str(backup_path))
                    backup=json.loads(backup_path.read_text(encoding='utf-8'))
                    check(label+' whole-library backup contains all trips without credentials',len(backup['trips'])==3 and 'mock-not-a-real-key' not in json.dumps(backup) and backup['trips'][0]['data']['p']['done'])
                    before=page.evaluate('localStorage.tourismTrips_v1')
                    page.evaluate("() => {window.realSetItem=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k==='tourismTrips_v1')throw new Error('quota');return realSetItem.call(this,k,v)}}")
                    page.locator('#tripLibrary button[onclick="TripLibrary.openName(\'new\')"]').click()
                    page.locator('#tripName').fill('不應新增'); page.locator('#tripNameForm button').click()
                    check(label+' failed creation preserves active trip and library',page.locator('#tripNameModal').is_visible() and '無法儲存' in page.locator('#tripNameError').inner_text() and page.evaluate('localStorage.tourismTrips_v1')==before)
                    page.evaluate('() => {Storage.prototype.setItem=realSetItem}')
                    page.locator('#tripNameModal .modal-close').click(); page.locator('#tripNameModal').wait_for(state='hidden')
                    other=context.new_page(); other.on('dialog',lambda d:d.accept())
                    other.goto(f'http://127.0.0.1:{server.server_port}/',wait_until='networkidle')
                    other.evaluate("TripLibrary.openName('rename');document.getElementById('tripName').value='另一分頁更新';document.getElementById('tripNameForm').requestSubmit()")
                    page.wait_for_function("document.getElementById('libraryError').textContent.includes('另一個分頁')")
                    result=page.evaluate("() => {try{saveInputs();return '';}catch(e){return e.message;}}")
                    check(label+' stale tab cannot overwrite other tab', '另一個分頁' in result and page.evaluate("JSON.parse(localStorage.tourismTrips_v1).trips[0].name==='另一分頁更新'"))
                    other.close(); page.reload(wait_until='networkidle')
                    with page.expect_navigation(wait_until='load'): page.locator('#importFile').set_input_files(str(backup_path))
                    check(label+' collection import adds without replacing originals',page.locator('#tripSelect option').count()==6 and page.evaluate(f"JSON.parse(localStorage.tourismTrips_v1).trips.some(t=>t.id==={json.dumps(source)})"))
                    imported=page.locator('#tripSelect').input_value()
                    check(label+' imported travel checks retained',page.evaluate('TripLibrary.progress().done.length===1'))
                    with page.expect_navigation(wait_until='load'):
                        page.locator('#importFile').set_input_files({'name':'legacy.json','mimeType':'application/json','buffer':json.dumps(legacy,ensure_ascii=False).encode('utf-8')})
                    check(label+' legacy import affects only selected trip and resets checks',page.locator('#tripSelect option').count()==6 and page.locator('#tripSelect').input_value()==imported and page.evaluate('TripLibrary.progress().done.length===0'))
                    page.locator('#undoTrip').click(); page.wait_for_function('!isBusy')
                    check(label+' Undo import restores previous trip and completion',page.evaluate('tripData.length===2 && TripLibrary.progress().done.length===1'))
                    management()
                    with page.expect_navigation(wait_until='load'): page.locator('#removeTrip').click()
                    check(label+' removing selected copy retains original trips',page.locator('#tripSelect option').count()==5 and page.locator('#tripSelect').input_value()==source)
                    for test_width in ([320,760,900,1440] if label=='mobile' else [1440]):
                        page.set_viewport_size({'width':test_width,'height':950})
                        page.evaluate("PlannerUI.switchView('itinerary',false)")
                        check(f'{label} {test_width} library no overflow',not overflow(page)['overflow'])
                        page.locator('#travelModeButton').click()
                        check(f'{label} {test_width} travel no overflow',not overflow(page)['overflow'])
                        page.locator('#travelModeButton').click()
                    page.set_viewport_size({'width':width,'height':950}); page.evaluate('window.scrollTo(0,0)')
                    page.screenshot(path=str(ARTIFACTS/f'journeys-library-{label}.png'),full_page=True)
                    check(label+' no uncaught browser errors',not errors)
                except Exception as err:
                    failures.append({'viewport':label,'error':str(err),'trace':traceback.format_exc(),'page_errors':errors})
                    page.screenshot(path=str(ARTIFACTS/f'journeys-failure-{label}.png'),full_page=True)
                finally: context.close()
            browser.close()
    finally: server.shutdown()
    report={'checks':checks,'failures':failures,'passed':not failures and all(c['passed'] for c in checks)}
    (ARTIFACTS/'journeys-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(report,ensure_ascii=False,indent=2))
    return 0 if report['passed'] else 1

if __name__=='__main__': raise SystemExit(main())
