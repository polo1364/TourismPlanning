"""Exercise degraded scans against real Codex, retaining source and response evidence."""
import argparse
import base64
from collections import Counter
import html
import json
from pathlib import Path
import re
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright
from itinerary_mobile_codex_live import SOURCES, EXPECTED, TARGET, ROOT, normalize


def make_sources(browser, output, case):
    page = browser.new_page(viewport={'width': 1400, 'height': 1100}, device_scale_factor=1)
    files, manifest = [], []
    styles = [('blur(1.2px)', 'rotate(7deg)'), ('blur(1px)', 'rotate(-90deg)'),
              ('blur(1.3px)', 'skewX(-8deg) rotate(-5deg)'), ('blur(1px)', 'rotate(180deg)')]
    names = ['掃描甲.pdf', '掃描乙.pdf', '照片甲.png', '照片乙.jpg']
    for index, (_, pages) in enumerate(SOURCES):
        if case == 'unreadable-page' and index == 1:
            pages = pages + [('2026-11-12', [('09:00', '天垣古董店', '沿北側階梯上樓'), ('12:00', '霞汐食堂', '窗邊座位')])]
        name, rasters = names[index], []
        for number, (date, stops) in enumerate(pages, 1):
            rows = ''.join(f'<section><b>{time} {html.escape(title)}</b><div>提醒：{html.escape(note)}</div></section>' for time, title, note in stops)
            extra = ''
            if case == 'unclear' and index == 2:
                # A unique activity is intentionally unrecoverable; its time remains legible.
                extra = '<section><b>19:30 <span style="filter:blur(24px)">光嶼咖啡館</span></b><div>提醒：<span style="filter:blur(24px)">攜帶白色預約卡</span></div></section>'
            blur, transform = styles[index]
            if case == 'unreadable-page' and index == 1 and number == 3:
                blur, transform = 'blur(18px)', 'rotate(9deg)'
            page.set_content(f'<style>body{{margin:0;background:white;color:#111;font:36px "Microsoft JhengHei",sans-serif;line-height:1.55}}article{{position:absolute;left:270px;top:160px;width:860px;transform:{transform};filter:{blur};transform-origin:50% 50%}}h1{{font-size:38px}}section{{margin:26px 0}}b{{font-weight:500}}</style><article><h1>台北旅行行程 {date}</h1>{rows}{extra}</article>')
            page.evaluate('document.fonts.ready')
            kind = 'jpeg' if name.endswith('.jpg') else 'png'
            pixels = page.screenshot(type=kind, **({'quality': 80} if kind == 'jpeg' else {}))
            (output / f'source-{index+1}-page-{number}.{kind}').write_bytes(pixels)
            rasters.append((kind, pixels))
        if name.endswith('.pdf'):
            images = ''.join(f'<section><img src="data:image/{kind};base64,{base64.b64encode(data).decode()}"/></section>' for kind, data in rasters)
            page.set_content('<style>@page{size:1400px 1100px;margin:0}body{margin:0}section{height:1100px;break-after:page;overflow:hidden}section:last-child{break-after:auto}img{width:100%}</style>' + images)
            page.evaluate('Promise.all([...document.images].map(image=>image.decode()))')
            data = page.pdf(prefer_css_page_size=True, print_background=True)
        else:
            data = rasters[0][1]
        path = output / name
        path.write_bytes(data)
        files.append(path)
        manifest.append({'name': name, 'pages': pages, 'effects': styles[index]})
    page.close()
    unclear = {'file': names[2], 'page': 1, 'time': '19:30', 'title': '光嶼咖啡館', 'note': '攜帶白色預約卡'} if case == 'unclear' else {'file': names[1], 'page': 3, 'effect': 'blur(18px) rotate(9deg)'} if case == 'unreadable-page' else None
    (output / 'sources.json').write_text(json.dumps({'sources': manifest, 'expected_readable': EXPECTED, 'source_records': 15 if case == 'unclear' else 16 if case == 'unreadable-page' else 14, 'unreadable': unclear}, ensure_ascii=False, indent=2), encoding='utf-8')
    return files


