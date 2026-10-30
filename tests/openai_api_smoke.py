"""API setup, import, draft retention and key isolation with mocked network responses."""
from functools import partial
from http.server import ThreadingHTTPServer
from urllib.parse import urlsplit
import json
import threading
from playwright.sync_api import sync_playwright
from browser_smoke import ROOT, Handler
from itinerary_import_smoke import ImportNetwork, TEXT


class ApiNetwork(ImportNetwork):
    def __init__(self):
        super().__init__()
        self.configured = False
        self.saved = []

    def route(self, route):
        url = urlsplit(route.request.url)
        if url.hostname == '127.0.0.1' and url.port == 8081 and route.request.method != 'OPTIONS':
            if url.path == '/status':
                value = {'ready': self.configured, 'auth': 'api', 'token': 'mock-import-token'}
            elif url.path == '/settings':
                self.saved.append(route.request.post_data_json)
                self.configured = True
                value = {'saved': True, 'auth': 'api'}
            elif url.path == '/usage':
                value = {'available': False, 'billing': 'api', 'limits': [], 'models': [{'id': 'gpt-6-sol', 'name': 'gpt-6-sol', 'isDefault': True}]}
            else:
                return super().route(route)
            return route.fulfill(status=200, headers=self.cors(route), content_type='application/json', body=json.dumps(value))
        return super().route(route)


def main():
    output = ROOT / 'artifacts/api-billing'
    output.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory=str(ROOT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    checks = []
    key = 'sk-fake-browser-test-only-1234567890'
    def check(name, passed):
        checks.append({'name': name, 'passed': bool(passed)})
        assert passed, name
    with sync_playwright() as p:
        for profile in ['desktop', 'android', 'iphone']:
            browser = (p.webkit if profile == 'iphone' else p.chromium).launch()
            device = p.devices['iPhone 13' if profile == 'iphone' else 'Pixel 7'] if profile != 'desktop' else {'viewport': {'width': 1440, 'height': 1000}}
            context = browser.new_context(**device, accept_downloads=True)
            network = ApiNetwork()
            context.route('**/*', network.route)
            page = context.new_page()
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.goto(f'http://127.0.0.1:{server.server_port}/', wait_until='networkidle')
            page.wait_for_function("CodexLocal.billing()==='api'")
            page.evaluate("openModal('apiModal')")
            check(profile + ' API selected without a key', page.locator('#aiProvider').input_value() == 'codex' and page.locator('#openaiKeySettings').is_visible())
            check(profile + ' empty key does not generate', not network.ai_requests)
            page.locator('#openaiApiKey').fill(key)
            page.locator('#openaiSaveKey').click()
            page.wait_for_function("document.getElementById('openaiKeyStatus').textContent.includes('已儲存')")
            check(profile + ' key saved only through server settings', network.saved == [{'apiKey': key}] and page.locator('#openaiApiKey').input_value() == '')
            check(profile + ' no subscription quota displayed', 'API' in page.locator('#codexUsageSummary').inner_text() and page.locator('#codexUsageWindows progress').count() == 0)
            check(profile + ' server models available', page.locator('#codexModel option[value="gpt-6-sol"]').count() == 1)
            check(profile + ' key absent from browser storage', key not in page.evaluate('JSON.stringify([localStorage,sessionStorage])'))
            check(profile + ' settings fit mobile width', page.locator('#openaiKeySettings').evaluate('e=>e.scrollWidth<=e.clientWidth+1') and page.evaluate('document.body.scrollWidth<=innerWidth'))
            page.locator('#openaiKeySettings').screenshot(path=str(output / f'key-settings-{profile}.png'))
            page.evaluate("closeModal('apiModal')")
            page.locator('#openItineraryImport').click()
            page.wait_for_function("!document.getElementById('itinerarySourceText').disabled")
            page.locator('#itinerarySourceText').fill(TEXT)
            page.locator('#itineraryAddCorrection').click()
            page.locator('#itineraryCorrection-0').fill('保留手動補充：晚餐餐盒與茶飲。')
            check(profile + ' import clearly uses API billing', 'API' in page.locator('#itineraryParseButton').inner_text() and 'API 額度' in page.locator('#itineraryPrivacy').inner_text())
            page.locator('#itineraryParseButton').click()
            page.wait_for_function("!isBusy && !document.getElementById('itinerarySaveButton').disabled")
            check(profile + ' import preserves correction and returns usage', '晚餐餐盒' in network.ai_requests[-1]['prompt'] and '20 Token' in page.locator('#codexTokenUsage').text_content())
            check(profile + ' API key never appears in import payload', key not in json.dumps(network.ai_requests))
            page.reload(wait_until='networkidle')
            page.locator('#openItineraryImport').click()
            page.wait_for_function("!document.getElementById('itinerarySourceText').disabled")
            check(profile + ' draft and correction survive reload', page.locator('#itinerarySourceText').input_value() == TEXT and '晚餐餐盒' in page.locator('#itineraryCorrection-0').input_value())
            check(profile + ' no browser errors or DeepSeek fallback', not errors and not network.deepseek_requests)
            context.close()
            browser.close()
    server.shutdown()
    (output / 'report.json').write_text(json.dumps({'checks': checks, 'physical_device': False, 'api': 'mocked'}, indent=2), encoding='utf-8')
    print(json.dumps({'passed': True, 'checks': len(checks)}))


if __name__ == '__main__':
    main()
