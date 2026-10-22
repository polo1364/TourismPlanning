"""Import activity feedback and readable summaries, with isolated storage and mocked AI."""
from functools import partial
from collections import Counter
import re
from http.server import ThreadingHTTPServer
import json
from pathlib import Path
import threading

from playwright.sync_api import sync_playwright
from browser_smoke import ROOT, Handler, sample_day
from itinerary_import_smoke import ImportNetwork, TEXT


def main():
    output = ROOT / 'artifacts/category-notes'
    output.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory=str(ROOT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    checks = []
    def check(name, result):
        checks.append({'name': name, 'passed': bool(result)})
        assert result, name
    day = sample_day()
    notes = '日期暫定：2027 年 5 月中旬，共 6 天含六日。\n人工補充：日期先隨意，晚餐餐盒加茶飲。\n'
    notes += '團費：成人每人 38,500 元；兒童費用依原文確認。住宿：兩人一室，單人房另加價；房型待確認。提醒：自備飲用水。' * 8
    notes += '\n交通：搭乘遊覽車，接送時間待確認。\n'
    notes += '\n最後一條重要提醒：攜帶白色預約卡。<img src=x onerror="window.summaryInjected=1">'
    day['summary'] = '日期暫定（依人工授權選定，尚未確認）\n高雄小港機場出發，抵達大阪後前往飯店。早餐與午餐依原文確認；晚餐為餐盒加茶飲。\n匯入核對事項\n' + notes
    def fragments(texts):
        return Counter(''.join(part.split()) for text in texts for part in re.split(r'(?<=[。；！？·])|[\r\n]+', text) if part.strip())
    with sync_playwright() as p:
        for profile in ['desktop', 'android', 'iphone']:
            browser = (p.webkit if profile == 'iphone' else p.chromium).launch()
            device = p.devices['iPhone 13' if profile == 'iphone' else 'Pixel 7'] if profile != 'desktop' else {'viewport': {'width': 1440, 'height': 1000}}
            context = browser.new_context(**device, accept_downloads=True)
            network = ImportNetwork()
            context.route('**/*', network.route)
            page = context.new_page()
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.goto(f'http://127.0.0.1:{server.server_port}/', wait_until='networkidle')
            page.clock.install()
            page.locator('#openItineraryImport').click()
            page.wait_for_function("!document.getElementById('itinerarySourceText').disabled")
            page.locator('#itinerarySourceText').fill(TEXT)
            page.locator('#itineraryAddCorrection').click()
            page.locator('#itineraryCorrection-0').fill('補充：請保留晚餐餐盒與茶飲。')
            network.hold_ai = True
            page.locator('#itineraryParseButton').click()
            page.wait_for_function("document.getElementById('itineraryWorkPanel').classList.contains('is-running')")
            page.wait_for_timeout(200)
            check(profile + ' active spinner and real Codex stage', page.locator('.import-work-spinner').is_visible() and 'Codex' in page.locator('#itineraryWorkTitle').inner_text())
            page.clock.fast_forward(65000)
            check(profile + ' elapsed timer and honest waiting hint', '01:' in page.locator('#itineraryWorkElapsed').inner_text() and '尚未收到' in page.locator('#itineraryWorkHint').inner_text())
            check(profile + ' no invented completion percentage', page.locator('.import-work-track').get_attribute('aria-valuenow') is None)
            check(profile + ' pending feedback fits viewport width', page.locator('#itineraryWorkPanel').evaluate('e=>e.scrollWidth<=e.clientWidth+1'))
            page.locator('#itineraryWorkPanel').screenshot(path=str(output / f'working-{profile}.png'))
            page.emulate_media(reduced_motion='reduce')
            check(profile + ' reduced motion disables spinner', page.locator('.import-work-spinner').evaluate("e=>getComputedStyle(e).animationName==='none'"))
            page.locator('#itineraryImportCancel').click()
            timer = page.locator('#itineraryWorkElapsed').text_content()
            page.clock.fast_forward(3000)
            check(profile + ' cancellation stops indicator and timer', not page.locator('#itineraryWorkHeading').is_visible() and page.locator('#itineraryWorkElapsed').text_content() == timer)
            check(profile + ' cancellation keeps sources and correction', page.locator('#itinerarySourceText').input_value() == TEXT and '餐盒' in page.locator('#itineraryCorrection-0').input_value())
            network.release()
            network.result = {'error': '來源看不清楚，請補充內容。'}
            network.hold_ai = False
            page.locator('#itineraryParseButton').click()
            page.wait_for_function("!isBusy && !document.getElementById('itineraryImportError').hidden")
            check(profile + ' failure stops indicator and keeps correction', not page.locator('#itineraryWorkHeading').is_visible() and '餐盒' in page.locator('#itineraryCorrection-0').input_value())
            network.result = {'city': '台北', 'days': [sample_day()], 'warnings': ['日期待確認。費用需核對；請保留原始文件。']}
            page.locator('#itineraryParseButton').click()
            page.wait_for_function("!isBusy && !document.getElementById('itinerarySaveButton').disabled")
            check(profile + ' success stops indicator and groups notes', not page.locator('#itineraryWorkHeading').is_visible() and page.locator('.import-preview-notes > h5').is_visible())
            page.locator('#itineraryImportClose').click()
            page.evaluate("async day=>{tripData=[day];generationState=null;await renderTrip()}", day)
            page.locator('#itineraryTab').click()
            before = page.evaluate('JSON.stringify(tripData)')
            check(profile + ' saved summaries split into paragraphs', page.locator('.summary-overview p').count() >= 3)
            check(profile + ' review notes collapsed separately from route', page.locator('.summary-review').get_attribute('open') is None and page.locator('.day-schedule').is_visible())
            page.locator('.summary-review > summary').click()
            actual = page.locator('.summary-review-copy p').all_text_contents()
            check(profile + ' every original note retained exactly once', fragments(actual) == fragments([notes]))
            for key, expected in [('cost', '38,500'), ('stay', '單人房另加價'), ('transport', '遊覽車'), ('attention', '白色預約卡'), ('source', '日期先隨意')]:
                check(profile + ' classified ' + key, expected in page.locator('.summary-review-copy .summary-category-' + key).inner_text())
            check(profile + ' note markup escaped', page.evaluate('window.summaryInjected') is None and page.locator('.summary-review-copy img').count() == 0)
            check(profile + ' notes and main page fit viewport', page.locator('.summary-review-copy').evaluate('e=>e.scrollWidth<=e.clientWidth+1') and page.evaluate('document.body.scrollWidth<=innerWidth'))
            page.locator('.summary-review').screenshot(path=str(output / f'notes-{profile}.png'))
            check(profile + ' formatting does not change saved data', page.evaluate('JSON.stringify(tripData)') == before)
            if profile in ['desktop', 'android', 'iphone']:
                with page.expect_download() as download:
                    page.locator('#downloadBook').click()
                file = output / f'readable-book-{profile}.html'
                download.value.save_as(str(file))
                reader = browser.new_page(**device)
                reader.goto(file.as_uri(), wait_until='networkidle')
                check(profile + ' export preserves every note once', fragments(reader.locator('.summary-review-copy p').all_text_contents()) == fragments([notes]))
                check(profile + ' export has topic blocks', reader.locator('.summary-review-copy .summary-category').count() == 6)
                reader.wait_for_function("() => document.body.dataset.readerReady === 'true'")
                reader.locator('#pagePicker').select_option('1')
                clipped = reader.locator('#page-1').evaluate('''flow => {
                    const base = flow.getBoundingClientRect(), stride = base.width + parseFloat(getComputedStyle(flow).columnGap);
                    const count = Number(flow.dataset.leaves), walker = document.createTreeWalker(flow, NodeFilter.SHOW_TEXT);
                    let node; const bad = [];
                    while (node = walker.nextNode()) {
                        if (!node.textContent.trim()) continue;
                        const range = document.createRange(); range.selectNodeContents(node);
                        for (const r of range.getClientRects()) {
                            if (!r.width || !r.height) continue;
                            const col = Math.floor((r.left - base.left + .5) / stride);
                            if (r.top < base.top - 2 || r.bottom > base.bottom + 2 || col >= count || r.right > base.left + col * stride + base.width + 2) bad.push(node.textContent.slice(0, 30));
                        }
                    }
                    return bad;
                }''')
                check(profile + ' every categorized booklet text fragment fits', not clipped or print(clipped[:5]))
                check(profile + ' booklet and controls fit viewport', reader.evaluate('document.body.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight'))
                # Show the actual category page rather than the cover.
                while not reader.locator('#next').is_disabled():
                    reader.locator('#next').click()
                    reader.wait_for_function('() => !document.body.dataset.turning')
                    if reader.locator('.summary-review-copy .summary-category-cost h5').evaluate('e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.left<innerWidth}'):
                        break
                reader.screenshot(path=str(output / f'book-{profile}.png'))
                reader.emulate_media(media='print')
                check(profile + ' print expands all topic content', reader.locator('.summary-review-copy .summary-category:visible').count() == 6)
                check('export review follows activities and is not collapsed', reader.locator('details.summary-review').count() == 0 and reader.locator('.manual-details > .summary-review').count() == 1)
                reader.close()
            check(profile + ' no browser errors', not errors)
            context.close()
            browser.close()
    server.shutdown()
    (output / 'report.json').write_text(json.dumps({'passed': True, 'checks': checks, 'physical_device': False, 'ai': 'mocked'}, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'passed': True, 'checks': len(checks)}))


if __name__ == '__main__':
    main()