def run(args):
    output = ROOT / 'artifacts' / args.output
    output.mkdir(parents=True, exist_ok=False)
    credentials = json.loads(Path(args.credentials).read_text(encoding='utf-8-sig'))
    origin = TARGET.rstrip('/')
    assert credentials['url'].rstrip('/') == origin
    authorization = 'Basic ' + base64.b64encode(f"{credentials['username']}:{credentials['password']}".encode()).decode()
    report = {'target': TARGET, 'case': args.case, 'engine': args.engine, 'physical_device': False, 'calls': [], 'responses': [], 'checks': [], 'errors': [], 'blocked': [], 'local_candidate': bool(args.candidate)}
    replay = json.loads(Path(args.replay).read_text(encoding='utf-8'))['responses'][0] if args.replay else None
    report['transport'] = 'replayed_actual_response' if replay else 'real_codex'
    if replay:
        assert replay['status'] == 200
        report['replay_source'] = str(Path(args.replay).resolve())
    def check(name, passed):
        report['checks'].append({'name': name, 'passed': bool(passed)})
        if not passed:
            raise AssertionError(name)
    with sync_playwright() as p:
        maker = p.chromium.launch()
        files = make_sources(maker, output, args.case)
        maker.close()
        browser = getattr(p, args.engine).launch()
        device = 'Pixel 7' if args.engine == 'chromium' else 'iPhone 13'
        context = browser.new_context(**p.devices[device], service_workers='block', timezone_id='Asia/Taipei')
        context.add_init_script("localStorage.setItem('aiProvider','deepseek');localStorage.setItem('roamReadingMode','continuous');")
        def route_request(route):
            request = route.request
            parsed = urlsplit(request.url)
            same = f'{parsed.scheme}://{parsed.netloc}' == origin
            if parsed.scheme == 'blob' and request.url.startswith(f'blob:{origin}/'):
                return route.continue_()
            if same and args.candidate and parsed.path == '/itinerary-import.js':
                return route.fulfill(path=str(ROOT / 'itinerary-import.js'), content_type='application/javascript')
            if same and request.method == 'POST' and parsed.path == '/codex/import-itinerary' and not report['calls']:
                body = request.post_data_json
                report['calls'].append({'attachments': [{k: image[k] for k in ['name', 'page']} for image in body['images']]})
                (output / 'prompt.txt').write_text(body['prompt'], encoding='utf-8')
                if replay:
                    return route.fulfill(status=200, content_type='application/json', body=json.dumps(replay['body']))
                return route.continue_(headers={**request.headers, 'authorization': authorization})
            if request.method not in {'GET', 'HEAD'}:
                report['blocked'].append({'method': request.method, 'path': parsed.path})
                return route.abort()
            if same:
                return route.continue_(headers={**request.headers, 'authorization': authorization})
            if parsed.hostname in {'fonts.googleapis.com', 'fonts.gstatic.com', 'cdnjs.cloudflare.com', 'html2canvas.hertzen.com'}:
                return route.continue_()
            return route.abort()
        context.route('**/*', route_request)
        page = context.new_page()
        page.on('pageerror', lambda error: report['errors'].append(str(error)))
        def response_seen(response):
            if urlsplit(response.url).path == '/codex/import-itinerary':
                report['responses'].append({'status': response.status, 'body': response.json()})
        page.on('response', response_seen)
        try:
            check('production login', page.goto(TARGET, wait_until='networkidle', timeout=60000).status == 200)
            page.wait_for_selector('#openItineraryImport')
            before = page.evaluate('localStorage.tourismTrips_v1')
            page.locator('#openItineraryImport').tap()
            page.locator('#itinerarySourceFile').set_input_files([str(file) for file in files])
            page.wait_for_function("!isBusy && (document.getElementById('itineraryFileInfo').textContent.includes('已準備 4 個檔案') || !document.getElementById('itineraryImportError').hidden)", timeout=120000)
            report['prepare_error'] = page.locator('#itineraryImportError').text_content()
            image_count = 7 if args.case == 'unreadable-page' else 6
            check('all mixed files prepared', page.locator('#itineraryImportError').is_hidden() and f'{image_count} 張圖片' in page.locator('#itineraryFileInfo').text_content())
            check('no AI call during preparation', not report['calls'])
            page.locator('#itineraryParseButton').tap()
            print(json.dumps({'stage': 'import request sent', 'transport': report['transport'], 'case': args.case, 'engine': args.engine}), flush=True)
            page.wait_for_function("!isBusy && (!document.getElementById('itinerarySaveButton').disabled || !document.getElementById('itineraryImportError').hidden)", timeout=215000)
            report['visible_error'] = page.locator('#itineraryImportError').text_content()
            report['warnings'] = page.locator('#itineraryImportPreview .import-warning').all_text_contents()
            report['preview'] = page.locator('#itineraryImportPreview').text_content()
            report['save_enabled'] = page.locator('#itinerarySaveButton').is_enabled()
            check('one import call includes every source page', len(report['calls']) == 1 and len(report['calls'][0]['attachments']) == image_count)
            check('existing journeys unchanged', before == page.evaluate('localStorage.tourismTrips_v1'))
            if args.case != 'readable':
                message = report['visible_error'] + '\n'.join(report['warnings'])
                check('unreadable activity is explicitly flagged', bool(re.search('模糊|不清|無法辨識|無法可靠|待確認|看不清|難以辨識', message)))
                if args.case == 'unclear':
                    check('warning identifies the affected source or activity', '照片甲' in message or '19:30' in message)
                    check('unknown activity is not silently saved as complete', not report['save_enabled'] or ('19:30' in report['preview'] and bool(report['warnings'])))
                else:
                    check('warning identifies the unreadable PDF page', '掃描乙' in message and bool(re.search('第.?3.?頁|第.?三.?頁|page.?3', message)))
                    check('unreadable entire page blocks saving an incomplete itinerary', not report['save_enabled'])
            else:
                check('readable degraded scans produce a preview', report['save_enabled'] and not report['visible_error'])
            if report['save_enabled']:
                actual = []
                for detail in page.locator('#itineraryImportPreview details').all():
                    date = re.search(r'\d{4}-\d{2}-\d{2}', detail.locator('summary').text_content()).group()
                    for item in detail.locator('li').all():
                        label = item.locator('strong').text_content()
                        actual.append({'date': date, 'time': label[:5], 'title': label.split(' · ', 1)[1], 'text': item.text_content()})
                report['actual'] = actual
                expected = Counter((date, time, normalize(title)) for date, time, title, _ in EXPECTED)
                check('all eight activities preserved and six duplicates merged', Counter((x['date'], x['time'], normalize(x['title'])) for x in actual) == expected)
                check('all thirteen complementary notes preserved', all(all(normalize(note) in normalize(next(x['text'] for x in actual if (x['date'], x['time'], normalize(x['title'])) == (date, time, normalize(title)))) for note in notes) for date, time, title, notes in EXPECTED))
            check('no horizontal overflow', page.locator('#itineraryImportModal .modal-content').evaluate('e=>e.scrollWidth<=e.clientWidth+1'))
            if report['save_enabled']:
                page.locator('#itineraryImportPreview').screenshot(path=str(output / 'preview.png'))
                with page.expect_navigation(wait_until='domcontentloaded', timeout=60000):
                    page.locator('#itinerarySaveButton').tap()
                page.wait_for_function('typeof TripLibrary!=="undefined" && typeof tripData!=="undefined" && tripData.length===2', timeout=60000)
                book = page.evaluate('JSON.parse(localStorage.tourismTrips_v1)')
                previous = json.loads(before)
                check('original journeys are identical after saving', all(trip in book['trips'] for trip in previous['trips']))
                saved = next(trip for trip in book['trips'] if trip['id'] == book['activeId'])['data']['t']
                check('all eight activities persist', Counter((day['date'], item['time'], normalize(item['title'])) for day in saved for item in day['itinerary']) == expected)
                summary = '\n'.join(day['summary'] for day in saved)
                check('all warnings persist in saved journey', all(warning in summary for warning in report['warnings']))
            check('no unintended mutation or uncaught exception', not report['errors'] and not report['blocked'])
            report['passed'] = True
        except Exception as error:
            report['passed'] = False
            report['failure'] = str(error)
        finally:
            page.screenshot(path=str(output / 'result.png'))
            context.close()
            browser.close()
    (output / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'passed': report['passed'], 'checks': len(report['checks']), 'report': str(output / 'report.json')}), flush=True)
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--credentials', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--case', choices=['readable', 'unclear', 'unreadable-page'], required=True)
    parser.add_argument('--engine', choices=['chromium', 'webkit'], default='chromium')
    parser.add_argument('--candidate', action='store_true', help='Serve only the local import JS to this isolated browser; the AI request still uses production Codex')
    parser.add_argument('--replay', help='Replay a recorded actual Codex response for UI/storage checks without another AI call')
    raise SystemExit(run(parser.parse_args()))
