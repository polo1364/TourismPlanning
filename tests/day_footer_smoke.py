"""Day endings follow itinerary order regardless of hidden or collapsed chapters."""
from functools import partial
from http.server import ThreadingHTTPServer
import json
import threading
from playwright.sync_api import sync_playwright
from browser_smoke import ROOT, Handler, sample_day
from itinerary_import_smoke import ImportNetwork


def main():
    output = ROOT / 'artifacts/day-footer'
    output.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory=str(ROOT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    checks = []
    def check(name, passed):
        checks.append({'name': name, 'passed': bool(passed)})
        assert passed, name
    days = [sample_day(f'2027-05-{11+i:02d}') for i in range(6)]
    expected = [f'— 第 {i+1} 天 · 完 —' for i in range(6)]
    with sync_playwright() as p:
        for profile in ['desktop', 'android', 'iphone']:
            browser = (p.webkit if profile == 'iphone' else p.chromium).launch()
            device = p.devices['iPhone 13' if profile == 'iphone' else 'Pixel 7'] if profile != 'desktop' else {'viewport': {'width': 1440, 'height': 1000}}
            context = browser.new_context(**device, reduced_motion='reduce', accept_downloads=True)
            context.route('**/*', ImportNetwork().route)
            page = context.new_page()
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.goto(f'http://127.0.0.1:{server.server_port}/', wait_until='networkidle')
            page.evaluate('async days=>{tripData=days;generationState=null;await renderTrip()}', days)
            page.locator('#itineraryTab').click()
            page.locator('#dayIndex button').first.click()
            before = page.evaluate('JSON.stringify(tripData)')
            for i in range(6):
                if i:
                    page.locator('#bookNext').click()
                check(f'{profile} next day {i+1}', page.locator('#tripContainer > details:visible .day-end').inner_text() == expected[i])
            page.locator('#bookPrevious').click()
            check(profile + ' previous day 5', page.locator('#tripContainer > details:visible .day-end').inner_text() == expected[4])
            page.locator('#dayIndex button').nth(2).click()
            check(profile + ' jump to day 3', page.locator('#tripContainer > details:visible .day-end').inner_text() == expected[2])
            page.locator('#tripContainer > details:visible .day-end').screenshot(path=str(output / f'footer-day3-{profile}.png'))
            page.locator('#bookReadMode').click()
            page.evaluate("document.querySelectorAll('#tripContainer > details').forEach(day=>day.open=true)")
            check(profile + ' continuous day numbers', page.locator('#tripContainer .day-end').all_text_contents() == expected)
            page.locator('#tripContainer > details').first.locator(':scope > summary').click()
            check(profile + ' collapse earlier day preserves day 3', page.locator('#tripContainer .day-end').nth(2).inner_text() == expected[2])
            page.locator('#bookReadMode').click()
            page.evaluate('async()=>{await renderTrip()}')
            check(profile + ' rerender keeps selected number', page.locator('#tripContainer > details:visible .day-end').inner_text() == expected[2])
            check(profile + ' no counter footer or overflow', page.locator('#tripContainer > details:visible .day-content').evaluate("e=>['none','normal'].includes(getComputedStyle(e,'::after').content)") and page.evaluate('document.body.scrollWidth<=innerWidth'))
            with page.expect_download() as download:
                page.locator('#downloadBook').click()
            file = output / f'book-{profile}.html'
            download.value.save_as(str(file))
            reader = browser.new_page(**device)
            reader.goto(file.as_uri(), wait_until='load')
            check(profile + ' exported booklet has exactly one correct footer per day', reader.locator('.day-end').all_text_contents() == expected)
            reader.close()
            check(profile + ' saved data unchanged', page.evaluate('JSON.stringify(tripData)') == before)
            if errors: print(profile, errors)
            check(profile + ' no runtime errors', not errors)
            context.close()
            browser.close()
    server.shutdown()
    (output / 'report.json').write_text(json.dumps({'checks': checks, 'physical_device': False}, indent=2), encoding='utf-8')
    print(json.dumps({'passed': True, 'checks': len(checks)}))


if __name__ == '__main__':
    main()
