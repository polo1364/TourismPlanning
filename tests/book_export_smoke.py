"""Download the actual standalone booklet and read it from file:// offline."""
import json
import threading
from functools import partial
from http.server import ThreadingHTTPServer
from playwright.sync_api import sync_playwright
from browser_smoke import ROOT, ARTIFACTS, Handler, Network, sample_day, overflow


def main():
    server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory=str(ROOT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    ARTIFACTS.mkdir(exist_ok=True)
    checks = []

    def check(name, result):
        checks.append({'name': name, 'passed': bool(result)})
        assert result, name

    days = [sample_day(), sample_day('2026-11-11', '牧場與湖畔漫遊')]
    days[0]['summary'] = '取消瑞穗牧場、北回歸線標誌公園與公正包子，下午僅安排雲山水夢幻湖。'
    note = '只收現金，記得帶水。\n</script><img src=x onerror="window.injected=true">'
    days[0]['itinerary'][0]['userNote'] = note
    days[1]['itinerary'][0]['title'] = '長景點名稱' * 25
    days[1]['itinerary'][0]['desc'] = '沿途請預留休息時間。' * 120
    days[1]['itinerary'][0]['booking'] = True
    days[1]['itinerary'][0]['userNote'] = '長提醒：記得帶水與零錢，保留休息時間。\n' * 40

    with sync_playwright() as p:
        browser = p.chromium.launch()
        context = browser.new_context(accept_downloads=True, viewport={'width': 1440, 'height': 1000})
        network = Network()
        context.route('**/*', network.route)
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(f'http://127.0.0.1:{server.server_port}/', wait_until='networkidle')
        page.evaluate('''async days => {
            sessionStorage.setItem('deepseekApiKey', 'PRIVATE_KEY_MUST_NOT_EXPORT');
            localStorage.setItem('unrelated-journey', 'OTHER_TRIP_MUST_NOT_EXPORT');
            tripData = days; generationState = {city:'台北與花蓮', apiKey:'STATE_KEY_MUST_NOT_EXPORT'};
            await renderTrip();
        }''', days)
        page.locator('#itineraryTab').click()
        before = page.evaluate('JSON.stringify(tripData)')
        with page.expect_download() as download:
            page.locator('#downloadBook').click()
        output = ARTIFACTS / 'travel-book-preview.html'
        download.value.save_as(str(output))
        page.wait_for_function('!isBusy')
        content = output.read_text(encoding='utf-8')
        check('HTML filename', download.value.suggested_filename.endswith('_旅行小冊.html'))
        check('all days despite paged mode', content.count('class="book-page"') == 2)
        check('state unchanged', page.evaluate('JSON.stringify(tripData)') == before)
        check('no settings or other trips', all(value not in content for value in ['PRIVATE_KEY_MUST_NOT_EXPORT', 'OTHER_TRIP_MUST_NOT_EXPORT', 'STATE_KEY_MUST_NOT_EXPORT', 'localStorage', 'sessionStorage']))
        check('cover embedded and compressed', 'data:image/jpeg;base64,' in content and output.stat().st_size < 1500000)
        check('no app handlers', 'onclick=' not in content and 'PlannerUI' not in content)
        check('success feedback', '已下載' in page.locator('#bookExportStatus').inner_text())
        check('download explains iPhone preview limitation', '檔案' in page.locator('#bookExportStatus').inner_text() and 'Safari' in page.locator('#bookExportStatus').inner_text())
        check('no export runtime errors', not errors)
        page.set_viewport_size({'width': 320, 'height': 800})
        check('mobile export button fits', not overflow(page)['overflow'] and page.locator('#downloadBook').is_visible())

        # Missing art degrades to a usable booklet rather than aborting the download.
        page.route('**/assets/roam-*.png', lambda route: route.abort())
        with page.expect_download() as fallback_download:
            page.locator('#downloadBook').click()
        fallback = ARTIFACTS / 'travel-book-no-art.html'
        fallback_download.value.save_as(str(fallback))
        check('missing art still downloads', 'data:image/jpeg;base64,' not in fallback.read_text(encoding='utf-8'))
        page.wait_for_function('!isBusy')
        page.evaluate('''() => { window.savedDownloadBlob = downloadBlob; downloadBlob = () => { throw new Error('test download failure'); }; }''')
        page.locator('#downloadBook').click()
        page.wait_for_function('!isBusy')
        check('download failure visible and re-enabled', 'test download failure' in page.locator('#bookExportStatus').inner_text() and page.locator('#downloadBook').is_enabled())
        check('failure preserves trip', page.evaluate('JSON.stringify(tripData)') == before)
        # Keep presentation artifacts separate from malicious-input regression fixtures.
        page.unroute('**/assets/roam-*.png')
        demo_days = [sample_day('2026-11-07', '花東縱谷慢旅行')]
        demo_days[0]['summary'] = '前往瑞穗牧場散步，晚間走訪東大門夜市。'
        demo_days[0]['itinerary'][0].update(title='瑞穗牧場', desc='草地散步，欣賞縱谷風景。', address='花蓮縣瑞穗鄉',
            userNote='記得帶水、防曬與零錢。\n熱門店家請預留等候時間。', transit=[])
        demo_days[0]['itinerary'][1].update(title='東大門夜市晚餐與散步', time='18:00', desc='直接在夜市享用晚餐，不另安排餐廳。', address='花蓮市', cost='依實際消費', tips='預留步行與休息時間。')
        page.evaluate('''async days => { downloadBlob = window.savedDownloadBlob; tripData = days; generationState = {city:'花東旅行示範'}; await renderTrip(); }''', demo_days)
        with page.expect_download() as demo_download:
            page.locator('#downloadBook').click()
        demo_path = ARTIFACTS / 'travel-manual-demo.html'
        demo_download.value.save_as(str(demo_path))
        check('demo has no security fixture', 'window.injected' not in demo_path.read_text(encoding='utf-8'))
        context.close()

        requests = []
        offline = browser.new_context(offline=True, viewport={'width': 1440, 'height': 1000}, reduced_motion='reduce', has_touch=True)
        reader = offline.new_page()
        reader.on('request', lambda request: requests.append(request.url) if request.url.startswith(('http:', 'https:')) else None)
        reader.on('pageerror', lambda error: errors.append(str(error)))
        reader.goto(output.as_uri(), wait_until='load')
        reader.wait_for_function("document.body.dataset.readerReady === 'true'")
        check('file opens offline on cover', reader.locator('#page-0').is_visible() and '頁' in reader.locator('#pageNumber').inner_text())
        check('static preview notice absent with JavaScript', reader.locator('.preview-notice').count() == 0)
        check('first boundary disabled', reader.locator('#previous').is_disabled())
        check('only one page visible', reader.locator('.book-page:visible').count() == 1)
        reader.screenshot(path=str(ARTIFACTS / 'travel-book-cover-1440.png'), full_page=True)
        reader.locator('.toc a').first.click()
        check('table of contents navigation', reader.locator('#page-1').is_visible())
        check('note text preserved literally', reader.locator('#page-1 .stop-note-text').inner_text() == note)
        check('injection remains text', reader.evaluate('window.injected !== true') and reader.locator('#page-1 img, #page-1 script').count() == 0)
        check('inline name stickers', reader.locator('#page-1 .chapter-intro .inline-place').count() >= 3)
        check('read-only notes', reader.locator('.note-open,.note-pencil,.stop-edit').count() == 0)
        check('map link retained', reader.locator('.table-map-link').first.get_attribute('href').startswith('https://www.google.com/maps/'))
        check('routes included as paginated text', reader.locator('#page-1 .transit-details .transit-option').count() > 0 and reader.locator('details').count() == 0)
        old = reader.locator('body').get_attribute('data-reader-page')
        reader.keyboard.press('ArrowRight')
        check('keyboard next', int(reader.locator('body').get_attribute('data-reader-page')) == int(old) + 1)
        reader.keyboard.press('End')
        check('last boundary', reader.locator('#page-2').is_visible() and reader.locator('#next').is_disabled())
        last_counter = reader.locator('#pageNumber').inner_text()
        reader.keyboard.press('ArrowRight')
        check('keyboard cannot move past last', reader.locator('#pageNumber').inner_text() == last_counter)
        reader.locator('#previous').click()
        check('previous button', not reader.locator('#next').is_disabled())
        reader.locator('#pagePicker').select_option('2')
        check('picker navigates', reader.locator('#page-2').is_visible())
        check('long description not truncated', len(reader.locator('#page-2 .stop-description').first.inner_text()) > 1000)
        for width, height in [(320, 568), (390, 844), (760, 1000), (1440, 1000), (844, 390)]:
            reader.set_viewport_size({'width': width, 'height': height})
            reader.evaluate('() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
            for index in ['0', '1', '2']:
                reader.locator('#pagePicker').select_option(index)
                check(f'{width} page {index} no horizontal overflow', not overflow(reader)['overflow'])
                check(f'{width} page {index} book and controls stay in viewport', reader.evaluate('''() => document.body.scrollWidth <= innerWidth && [...document.querySelectorAll('.sheet-window:not([hidden]),.reader-nav,.reader-controls,#printBook')].every(el => {
                    const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight;
                })'''))
                check(f'{width} page {index} no vertical scrolling', reader.evaluate('document.documentElement.scrollHeight <= innerHeight && document.body.scrollHeight <= innerHeight'))
                # Inspect every text fragment in all columns, including pages still offscreen.
                # No clipped lines, overflowing long names or lost trailing columns are allowed.
                fragments = reader.locator(f'#page-{index}').evaluate('''flow => {
                    const base = flow.getBoundingClientRect();
                    const style = getComputedStyle(flow), gap = parseFloat(style.columnGap);
                    const stride = base.width + gap, count = Number(flow.dataset.leaves);
                    const walker = document.createTreeWalker(flow, NodeFilter.SHOW_TEXT);
                    const bad = []; let node;
                    while (node = walker.nextNode()) {
                        if (!node.textContent.trim()) continue;
                        const range = document.createRange(); range.selectNodeContents(node);
                        for (const rect of range.getClientRects()) {
                            if (!rect.width || !rect.height) continue;
                            const col = Math.floor((rect.left - base.left + .5) / stride);
                            if (rect.top < base.top - 2 || rect.bottom > base.bottom + 2 || col >= count || rect.right > base.left + col * stride + base.width + 2)
                                bad.push({text:node.textContent.slice(0,30),top:rect.top-base.top,bottom:rect.bottom-base.bottom,col,count});
                        }
                    }
                    return bad;
                }''')
                check(f'{width} page {index} every text fragment fits', not fragments or print(fragments[:8]))
            reader.locator('#pagePicker').select_option('1')
            if width in [390, 1440]:
                reader.screenshot(path=str(ARTIFACTS / f'book-security-fixture-{width}.png'), full_page=True)
            reader.keyboard.press('Home')
            turns = 0
            while not reader.locator('#next').is_disabled():
                reader.locator('#next').click()
                turns += 1
                assert turns < 150, 'pagination failed to terminate'
            check(f'{width} every spread reachable', turns > 2 and reader.locator('#page-2').is_visible())
            reader.mouse.wheel(0, 900)
            check(f'{width} wheel never scrolls book', reader.evaluate('scrollY === 0 && scrollX === 0'))
        reader.set_viewport_size({'width': 390, 'height': 844})
        reader.evaluate('() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
        reader.locator('#pagePicker').select_option('1')
        old = reader.locator('body').get_attribute('data-reader-page')
        reader.evaluate('''() => {
            const main = document.querySelector('main');
            main.dispatchEvent(new TouchEvent('touchstart', {bubbles:true, touches:[new Touch({identifier:1,target:main,clientX:320,clientY:400})]}));
            main.dispatchEvent(new TouchEvent('touchend', {bubbles:true, changedTouches:[new Touch({identifier:1,target:main,clientX:90,clientY:410})]}));
        }''')
        check('mobile swipe advances', int(reader.locator('body').get_attribute('data-reader-page')) == int(old) + 1)
        old = reader.locator('body').get_attribute('data-reader-page')
        reader.evaluate('''() => {
            const main = document.querySelector('main');
            main.dispatchEvent(new TouchEvent('touchstart', {bubbles:true, touches:[new Touch({identifier:1,target:main,clientX:100,clientY:200})]}));
            main.dispatchEvent(new TouchEvent('touchend', {bubbles:true, changedTouches:[new Touch({identifier:1,target:main,clientX:180,clientY:500})]}));
        }''')
        check('vertical gesture does not turn page', reader.locator('body').get_attribute('data-reader-page') == old)
        reader.emulate_media(media='print')
        reader.evaluate("window.dispatchEvent(new Event('beforeprint'))")
        check('print includes all chapters', reader.locator('.book-page:visible').count() == 3)
        check('print includes routes', reader.locator('.transit-option:visible').count() == 2)
        reader.evaluate("window.dispatchEvent(new Event('afterprint'))")
        reader.emulate_media(media='screen')
        reader.evaluate('() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
        check('print restores reader', reader.locator('.book-page:visible').count() == 1)
        reader.emulate_media(media='print')
        pdf = reader.pdf(path=str(ARTIFACTS / 'travel-book-print.pdf'), format='A4', print_background=True)
        check('actual PDF generated', pdf.startswith(b'%PDF-') and len(pdf) > 10000)
        check('no external requests in standalone', not requests)
        check('no reader runtime errors', not errors)
        reader.emulate_media(media='screen')
        for width, height in [(1440, 1000), (390, 844)]:
            reader.set_viewport_size({'width':width,'height':height})
            reader.goto(demo_path.as_uri())
            reader.wait_for_function("document.body.dataset.readerReady === 'true'")
            reader.select_option('#pagePicker', '1')
            reader.evaluate('document.activeElement.blur()')
            reader.screenshot(path=str(ARTIFACTS / f'travel-manual-demo-{width}.png'))
            check(f'{width} demo notes are user text only', reader.locator('.stop-note-text').inner_text() == demo_days[0]['itinerary'][0]['userNote'])
        offline.close()
        no_js = browser.new_context(java_script_enabled=False, offline=True)
        plain = no_js.new_page()
        plain.goto(output.as_uri())
        check('all content readable without JavaScript', plain.locator('.book-page:visible').count() == 3 and plain.locator('.reader-nav').is_hidden())
        check('static preview explains why flipping is unavailable', plain.locator('.preview-notice').is_visible() and '無法翻頁' in plain.locator('.preview-notice').inner_text())
        no_js.close()
        # Real touch input through Chromium, including a swipe starting on a TOC link.
        touch_context = browser.new_context(**p.devices['iPhone 13'], reduced_motion='reduce')
        touch_page = touch_context.new_page()
        touch_page.goto(demo_path.as_uri())
        touch_page.wait_for_function("document.body.dataset.readerReady === 'true'")
        cdp = touch_context.new_cdp_session(touch_page)
        link_box = touch_page.locator('.toc a').first.bounding_box()
        x, y = link_box['x'] + link_box['width'] - 24, link_box['y'] + 24
        old = int(touch_page.locator('body').get_attribute('data-reader-page'))
        cdp.send('Input.dispatchTouchEvent', {'type':'touchStart','touchPoints':[{'x':x,'y':y}]})
        for distance in [30, 60, 90, 120, 150]:
            cdp.send('Input.dispatchTouchEvent', {'type':'touchMove','touchPoints':[{'x':x-distance,'y':y+2}]})
        cdp.send('Input.dispatchTouchEvent', {'type':'touchEnd','touchPoints':[]})
        check('native touch swipe from TOC link advances exactly one page', int(touch_page.locator('body').get_attribute('data-reader-page')) == old + 1)
        touch_page.locator('#previous').tap()
        # Wait for the gesture's click suppression window, then test an ordinary tap.
        touch_page.wait_for_timeout(550)
        touch_page.locator('.toc a').first.tap()
        check('ordinary TOC tap still opens chapter', touch_page.locator('#page-1').is_visible())
        touch_context.close()
        for width, height in [(1440, 1000), (390, 844)]:
            motion = browser.new_context(offline=True, viewport={'width':width,'height':height}, reduced_motion='no-preference', has_touch=True)
            flip = motion.new_page()
            flip.on('pageerror', lambda error: errors.append(str(error)))
            flip.goto(demo_path.as_uri())
            flip.wait_for_function("document.body.dataset.readerReady === 'true'")
            flip.evaluate('() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
            flip.locator('#next').click()
            check(f'{width} forward leaf animation exists', flip.locator('.page-turn.forward .turn-leaf').count() == 1)
            geometry = flip.evaluate('''() => {
                const leaf = document.querySelector('.turn-leaf');
                const animation = leaf.getAnimations()[0];
                for (const a of document.querySelector('main').getAnimations({subtree:true})) { a.pause(); a.currentTime = 240; }
                const sheet = document.querySelector('main > .sheet-window:not([hidden])');
                return {end:animation.effect.getKeyframes().at(-1).transform,origin:getComputedStyle(leaf).transformOrigin,
                    stationary:getComputedStyle(sheet).transform,inert:document.querySelector('.page-turn').inert,
                    layerWidth:leaf.offsetWidth,bookWidth:document.querySelector('main').clientWidth,
                    duplicateIds:document.querySelectorAll('.page-turn [id]').length};
            }''')
            check(f'{width} next turns right to left', geometry['end'] == 'rotateY(-180deg)' and geometry['origin'].startswith('0px'))
            check(f'{width} only leaf moves and copies are inert', geometry['stationary'] == 'none' and geometry['inert'] and geometry['duplicateIds'] == 0)
            check(f'{width} correct half or full leaf', abs(geometry['layerWidth'] - geometry['bookWidth'] / (2 if width >= 900 else 1)) <= 1)
            flip.screenshot(path=str(ARTIFACTS / f'travel-manual-turn-{width}.png'), animations='allow')
            flip.evaluate("document.querySelector('main').getAnimations({subtree:true}).forEach(a => a.play())")
            flip.wait_for_function('() => !document.body.dataset.turning')
            check(f'{width} completed flip cleans snapshots', flip.locator('.page-turn').count() == 0)
            flip.locator('#previous').click()
            check(f'{width} previous turns in reverse', flip.evaluate("document.querySelector('.turn-leaf').getAnimations()[0].effect.getKeyframes().at(-1).transform === 'rotateY(180deg)'"))
            # Rapid inputs settle the previous sheet before starting another one.
            flip.locator('#next').click()
            check(f'{width} rapid next previous has one layer', flip.locator('.page-turn').count() == 1)
            flip.set_viewport_size({'width':width-10,'height':height-10})
            flip.wait_for_function('() => !document.body.dataset.turning')
            check(f'{width} resize cleans animation', flip.locator('.page-turn').count() == 0)
            flip.locator('#previous').click()
            flip.emulate_media(reduced_motion='reduce')
            flip.wait_for_function('() => !document.body.dataset.turning')
            flip.locator('#next').click()
            check(f'{width} reduced motion navigates without flip', flip.locator('.page-turn').count() == 0)
            flip.emulate_media(reduced_motion='no-preference')
            flip.locator('#previous').click()
            flip.evaluate("window.dispatchEvent(new Event('beforeprint'))")
            check(f'{width} print removes animated copies', flip.locator('.page-turn').count() == 0)
            motion.close()
        # Finger-driven turns: a short drag falls back, a long drag completes exactly one page.
        drag_context = browser.new_context(offline=True, viewport={'width':390,'height':844}, reduced_motion='no-preference', has_touch=True, is_mobile=True)
        drag = drag_context.new_page()
        drag.on('pageerror', lambda error: errors.append(str(error)))
        drag.goto(demo_path.as_uri())
        drag.wait_for_function("document.body.dataset.readerReady === 'true'")
        drag_cdp = drag_context.new_cdp_session(drag)
        def swipe(distance, settle=True):
            box = drag.locator('main').bounding_box()
            x, y = box['x'] + box['width'] - 30, box['y'] + box['height'] / 2
            drag_cdp.send('Input.dispatchTouchEvent', {'type':'touchStart','touchPoints':[{'x':x,'y':y}]})
            for step in range(1, 9):
                drag_cdp.send('Input.dispatchTouchEvent', {'type':'touchMove','touchPoints':[{'x':x - distance * step / 8,'y':y + 1}]})
                drag.wait_for_timeout(30)
            mid = drag.evaluate("document.querySelector('.page-turn .turn-leaf') ? getComputedStyle(document.querySelector('.turn-leaf')).transform : null")
            drag_cdp.send('Input.dispatchTouchEvent', {'type':'touchEnd','touchPoints':[]})
            if settle: drag.wait_for_function('() => !document.body.dataset.turning')
            return mid
        start = int(drag.locator('body').get_attribute('data-reader-page'))
        mid = swipe(60)
        check('drag moves the leaf under the finger', mid not in (None, 'none'))
        check('short slow drag falls back to the same page', int(drag.locator('body').get_attribute('data-reader-page')) == start and drag.locator('.page-turn').count() == 0)
        swipe(260)
        check('long drag turns exactly one page', int(drag.locator('body').get_attribute('data-reader-page')) == start + 1 and drag.locator('.page-turn').count() == 0)
        drag.locator('#pagePicker').select_option('1')
        check('first visit to a day plays the arrival stamp', drag.evaluate("!!document.querySelector('.sheet-window.arriving:not([hidden])')"))
        # Landscape phones: two-page spread and floating toolbars that hide after reading starts.
        drag.set_viewport_size({'width':844,'height':390})
        drag.wait_for_function("() => document.body.dataset.spread === '2'")
        check('landscape phone opens a two-page spread', drag.locator('body').get_attribute('data-spread') == '2')
        box = drag.locator('main').bounding_box()
        tap = {'x': box['x'] + box['width'] / 2, 'y': box['y'] + box['height'] / 2}
        drag_cdp.send('Input.dispatchTouchEvent', {'type':'touchStart','touchPoints':[tap]})
        drag_cdp.send('Input.dispatchTouchEvent', {'type':'touchEnd','touchPoints':[]})
        check('tap on the page hides the landscape toolbars', drag.locator('body').get_attribute('data-chrome') == 'hidden')
        drag_cdp.send('Input.dispatchTouchEvent', {'type':'touchStart','touchPoints':[tap]})
        drag_cdp.send('Input.dispatchTouchEvent', {'type':'touchEnd','touchPoints':[]})
        check('second tap shows the toolbars again', drag.locator('body').get_attribute('data-chrome') is None)
        drag.wait_for_function("() => document.body.dataset.chrome === 'hidden'", timeout=6000)
        check('toolbars fade away while reading', True)
        check('landscape book fills the height', drag.evaluate("document.querySelector('main').getBoundingClientRect().height > innerHeight - 30"))
        drag.screenshot(path=str(ARTIFACTS / 'travel-manual-landscape-844.png'))
        drag_context.close()
        check('no animation runtime errors', not errors)
        browser.close()
        # WebKit engine checks are not a substitute for iPhone Files/Quick Look.
        webkit = p.webkit.launch()
        safari_context = webkit.new_context(**p.devices['iPhone 13'], reduced_motion='reduce')
        safari = safari_context.new_page()
        safari_errors = []
        safari.on('pageerror', lambda error: safari_errors.append(str(error)))
        for protocol, url in [('file', demo_path.as_uri()), ('http', f'http://127.0.0.1:{server.server_port}/artifacts/travel-manual-demo.html')]:
            safari.goto(url)
            safari.wait_for_function("document.body.dataset.readerReady === 'true'")
            count = 0
            while not safari.locator('#next').is_disabled():
                old = int(safari.locator('body').get_attribute('data-reader-page'))
                safari.locator('#next').tap()
                assert int(safari.locator('body').get_attribute('data-reader-page')) == old + 1
                count += 1
                assert count < 100
            check(f'WebKit {protocol} all pages reachable by touch buttons', count > 2)
            safari.locator('#previous').tap()
            check(f'WebKit {protocol} previous works', not safari.locator('#next').is_disabled())
            check(f'WebKit {protocol} viewport fits without scroll', safari.evaluate('scrollX === 0 && scrollY === 0 && document.documentElement.scrollWidth <= innerWidth'))
        check('WebKit no runtime errors', not safari_errors)
        safari_context.close()
        webkit.close()
    server.shutdown()
    report = {'checks': checks, 'passed': len(checks), 'file_bytes': output.stat().st_size}
    (ARTIFACTS / 'book-export-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'passed': len(checks), 'file_bytes': output.stat().st_size}))


if __name__ == '__main__':
    main()
