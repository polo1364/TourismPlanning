"""Generation feedback with delayed providers; no real AI requests or saved user data."""
import json
import threading
from functools import partial
from http.server import ThreadingHTTPServer
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright
from browser_smoke import ROOT, ARTIFACTS, Handler, Network, sample_day, overflow


class ProgressNetwork(Network):
    def __init__(self):
        super().__init__()
        self.calls = 0
        self.weather = []
        self.pending_responses = []

    def route(self, route):
        url = urlparse(route.request.url)
        if url.hostname in {'geocoding-api.open-meteo.com', 'api.open-meteo.com'}:
            self.weather.append(url.hostname)
        codex = url.port == 8081
        if codex and url.path == '/status':
            return route.fulfill(json={'ready': True, 'auth': 'chatgpt', 'token': 'test-only'})
        if (codex and url.path == '/generate') or url.hostname == 'api.deepseek.com':
            if route.request.method == 'OPTIONS':
                return route.fulfill(status=204)
            self.calls += 1
            payload = {'data': sample_day()} if codex else {'choices': [{'finish_reason': 'stop', 'message': {'content': json.dumps(sample_day())}}]}
            self.pending_responses.append((route, payload))
            return
        return super().route(route)

    def release(self, fail=False):
        pending, self.pending_responses = self.pending_responses, []
        for route, payload in pending:
            route.fulfill(status=503 if fail else 200, json={'error': 'Test unavailable'} if fail else payload)


def main():
    server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory=str(ROOT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    checks = []

    def check(name, value):
        checks.append({'name': name, 'passed': bool(value)})
        assert value, name

    with sync_playwright() as p:
        browser = p.chromium.launch()
        for provider in ['deepseek', 'codex']:
            for width in [1440, 390]:
                label = f'{provider}-{width}'
                context = browser.new_context(viewport={'width': width, 'height': 950}, is_mobile=width == 390, has_touch=width == 390)
                context.add_init_script(f"localStorage.setItem('aiProvider','{provider}');sessionStorage.setItem('deepseekApiKey','test-only')")
                net = ProgressNetwork()
                context.route('**/*', net.route)
                page = context.new_page()
                errors = []
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.goto(f'http://127.0.0.1:{server.server_port}/', wait_until='networkidle')
                page.locator('#city').fill('台北')
                page.locator('#flightArrival').fill('2099-11-10T09:00')
                page.locator('#flightDeparture').fill('2099-11-10T18:00')
                page.locator('#lodgingSection > summary').click()
                page.locator('#hasHotel').uncheck()
                page.locator('#planBtn').click()
                page.wait_for_function("document.getElementById('operationStage').textContent.includes('回覆')")
                page.wait_for_function("document.getElementById('operationElapsed').textContent !== '已用時 0:00'")
                check(label + ' request sent once', net.calls == 1)
                check(label + ' far future skips unavailable weather', not net.weather)
                check(label + ' spinner visible while first response waits', page.locator('.operation-spinner').is_visible())
                check(label + ' progress stays at zero until saved', page.locator('#dayProgress').get_attribute('value') == '0')
                box = page.locator('#operationStatus').bounding_box()
                check(label + ' status immediately in viewport', box['y'] >= 0 and box['y'] + box['height'] <= 950)
                check(label + ' provider is identified', provider.lower() in page.locator('#operationStage').inner_text().lower())
                page.locator('#settingsTab').click()
                check(label + ' status and cancel survive switching tabs', page.locator('#operationStatus').is_visible() and page.locator('#cancelOperation').is_enabled())
                for size in [320, 390, 760, 1440]:
                    page.set_viewport_size({'width': size, 'height': 950})
                    check(label + f' no overflow at {size}', not overflow(page)['overflow'])
                page.set_viewport_size({'width': width, 'height': 950})
                page.locator('#operationStatus').screenshot(path=str(ARTIFACTS / f'generation-progress-{label}.png'))
                page.locator('#cancelOperation').click()
                page.wait_for_function('!isBusy')
                net.release()
                elapsed = page.locator('#operationElapsed').inner_text()
                page.wait_for_timeout(1100)
                check(label + ' cancellation stops timer and spinner', elapsed == page.locator('#operationElapsed').inner_text() and not page.locator('.operation-spinner').is_visible())
                check(label + ' cancelled response was not saved', page.evaluate('tripData.length === 0'))
                page.locator('#retryOperation').click()
                page.wait_for_timeout(150)
                net.release(fail=True)
                page.wait_for_function('!isBusy')
                check(label + ' failure stops feedback and offers retry', page.locator('#operationStage').inner_text() == '生成未完成' and page.locator('#retryOperation').is_enabled())
                page.locator('#retryOperation').click()
                page.wait_for_timeout(150)
                net.release()
                page.wait_for_function('!isBusy && tripData.length === 1')
                check(label + ' completion is saved and spinner stops', page.locator('#operationStage').inner_text() == '生成完成' and not page.locator('.operation-spinner').is_visible() and page.evaluate('JSON.parse(localStorage.myTrip_v27).length === 1'))
                check(label + ' no duplicate calls', net.calls == 3)
                # Near-term travel still obtains real forecast fields from the weather fixture.
                page.locator('#settingsTab').click()
                date = page.evaluate("() => {const d = new Date(); d.setDate(d.getDate()+2); return formatLocalDate(d);}")
                page.locator('#flightArrival').fill(date + 'T09:00')
                page.locator('#flightDeparture').fill(date + 'T18:00')
                page.locator('#planBtn').click()
                page.wait_for_timeout(250)
                check(label + ' near-term weather retained', net.weather == ['geocoding-api.open-meteo.com', 'api.open-meteo.com'])
                page.locator('#cancelOperation').click()
                page.wait_for_function('!isBusy')
                net.release()
                page.emulate_media(reduced_motion='reduce')
                check(label + ' no page errors', not errors)
                context.close()
        browser.close()
    server.shutdown()
    report = {'checks': checks, 'passed': all(c['passed'] for c in checks)}
    (ARTIFACTS / 'generation-progress-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f"Generation progress: {len(checks)} checks passed")


if __name__ == '__main__':
    main()
