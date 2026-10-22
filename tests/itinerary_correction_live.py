"""Manual scan correction: retain exact attachments, retry Codex, save without omissions."""
import argparse
import base64
from collections import Counter
import hashlib
import json
from pathlib import Path
import re
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright
from itinerary_scan_quality_live import make_sources
from itinerary_mobile_codex_live import EXPECTED, ROOT, TARGET, normalize

CORRECTION = '照片甲.png 第 1 頁：2026-11-10 19:30 光嶼咖啡館，提醒：攜帶白色預約卡。此為下方模糊活動的完整內容，其餘可讀活動保留。'
EXPECTED_ALL = EXPECTED + [('2026-11-10', '19:30', '光嶼咖啡館', ['攜帶白色預約卡'])]
LAST_FILE_ACTIVITY = ('2026-11-11', '20:00', '夜間集合', ['攜帶綠色識別卡'])


def mock_result(attempt, count, fallback, expected=EXPECTED_ALL):
    reviews = [{'index': index + 1, 'status': 'clear', 'message': ''} for index in range(count)]
    if attempt <= 2:
        reviews[4] = {'index': 5, 'status': 'unreadable', 'message': '19:30 活動名稱與提醒看不清楚，請補上完整內容。'}
        return {'error': '照片甲.png 第 1 頁 19:30 名稱及提醒模糊。', **({} if fallback else {'sourceReviews': reviews})}
    days = {}
    for date, time, title, notes in expected:
        day = days.setdefault(date, {'date': date, 'day_title': '台北行程', 'summary': '', 'itinerary': []})
        day['itinerary'].append({'time': time, 'title': title, 'tips': '；'.join(notes)})
    return {'city': '台北', 'days': list(days.values()), 'warnings': [], 'sourceReviews': reviews}


