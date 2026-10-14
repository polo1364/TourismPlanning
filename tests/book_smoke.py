"""Digital travel book flow with real clicks, isolated storage and mocked APIs."""
import json
import threading
from functools import partial
from http.server import ThreadingHTTPServer
from playwright.sync_api import sync_playwright
from browser_smoke import ROOT, ARTIFACTS, Handler, Network, START, END, sample_day, overflow


def main():
    server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory=str(ROOT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    checks = []
    def check(name, result):
        checks.append({'name': name, 'passed': bool(result)})
        if not result:
            raise AssertionError(name)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for label, width in [('desktop', 1440), ('mobile', 390)]:
            context = browser.new_context(viewport={'width': width, 'height': 1000}, is_mobile=width==390, has_touch=width==390)
            context.add_init_script("sessionStorage.setItem('deepseekApiKey','mock-not-a-real-key')")
            net = Network()
            context.route('**/*', net.route)
            page = context.new_page()
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.on('dialog', lambda d: d.accept())
            page.goto(f'http://127.0.0.1:{server.server_port}/', wait_until='networkidle')
            check(label+' starts with a focused input page', page.locator('#settingsPanel').is_visible() and not page.locator('#itineraryPanel').is_visible())
            page.locator('#customPrefs').fill('希望輕鬆散步，避免太多階梯')
            page.locator('[data-brief]').first.click()
            page.locator('[data-brief]').first.click()
            check(label+' preference chips append without duplication', page.locator('#customPrefs').input_value().count('步調放慢') == 1)
            page.locator('#city').fill('台北')
            page.locator('#flightArrival').fill(START+'T08:00')
            page.locator('#flightDeparture').fill(END+'T20:00')
            page.locator('#lodgingSection > summary').click()
            page.locator('#hasHotel').uncheck()
            page.evaluate('TripMotion.settle();window.scrollTo(0,0)')
            page.screenshot(path=str(ARTIFACTS/f'book-home-{label}.png'), full_page=True)
            # Create a partial checkpoint; full generation clicks are tested separately.
            page.evaluate('() => { void planTrip(); }')
            page.wait_for_function('!isBusy && tripData.length===1')
            check(label+' first generation opens the book', page.locator('#itineraryPanel').is_visible() and not page.locator('#settingsPanel').is_visible())
            check(label+' free text reaches generation prompt', '希望輕鬆散步' in net.ai_requests[0]['messages'][-1]['content'])
            check(label+' only generated chapter appears', page.locator('#tripContainer > details:visible').count()==1 and page.locator('#bookPrevious').is_disabled() and page.locator('#bookNext').is_disabled())
            page.locator('#generateNextDayBtn').click()
            page.wait_for_function('!isBusy && tripData.length===2')
            check(label+' completed book opens at first chapter', page.locator('#tripContainer > details:visible').get_attribute('data-date')==START and page.locator('#bookPrevious').is_disabled())
            page.locator('#bookNext').click()
            snapshot = page.evaluate("localStorage.getItem('tourismTrips_v1')")
            page.locator('#bookPrevious').click()
            check(label+' previous page returns to first day', page.locator('#tripContainer > details:visible').get_attribute('data-date')==START)
            page.locator('#bookNext').click()
            check(label+' forward page retains correct day', page.locator('#tripContainer > details:visible').get_attribute('data-date')==END)
            check(label+' flipping pages never writes journey data', snapshot==page.evaluate("localStorage.getItem('tourismTrips_v1')"))
            page.locator('#bookPrevious').focus()
            page.keyboard.press('ArrowLeft')
            check(label+' keyboard page navigation works', page.locator('#tripContainer > details:visible').get_attribute('data-date')==START)
            page.locator('#dayIndex button').last.click()
            check(label+' date index selects the correct chapter and focus', page.locator('#tripContainer > details:visible').get_attribute('data-date')==END and page.locator('#tripContainer > details').last.locator('summary').evaluate('e=>e===document.activeElement'))
            page.locator('#tripContainer > details:visible .stop-edit').first.click()
            page.locator('#stop_title').fill('第二天的新景點')
            page.locator('#stopForm button[type="submit"]').click()
            page.wait_for_function('!isBusy')
            page.locator('#stopModal').wait_for(state='hidden')
            check(label+' editing retains current chapter', page.locator('#tripContainer > details:visible').get_attribute('data-date')==END and '第二天的新景點' in page.locator('#tripContainer > details:visible').inner_text())
            page.locator('#undoTrip').click()
            page.wait_for_function('!isBusy')
            check(label+' undo restores content without changing chapter', page.locator('#tripContainer > details:visible').get_attribute('data-date')==END and '第二天的新景點' not in page.locator('#tripContainer > details:visible').inner_text())
            page.locator('#bookReadMode').click()
            check(label+' continuous reading preserves all chapters', page.locator('#tripContainer > details:visible').count()==2)
            page.reload(wait_until='networkidle')
            check(label+' continuous preference persists', page.locator('#bookReadMode').get_attribute('aria-pressed')=='true')
            page.locator('#bookReadMode').click()
            page.locator('#bookNext').click()
            page.evaluate('TripMotion.settle();document.getAnimations().forEach(a=>{if(a.effect?.getTiming().iterations!==Infinity)a.finish()});window.scrollTo(0,0)')
            page.screenshot(path=str(ARTIFACTS/f'book-chapter-{label}.png'), full_page=True)
            page.locator('#tripContainer > details:visible').screenshot(path=str(ARTIFACTS/f'book-spread-{label}.png'))
            page.locator('#settingsTab').click()
            check(label+' returning to input preserves the brief', '希望輕鬆散步' in page.locator('#customPrefs').input_value())
            page.locator('#itineraryTab').click()
            check(label+' returning to book retains selected page', page.locator('#tripContainer > details:visible').get_attribute('data-date')==END)
            page.locator('#travelModeButton').click()
            check(label+' travel mode hides book pagination', page.locator('#journeyPanel').is_visible() and not page.locator('#bookNavigation').is_visible())
            page.locator('#travelModeButton').click()
            check(label+' exiting travel mode restores selected chapter', page.locator('#tripContainer > details:visible').get_attribute('data-date')==END)
            for size in [320, 390, 760, 900, 1440]:
                page.set_viewport_size({'width':size,'height':950})
                check(label+f' book {size}px no overflow', not overflow(page)['overflow'])
                page.locator('#settingsTab').click()
                check(label+f' brief {size}px no overflow', not overflow(page)['overflow'])
                page.locator('#itineraryTab').click()
            page.emulate_media(reduced_motion='reduce')
            page.locator('#bookPrevious').click()
            check(label+' reduced motion stops page transforms', page.locator('#tripContainer > details:visible').evaluate("e=>!e.getAnimations().some(a=>a.playState==='running')"))
            # New trip and returning to a saved trip exercise book selection boundaries.
            old_id = page.locator('#tripSelect').input_value()
            page.evaluate("TripLibrary.openName('new')")
            page.locator('#tripName').fill('空白測試旅程')
            page.locator('#tripNameModal form').evaluate('e=>e.requestSubmit()')
            page.wait_for_function('!isBusy && tripData.length===0')
            check(label+' new trip returns to input without stale book pages', page.locator('#settingsPanel').is_visible() and not page.locator('#bookNavigation').is_visible())
            page.locator('#tripSelect').select_option(old_id)
            page.wait_for_function('!isBusy && tripData.length===2')
            check(label+' switching back selects a valid first chapter', page.locator('#tripContainer > details:visible').get_attribute('data-date')==START)
            # Cancelling a new book must keep both the saved chapters and a valid page.
            original = page.evaluate('JSON.stringify(tripData)')
            page.locator('#settingsTab').click()
            net.hold_ai = True
            page.locator('#planBtn').click()
            page.wait_for_function('isBusy')
            page.locator('#bookNext').click()
            check(label+' pending generation allows reading existing pages', page.locator('#tripContainer > details:visible').get_attribute('data-date')==END)
            page.locator('#cancelOperation').click()
            page.wait_for_function('!isBusy')
            net.hold_ai = False
            net.release_ai()
            check(label+' cancelling generation preserves the book and current page', page.evaluate('JSON.stringify(tripData)')==original and page.locator('#tripContainer > details:visible').get_attribute('data-date')==END)
            long_days = [sample_day(f'2026-11-{10+i:02d}', title='LongChapterNameWithoutSpaces'*12) for i in range(15)]
            long_days[0]['summary'] = '<img src=x onerror="window.injected=true">'
            page.evaluate("async days=>{tripData=validateTrip(days);generationState=null;await renderTrip();}",long_days)
            page.locator('#dayIndex button').last.click()
            check(label+' 15-day book reaches the last chapter', page.locator('#tripContainer > details:visible').get_attribute('data-date')=='2026-11-24' and page.locator('#bookNext').is_disabled())
            check(label+' chapter summary remains untrusted text', page.locator('#tripContainer > details img').count()==0 and not page.evaluate('Boolean(window.injected)'))
            for size in [320,900,1440]:
                page.set_viewport_size({'width':size,'height':950})
                check(label+f' long chapter {size}px has no overflow',not overflow(page)['overflow'])
            check(label+' no uncaught browser errors', not errors)
            context.close()
        browser.close()
    server.shutdown()
    report = {'checks':checks,'passed':all(c['passed'] for c in checks)}
    (ARTIFACTS/'book-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(report,ensure_ascii=False,indent=2))


if __name__=='__main__':
    main()
