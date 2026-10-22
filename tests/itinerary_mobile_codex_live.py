"""Real mobile Codex import: two raster PDFs plus PNG/JPEG, with a source-by-source oracle."""
import argparse
import base64
from collections import Counter
from datetime import datetime, timezone
import hashlib
import html
import json
from pathlib import Path
import re
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
TARGET = 'https://roam-161-33-192-81.sslip.io/'
EXPECTED = [
    ('2026-11-10', '09:00', '大稻埕', ['北側入口集合', '穿舒適鞋']),
    ('2026-11-10', '12:00', '台北車站', ['南門集合', '帶雨傘']),
    ('2026-11-10', '15:00', '中正紀念堂', ['自備飲水', '戴帽子']),
    ('2026-11-10', '18:00', '大稻埕', ['晚餐後散步']),
    ('2026-11-11', '09:00', '龍山寺', ['保持安靜', '勿開閃光燈']),
    ('2026-11-11', '12:00', '西門町', ['午餐自理', '保留發票']),
    ('2026-11-11', '15:00', '台北植物園', ['走東側步道']),
    ('2026-11-11', '18:00', '台北車站', ['搭車返程']),
]
SOURCES = [
    ('掃描行程甲.pdf', [
        ('2026-11-10', [('09:00', '大稻埕', '北側入口集合'), ('12:00', '台北車站', '南門集合')]),
        ('2026-11-11', [('09:00', '龍山寺', '保持安靜'), ('12:00', '西門町', '午餐自理')]),
    ]),
    ('掃描行程乙.pdf', [
        ('2026-11-10', [('09:00', '大稻埕', '穿舒適鞋'), ('15:00', '中正紀念堂', '自備飲水')]),
        ('2026-11-11', [('09:00', '龍山寺', '勿開閃光燈'), ('18:00', '台北車站', '搭車返程')]),
    ]),
    ('第一天補充.png', [('2026-11-10', [('12:00', '台北車站', '帶雨傘'), ('15:00', '中正紀念堂', '戴帽子'), ('18:00', '大稻埕', '晚餐後散步')])]),
    ('第二天補充.jpg', [('2026-11-11', [('12:00', '西門町', '保留發票'), ('15:00', '台北植物園', '走東側步道'), ('18:00', '台北車站', '搭車返程')])]),
]


def normalize(value):
    return re.sub(r'\s+', '', str(value)).replace('臺', '台')


def fixtures(browser, directory):
    page = browser.new_page(viewport={'width': 1200, 'height': 1000}, device_scale_factor=1)
    paths, manifest = [], []
    for name, pages in SOURCES:
        raster = []
        for date, stops in pages:
            rows = ''.join(f'<section><b>{time} {html.escape(title)}</b><div>提醒：{html.escape(note)}</div></section>' for time, title, note in stops)
            page.set_content(f'<style>body{{margin:60px;background:white;color:#111;font:42px "Microsoft JhengHei",sans-serif;line-height:1.65}}h1{{font-size:48px}}section{{margin:30px 0}}b{{font-weight:500}}</style><h1>台北旅行行程 {date}</h1>{rows}')
            page.evaluate('document.fonts.ready')
            kind = 'jpeg' if name.endswith('.jpg') else 'png'
            pixels = page.screenshot(type=kind, **({'quality': 95} if kind == 'jpeg' else {}))
            raster.append((kind, pixels))
        if name.endswith('.pdf'):
            images = ''.join(f'<section><img src="data:image/{kind};base64,{base64.b64encode(pixels).decode()}"/></section>' for kind, pixels in raster)
            page.set_content('<style>@page{size:900px 750px;margin:0}body{margin:0}section{height:750px;overflow:hidden;break-after:page}section:last-child{break-after:auto}img{width:100%}</style>' + images)
            page.evaluate('Promise.all([...document.images].map(image=>image.decode()))')
            data = page.pdf(prefer_css_page_size=True, print_background=True)
        else:
            data = raster[0][1]
        path = directory / name
        path.write_bytes(data)
        paths.append(path)
        manifest.append({'name': name, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest(), 'pages': pages})
    page.close()
    (directory / 'sources.json').write_text(json.dumps({'source_rows': 14, 'expected_unique': 8, 'expected_duplicate_rows': 6, 'expected': EXPECTED, 'sources': manifest}, ensure_ascii=False, indent=2), encoding='utf-8')
    return paths


