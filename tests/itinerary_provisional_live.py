"""Real Codex or response replay: 50 mixed files, provisional dates and retained drafts."""
import argparse
import base64
from collections import Counter
from datetime import date, timedelta
import hashlib
import json
from pathlib import Path
import re
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright, Error as PlaywrightError
import itinerary_scan_quality_live as scans
from itinerary_mobile_codex_live import ROOT, TARGET

MANUAL = '2027的5月中 6天含六日 日期先隨意。第3天 09:00 植物園導覽的提醒再加上：攜帶白色預約卡（原提醒保留）。'
STOPS = [('大稻埕散步', '北側入口集合'), ('故宮參觀', '入口領取地圖'), ('植物園導覽', '請穿步行鞋'),
         ('淡水老街', '現金付款'), ('北投溫泉', '攜帶毛巾'), ('象山步道', '自備飲用水')]


def run(args):
    output = ROOT / 'artifacts' / args.output
    output.mkdir(parents=True, exist_ok=False)
    credentials = json.loads(Path(args.credentials).read_text(encoding='utf-8-sig'))
    origin = TARGET.rstrip('/')
    assert credentials['url'].rstrip('/') == origin
    auth = 'Basic ' + base64.b64encode(f"{credentials['username']}:{credentials['password']}".encode()).decode()
    replay = json.loads(Path(args.replay).read_text(encoding='utf-8'))['responses'] if args.replay else None
    report = {'profile': args.profile, 'physical_device': False, 'candidate': args.candidate,
              'account_usage_mocked': bool(replay), 'transport': 'replay' if replay else 'real_codex', 'checks': [], 'calls': [], 'responses': [], 'errors': [], 'blocked': []}
    def check(name, condition):
        report['checks'].append({'name': name, 'passed': bool(condition)})
        if not condition:
            raise AssertionError(name)
    with sync_playwright() as p:
        maker = p.chromium.launch()
        source_days = [(f'第{i+1}天（2027年5月）', [('09:00', title, note)]) for i, (title, note) in enumerate(STOPS)]
        scans.SOURCES = [('A', source_days[:3]), ('B', source_days[3:]), ('C', source_days[:1]), ('D', source_days[3:4])]
        files = scans.make_sources(maker, output, 'readable')
        maker.close()
        for number in range(5, 51):
            i = (number - 5) % 6
            text = f'第{i+1}天（2027年5月）09:00 {STOPS[i][0]}，提醒：{STOPS[i][1]}'
            if number == 50:
                text = '第6天（2027年5月）18:00 夜間集合，提醒：攜帶綠色識別卡'
            file = output / f'補充-{number:02}.txt'
            file.write_text(text, encoding='utf-8')
            files.append(file)
        engine = p.webkit if args.profile == 'iphone' else p.chromium
        device = dict(p.devices['iPhone 13' if args.profile == 'iphone' else 'Pixel 7']) if args.profile != 'desktop' else {'viewport': {'width': 1440, 'height': 1000}}
        device.pop('default_browser_type', None)
        closing = False
        def route_request(route):
            try:
                return handle_route(route)
            except PlaywrightError:
                if not closing:
                    report["errors"].append("Browser request failed: " + urlsplit(route.request.url).path)
                try:
                    route.abort()
                except PlaywrightError:
                    pass
        def handle_route(route):
            request = route.request
            url = urlsplit(request.url)
            same = f'{url.scheme}://{url.netloc}' == origin
            if url.scheme == 'blob' and request.url.startswith('blob:' + origin + '/'):
                return route.continue_()
            if same and replay and url.path == '/codex/usage':
                return route.fulfill(status=200, content_type='application/json', body=json.dumps({'available': False, 'limits': [], 'models': []}))
            if same and args.candidate and url.path == '/itinerary-import.js':
                return route.fulfill(path=str(ROOT / 'itinerary-import.js'), content_type='application/javascript')
            if same and request.method == 'POST' and url.path == '/codex/import-itinerary' and len(report['calls']) < 3:
                body = request.post_data_json
                report['calls'].append({'prompt': body['prompt'], 'images': [{'name': image['name'], 'page': image['page'],
                    'sha256': hashlib.sha256(base64.b64decode(image['dataBase64'])).hexdigest()} for image in body['images']]})
                if replay:
                    return route.fulfill(status=200, content_type='application/json', body=json.dumps(replay[len(report['calls'])-1]['body']))
                return route.continue_(headers={**request.headers, 'authorization': auth})
            if request.method not in {'GET', 'HEAD'}:
                report['blocked'].append(url.path)
                return route.abort()
            if same:
                if args.profile == 'iphone':
                    return route.fulfill(response=route.fetch(headers={**request.headers, 'authorization': auth}))
                return route.continue_(headers={**request.headers, 'authorization': auth})
            if url.hostname in {'fonts.googleapis.com', 'fonts.gstatic.com', 'cdnjs.cloudflare.com', 'html2canvas.hertzen.com'}:
                return route.continue_()
            return route.abort()
        def close_context(context):
            nonlocal closing
            for tab in context.pages:
                tab.wait_for_load_state('networkidle')
            closing = True
            context.unroute_all(behavior='ignoreErrors')
            context.close()
        def new_context():
            nonlocal closing
            closing = False
            context = engine.launch_persistent_context(str(output / 'profile'), **device, service_workers='block', timezone_id='Asia/Taipei')
            context.route('**/*', route_request)
            context.add_init_script("localStorage.setItem('aiProvider','deepseek');localStorage.setItem('roamReadingMode','continuous');")
            return context
        def new_page(context):
            page = context.new_page()
            page.on('pageerror', lambda error: report['errors'].append(str(error)))
            page.on('response', lambda response: report['responses'].append({'status': response.status, 'body': response.json()}) if urlsplit(response.url).path == '/codex/import-itinerary' else None)
            page.goto(TARGET, wait_until='networkidle')
            page.locator('#openItineraryImport').click()
            page.wait_for_function("!document.getElementById('itinerarySourceText').disabled")
            return page
        def saved():
            page.wait_for_function("document.getElementById('itineraryDraftStatus').textContent.includes('草稿已儲存')")
        def submit():
            page.locator('#itineraryParseButton').click()
            print(json.dumps({'stage': 'import', 'attempt': len(report['calls']), 'profile': args.profile}), flush=True)
            page.wait_for_function("!isBusy && (!document.getElementById('itinerarySaveButton').disabled || !document.getElementById('itineraryImportError').hidden)", timeout=215000)
            report['last_error'] = page.locator('#itineraryImportError').text_content()
        def preview(provisional, start=None):
            check('preview is valid', page.locator('#itinerarySaveButton').is_enabled())
            details = page.locator('#itineraryImportPreview details').all()
            dates = [date.fromisoformat(re.search(r'\d{4}-\d{2}-\d{2}', detail.locator('summary').text_content()).group()) for detail in details]
            check('six consecutive days with both weekend days', len(dates) == 6 and dates == [dates[0]+timedelta(days=i) for i in range(6)])
            # Python weekday uses Saturday=5, Sunday=6.
            check('both Saturday and Sunday are included', {5, 6} <= {d.weekday() for d in dates})
            check('dates meet May 2027 middle-of-month constraints', all(d.year == 2027 and d.month == 5 and 11 <= d.day <= 20 for d in dates))
            if start:
                check('manual start date overrides provisional selection', str(dates[0]) == start)
            expected = [(str(dates[i]), '09:00', title) for i, (title, _) in enumerate(STOPS)] + [(str(dates[5]), '18:00', '夜間集合')]
            actual = []
            for i, detail in enumerate(details):
                check(f'day {i+1} provisional heading matches state', ('（暫定）' in detail.locator('summary').text_content()) == provisional)
                for item in detail.locator('li').all():
                    label = item.locator('strong').text_content()
                    actual.append((str(dates[i]), label[:5], label.split(' · ', 1)[1]))
                check(f'day {i+1} original reminder survives', STOPS[i][1] in detail.text_content())
            check('all seven activities retained with duplicates merged', Counter(actual) == Counter(expected))
            check('manual correction and file 50 reminder survive', '攜帶白色預約卡' in details[2].text_content() and '攜帶綠色識別卡' in details[5].text_content())
            check('no horizontal overflow', page.locator('#itineraryImportModal .modal-content').evaluate('e=>e.scrollWidth<=e.clientWidth+1'))
            return dates
        context = new_context()
        page = new_page(context)
        try:
            before = page.evaluate('localStorage.tourismTrips_v1')
            page.locator('#itinerarySourceFile').set_input_files([str(file) for file in files])
            page.wait_for_function("!isBusy && document.getElementById('itineraryFileInfo').textContent.includes('已準備 50 個檔案')", timeout=120000)
            check('50 files prepared without AI', not report['calls'])
            submit()
            check('missing dates without permission block saving', page.locator('#itinerarySaveButton').is_disabled() and '日期' in report['last_error'])
            page.locator('#itineraryAddCorrection').click()
            page.locator('#itineraryCorrection-0').fill(MANUAL)
            saved()
            close_context(context)
            context = new_context()
            page = new_page(context)
            check('restart restores manual permission and 50 files without AI', len(report['calls']) == 1 and page.locator('#itineraryCorrection-0').input_value() == MANUAL and '50 個檔案' in page.locator('#itineraryFileInfo').text_content())
            originals = page.evaluate("""async()=>{const db=await new Promise(r=>{const q=indexedDB.open('roamItineraryDraft_v1',1);q.onsuccess=()=>r(q.result)});const s=await new Promise(r=>{const q=db.transaction('draft').objectStore('draft').get('sources');q.onsuccess=()=>r(q.result)});db.close();return Promise.all(s.originals.map(async f=>({name:f.name,hash:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await f.arrayBuffer()))).map(x=>x.toString(16).padStart(2,'0')).join('')})))}""")
            check('all 50 original file hashes survive restart', originals == [{'name': f.name, 'hash': hashlib.sha256(f.read_bytes()).hexdigest()} for f in files])
            submit()
            dates = preview(True)
            saved()
            page.locator('#itineraryImportPreview').screenshot(path=str(output / 'provisional-preview.png'))
            with page.expect_navigation(wait_until='domcontentloaded'):
                page.locator('#itinerarySaveButton').click()
            page.wait_for_function("typeof TripLibrary!=='undefined' && TripLibrary.active()?.data.t.length===6")
            book = page.evaluate('JSON.parse(localStorage.tourismTrips_v1)')
            active = next(trip for trip in book['trips'] if trip['id'] == book['activeId'])
            check('saved days retain provisional labels and manual notes', all('日期暫定' in day['summary'] for day in active['data']['t']) and MANUAL in active['data']['t'][0]['summary'])
            check('existing journeys unchanged', all(trip in book['trips'] for trip in json.loads(before)['trips']))
            page.locator('#openItineraryImport').click()
            page.wait_for_function("!document.getElementById('itinerarySaveButton').disabled")
            check('saved draft preview restores without AI', len(report['calls']) == 2 and page.locator('#itineraryCorrection-0').input_value() == MANUAL)
            # Choose a different start that still meets the original conditions.
            revised = '2027-05-13' if str(dates[0]) != '2027-05-13' else '2027-05-14'
            page.locator('#itineraryImportStart').fill(revised)
            check('editing date invalidates old preview', page.locator('#itinerarySaveButton').is_disabled())
            saved()
            page.reload(wait_until='networkidle')
            page.locator('#openItineraryImport').click()
            page.wait_for_function("!document.getElementById('itinerarySourceText').disabled")
            check('revised date and manual text restore', page.locator('#itineraryImportStart').input_value() == revised and page.locator('#itineraryCorrection-0').input_value() == MANUAL)
            submit()
            preview(False, revised)
            check('all requests reuse exact eight source images', len(report['calls']) == 3 and len(report['calls'][0]['images']) == 8 and all(c['images'] == report['calls'][0]['images'] for c in report['calls']))
            check('all 50 files remain in every request', all(all(file.name in c['prompt'] for file in files) for c in report['calls']))
            check('only manual permission enables selection', '暫定日期授權：未啟用' in report['calls'][0]['prompt'] and '暫定日期授權：已啟用' in report['calls'][1]['prompt'] and '暫定日期授權：未啟用' in report['calls'][2]['prompt'])
            with page.expect_navigation(wait_until='domcontentloaded'):
                page.locator('#itinerarySaveButton').click()
            page.wait_for_function("start=>typeof TripLibrary!=='undefined' && TripLibrary.active()?.data.t[0]?.date===start", arg=revised)
            revised_book = page.evaluate('JSON.parse(localStorage.tourismTrips_v1)')
            revised_trip = next(t for t in revised_book['trips'] if t['id'] == revised_book['activeId'])
            check('revised dates persist as a new trip without overwriting saved journeys', all(t in revised_book['trips'] for t in book['trips']) and len(revised_trip['data']['t']) == 6 and sum(len(d['itinerary']) for d in revised_trip['data']['t']) == 7)
            check('confirmed dates no longer carry provisional day labels', all('日期暫定（依人工授權選定，尚未確認）' not in d['summary'] for d in revised_trip['data']['t']))
            check('no JavaScript error or unrelated mutation', not report['errors'] and not report['blocked'])
            report['passed'] = True
        except Exception as error:
            report.update(passed=False, failure=re.sub(r'(?im)(authorization|x-roam-token):[^\r\n]*', r'\1: [redacted]', str(error)).replace(auth, '[redacted]').replace(credentials['password'], '[redacted]'))
        finally:
            report['visible_error'] = page.locator('#itineraryImportError').text_content()
            page.screenshot(path=str(output / 'result.png'))
            close_context(context)
    (output / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'passed': report['passed'], 'checks': len(report['checks']), 'report': str(output / 'report.json')}), flush=True)
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--credentials', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--profile', choices=['desktop', 'android', 'iphone'], default='android')
    parser.add_argument('--candidate', action='store_true')
    parser.add_argument('--replay')
    raise SystemExit(run(parser.parse_args()))
