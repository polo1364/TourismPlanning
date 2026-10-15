"""Real local cloud backend + HTTPS browser routing. No production data or AI calls."""
import base64
import json
import subprocess
import tempfile
import urllib.request
import urllib.error
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright
from browser_smoke import ROOT, ARTIFACTS, Network, sample_day

ORIGIN = 'https://travel.example.test'


def main():
    checks = []
    def check(name, result):
        checks.append({'name': name, 'passed': bool(result)})
        assert result, name

    with tempfile.TemporaryDirectory(prefix='roam-share-browser-') as directory:
        server = subprocess.Popen(['node', str(ROOT / 'tests/share-fixture.cjs'), directory], stdout=subprocess.PIPE, text=True)
        try:
            port = int(server.stdout.readline().strip())
            def proxy(owner=False):
                external = Network()
                def route_handler(route):
                    request = route.request
                    parsed = urlsplit(request.url)
                    if parsed.hostname != 'travel.example.test':
                        return external.route(route)
                    headers = {key: value for key, value in request.headers.items() if key not in ['host', 'content-length', 'accept-encoding']}
                    headers.update({'Host': 'travel.example.test', 'X-Forwarded-Proto': 'https'})
                    if owner:
                        headers['Authorization'] = 'Basic ' + base64.b64encode(b'roam:share-browser-test').decode()
                    else:
                        headers.pop('authorization', None)
                    local = f'http://127.0.0.1:{port}{parsed.path}' + (('?' + parsed.query) if parsed.query else '')
                    req = urllib.request.Request(local, data=request.post_data_buffer, headers=headers, method=request.method)
                    try:
                        response = urllib.request.urlopen(req, timeout=30)
                    except urllib.error.HTTPError as error:
                        response = error
                    with response:
                        route.fulfill(status=response.status, headers=dict(response.headers), body=response.read())
                return route_handler

            with sync_playwright() as p:
                browser = p.chromium.launch()
                owner = browser.new_context(viewport={'width':1440,'height':1000}, permissions=['clipboard-read', 'clipboard-write'])
                owner.route('**/*', proxy(True))
                page = owner.new_page()
                errors = []
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.goto(ORIGIN)
                day = sample_day()
                day['itinerary'][0]['userNote'] = '記得帶水，集合時間 09:00。'
                page.evaluate('''async day => { tripData = [day]; generationState = {city:'台北分享示範'};
                    sessionStorage.setItem('deepseekApiKey','SHARE_SECRET_MUST_STAY_PRIVATE'); await renderTrip(); }''', day)
                page.locator('#itineraryTab').click()
                original = page.evaluate('JSON.stringify(tripData)')
                page.locator('#createBookShare').click()
                page.wait_for_function('() => !isBusy')
                check('share creation feedback', '已建立' in page.locator('#bookShareStatus').inner_text())
                url = page.locator('.share-url').input_value()
                check('unguessable public URL returned', url.startswith(ORIGIN + '/s/') and len(url.rsplit('/',1)[1]) == 48)
                check('creation preserves trip', page.evaluate('JSON.stringify(tripData)') == original)
                page.get_by_role('button', name='複製網址', exact=True).click()
                check('copy link works', page.evaluate('navigator.clipboard.readText()') == url)
                page.screenshot(path=str(ARTIFACTS / 'book-share-management-desktop.png'), full_page=True)
                page.set_viewport_size({'width':390,'height':844})
                page.locator('#bookShares').scroll_into_view_if_needed()
                check('mobile share panel fits', page.evaluate('document.documentElement.scrollWidth <= innerWidth'))
                page.screenshot(path=str(ARTIFACTS / 'book-share-management-mobile.png'))
                page.evaluate("async () => { tripData[0].itinerary[0].userNote='修改後的新提醒'; await renderTrip(); }")
                for engine_name, engine in [('Chromium', p.chromium), ('WebKit', p.webkit)]:
                    guest_browser = engine.launch()
                    for width, height in [(1440,1000), (390,844)]:
                        guest = guest_browser.new_context(viewport={'width':width,'height':height}, has_touch=True, is_mobile=width < 900, reduced_motion='no-preference')
                        guest.route('**/*', proxy(False))
                        book = guest.new_page()
                        book.on('pageerror', lambda error: errors.append(str(error)))
                        response = book.goto(url)
                        check(f'{engine_name} {width} guest reads without login', response.status == 200)
                        book.wait_for_function("() => document.body.dataset.readerReady === 'true'")
                        check(f'{engine_name} {width} private settings absent', 'SHARE_SECRET_MUST_STAY_PRIVATE' not in book.content())
                        check(f'{engine_name} {width} published snapshot immutable', book.locator('.stop-note-text').text_content() == day['itinerary'][0]['userNote'])
                        check(f'{engine_name} {width} isolated from owner storage', book.evaluate("() => { try { localStorage.getItem('x'); return false; } catch { return true; } }") )
                        check(f'{engine_name} {width} private API blocked by CSP', book.evaluate("async () => { try { await fetch('/api/shares'); return false; } catch { return true; } }") )
                        book.locator('#next').tap()
                        check(f'{engine_name} {width} right-to-left animation', book.locator('.page-turn.forward').count() == 1)
                        book.wait_for_function('() => !document.body.dataset.turning')
                        turns = 1
                        while not book.locator('#next').is_disabled():
                            book.locator('#next').tap()
                            book.wait_for_function('() => !document.body.dataset.turning')
                            turns += 1
                            assert turns < 50
                        check(f'{engine_name} {width} every page reachable', turns >= 1 and book.locator('#next').is_disabled())
                        check(f'{engine_name} {width} no page scroll', book.evaluate('scrollX === 0 && scrollY === 0 && document.documentElement.scrollWidth <= innerWidth'))
                        book.locator('#previous').tap()
                        check(f'{engine_name} {width} reverse page available', not book.locator('#next').is_disabled())
                        guest.close()
                    guest_browser.close()
                # The list is server-backed, so it survives a fresh planner page.
                page.reload()
                page.locator('#itineraryTab').click()
                page.locator('#bookShares summary').click()
                page.wait_for_selector('.share-url')
                check('list survives reload', page.locator('.share-url').input_value() == url)
                page.route('**/api/shares/*', lambda route: route.fulfill(status=503, content_type='application/json', body='{"error":"測試取消失敗"}') if route.request.method == 'DELETE' else route.fallback())
                page.get_by_role('button', name='取消分享', exact=True).click()
                page.wait_for_function('() => !isBusy')
                check('revoke failure visible without hiding link', '測試取消失敗' in page.locator('#bookShareStatus').inner_text() and page.locator('.share-url').count() == 1)
                page.unroute('**/api/shares/*')
                page.get_by_role('button', name='取消分享', exact=True).click()
                page.wait_for_function('() => !isBusy')
                check('revoke success clears list', '已取消分享' in page.locator('#bookShareStatus').inner_text() and page.locator('.share-url').count() == 0)
                anonymous = browser.new_context()
                anonymous.route('**/*', proxy(False))
                gone = anonymous.new_page()
                check('revoked URL no longer serves book', gone.goto(url).status == 404 and '已取消分享' in gone.locator('body').inner_text())
                check('no runtime errors', not errors)
                anonymous.close(); owner.close(); browser.close()
        finally:
            server.terminate(); server.wait(timeout=10)
    report = {'passed':len(checks), 'checks':checks}
    (ARTIFACTS / 'book-sharing-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'passed':len(checks)}))


if __name__ == '__main__':
    main()