def run(args):
    correction = CORRECTION if args.case == 'image' else '掃描乙.pdf 第 3 頁完整行程：2026-11-12 09:00 天垣古董店，提醒：沿北側階梯上樓；12:00 霞汐食堂，提醒：窗邊座位。該頁共兩個活動，當日標題：台北第三天。'
    expected_all = EXPECTED_ALL if args.case == 'image' else EXPECTED + [('2026-11-12', '09:00', '天垣古董店', ['沿北側階梯上樓']), ('2026-11-12', '12:00', '霞汐食堂', ['窗邊座位'])]
    if args.file_count == 50:
        expected_all = expected_all + [LAST_FILE_ACTIVITY]
    file_info = f'已準備 {args.file_count} 個檔案'
    source_name = '照片甲.png' if args.case == 'image' else '掃描乙.pdf'
    output = ROOT / 'artifacts' / args.output
    output.mkdir(parents=True, exist_ok=False)
    credentials = json.loads(Path(args.credentials).read_text(encoding='utf-8-sig'))
    origin = TARGET.rstrip('/')
    assert credentials['url'].rstrip('/') == origin
    authorization = 'Basic ' + base64.b64encode(f"{credentials['username']}:{credentials['password']}".encode()).decode()
    report = {'profile': args.profile, 'mode': args.mode, 'case': args.case, 'candidate_overlay': args.candidate, 'calls': [], 'responses': [], 'checks': [], 'errors': [], 'blocked': [], 'network_failures': []}
    replay = json.loads(Path(args.replay).read_text(encoding='utf-8'))['responses'] if args.replay else None
    report['transport'] = 'replayed_actual_response' if replay else args.mode
    report['file_count'] = args.file_count
    report['extra_kind'] = args.extra_kind
    report['upload_batches'] = args.batches
    report['webkit_persistent_http_proxy'] = bool(args.persistence and args.profile == 'iphone')
    def check(name, passed):
        report['checks'].append({'name': name, 'passed': bool(passed)})
        if not passed:
            raise AssertionError(name)
    with sync_playwright() as p:
        maker = p.chromium.launch()
        files = make_sources(maker, output, 'unclear' if args.case == 'image' else 'unreadable-page')
        extra_page = maker.new_page(viewport={'width': 900, 'height': 320}) if args.extra_kind == 'image' else None
        for number in range(5, args.file_count + 1):
            date, time, title, notes = LAST_FILE_ACTIVITY if number == 50 else EXPECTED[(number - 5) % len(EXPECTED)]
            text = f'{date}\n{time} {title}\n提醒：{"；".join(notes)}\n'
            file = output / f'補充行程-{number:02}.{("png" if extra_page else "txt")}'
            if extra_page:
                extra_page.set_content('<style>body{font:32px "Microsoft JhengHei",sans-serif;white-space:pre-wrap;padding:24px}</style><main></main>')
                extra_page.locator('main').evaluate('(element, text) => { element.textContent = text; }', text)
                extra_page.screenshot(path=str(file))
            else:
                file.write_text(text, encoding='utf-8')
            files.append(file)
        maker.close()
        engine = p.webkit if args.profile == 'iphone' else p.chromium
        browser = None if args.persistence else engine.launch()
        device = p.devices['iPhone 13' if args.profile == 'iphone' else 'Pixel 7'] if args.profile != 'desktop' else {'viewport': {'width': 1440, 'height': 1050}}
        def new_context():
            options = dict(**device, service_workers='block', timezone_id='Asia/Taipei', http_credentials={'username': credentials['username'], 'password': credentials['password'], 'origin': origin})
            if args.persistence:
                options.pop('default_browser_type', None)
            print(json.dumps({'stage': 'opening browser', 'profile': args.profile}), flush=True)
            result = engine.launch_persistent_context(str(output / 'browser-profile'), timeout=30000, **options) if args.persistence else browser.new_context(**options)
            print(json.dumps({'stage': 'browser ready', 'profile': args.profile}), flush=True)
            return result
        context = new_context()
        context.add_init_script("localStorage.setItem('aiProvider','deepseek');localStorage.setItem('roamReadingMode','continuous');")
        def route_request(route):
            request = route.request
            parsed = urlsplit(request.url)
            same = f'{parsed.scheme}://{parsed.netloc}' == origin
            if parsed.scheme == 'blob' and request.url.startswith(f'blob:{origin}/'):
                return route.continue_()
            if same and args.candidate and parsed.path in ['/itinerary-import.js', '/itinerary-import.css']:
                return route.fulfill(path=str(ROOT / parsed.path[1:]), content_type='application/javascript' if parsed.path.endswith('.js') else 'text/css')
            if same and request.method == 'POST' and parsed.path == '/codex/import-itinerary' and len(report['calls']) < (3 if args.mode == 'mock' else 2):
                body = request.post_data_json
                report['calls'].append({'prompt': body['prompt'], 'images': [{'name': image['name'], 'page': image['page'], 'sha256': hashlib.sha256(base64.b64decode(image['dataBase64'])).hexdigest()} for image in body['images']]})
                if replay:
                    return route.fulfill(status=200, content_type='application/json', body=json.dumps(replay[len(report['calls']) - 1]['body']))
                if args.mode == 'mock':
                    return route.fulfill(status=200, content_type='application/json', body=json.dumps({'data': mock_result(len(report['calls']), len(body['images']), args.fallback, expected_all), 'usage': {}}))
                return route.continue_(headers={**request.headers, 'authorization': authorization})
            if request.method not in {'GET', 'HEAD'}:
                report['blocked'].append({'method': request.method, 'path': parsed.path})
                return route.abort()
            if same:
                # Windows Playwright WebKit's persistent profile stalls on authenticated
                # navigation. Fetch the same production bytes through Playwright's HTTP
                # client; the WebKit renderer and its on-disk IndexedDB remain real.
                if args.persistence and args.profile == 'iphone':
                    return route.fulfill(response=route.fetch(headers={**request.headers, 'authorization': authorization}))
                return route.continue_(headers={**request.headers, 'authorization': authorization})
            if parsed.hostname in {'fonts.googleapis.com', 'fonts.gstatic.com', 'cdnjs.cloudflare.com', 'html2canvas.hertzen.com'}:
                return route.continue_()
            return route.abort()
        context.route('**/*', route_request)
        page = context.new_page()
        page.on('pageerror', lambda error: report['errors'].append(str(error)))
        page.on('requestfailed', lambda request: report['network_failures'].append({'path': urlsplit(request.url).path, 'failure': request.failure}))
        def response_seen(response):
            if urlsplit(response.url).path == '/codex/import-itinerary':
                report['responses'].append({'status': response.status, 'body': response.json()})
        page.on('response', response_seen)
        def tap(selector):
            getattr(page.locator(selector), 'click' if args.profile == 'desktop' else 'tap')()
        def done():
            page.wait_for_function("!isBusy && (!document.getElementById('itinerarySaveButton').disabled || !document.getElementById('itineraryImportError').hidden)", timeout=215000)
        def saved():
            page.wait_for_function("document.getElementById('itineraryDraftStatus').textContent.includes('草稿已儲存')", timeout=30000)
        try:
            check('production login', page.goto(TARGET, wait_until='networkidle', timeout=60000).status == 200)
            page.wait_for_selector('#openItineraryImport')
            before = page.evaluate('localStorage.tourismTrips_v1')
            page.evaluate('() => {window.testReads=0;const read=ItineraryFile.read;ItineraryFile.read=(...args)=>{window.testReads++;return read(...args)}}')
            tap('#openItineraryImport')
            print(json.dumps({'stage': 'preparing files', 'profile': args.profile}), flush=True)
            if args.file_count == 50:
                extra = output / '第51份.txt'
                extra.write_text('2026-11-11\n20:30 不應加入的活動\n', encoding='utf-8')
                page.locator('#itinerarySourceFile').set_input_files([str(file) for file in files + [extra]])
                page.wait_for_function("!isBusy && document.getElementById('itineraryImportError').textContent.includes('最多讀取 50 個檔案')")
                check('51-file batch rejected atomically before any file read or AI call', page.evaluate('testReads') == 0 and not report['calls'] and page.locator('#itineraryFileInfo').text_content() == '')
            batches = [files] if args.batches == 1 else [files[:4], files[4:]]
            prepared = 0
            for batch in batches:
                page.locator('#itinerarySourceFile').set_input_files([str(file) for file in batch])
                prepared += len(batch)
                page.wait_for_function("text => !isBusy && document.getElementById('itineraryFileInfo').textContent.includes(text)", arg=f'已準備 {prepared} 個檔案', timeout=120000)
            check('all files prepared once without AI', page.evaluate('testReads') == args.file_count and not report['calls'])
            if args.file_count == 50:
                previous_text = page.locator('#itinerarySourceText').input_value()
                page.locator('#itinerarySourceFile').set_input_files(str(extra))
                page.wait_for_function("!isBusy && document.getElementById('itineraryImportError').textContent.includes('最多讀取 50 個檔案')")
                check('51st appended file preserves all 50 prepared sources', page.evaluate('testReads') == 50 and file_info in page.locator('#itineraryFileInfo').text_content() and page.locator('#itinerarySourceText').input_value() == previous_text)
                check('file picker help displays the 50-file limit', '最多 50 個檔案' in page.locator('#itineraryFileHelp').text_content())
            tap('#itineraryParseButton')
            print(json.dumps({'stage': 'initial import', 'mode': report['transport'], 'profile': args.profile}), flush=True)
            done()
            check('unreadable activity blocks saving and offers manual correction', page.locator('#itinerarySaveButton').is_disabled() and page.locator('#itineraryCorrections').is_visible())
            input_selector = '#itineraryCorrection-5' if page.locator('#itineraryCorrection-5').count() else '#itineraryCorrection-0'
            check('source-specific or fallback correction label is visible', source_name in page.locator('#itineraryCorrections').text_content())
            check('empty correction cannot submit', page.locator('#itineraryCorrectionRetry').is_disabled())
            page.locator(input_selector).fill(correction)
            if args.persistence:
                saved()
                page.reload(wait_until='networkidle')
                tap('#openItineraryImport')
                page.wait_for_function("!document.getElementById('itineraryCorrectionRetry').disabled")
                check('reload restores manual correction without AI', page.locator(input_selector).input_value() == correction and len(report['calls']) == 1)
                context.close()
                context = new_context()
                context.route('**/*', route_request)
                page = context.new_page()
                page.on('pageerror', lambda error: report['errors'].append(str(error)))
                page.on('response', response_seen)
                page.goto(TARGET, wait_until='networkidle')
                tap('#openItineraryImport')
                page.wait_for_function("!document.getElementById('itineraryCorrectionRetry').disabled")
                page.evaluate('() => {window.testReads=0;const read=ItineraryFile.read;ItineraryFile.read=(...args)=>{window.testReads++;return read(...args)}}')
                check('browser restart restores all files and correction without AI', file_info in page.locator('#itineraryFileInfo').text_content() and page.locator(input_selector).input_value() == correction and len(report['calls']) == 1)
                originals = page.evaluate("""async () => {const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('roamItineraryDraft_v1',1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});const sources=await new Promise(resolve=>{const r=db.transaction('draft').objectStore('draft').get('sources');r.onsuccess=()=>resolve(r.result)});db.close();return Promise.all(sources.originals.map(async f=>({name:f.name,hash:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await f.arrayBuffer()))).map(x=>x.toString(16).padStart(2,'0')).join('')})))}""")
                check('original uploaded file bytes survive browser restart', originals == [{'name': file.name, 'hash': hashlib.sha256(file.read_bytes()).hexdigest()} for file in files])
            tap('#itineraryImportClose')
            tap('#openItineraryImport')
            check('closing and reopening retains correction and files', page.locator(input_selector).input_value() == correction and file_info in page.locator('#itineraryFileInfo').text_content())
            page.locator('#itineraryCorrections').screenshot(path=str(output / 'correction.png'))
            tap('#itineraryCorrectionRetry')
            print(json.dumps({'stage': 'correction retry', 'mode': report['transport'], 'profile': args.profile}), flush=True)
            done()
            if args.mode == 'mock':
                check('unsuccessful retry retains correction and blocks save', page.locator(input_selector).input_value() == correction and page.locator('#itinerarySaveButton').is_disabled())
                tap('#itineraryCorrectionRetry')
                done()
            report['final_error'] = page.locator('#itineraryImportError').text_content()
            check('Codex produces a valid corrected preview', page.locator('#itinerarySaveButton').is_enabled() and not report['final_error'])
            check('all retries reuse exact images without selecting or reparsing files', page.evaluate('testReads') == (0 if args.persistence else args.file_count) and all(call['images'] == report['calls'][0]['images'] for call in report['calls']))
            check('every source filename remains in every Codex request', all(all(file.name in call['prompt'] for file in files) for call in report['calls']))
            check('retry sends the manual correction with the original sources', all(correction in call['prompt'] for call in report['calls'][1:]))
            check('preview preserves existing stored journeys', before == page.evaluate('localStorage.tourismTrips_v1'))
            actual = []
            for detail in page.locator('#itineraryImportPreview details').all():
                date = re.search(r'\d{4}-\d{2}-\d{2}', detail.locator('summary').text_content()).group()
                for item in detail.locator('li').all():
                    label = item.locator('strong').text_content()
                    actual.append({'date': date, 'time': label[:5], 'title': label.split(' · ', 1)[1], 'text': item.text_content()})
            report['actual'] = actual
            expected = Counter((date, time, normalize(title)) for date, time, title, _ in expected_all)
            check('all activities survive and duplicate activities remain merged', Counter((x['date'], x['time'], normalize(x['title'])) for x in actual) == expected)
            check('original thirteen notes and corrected notes all survive', all(all(normalize(note) in normalize(next(x['text'] for x in actual if (x['date'], x['time'], normalize(x['title'])) == (date, time, normalize(title)))) for note in notes) for date, time, title, notes in expected_all))
            check('correction UI has no horizontal overflow', page.locator('#itineraryImportModal .modal-content').evaluate('e=>e.scrollWidth<=e.clientWidth+1'))
            if args.persistence:
                saved()
                calls_before = len(report['calls'])
                page.reload(wait_until='networkidle')
                tap('#openItineraryImport')
                page.wait_for_function("!document.getElementById('itinerarySaveButton').disabled")
                check('completed preview restores without another Codex call', len(report['calls']) == calls_before and len(page.locator('#itineraryImportPreview li').all()) == len(expected_all))
            if args.mode == 'mock':
                page.locator(input_selector).fill(correction + '更正')
                check('editing correction invalidates old preview', page.locator('#itinerarySaveButton').is_disabled())
                tap('#itineraryClearFiles')
                check('clear removes attachments and corrections', page.locator('#itineraryCorrections').is_hidden() and page.locator('#itineraryCorrectionFields textarea').count() == 0 and page.locator('#itineraryFileInfo').text_content() == '')
                if args.persistence:
                    page.wait_for_function("document.getElementById('itineraryDraftStatus').textContent.includes('已清除')")
                    page.reload(wait_until='networkidle')
                    tap('#openItineraryImport')
                    page.wait_for_function("!document.getElementById('itinerarySourceText').disabled")
                    check('cleared draft stays cleared after reload', page.locator('#itineraryFileInfo').text_content() == '' and page.locator('#itineraryCorrectionFields textarea').count() == 0 and page.locator('#itineraryParseButton').is_disabled())
                    page.evaluate("() => {window.draftTransaction=IDBDatabase.prototype.transaction; IDBDatabase.prototype.transaction=function(...args){if(this.name==='roamItineraryDraft_v1' && args[1]==='readwrite') throw new DOMException('Simulated quota failure','QuotaExceededError'); return window.draftTransaction.apply(this,args)}}")
                    page.locator('#itinerarySourceText').fill('storage failure test')
                    check('storage failure is visible and retains in-page input', '儲存失敗' in page.locator('#itineraryDraftStatus').text_content() and page.locator('#itinerarySourceText').input_value() == 'storage failure test')
                    page.evaluate('() => { IDBDatabase.prototype.transaction=window.draftTransaction; }')
                    page.locator('#itinerarySourceText').fill('storage retry test')
                    saved()
                    check('subsequent edit retries storage successfully', '草稿已儲存' in page.locator('#itineraryDraftStatus').text_content())
                    other = context.new_page()
                    other.goto(TARGET, wait_until='networkidle')
                    other.locator('#openItineraryImport').click()
                    other.wait_for_function("!document.getElementById('itinerarySourceText').disabled")
                    page.locator('#itinerarySourceText').fill('newest draft from original tab')
                    saved()
                    other.locator('#itinerarySourceText').fill('stale tab must not overwrite')
                    other.wait_for_function("document.getElementById('itineraryDraftStatus').textContent.includes('儲存失敗')")
                    check('stale tab cannot overwrite a newer draft', '其他分頁' in other.locator('#itineraryDraftStatus').text_content())
                    other.reload(wait_until='networkidle')
                    other.locator('#openItineraryImport').click()
                    other.wait_for_function("!document.getElementById('itinerarySourceText').disabled")
                    check('newest draft survives conflicting tab write', other.locator('#itinerarySourceText').input_value() == 'newest draft from original tab')
                    other.close()
            else:
                page.locator('#itineraryImportPreview').screenshot(path=str(output / 'preview.png'))
                with page.expect_navigation(wait_until='domcontentloaded', timeout=60000):
                    tap('#itinerarySaveButton')
                page.wait_for_function('count=>typeof TripLibrary!=="undefined" && typeof tripData!=="undefined" && tripData.length===count', arg=len({row[0] for row in expected_all}), timeout=60000)
                book = page.evaluate('JSON.parse(localStorage.tourismTrips_v1)')
                check('original journeys unchanged after save', all(trip in book['trips'] for trip in json.loads(before)['trips']))
                saved = next(trip for trip in book['trips'] if trip['id'] == book['activeId'])['data']['t']
                check('all activities persist after reload', Counter((day['date'], item['time'], normalize(item['title'])) for day in saved for item in day['itinerary']) == expected)
                check('manual correction is retained in saved review notes', correction in '\n'.join(day['summary'] for day in saved))
            check('no uncaught exception or unexpected server mutation', not report['errors'] and not report['blocked'])
            report['passed'] = True
        except Exception as error:
            report['passed'] = False
            report['failure'] = str(error)
        finally:
            page.screenshot(path=str(output / 'result.png'))
            context.close()
            if browser:
                browser.close()
    (output / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'passed': report['passed'], 'checks': len(report['checks']), 'report': str(output / 'report.json')}), flush=True)
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--credentials', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--mode', choices=['mock', 'live'], default='mock')
    parser.add_argument('--profile', choices=['desktop', 'android', 'iphone'], default='android')
    parser.add_argument('--candidate', action='store_true')
    parser.add_argument('--persistence', action='store_true', help='Verify reload and full browser restart using a persistent isolated profile')
    parser.add_argument('--file-count', type=int, choices=[4, 50], default=4)
    parser.add_argument('--batches', type=int, choices=[1, 2], default=1)
    parser.add_argument('--extra-kind', choices=['text', 'image'], default='text')
    parser.add_argument('--fallback', action='store_true')
    parser.add_argument('--replay', help='Replay actual prior live responses without additional Codex calls')
    parser.add_argument('--case', choices=['image', 'pdf'], default='image')
    args = parser.parse_args()
    if args.case == 'pdf' and args.mode == 'mock':
        parser.error('PDF scenario requires live mode or live response replay')
    if args.batches == 2 and args.file_count != 50:
        parser.error('Two upload batches require the 50-file scenario')
    raise SystemExit(run(args))
