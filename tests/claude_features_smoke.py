"""Claude API mode: SVG artwork and itinerary import, with deterministic Claude API stubs.

No paid provider calls are made: api.anthropic.com is answered locally with streamed (SSE) replies.
Run: python tests/claude_features_smoke.py
"""
from __future__ import annotations

import base64
import io
import json
import sys
import threading
from functools import partial
from http.server import ThreadingHTTPServer
from urllib.parse import urlparse

from PIL import Image
from playwright.sync_api import sync_playwright
from browser_smoke import ROOT, ARTIFACTS, Handler, Network, START, sample_day

# Model output is untrusted: this SVG carries a script, an event handler, an external image and a link.
HOSTILE_SVG = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1536 1024" onload="window.svgXss=1">'
               '<script>window.svgXss=2</script><rect width="1536" height="1024" fill="#2f6f73"/>'
               '<circle cx="768" cy="512" r="300" fill="#e2b84a" onclick="window.svgXss=3"/>'
               '<image href="https://example.invalid/x.png" width="10" height="10"/>'
               '<a href="https://example.invalid"><rect width="10" height="10"/></a></svg>')


def sse(text):
    events = [
        ('message_start', {'type': 'message_start', 'message': {'id': 'msg_mock', 'type': 'message', 'role': 'assistant', 'model': 'claude-opus-5-5', 'content': [], 'stop_reason': None, 'stop_sequence': None, 'usage': {'input_tokens': 1000, 'output_tokens': 1}}}),
        ('content_block_start', {'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'text', 'text': ''}}),
        ('content_block_delta', {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'text_delta', 'text': text}}),
        ('content_block_stop', {'type': 'content_block_stop', 'index': 0}),
        ('message_delta', {'type': 'message_delta', 'delta': {'stop_reason': 'end_turn', 'stop_sequence': None}, 'usage': {'output_tokens': 1000}}),
        ('message_stop', {'type': 'message_stop'}),
    ]
    return ''.join(f'event: {name}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n' for name, data in events)


def import_result(images):
    first = sample_day()
    first['summary'] = '費用：午餐自費。'
    return {'city': '台北', 'days': [first], 'warnings': [], 'provisionalDates': [],
            'sourceReviews': [{'index': index + 1, 'status': 'clear', 'message': ''} for index in range(images)]}


class ClaudeNetwork(Network):
    def __init__(self):
        super().__init__()
        self.claude = []

    def route(self, route):
        if urlparse(route.request.url).hostname != 'api.anthropic.com':
            return super().route(route)
        body = route.request.post_data_json
        self.claude.append(body)
        content = body['messages'][0]['content']
        if isinstance(content, str) and '<svg' in content:
            text = '這是插圖：\n' + HOSTILE_SVG
        else:
            images = sum(1 for block in content if isinstance(block, dict) and block.get('type') == 'image')
            text = json.dumps(import_result(images), ensure_ascii=False)
        return route.fulfill(status=200, headers={'content-type': 'text/event-stream', 'access-control-allow-origin': '*'}, body=sse(text))


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    ARTIFACTS.mkdir(exist_ok=True)
    server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory=str(ROOT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f'http://127.0.0.1:{server.server_port}/'
    checks = []

    def check(name, value):
        checks.append(name)
        assert value, name

    big = io.BytesIO()
    Image.new('RGB', (3000, 2000), (200, 120, 80)).save(big, 'PNG')
    with sync_playwright() as p:
        browser = p.chromium.launch()
        context = browser.new_context(viewport={'width': 1440, 'height': 950}, timezone_id='Asia/Taipei')
        network = ClaudeNetwork()
        context.route('**/*', network.route)
        seed = {'i': {'city': '台北', 'hasHotel': False, 'flightArrival': START + 'T08:00', 'flightDeparture': START + 'T20:00'}, 't': [sample_day()]}
        context.add_init_script("""localStorage.setItem('aiProvider','claude');sessionStorage.setItem('claudeApiKey','mock-not-a-real-key');
            if(!localStorage.claudeSeeded){const d=SEED;localStorage.setItem('tripDraft_v27',JSON.stringify(d.i));localStorage.setItem('myTrip_v27',JSON.stringify(d.t));localStorage.claudeSeeded='yes';}""".replace('SEED', json.dumps(seed, ensure_ascii=False)))
        page = context.new_page()
        page.set_default_timeout(20000)
        errors, dialogs = [], []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('dialog', lambda dialog: (dialogs.append(dialog.message), dialog.accept()))
        page.goto(base, wait_until='networkidle')
        page.wait_for_function('tripData.length === 1 && !isBusy')

        # --- SVG artwork ---
        page.evaluate("PlannerUI.switchView('itinerary', false)")
        page.locator('#artworkPanel > summary').click()
        page.wait_for_function("!document.getElementById('generateArtwork').disabled")
        check('Claude mode explains vector artwork', 'Claude' in page.locator('#artworkHelp').text_content())
        total = page.evaluate('TripArtworkCore.targets(document.getElementById("city").value, tripData).length')
        page.locator('#generateArtwork').click()
        page.wait_for_function("document.getElementById('artworkStatus').textContent.includes('已保存') && !isBusy")
        check('confirmation names Claude API billing', any('Claude API' in message for message in dialogs))
        svg_requests = [body for body in network.claude if isinstance(body['messages'][0]['content'], str)]
        check('one Claude drawing request per picture', len(svg_requests) == total)
        check('drawing requests stream with the selected model', all(body['stream'] and body['model'] == 'claude-opus-5-5' for body in svg_requests))
        stored = page.evaluate("""async () => { const refs = TripLibrary.active().data.a; const out = [];
            for (const ref of refs) { const image = await TripArtworkStore.get(ref.assetId); out.push({ mime: image.dataUrl.slice(0, 15), width: image.width, height: image.height }); } return out; }""")
        check('every picture is stored as a raster image', len(stored) == total and all(item['mime'] == 'data:image/jpeg' and item['width'] == 1440 for item in stored))
        check('artwork cards show the saved pictures', page.locator('#artworkList img').count() == total)
        check('hostile SVG content never ran', page.evaluate('window.svgXss === undefined'))
        page.locator('#artworkPanel').screenshot(path=str(ARTIFACTS / 'claude-artwork-panel.png'))


        # --- Itinerary import ---
        page.evaluate("PlannerUI.switchView('settings', false)")
        page.locator('#openItineraryImport').click()
        page.locator('#itineraryImportModal').wait_for(state='visible')
        check('import button names Claude', page.locator('#itineraryParseButton').text_content() == '使用 Claude API 讀取並整合')
        check('privacy note names Anthropic', 'Anthropic' in page.locator('#itineraryPrivacy').text_content())
        page.locator('#itinerarySourceFile').set_input_files({'name': '大圖.png', 'mimeType': 'image/png', 'buffer': big.getvalue()})
        page.wait_for_function('!isBusy')
        page.locator('#itinerarySourceText').fill('台北一日行程\n' + START + '\n09:00 大稻埕街區')
        page.locator('#itineraryParseButton').click()
        page.wait_for_function("!isBusy && !document.getElementById('itinerarySaveButton').disabled")
        request = network.claude[-1]
        blocks = request['messages'][0]['content']
        images = [block for block in blocks if block.get('type') == 'image']
        check('import streams to Claude with a 32k output budget', request['stream'] and request['max_tokens'] == 32000)
        check('import sends the attachment as an image block', len(images) == 1)
        picture = Image.open(io.BytesIO(base64.b64decode(images[0]['source']['data'])))
        check('large attachment is scaled to 1568 px before sending', max(picture.size) == 1568 and images[0]['source']['media_type'] == 'image/jpeg')
        check('import preview is ready to save', page.locator('#itineraryImportPreview').text_content().strip() != '')
        check('no page errors', not errors)
        page.locator('#itineraryImportModal').screenshot(path=str(ARTIFACTS / 'claude-import-preview.png'))
        page.evaluate("closeModal('itineraryImportModal')")

        # --- Usage and monthly budget ---
        requests = total + 1
        month = page.evaluate('ClaudeUsage.month()')
        check('every Claude reply is counted per feature', month['requests'] == requests and month['features']['artwork']['requests'] == total and month['features']['import']['requests'] == 1)
        # Each stub reply is 1,000 input + 1,000 output tokens on Opus 5.5: US$0.024.
        check('cost is estimated from the official prices', abs(month['cost'] - 0.024 * requests) < 1e-9)
        check("header shows this month's estimate", page.locator('#apiStatus').text_content() == f'Claude · 本月 US${0.024 * requests:.2f}')
        page.locator('.header-status').click()
        page.locator('#claudeUsageDetails > summary').click()
        check('collapsed heading already shows the month estimate', page.locator('#claudeUsageSummary').text_content().startswith('本月 US$'))
        check('save button stays in view with usage open', page.evaluate("(() => { const r = document.getElementById('settingsDone').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; })()"))
        check('usage panel lists requests and features', f'{requests} 次請求' in page.locator('#claudeUsageMonth').text_content() and '行程插圖' in page.locator('#claudeUsageDetail').text_content() and '匯入行程' in page.locator('#claudeUsageDetail').text_content())
        page.locator('#claudeBudget').fill('0.05')
        page.locator('#claudeBudget').dispatch_event('change')
        check('budget shows a progress bar', page.locator('#claudeUsageMonth progress').count() == 1 and '上限 US$0.05' in page.locator('#claudeUsageMonth').text_content())
        page.locator('#claudeUsageDetails').screenshot(path=str(ARTIFACTS / 'claude-usage-panel.png'))
        page.evaluate("closeModal('apiModal')")
        sent = len(network.claude)
        page.evaluate("PlannerUI.switchView('itinerary', false)")
        page.locator('#artworkList button').first.click()
        page.wait_for_function("document.getElementById('artworkStatus').textContent.includes('預算') && !isBusy")
        check('a reached budget stops sending before any request', len(network.claude) == sent)
        check('no page errors', not errors)
        browser.close()
    server.shutdown()
    print(f'Claude features: {len(checks)} checks passed')


if __name__ == '__main__':
    main()
