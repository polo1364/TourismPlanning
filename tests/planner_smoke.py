"""Deterministic interaction checks for workspace, editing, cancellation and reviews."""
import json
import sys
import threading
import traceback
from functools import partial
from http.server import ThreadingHTTPServer
from playwright.sync_api import sync_playwright
from browser_smoke import Handler, Network, ROOT, ARTIFACTS, sample_day, START, END, overflow


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory=str(ROOT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    checks, failures = [], []
    def check(name, value):
        checks.append({'name': name, 'passed': bool(value)})
        assert value, name
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            for label, width in [('desktop', 1440), ('mobile', 390)]:
                context = browser.new_context(viewport={'width': width, 'height': 900}, timezone_id='Asia/Taipei')
                context.add_init_script("localStorage.setItem('roamReadingMode','continuous')")
                network = Network()
                context.route('**/*', network.route)
                page = context.new_page()
                errors = []
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.on('dialog', lambda dialog: dialog.accept())
                def view(name):
                    page.locator(f'#{name}Tab').click()
                try:
                    page.goto(f'http://127.0.0.1:{server.server_port}/', wait_until='networkidle')
                    page.evaluate("document.getElementById('apiKey').value='mock-not-a-real-key'")
                    check(label + ' optional sections collapsed', not page.locator('#lodgingSection').evaluate('el=>el.open') and not page.locator('#preferencesSection').evaluate('el=>el.open'))
                    check(label + ' essential fields usable', page.locator('#city').is_visible() and page.locator('#flightArrival').is_visible())
                    if width < 761:
                        view('itinerary')
                        check(label + ' itinerary tab hides settings', not page.locator('#city').is_visible() and page.locator('#placeholderMsg').is_visible())
                        view('settings')
                    page.locator('#city').fill('台北')
                    page.locator('#flightArrival').fill(START+'T08:00')
                    page.locator('#flightDeparture').fill(END+'T19:00')
                    page.locator('#budget').fill('100')
                    page.locator('#planBtn').click()
                    check(label + ' missing lodging reveals required input', page.locator('#hotel').is_visible() and page.evaluate("document.activeElement.id==='hotel'") and len(network.ai_requests)==0)
                    page.locator('#hasHotel').uncheck()
                    page.evaluate('window.scrollTo(0, 0)')
                    page.screenshot(path=str(ARTIFACTS/f'planner-settings-{label}.png'), full_page=True)
                    # Start at a partial checkpoint for editor and continuation regressions.
                    page.evaluate('() => { void planTrip(); }')
                    page.wait_for_function('tripData.length===1 && !isBusy')
                    check(label + ' generate switches to itinerary', page.locator('#tripContainer > details').is_visible())
                    page.locator('#tripReview summary').click()
                    check(label + ' check shows missing data and over budget', '超出旅程預算' in page.locator('#tripReview').inner_text() and '尚無法檢查' in page.locator('#tripReview').inner_text())
                    page.locator('#reviewBudget').fill('300')
                    page.locator('#reviewBudgetForm button').click()
                    page.wait_for_function('!isBusy && generationState.budget===300')
                    check(label + ' budget updates without regenerating trip', len(network.ai_requests)==1 and '超出旅程預算' not in page.locator('#tripReview').inner_text() and page.evaluate("JSON.parse(localStorage.generationState_v27).budget===300 && JSON.parse(localStorage.tripDraft_v27).budget==='300'"))
                    check(label + ' timeline keeps duration without repeating the next title', page.locator('.next-stop').count()==0 and '待補' in page.locator('.stop-meta').first.inner_text())
                    page.locator('.stop-edit').first.click()
                    page.locator('#stop_title').fill('編輯後景點')
                    page.locator('#stop_endTime').fill('08:00')
                    page.locator('#stopForm button[type=submit]').click()
                    check(label + ' invalid timing rejected before saving', '結束時間須晚於' in page.locator('#stop_error').inner_text() and page.evaluate("tripData[0].itinerary[0].title!=='編輯後景點'"))
                    page.locator('#stop_endTime').fill('12:30')
                    page.locator('#stop_cost').fill('150')
                    page.locator('#stopForm button[type=submit]').click()
                    page.wait_for_function("!isBusy && tripData[0].itinerary[0].title==='編輯後景點'")
                    page.locator('#stopModal').wait_for(state='hidden')
                    check(label + ' save returns focus to the edited stop', page.evaluate("document.activeElement.classList.contains('stop-edit')"))
                    check(label + ' edit updates persistence and continuation', page.evaluate("JSON.parse(localStorage.myTrip_v27)[0].itinerary[0].endTime==='12:30' && generationState.allVisitedSpots.includes('編輯後景點')"))
                    check(label + ' overlap detected', '時間重疊' in page.locator('#tripReview').inner_text())
                    page.locator('.stop-edit').first.click()
                    page.locator('#moveDown').click()
                    page.wait_for_function("!isBusy && tripData[0].itinerary[1].title==='編輯後景點'")
                    check(label + ' reorder clears stale routes and retains times', page.evaluate("tripData[0].itinerary.every(i=>i.transit.length===0 && i.travelMinutes===undefined) && tripData[0].itinerary[1].time==='09:00'"))
                    page.locator('#stopModal .modal-close').click()
                    page.locator('#stopModal').wait_for(state='hidden')
                    check(label + ' reorder preserves editor return focus', page.evaluate("document.activeElement.classList.contains('stop-edit')"))
                    page.locator('.stop-edit').first.click()
                    # The UI must preserve user data if browser storage refuses the edit.
                    before = page.evaluate('JSON.stringify(tripData)')
                    page.evaluate("() => { window.originalSetItem=Storage.prototype.setItem; Storage.prototype.setItem=function(k,v){if(k==='myTrip_v27')throw new Error('quota');return originalSetItem.call(this,k,v)}; }")
                    page.locator('#stop_title').fill('不應存下的變更')
                    page.locator('#stopForm button[type=submit]').click()
                    page.wait_for_function("!isBusy && document.getElementById('stop_error').textContent.includes('無法儲存')")
                    check(label + ' failed edit rolls back memory and DOM', page.evaluate('JSON.stringify(tripData)')==before and '不應存下的變更' not in page.locator('#tripContainer').inner_text())
                    page.evaluate('() => { Storage.prototype.setItem=originalSetItem; }')
                    page.locator('#stopModal .modal-close').click()
                    page.locator('#stopModal').wait_for(state='hidden')
                    page.locator('.stop-edit').first.click()
                    page.locator('#stopModal details > summary').click()
                    page.locator('#stop_replaceInstruction').fill('換成室內展覽')
                    network.result_override={'invalid':'no single item'}
                    before=page.evaluate('JSON.stringify(tripData)')
                    page.locator('#stopModal details button').click()
                    page.wait_for_function('!isBusy')
                    check(label + ' malformed replacement keeps all original stops', page.evaluate('JSON.stringify(tripData)')==before and page.locator('#retryOperation').is_visible())
                    network.result_override={'item':{'title':'室內展覽','type':'SPOT','desc':'室內活動','address':'台北','cost':'200'}}
                    other = page.evaluate('JSON.stringify(tripData[0].itinerary[1])')
                    page.locator('#retryOperation').click()
                    page.wait_for_function("!isBusy && tripData[0].itinerary[0].title==='室內展覽'")
                    check(label + ' AI replaces one stop only and preserves time', page.evaluate('JSON.stringify(tripData[0].itinerary[1])')==other and page.evaluate('tripData[0].itinerary[0].time')=='12:00')
                    network.result_override=None
                    page.locator('.stop-edit').first.click()
                    page.locator('#deleteStop').click()
                    page.wait_for_function('!isBusy && tripData[0].itinerary.length===1')
                    page.locator('#stopModal').wait_for(state='hidden')
                    check(label + ' delete updates continuation', page.evaluate("generationState.allVisitedSpots.length===1 && !generationState.allVisitedSpots.includes('室內展覽')"))
                    page.locator('.stop-edit').first.click()
                    check(label + ' cannot delete last stop', page.locator('#deleteStop').is_disabled())
                    page.locator('#stopModal .modal-close').click()
                    page.locator('#stopModal').wait_for(state='hidden')
                    before = page.evaluate('JSON.stringify(tripData)')
                    network.hold_ai=True
                    calls=len(network.ai_requests)
                    page.locator('#generateNextDayBtn').click()
                    page.wait_for_function('isBusy')
                    page.wait_for_timeout(100)
                    check(label + ' pending progress keeps completed day visible', page.locator('#tripContainer > details').is_visible() and '已儲存 1 / 2' in page.locator('#operationText').inner_text())
                    page.locator('#cancelOperation').click()
                    page.wait_for_function('!isBusy')
                    check(label + ' cancellation preserves trip and enables retry', page.evaluate('JSON.stringify(tripData)')==before and page.locator('#retryOperation').is_visible())
                    network.hold_ai=False
                    network.release_ai()
                    page.wait_for_timeout(100)
                    check(label + ' late response after cancellation cannot commit', page.evaluate('JSON.stringify(tripData)')==before)
                    network.fail_ai=True
                    page.locator('#retryOperation').click()
                    page.wait_for_function('!isBusy')
                    check(label + ' failed retry retains original days', page.evaluate('JSON.stringify(tripData)')==before and page.locator('#retryOperation').is_visible())
                    network.fail_ai=False
                    page.locator('#retryOperation').click()
                    page.wait_for_function('!isBusy && tripData.length===2')
                    check(label + ' retry generates only missing day', len(network.ai_requests)==calls+3 and page.evaluate('JSON.stringify(tripData.slice(0,1))')==before)
                    check(label + ' completed progress accurate', '已完成 2 / 2' in page.locator('#operationText').inner_text())
                    # Cancelling a fresh plan must preserve the previous full trip as well.
                    view('settings')
                    before=page.evaluate('JSON.stringify(tripData)')
                    network.hold_ai=True
                    page.locator('#planBtn').click()
                    page.wait_for_timeout(100)
                    check(label + ' fresh plan keeps old cards while pending', page.locator('#tripContainer > details').count()==2)
                    page.locator('#cancelOperation').click()
                    page.wait_for_function('!isBusy')
                    network.hold_ai=False
                    network.release_ai()
                    check(label + ' fresh cancellation restores old trip', page.evaluate('JSON.stringify(tripData)')==before)
                    network.hold_ai=True
                    page.locator('#tripContainer .btn-modify').first.click()
                    page.locator('#modifyInstruction').fill('改成上午室內行程')
                    page.locator('#modifyModal button[onclick="submitModification()"]').click()
                    page.wait_for_timeout(100)
                    page.locator('#cancelOperation').click()
                    page.wait_for_function('!isBusy')
                    network.hold_ai=False
                    network.release_ai()
                    check(label + ' cancelling whole-day edit preserves saved content', page.evaluate('JSON.stringify(tripData)')==before and page.evaluate('localStorage.myTrip_v27')==before)
                    check(label + ' no horizontal overflow', not overflow(page)['overflow'])
                    page.reload(wait_until='networkidle')
                    check(label + ' edits and timing survive reload', page.evaluate("tripData[0].itinerary[0].title==='編輯後景點' && tripData[0].itinerary[0].endTime==='12:30'"))
                    check(label + ' backup validation retains timing and budget', page.evaluate("() => {const backup=validateBackup({version:2,i:JSON.parse(localStorage.tripDraft_v27),t:tripData,g:generationState}); return backup.t[0].itinerary[0].endTime==='12:30' && backup.g.budget===300; }"))
                    if label=='mobile':
                        for test_width in [320, 760, 768, 900, 1440]:
                            page.set_viewport_size({'width':test_width,'height':900})
                            for panel in ['settings','itinerary']:
                                page.evaluate('panel => PlannerUI.switchView(panel, false)', panel)
                                check(f'width {test_width}: {panel} no overflow', not overflow(page)['overflow'])
                        page.set_viewport_size({'width':390,'height':900})
                        page.locator('.stop-edit').first.click()
                        page.wait_for_function("document.getElementById('stopModal').getAnimations({subtree:true}).every(a=>a.playState!=='running')")
                        check('mobile editor stays within viewport', not overflow(page)['overflow'])
                        page.screenshot(path=str(ARTIFACTS/'planner-editor-mobile.png'))
                        page.locator('#stopModal .modal-close').click()
                        page.locator('#stopModal').wait_for(state='hidden')
                    page.evaluate('window.scrollTo(0, 0)')
                    page.screenshot(path=str(ARTIFACTS/f'planner-itinerary-{label}.png'), full_page=True)
                    check(label + ' no uncaught errors', not errors)
                except Exception as error:
                    failures.append({'viewport':label,'error':str(error),'trace':traceback.format_exc(),'page_errors':errors})
                    page.screenshot(path=str(ARTIFACTS/f'planner-failure-{label}.png'), full_page=True)
                finally:
                    context.close()
            browser.close()
    finally:
        server.shutdown()
    report={'checks':checks,'failures':failures,'passed':not failures and all(c['passed'] for c in checks)}
    (ARTIFACTS/'planner-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(report,ensure_ascii=False,indent=2))
    return 0 if report['passed'] else 1

if __name__=='__main__':
    raise SystemExit(main())
