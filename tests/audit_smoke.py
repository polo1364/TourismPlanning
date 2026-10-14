"""Cross-feature regression probes; isolated storage and no live AI requests."""
import json
import sys
import threading
from functools import partial
from http.server import ThreadingHTTPServer
from playwright.sync_api import sync_playwright
from browser_smoke import ROOT, ARTIFACTS, Handler, Network, START, END, sample_day, workspace_view, overflow


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory=str(ROOT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    checks = []
    def check(name, result):
        checks.append({'name': name, 'passed': bool(result)})
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for label, width in [('desktop', 1440), ('mobile', 390)]:
            context = browser.new_context(viewport={'width': width, 'height': 950}, timezone_id='Asia/Taipei')
            context.add_init_script("localStorage.setItem('roamReadingMode','continuous')")
            net = Network()
            context.route('**/*', net.route)
            legacy = {'i': {'city': '台北', 'hasHotel': False, 'flightArrival': START+'T08:00', 'flightDeparture': END+'T20:00'}, 't': [sample_day(), sample_day(END)], 'g': {'city': '台北', 'flightArr': START+'T08:00', 'flightDep': END+'T20:00', 'tags': []}}
            context.add_init_script("""if(!localStorage.seeded){const d=PAYLOAD;for(const [k,v] of Object.entries({tripDraft_v27:d.i,myTrip_v27:d.t,generationState_v27:d.g}))localStorage.setItem(k,JSON.stringify(v));localStorage.seeded='1';} sessionStorage.setItem('deepseekApiKey','mock-not-a-real-key');""".replace('PAYLOAD', json.dumps(legacy)))
            page = context.new_page()
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.on('dialog', lambda d: d.accept())
            page.goto(f'http://127.0.0.1:{server.server_port}/', wait_until='networkidle')
            # A traveller returns to settings to ask for ideas, then must be able to cancel.
            page.locator('#travelModeButton').click()
            workspace_view(page, 'settings')
            if width > 760: page.evaluate("PlannerUI.switchView('settings',false)")
            page.locator('#preferencesSection > summary').click()
            net.hold_ai = True
            page.locator('.btn-magic').click()
            page.wait_for_function('isBusy')
            check(label+' travel mode keeps pending operation and cancellation reachable', page.locator('#cancelOperation').is_visible())
            page.evaluate('PlannerUI.cancel()')
            page.wait_for_function('!isBusy')
            net.hold_ai = False
            net.release_ai()
            check(label+' cancelling ideas preserves both days', page.evaluate('tripData.length===2'))
            if page.evaluate('TripLibrary.progress().enabled'): page.locator('#travelModeButton').click()
            workspace_view(page, 'itinerary')
            # Retry must retain its original target and instruction even if another modal is opened.
            net.fail_ai = True
            page.locator('.btn-modify').first.click()
            page.locator('#modifyInstruction').fill('第一天改成室內')
            page.locator('#modifyModal .btn-primary').click()
            page.wait_for_function('!isBusy')
            page.locator('#tripContainer > details').nth(1).locator(':scope > summary').click()
            page.locator('.btn-modify').nth(1).click()
            page.locator('#modifyInstruction').fill('第二天尚未送出')
            page.locator('#modifyModal button').last.click()
            page.locator('#modifyModal').wait_for(state='hidden')
            net.fail_ai = False
            before = len(net.ai_requests)
            page.locator('#retryOperation').click()
            page.wait_for_function('!isBusy')
            prompt = net.ai_requests[-1]['messages'][-1]['content']
            check(label+' retry preserves original day and instruction', len(net.ai_requests)==before+1 and '第一天改成室內' in prompt and START in prompt and '第二天尚未送出' not in prompt and page.evaluate("tripData[0].day_title==='微調後的輕鬆旅程' && tripData[1].day_title!=='微調後的輕鬆旅程'"))
            # Legacy backups without continuation still need budget undo.
            page.evaluate("generationState=null; persistTrip();")
            page.reload(wait_until='networkidle')
            page.locator('#tripReview summary').click()
            page.locator('#reviewBudget').fill('900')
            page.locator('#reviewBudgetForm button').click()
            page.wait_for_function('!isBusy')
            page.locator('#undoTrip').click()
            page.wait_for_function('!isBusy')
            check(label+' legacy itinerary budget update is undoable', page.locator('#budget').input_value() != '900')
            # Blank city must fail before it spends a provider request.
            workspace_view(page, 'settings')
            page.locator('#city').fill('   ')
            before = len(net.ai_requests)
            page.locator('#planBtn').click()
            page.wait_for_function('!isBusy')
            check(label+' whitespace destination rejected before AI call', len(net.ai_requests)==before)
            # Long content and the 15-day limit exercise the new summary and date index.
            long_days = [sample_day(f'2026-11-{10+i:02d}') for i in range(15)]
            long_days[0]['itinerary'][0]['title'] = 'VeryLongDestinationWithoutSpaces'*8
            long_days[0]['itinerary'][0]['desc'] = '<img src=x onerror="window.injected=true">'
            page.evaluate("""async days=>{tripData=validateTrip(days);generationState=null;document.getElementById('city').value='長名稱目的地 / LongDestination'.repeat(5);saveInputs();persistTrip();await renderTrip();PlannerUI.switchView('itinerary',false);}""", long_days)
            check(label+' overview counts all 15 days and 30 stops', page.locator('#overviewDays').inner_text()=='15' and page.locator('#overviewStops').inner_text()=='30')
            check(label+' untrusted itinerary content renders as text', page.locator('#tripContainer > details img').count()==0 and not page.evaluate('Boolean(window.injected)'))
            page.locator('#dayIndex button').last.click()
            check(label+' date index opens and focuses target day', page.locator('#tripContainer > details').last.evaluate('el=>el.open && el.querySelector("summary")===document.activeElement'))
            for size in [320, 390, 760, 900, 1440]:
                page.set_viewport_size({'width':size,'height':900})
                page.evaluate("PlannerUI.switchView('itinerary',false)")
                check(label+f' long-content width {size} has no overflow', not overflow(page)['overflow'])
            page.set_viewport_size({'width':width,'height':950})
            page.evaluate("PlannerUI.jumpToDay(0)")
            page.locator('.stop-edit').first.click()
            page.locator('#stopModal .modal-close').focus()
            page.keyboard.press('Shift+Tab')
            check(label+' editor keyboard focus stays inside dialog', page.evaluate("document.getElementById('stopModal').contains(document.activeElement)"))
            page.keyboard.press('Escape')
            page.locator('#stopModal').wait_for(state='hidden')
            check(label+' Escape returns focus to edited stop', page.locator('.stop-edit').first.evaluate('el=>el===document.activeElement'))
            # Cost coverage must reach the UI, and repeated renders must not duplicate warnings.
            page.evaluate("""async()=>{document.getElementById('city').value='台北';tripData[0].itinerary[0].cost='USD 20';tripData[0].itinerary[1].cost='2人共 NT$500';await renderTrip();await renderTrip();}""")
            check(label+' mixed currency and quantity prices surface coverage warning once', page.locator('.cost-coverage').count()==1 and '2 站費用待確認' in page.locator('#tripReview summary').inner_text())
            # Capture readable, short fixtures for visual review, separately from stress content.
            page.evaluate("""async d=>{tripData=validateTrip(d.t);generationState=restoreGenerationState(d.g,tripData);document.getElementById('city').value='台北';persistTrip();await renderTrip();PlannerUI.switchView('itinerary',false);document.querySelector('#tripReview details').open=false;window.scrollTo(0,0);}""", legacy)
            page.evaluate('TripMotion.settle()')
            page.screenshot(path=str(ARTIFACTS/f'audit-after-{label}.png'), full_page=True)
            page.locator('#travelModeButton').click()
            page.evaluate('window.scrollTo(0,0)')
            page.screenshot(path=str(ARTIFACTS/f'audit-travel-{label}.png'), full_page=True)
            check(label+' no uncaught errors', not errors)
            context.close()
        browser.close()
    server.shutdown()
    report = {'checks': checks, 'passed': all(c['passed'] for c in checks)}
    (ARTIFACTS/'audit-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
