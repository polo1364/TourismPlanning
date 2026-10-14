"""Quota/model UI on desktop and mobile. Generation is always mocked."""
import argparse
import json
import threading
from functools import partial
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright
from browser_smoke import ROOT, ARTIFACTS, Handler, Network, overflow


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--credentials')
    args = parser.parse_args()
    credentials = json.loads(Path(args.credentials).read_text()) if args.credentials else None
    server = None
    if not credentials:
        server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory=str(ROOT)))
        threading.Thread(target=server.serve_forever, daemon=True).start()
    base = credentials['url'] if credentials else f'http://127.0.0.1:{server.server_port}'
    checks, errors = [], []
    completed = False
    def check(name, passed):
        checks.append({'name': name, 'passed': bool(passed)})
        assert passed, name
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            for width in [1440, 390]:
                prefix = f'{width}px '
                options = {'viewport': {'width': width, 'height': 950}, 'is_mobile': width == 390, 'has_touch': width == 390}
                if credentials: options['http_credentials'] = {k: credentials[k] for k in ['username', 'password']} | {'origin': base}
                context = browser.new_context(**options)
                net = Network()
                state = {'fail': False, 'missing': False, 'calls': []}
                def route(r):
                    url = urlparse(r.request.url)
                    headers = {'Access-Control-Allow-Origin': r.request.headers.get('origin', '*'), 'Access-Control-Allow-Headers': 'Content-Type, X-Roam-Token'}
                    bridge = url.hostname == '127.0.0.1' and url.port == 8081
                    cloud = credentials and url.hostname == urlparse(base).hostname
                    if bridge or cloud:
                        if r.request.method == 'OPTIONS': return r.fulfill(status=204, headers=headers)
                        if url.path.endswith('/generate'):
                            state['calls'].append(r.request.post_data_json)
                            data = {'data': {'ok': True}, 'usage': {'inputTokens': 100, 'outputTokens': 20, 'cachedInputTokens': 40, 'totalTokens': 120}}
                            return r.fulfill(content_type='application/json', headers=headers, body=json.dumps(data))
                        if cloud: return r.continue_()
                        if url.path == '/status': return r.fulfill(content_type='application/json', headers=headers, body=json.dumps({'ready': True, 'auth': 'chatgpt', 'token': 'fixture'}))
                        if url.path == '/usage':
                            info = {'available': not state['fail'], 'checkedAt': '2026-10-14T15:00:00Z', 'models': [] if state['missing'] else [{'id': 'fixture-model', 'name': 'Fixture', 'isDefault': True}],
                                    'limits': [] if state['fail'] else [{'id': 'codex', 'name': 'codex', 'windows': [{'usedPercent': 32, 'remainingPercent': 68, 'windowDurationMins': 10080, 'resetsAt': 1792498467}]}]}
                            return r.fulfill(content_type='application/json', headers=headers, body=json.dumps(info))
                    return net.route(r)
                context.route('**/*', route)
                page = context.new_page()
                page.on('pageerror', lambda e: errors.append(str(e)))
                page.goto(base, wait_until='networkidle')
                page.wait_for_function("document.querySelector('#codexModel').options.length > 1", timeout=30000)
                check(prefix+'quota received', page.locator('#codexUsageSummary').is_visible() and '剩餘' in page.locator('#codexUsageSummary').inner_text())
                check(prefix+'header fits', not overflow(page)['overflow'])
                page.locator('#codexUsageSummary').click()
                page.wait_for_function("!document.querySelector('#codexUsageRefresh').disabled")
                check(prefix+'quota has reset', '重置' in page.locator('#codexUsageWindows').inner_text())
                model = page.locator('#codexModel option').nth(1).get_attribute('value')
                page.locator('#codexModel').select_option(model)
                page.evaluate('setBusy(true)')
                check(prefix+'model locked while generating', page.locator('#codexModel').is_disabled())
                page.evaluate('setBusy(false)')
                check(prefix+'model unlocks after generating', not page.locator('#codexModel').is_disabled())
                for _ in range(2): page.evaluate("CodexLocal.generate('fixture only')")
                check(prefix+'selected model submitted', len(state['calls']) == 2 and all(c['model'] == model for c in state['calls']))
                check(prefix+'tokens count once', '240 Token' in page.locator('#codexTokenUsage').inner_text() and '含快取 40' in page.locator('#codexTokenUsage').inner_text())
                check(prefix+'modal fits', page.locator('#apiModal .modal-content').evaluate('(e)=>e.scrollWidth <= e.clientWidth + 1'))
                page.evaluate('window.TripMotion?.settle()')
                page.screenshot(path=str(ARTIFACTS / f'codex-usage-{width}{"-cloud" if credentials else ""}.png'))
                page.reload(wait_until='networkidle')
                page.wait_for_function("document.querySelector('#codexModel').options.length > 1", timeout=30000)
                check(prefix+'model preference survives reload', page.locator('#codexModel').input_value() == model)
                check(prefix+'tokens honestly reset on reload', '尚無生成用量' in page.locator('#codexTokenUsage').inner_text())
                if not credentials:
                    state['fail'] = True
                    page.evaluate('CodexLocal.refreshUsage()')
                    check(prefix+'unknown quota is not zero', '待查' in page.locator('#codexUsageSummary').inner_text() and page.locator('#codexUsageWindows').inner_text() == '')
                    state['missing'] = True
                    page.evaluate('CodexLocal.refreshUsage()')
                    failure = page.evaluate("CodexLocal.generate('must not send').then(()=>'', e=>e.message)")
                    check(prefix+'missing model never silently switches', '模型' in failure and len(state['calls']) == 2)
                context.close()
            check('no browser errors', not errors)
            completed = True
            browser.close()
    finally:
        if server: server.shutdown()
        report = {'passed': completed and all(c['passed'] for c in checks), 'completed': completed, 'checks': checks, 'errors': errors, 'scope': 'Desktop/mobile Chromium; generation mocked; quota/model reads '+('real cloud' if credentials else 'fixtures')}
        (ARTIFACTS / ('codex-usage-cloud-report.json' if credentials else 'codex-usage-ui-report.json')).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'passed': report['passed'], 'checks': len(checks), 'real_generation_calls': 0}))


if __name__ == '__main__': main()