def run(args):
    output = ROOT / 'artifacts' / args.output
    output.mkdir(parents=True, exist_ok=False)
    credentials = json.loads(Path(args.credentials).read_text(encoding='utf-8-sig'))
    origin = TARGET.rstrip('/')
    if credentials['url'].rstrip('/') != origin:
        raise ValueError('Credentials must match the production origin')
    auth = {key: credentials[key] for key in ['username', 'password']}
    auth['origin'] = origin
    authorization = 'Basic ' + base64.b64encode(f"{credentials['username']}:{credentials['password']}".encode()).decode()
    secrets = [credentials['username'], credentials['password']]
    def redact(value):
        value = str(value)
        for secret in secrets:
            value = value.replace(secret, '[redacted]')
        return value
    reports = []
    with sync_playwright() as p:
        fixture_browser = p.chromium.launch(headless=True)
        files = fixtures(fixture_browser, output)
        fixture_browser.close()
        for engine, device in [('chromium', 'Pixel 7'), ('webkit', 'iPhone 13')]:
            if args.engine != 'both' and args.engine != engine:
                continue
            replay = None
            if engine == 'chromium' and args.replay_chromium:
                prior = json.loads(Path(args.replay_chromium).read_text(encoding='utf-8'))
                replay = prior['responses'][0]
                if replay['status'] != 200 or not replay['data']:
                    raise ValueError('Replay requires a successful actual Codex response')
            print(json.dumps({'stage': 'start', 'engine': engine, 'device': device}), flush=True)
            checks, calls, responses, errors, blocked, comparisons, shots = [], [], [], [], [], [], []
            report = {'engine': engine, 'device_profile': device, 'physical_device': False, 'checks': checks, 'calls': calls, 'responses': responses, 'errors': errors, 'blocked': blocked, 'comparison': comparisons, 'screenshots': shots}
            report['transport'] = 'replayed_actual_response' if replay else 'real_codex'
            if replay:
                report['replay_source'] = str(Path(args.replay_chromium).resolve())
            browser = getattr(p, engine).launch(headless=True)
            context = browser.new_context(**p.devices[device], http_credentials=auth, timezone_id='Asia/Taipei', service_workers='block')
            seed = {'date': '2026-11-09', 'day_title': '原有旅程', 'summary': '不可被覆寫', 'itinerary': [{'time': '08:00', 'title': '原始站點', 'type': 'SPOT', 'userNote': '保留原筆記'}]}
            context.add_init_script("""(() => {if(!localStorage.mobileImportSeeded){localStorage.setItem('aiProvider','deepseek');localStorage.setItem('roamReadingMode','continuous');localStorage.setItem('tripDraft_v27',JSON.stringify({city:'原有旅程',hasHotel:false}));localStorage.setItem('myTrip_v27',JSON.stringify([SEED]));localStorage.mobileImportSeeded='yes';}})();""".replace('SEED', json.dumps(seed, ensure_ascii=False)))
            def route_request(route):
                request = route.request
                parsed = urlsplit(request.url)
                same = f'{parsed.scheme}://{parsed.netloc}' == origin
                if parsed.scheme == 'blob' and request.url.startswith(f'blob:{origin}/'):
                    return route.continue_()
                def proceed():
                    # The test account header is restricted to the verified production origin.
                    if same:
                        return route.continue_(headers={**request.headers, 'authorization': authorization})
                    return route.continue_()
                if request.method == 'POST' and same and parsed.path == '/codex/import-itinerary' and not calls:
                    body = request.post_data_json
                    calls.append({'attachments': [{'name': item['name'], 'page': item['page'], 'mime': item['mime']} for item in body['images']], 'body_bytes': len(request.post_data_buffer)})
                    if replay:
                        return route.fulfill(status=200, content_type='application/json', body=json.dumps({'data': replay['data'], 'usage': replay['usage']}))
                    return proceed()
                if request.method not in {'GET', 'HEAD'}:
                    blocked.append({'method': request.method, 'path': parsed.path})
                    return route.abort()
                if same or parsed.hostname in {'fonts.googleapis.com', 'fonts.gstatic.com', 'cdnjs.cloudflare.com', 'html2canvas.hertzen.com'}:
                    return proceed()
                return route.abort()
            context.route('**/*', route_request)
            page = context.new_page()
            page.set_default_timeout(30000)
            page.on('pageerror', lambda error: errors.append(redact(error)))
            def response_seen(response):
                if urlsplit(response.url).path == '/codex/import-itinerary':
                    try:
                        body = response.json()
                        responses.append({'status': response.status, 'usage': body.get('usage'), 'data': body.get('data'), 'error': redact(body.get('error', ''))})
                    except Exception as error:
                        responses.append({'status': response.status, 'read_error': redact(error)})
            page.on('response', response_seen)
            def check(name, passed):
                checks.append({'name': name, 'passed': bool(passed)})
                if not passed:
                    raise AssertionError(name)
            def shot(name):
                destination = output / f'{engine}-{name}.png'
                page.screenshot(path=str(destination))
                shots.append(str(destination))
            try:
                navigation = page.goto(TARGET, wait_until='networkidle', timeout=60000)
                check('authenticated production page returns HTTP 200', navigation.status == 200)
                page.wait_for_selector('#openItineraryImport')
                report['viewport'] = page.evaluate('({width:innerWidth,height:innerHeight,touch:navigator.maxTouchPoints,ratio:devicePixelRatio})')
                check('mobile viewport profile is active', report['viewport']['width'] < 500)
                original = page.evaluate('TripLibrary.active()')
                before = page.evaluate('localStorage.tourismTrips_v1')
                # Verify the PDF inputs really have no selectable text, using the deployed parser.
                pdfs = [base64.b64encode(path.read_bytes()).decode() for path in files if path.suffix == '.pdf']
                counts = page.evaluate("""async values=>{const pdf=await import(new URL('vendor/pdfjs/pdf.mjs',document.baseURI));pdf.GlobalWorkerOptions.workerSrc=new URL('vendor/pdfjs/pdf.worker.mjs',document.baseURI).href;const result=[];for(const value of values){const task=pdf.getDocument({data:Uint8Array.from(atob(value),c=>c.charCodeAt(0)),verbosity:0});try{const doc=await task.promise;const chars=[];for(let i=1;i<=doc.numPages;i++){const page=await doc.getPage(i);const text=await page.getTextContent();chars.push(text.items.map(item=>item.str||'').join('').length);}result.push(chars);}finally{await task.destroy();}}return result;}""", pdfs)
                check('two PDFs each contain two raster-only pages', counts == [[0, 0], [0, 0]])
                page.evaluate("window.mobileTestTouches=0;document.getElementById('openItineraryImport').addEventListener('touchstart',()=>window.mobileTestTouches++,{passive:true})")
                page.locator('#openItineraryImport').tap()
                check('mobile tap dispatches a real browser touch event', page.evaluate('window.mobileTestTouches') > 0)
                page.locator('#itinerarySourceFile').set_input_files([str(path) for path in files])
                page.wait_for_function("!isBusy && (document.getElementById('itineraryFileInfo').textContent.includes('已準備 4 個檔案') || !document.getElementById('itineraryImportError').hidden)", timeout=120000)
                report['preparation'] = {'info': page.locator('#itineraryFileInfo').text_content(), 'error': page.locator('#itineraryImportError').text_content()}
                check('four mixed files prepare without errors', page.locator('#itineraryImportError').is_hidden() and '6 張圖片' in page.locator('#itineraryFileInfo').text_content())
                check('preparation neither calls AI nor modifies saved data', not calls and page.evaluate('localStorage.tourismTrips_v1') == before)
                check('source modal has no horizontal overflow', page.evaluate('document.documentElement.scrollWidth<=innerWidth+1') and page.locator('#itineraryImportModal .modal-content').evaluate('e=>e.scrollWidth<=e.clientWidth+1'))
                shot('sources')
                page.locator('#itineraryParseButton').tap()
                print(json.dumps({'stage': 'Codex request sent', 'engine': engine}), flush=True)
                page.wait_for_function("!isBusy && (!document.getElementById('itinerarySaveButton').disabled || !document.getElementById('itineraryImportError').hidden)", timeout=215000)
                report['visible_error'] = redact(page.locator('#itineraryImportError').text_content())
                check('Codex response completes the import', page.locator('#itineraryImportError').is_hidden() and page.locator('#itinerarySaveButton').is_enabled())
                check('one request includes every PDF page and both images', len(calls) == 1 and Counter((item['name'], item['page']) for item in calls[0]['attachments']) == Counter([(files[0].name, 1), (files[0].name, 2), (files[1].name, 1), (files[1].name, 2), (files[2].name, 1), (files[3].name, 1)]))
                check('preview does not change original journey data', page.evaluate('localStorage.tourismTrips_v1') == before)
                details = page.locator('#itineraryImportPreview details')
                check('preview has exactly two itinerary days', details.count() == 2)
                actual = []
                for i in range(details.count()):
                    detail = details.nth(i)
                    date = re.search(r'\d{4}-\d{2}-\d{2}', detail.locator('summary').text_content()).group()
                    if not detail.evaluate('e=>e.open'):
                        detail.locator('summary').tap()
                    for item in detail.locator('li').all():
                        label = item.locator('strong').text_content()
                        time = re.match(r'\d{2}:\d{2}', label).group()
                        title = label.split(' · ', 1)[1]
                        actual.append({'date': date, 'time': time, 'title': title, 'text': item.text_content()})
                    detail.evaluate("e=>e.scrollIntoView({block:'start'})")
                    shot(f'preview-day-{i+1}')
                report['actual'] = actual
                counts = Counter((row['date'], row['time'], normalize(row['title'])) for row in actual)
                expected_counts = Counter((date, time, normalize(title)) for date, time, title, _ in EXPECTED)
                check('all eight activities survive exactly once with dates and times', counts == expected_counts)
                check('activities remain in chronological order', [(item['date'], item['time']) for item in actual] == sorted((item['date'], item['time']) for item in actual))
                for date, time, title, notes in EXPECTED:
                    match = next(item for item in actual if (item['date'], item['time'], normalize(item['title'])) == (date, time, normalize(title)))
                    preserved = [note for note in notes if normalize(note) in normalize(match['text'])]
                    comparisons.append({'date': date, 'time': time, 'title': title, 'expected_notes': notes, 'preserved_notes': preserved, 'passed': len(preserved) == len(notes)})
                check('all complementary notes survive duplicate merging', all(item['passed'] for item in comparisons))
                check('same-place visits at different times or dates stay separate', sum(item['title'] == '大稻埕' for item in actual) == 2 and sum(normalize(item['title']) == '台北車站' for item in actual) == 2)
                check('preview modal has no horizontal overflow', page.locator('#itineraryImportModal .modal-content').evaluate('e=>e.scrollWidth<=e.clientWidth+1'))
                page.locator('#itineraryImportName').fill(f'手機驗收-{engine}')
                with page.expect_navigation(wait_until='domcontentloaded', timeout=60000):
                    page.locator('#itinerarySaveButton').tap()
                page.wait_for_function("typeof isBusy !== 'undefined' && !isBusy && JSON.parse(localStorage.tourismTrips_v1).trips.length===2", timeout=60000)
                page.reload(wait_until='domcontentloaded', timeout=60000)
                page.wait_for_function('typeof TripLibrary!=="undefined" && typeof tripData!=="undefined" && tripData.length===2', timeout=60000)
                book = page.evaluate('JSON.parse(localStorage.tourismTrips_v1)')
                check('original journey including notes remains identical after save and reload', next(item for item in book['trips'] if item['id'] == original['id']) == original)
                saved = next(item for item in book['trips'] if item['id'] == book['activeId'])['data']['t']
                saved_counts = Counter((day['date'], item['time'], normalize(item['title'])) for day in saved for item in day['itinerary'])
                check('two days and all eight deduplicated activities persist after reload', len(saved) == 2 and saved_counts == expected_counts)
                check('no other server mutation or uncaught browser exception', not blocked and not errors)
                report['passed'] = True
            except Exception as error:
                report['passed'] = False
                report['failure'] = redact(error)
                try:
                    shot('failure')
                except Exception:
                    pass
            finally:
                context.close()
                browser.close()
            reports.append(report)
            (output / f'{engine}-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
            print(json.dumps({'stage': 'complete', 'engine': engine, 'passed': report['passed'], 'checks': len(checks)}), flush=True)
    result = {'tested_at': datetime.now(timezone.utc).isoformat(), 'target': TARGET, 'passed': all(item['passed'] for item in reports), 'source_records': 14, 'expected_unique': 8, 'expected_duplicate_records': 6, 'engines': reports, 'scope': 'See per-engine transport: real Codex or replay of its previously captured actual response. Pixel 7 Chromium and iPhone 13 WebKit emulation; not physical devices. Two two-page raster PDFs + PNG + JPEG. Saved only in isolated browser contexts; no user journey or server stored data modified.'}
    (output / 'report.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'passed': result['passed'], 'report': str(output / 'report.json')}), flush=True)
    return 0 if result['passed'] else 1


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--credentials', required=True)
    parser.add_argument('--output', default='mobile-codex-import-20261023')
    parser.add_argument('--replay-chromium', help='Reuse a captured actual Chromium response for UI persistence checks without another AI request')
    parser.add_argument('--engine', choices=['both', 'chromium', 'webkit'], default='both')
    args = parser.parse_args()
    raise SystemExit(run(args))
