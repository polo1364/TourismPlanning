"""Explicit real cloud test: generates a two-day book using Codex plan usage.

Credentials are read from a private file outside the repository, never logged.
Weather/rates are mocked; cloud HTTPS, authentication and Codex are real.
"""
import argparse
import json
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright
from browser_smoke import Network, ARTIFACTS, START, END, overflow, sample_day


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--credentials', required=True)
    parser.add_argument('--ui-only', action='store_true', help='Use fixture itineraries; no AI calls.')
    args = parser.parse_args()
    credentials = json.loads(Path(args.credentials).read_text())
    base = credentials['url']
    auth = {key: credentials[key] for key in ['username', 'password']}
    auth['origin'] = base
    checks = []
    completed = False
    def check(name, value):
        checks.append({'name': name, 'passed': bool(value)})
        assert value, name
    with sync_playwright() as p:
        browser = p.chromium.launch()
        context = browser.new_context(viewport={'width': 1440, 'height': 1000}, http_credentials=auth)
        net = Network()
        requests = []
        def route(request):
            parsed = urlparse(request.request.url)
            if parsed.hostname == urlparse(base).hostname:
                if parsed.path == '/codex/generate': requests.append(request.request.method)
                return request.continue_()
            return net.route(request)
        context.route('**/*', route)
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        try:
            page.goto(base, wait_until='networkidle')
            page.wait_for_function("document.getElementById('codexStatus').textContent.includes('已連接雲端')", timeout=30000)
            check('authenticated_cloud_selected', page.locator('#aiProvider').input_value() == 'codex')
            check('desktop_input_fits', not overflow(page)['overflow'])
            page.screenshot(path=str(ARTIFACTS/'cloud-desktop-input.png'))
            page.locator('#city').fill('台北')
            page.locator('#flightArrival').fill(START+'T09:00')
            page.locator('#flightDeparture').fill(END+'T18:00')
            page.locator('#customPrefs').fill('兩天輕鬆散步，每天最多三站含午餐，費用以新台幣估算。每站說明簡短。')
            page.locator('#lodgingSection > summary').click()
            page.locator('#hasHotel').uncheck()
            if args.ui_only:
                page.evaluate("async days => { tripData=days; await renderTrip(); persistTrip('驗收示範', {undo:false,openBook:true}); window.PlannerUI.switchView('itinerary'); window.TripBook.select(0,false); }", [sample_day(START),sample_day(END)])
                check('fixture_book_loaded', page.evaluate('tripData.length===2'))
            else:
                page.locator('#planBtn').click()
                page.wait_for_function('isBusy')
                check('progress_visible_during_generation', page.locator('#operationText').is_visible())
                print('Real cloud generation started; waiting for two days.', flush=True)
                page.wait_for_function('!isBusy', timeout=420000)
                check('real_two_day_book_completed', page.evaluate('tripData.length===2 && tripData.every(d=>d.itinerary.length>0)'))
                check('two_codex_calls_only', len(requests) == 2 and not net.ai_requests)
                check('progress_complete', '100%' in page.locator('#operationText').inner_text())
            check('opens_first_page', page.locator('#bookPageNumber').inner_text() == '01 / 02')
            page.locator('#bookNext').click()
            check('can_turn_to_second_day', page.locator('#bookPageNumber').inner_text() == '02 / 02')
            check('desktop_book_fits', not overflow(page)['overflow'])
            page.evaluate('window.TripMotion?.settle()')
            page.screenshot(path=str(ARTIFACTS/'cloud-desktop-book.png'))
            state = context.storage_state()
            mobile = browser.new_context(viewport={'width':390,'height':844}, is_mobile=True, has_touch=True, http_credentials=auth, storage_state=state)
            mobile.route('**/*', route)
            phone = mobile.new_page()
            phone.on('pageerror', lambda error: errors.append(str(error)))
            phone.goto(base, wait_until='networkidle')
            check('mobile_saved_book_readable', phone.locator('#bookNavigation').is_visible() and phone.evaluate('tripData.length===2'))
            check('mobile_book_fits', not overflow(phone)['overflow'])
            phone.locator('#bookNext').click()
            check('mobile_next_page_works', phone.locator('#bookPageNumber').inner_text() == '02 / 02')
            phone.locator('#bookPrevious').click()
            check('mobile_previous_page_works', phone.locator('#bookPageNumber').inner_text() == '01 / 02')
            phone.evaluate('window.TripMotion?.settle()')
            phone.screenshot(path=str(ARTIFACTS/'cloud-mobile-book.png'))
            check('no_uncaught_errors', not errors)
            if args.ui_only: check('ui_check_did_not_generate', not requests and not net.ai_requests)
            completed = True
            mobile.close()
        finally:
            scope = 'Real Oracle HTTPS with fixture itineraries; no AI calls.' if args.ui_only else 'Real Oracle HTTPS and two-day Codex book.'
            report = {'passed': completed and all(item['passed'] for item in checks), 'completed': completed, 'checks': checks, 'errors': errors, 'generation_requests': len(requests), 'scope': scope+' Desktop/mobile Chromium. Weather and rates mocked. Physical phone not tested.'}
            report_file = 'cloud-ui-report.json' if args.ui_only else 'cloud-live-report.json'
            (ARTIFACTS/report_file).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
            browser.close()
    print(json.dumps({'passed': report['passed'], 'checks': len(checks), 'generation_requests': len(requests)}))


if __name__ == '__main__':
    main()
