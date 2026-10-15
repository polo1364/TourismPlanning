"""Artwork lifecycle and offline booklet regression; no paid AI or user data."""
import base64
import io
import json
import mimetypes
import threading
from functools import partial
from http.server import ThreadingHTTPServer
from urllib.parse import urlparse
from PIL import Image, ImageDraw
from playwright.sync_api import sync_playwright
from browser_smoke import ROOT, ARTIFACTS, Handler, Network, sample_day, overflow


def main():
    server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory=str(ROOT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    ARTIFACTS.mkdir(exist_ok=True)
    output_dir = ARTIFACTS / 'illustrations'
    output_dir.mkdir(exist_ok=True)
    picture = Image.new('RGB', (1200, 800), '#eee4cd')
    draw = ImageDraw.Draw(picture)
    draw.rectangle((500, 120, 700, 700), fill='#386276')
    draw.ellipse((70, 70, 250, 250), fill='#cc8b64')
    stream = io.BytesIO()
    picture.save(stream, format='PNG')
    live = output_dir / 'codex-live.png'
    image_data = base64.b64encode(live.read_bytes() if live.exists() else stream.getvalue()).decode()
    jobs, shares, checks, errors = {}, [], [], []
    starts = []
    hold = [False]
    lose_response = [False]
    network = Network()

    def check(name, result):
        checks.append({'name': name, 'passed': bool(result)})
        assert result, name

    def route_handler(route):
        request = route.request
        parsed = urlparse(request.url)
        path = parsed.path
        api = path.removeprefix('/codex')
        def respond(value, status=200):
            route.fulfill(status=status, content_type='application/json', body=json.dumps(value), headers={'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type,x-roam-token'})
        if parsed.port == 8081 or (parsed.hostname == 'travel.test' and path.startswith('/codex/')):
            if request.method == 'OPTIONS':
                return respond({})
            if api == '/status':
                return respond({'service': 'roam-cloud' if path.startswith('/codex') else 'roam-codex', 'ready': True, 'auth': 'chatgpt', 'token': 'fixture'})
            if api == '/usage':
                return respond({'available': False, 'models': []})
            if api == '/images' and request.method == 'POST':
                body = request.post_data_json
                if body['id'] not in jobs:
                    starts.append(body)
                    jobs[body['id']] = {'id': body['id'], 'subject': body['subject'], 'status': 'running' if hold[0] else 'completed'}
                if lose_response[0]:
                    lose_response[0] = False
                    return route.abort()
                return respond(jobs[body['id']], 202)
            if api.startswith('/images/'):
                parts = api.split('/')
                job = jobs.get(parts[2])
                if not job:
                    return respond({'error': 'not found', 'code': 'NOT_FOUND'}, 404)
                if parts[-1] == 'cancel':
                    job['status'] = 'cancelled'
                    return respond(job)
                if parts[-1] == 'image':
                    return respond({'mime': 'image/png', 'base64': image_data})
                return respond(job)
            return respond({'error': 'unexpected endpoint'}, 404)
        if path == '/api/shares' and parsed.hostname == 'travel.test':
            if request.method == 'GET':
                return respond({'token': 'share-fixture', 'shares': shares})
            body = request.post_data_json
            (output_dir / 'shared-with-artwork.html').write_text(body['html'], encoding='utf-8')
            item = {'id': 'a' * 48, 'title': body['title'], 'url': 'https://travel.test/s/' + 'a' * 48, 'createdAt': '2026-10-15T12:00:00Z'}
            shares.append(item)
            return respond(item, 201)
        if parsed.hostname in ['travel.test', 'public.test']:
            file = ROOT / ('index.html' if path == '/' else path.lstrip('/'))
            if file.is_file() and file.resolve().is_relative_to(ROOT):
                return route.fulfill(path=str(file), content_type=mimetypes.guess_type(file.name)[0] or 'application/octet-stream')
            return route.fulfill(status=404, body='not found')
        return network.route(route)

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        context = browser.new_context(accept_downloads=True, viewport={'width': 1440, 'height': 1000}, reduced_motion='reduce')
        context.route('**/*', route_handler)
        page = context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('dialog', lambda dialog: dialog.accept())
        page.goto(f'http://127.0.0.1:{server.server_port}/', wait_until='networkidle')
        page.evaluate('''async days => {
            tripData=days;generationState=null;document.getElementById('city').value='台北';
            saveInputs();persistTrip();await renderTrip();PlannerUI.switchView('itinerary');
            document.getElementById('artworkPanel').open=true;await TripArtwork.refresh();
        }''', [sample_day(), sample_day('2026-11-11', '第二天散步')])
        check('two-day plan shows five illustration slots', page.locator('.artwork-card').count() == 5)
        page.locator('#generateArtwork').click()
        page.wait_for_function("!isBusy && document.getElementById('artworkCount').textContent.includes('5 / 5')")
        generated = len(starts)
        check('identical subjects across days reuse generated assets', generated == 3)
        check('image bytes kept out of localStorage', page.evaluate("!localStorage.getItem('tourismTrips_v1').includes('base64')"))
        check('previews all decoded', page.evaluate("[...document.querySelectorAll('.artwork-card img')].every(img=>img.complete&&img.naturalWidth>0)"))
        page.screenshot(path=str(output_dir / 'artwork-desktop.png'), full_page=True)
        page.reload(wait_until='networkidle')
        page.evaluate("document.getElementById('artworkPanel').open=true")
        page.wait_for_function("document.getElementById('artworkCount').textContent.includes('5 / 5')")
        check('reload never starts image generation', len(starts) == generated)
        for index in range(2):
            with page.expect_download() as download:
                page.locator('#downloadBook').click()
            download.value.save_as(str(output_dir / f'book-with-artwork-{index}.html'))
            page.wait_for_function('!isBusy')
        check('repeated downloads make zero generation calls', len(starts) == generated)
        book = output_dir / 'book-with-artwork-0.html'
        content = book.read_text(encoding='utf-8')
        check('book embeds daily scene and detail images', content.count('class="itinerary-picture"') == 2 and content.count('class="hero-art" src="data:image/jpeg;base64,') == 2)
        check('book has no storage or generation API', 'indexedDB' not in content and '/images' not in content)
        with page.expect_download() as download:
            page.locator('#backupArtwork').click()
        backup = output_dir / 'trip-with-artwork.json'
        download.value.save_as(str(backup))
        page.wait_for_function('!isBusy')
        data = json.loads(backup.read_text(encoding='utf-8'))
        check('backup contains all referenced assets', len(data['assets']) == 3)
        page.evaluate('''async()=>{tripData[0].itinerary[0].time='10:00';tripData[0].itinerary[0].cost='NT$300';persistTrip();await renderTrip();await TripArtwork.refresh();}''')
        check('time and cost changes keep illustrations', '5 / 5' in page.locator('#artworkCount').inner_text())
        page.evaluate('''async()=>{tripData[0].itinerary[0].title='故宮博物院';persistTrip();await renderTrip();await TripArtwork.refresh();}''')
        check('only cover and changed scene become stale', '3 / 5' in page.locator('#artworkCount').inner_text())
        with page.expect_download() as download:
            page.locator('#downloadBook').click()
        stale_book = output_dir / 'stale-with-artwork.html'
        download.value.save_as(str(stale_book))
        page.wait_for_function('!isBusy')
        check('stale image omitted without regeneration', stale_book.read_text(encoding='utf-8').count('class="hero-art" src=') == 1 and len(starts) == generated)
        page.evaluate('TripLibrary.undo()')
        page.wait_for_function('!isBusy')
        page.evaluate('TripArtwork.refresh()')
        check('undo recovers matching images', '5 / 5' in page.locator('#artworkCount').inner_text())
        # Lost POST response must recover the persisted request instead of resubmitting.
        lose_response[0] = True
        page.locator('.artwork-card button').first.click()
        page.wait_for_function('!isBusy')
        after_loss = len(starts)
        page.locator('#generateArtwork').click()
        page.wait_for_function('!isBusy')
        check('uncertain regeneration resumes original job', len(starts) == after_loss)
        # Cancel a held single-image regeneration; old image remains available.
        hold[0] = True
        page.locator('.artwork-card button').first.click()
        page.wait_for_function("document.getElementById('artworkStatus').textContent.includes('正在處理')")
        page.wait_for_timeout(200)
        page.locator('#stopArtwork').click()
        page.wait_for_function('!isBusy')
        hold[0] = False
        check('cancellation keeps previous artwork', '5 / 5' in page.locator('#artworkCount').inner_text())
        page.evaluate('''()=>{window.fixturePut=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(...args){if(this.name==='assets')throw new DOMException('fixture quota','QuotaExceededError');return window.fixturePut.apply(this,args);};}''')
        page.locator('.artwork-card button').first.click()
        page.wait_for_function('!isBusy')
        after_quota = len(starts)
        check('browser quota failure preserves previous pictures', '5 / 5' in page.locator('#artworkCount').inner_text())
        page.evaluate('()=>{IDBObjectStore.prototype.put=window.fixturePut;}')
        page.locator('#generateArtwork').click()
        page.wait_for_function('!isBusy')
        check('quota recovery reuses completed server picture', len(starts) == after_quota)
        check('concurrent tabs reserve the same request ID', page.evaluate('''async()=>{
            const key='fixture-concurrent-'+crypto.randomUUID();
            const values=await Promise.all([TripArtworkStore.reserveJob(key,{}),TripArtworkStore.reserveJob(key,{})]);
            return values[0].id===values[1].id;
        }'''))
        # Clone retains shared images, switching never starts generation.
        before_switch = len(starts)
        original_id = page.evaluate('TripLibrary.active().id')
        page.evaluate("TripLibrary.openName('duplicate')")
        with page.expect_navigation(wait_until='networkidle'):
            page.locator('#tripNameForm button[type=submit]').click()
        page.evaluate("document.getElementById('artworkPanel').open=true;TripArtwork.refresh()")
        page.wait_for_function("document.getElementById('artworkCount').textContent.includes('5 / 5')")
        with page.expect_navigation(wait_until='networkidle'):
            page.evaluate('(id)=>TripLibrary.select(id)', original_id)
        check('copy and switch generate nothing', len(starts) == before_switch)
        page.set_viewport_size({'width':390,'height':844})
        page.evaluate("document.getElementById('artworkPanel').open=true;TripArtwork.refresh()")
        page.wait_for_timeout(200)
        check('mobile artwork panel fits viewport', not overflow(page)['overflow'])
        page.screenshot(path=str(output_dir / 'artwork-mobile.png'), full_page=True)
        # A different browser engine + public mode: import must bring image bytes, not backend links.
        webkit = playwright.webkit.launch()
        public = webkit.new_context(accept_downloads=True, viewport={'width':390,'height':844})
        public.route('**/*', route_handler)
        imported = public.new_page()
        imported.on('pageerror', lambda error: errors.append(str(error)))
        imported.on('dialog', lambda dialog: dialog.accept())
        imported.goto('https://public.test/', wait_until='networkidle')
        with imported.expect_navigation(wait_until='networkidle'):
            imported.locator('#importFile').set_input_files(str(backup))
        imported.wait_for_function('tripData.length===2')
        imported.evaluate("document.getElementById('artworkPanel').open=true;TripArtwork.refresh()")
        imported.wait_for_function("document.getElementById('artworkCount').textContent.includes('5 / 5')")
        check('cross-browser backup restores actual images', imported.locator('.artwork-card img').count() == 5)
        check('import preserves compressed image bytes without another lossy encode', imported.evaluate('''async expected=>{
            const image=await TripArtworkStore.get(TripLibrary.active().data.a[0].assetId);return image.dataUrl===expected;
        }''', data['assets'][0]['dataUrl']))
        check('public site disables generation but permits reading', imported.locator('#generateArtwork').is_disabled())
        # Malformed image import cannot replace current data.
        check('bad imported image preserves trip', imported.evaluate('''async()=>{
            const before=JSON.stringify(TripLibrary.active());
            try{await TripArtwork.importBackup({format:'tourism-artwork',version:1,collection:{format:'tourism-library',version:1,trips:[{name:'bad',data:TripLibrary.active().data}]},assets:[{id:crypto.randomUUID(),dataUrl:'data:image/svg+xml;base64,PHN2Zz4='}]});return false;}catch{return before===JSON.stringify(TripLibrary.active());}
        }'''))
        imported.evaluate('''()=>{
            const refs=TripLibrary.active().data.a;
            refs.push({assetId:crypto.randomUUID(),fingerprint:'historical-missing-picture',slot:'old-day:scene',caption:'old'});
            TripLibrary.write({artworkRefs_v1:JSON.stringify(refs)},{undo:false});
        }''')
        with imported.expect_download() as historical_download:
            imported.locator('#backupArtwork').click()
        imported.wait_for_function('!isBusy')
        check('missing historical asset cannot block current picture backup', '1 筆' in imported.locator('#artworkStatus').inner_text())
        check('history exclusion affects backup only', imported.evaluate("TripLibrary.active().data.a.some(ref=>ref.fingerprint==='historical-missing-picture')"))
        public.close()
        webkit.close()
        # Private-cloud share embeds existing images without generating.
        cloud = browser.new_context(viewport={'width':1440,'height':1000})
        cloud.add_init_script('window.ROAM_CLOUD=true')
        cloud.route('**/*', route_handler)
        owner = cloud.new_page()
        owner.on('dialog', lambda dialog: dialog.accept())
        owner.on('pageerror', lambda error: errors.append(str(error)))
        owner.goto('https://travel.test/', wait_until='networkidle')
        with owner.expect_navigation(wait_until='networkidle'):
            owner.locator('#importFile').set_input_files(str(backup))
        owner.wait_for_function('tripData.length===2')
        share_before = len(starts)
        owner.locator('#createBookShare').click()
        owner.wait_for_function("!isBusy && document.getElementById('bookShareStatus').textContent.includes('已建立')")
        shared = (output_dir / 'shared-with-artwork.html').read_text(encoding='utf-8')
        check('share embeds images and never generates', len(starts) == share_before and shared.count('class="itinerary-picture"') == 2)
        check('shared book remains below 5 MiB', len(shared.encode()) <= 5 * 1024 * 1024)
        owner.evaluate('''async()=>{
            const first=structuredClone(tripData[0]);
            tripData=Array.from({length:15},(_,i)=>({...structuredClone(first),date:'2026-11-'+String(i+10),day_title:'第'+(i+1)+'天',itinerary:first.itinerary.map(item=>({...item,title:item.title+' '+i}))}));
            persistTrip();await renderTrip();
            const assetId=TripLibrary.active().data.a[0].assetId;
            let refs=[];for(const target of TripArtworkCore.targets('台北',tripData))refs=TripArtworkCore.attach(refs,target,assetId);
            TripLibrary.write({artworkRefs_v1:JSON.stringify(refs)},{undo:false});
        }''')
        owner.locator('#createBookShare').click()
        owner.wait_for_function("!isBusy && document.getElementById('bookShareStatus').textContent.includes('已建立')",timeout=60000)
        long_book = (output_dir / 'shared-with-artwork.html').read_text(encoding='utf-8')
        check('15-day book keeps all 31 pictures within share limit', long_book.count('class="itinerary-picture"') == 15 and long_book.count('class="hero-art" src=') == 15 and len(long_book.encode()) <= 5*1024*1024)
        check('15-day compression does not regenerate', len(starts) == share_before)
        cloud.close()
        # Offline images, full pagination and print are checked at desktop and mobile widths.
        for width, height in [(1440,1000),(390,844)]:
            reader = browser.new_context(viewport={'width':width,'height':height}, reduced_motion='reduce', offline=True)
            view = reader.new_page()
            view.on('pageerror', lambda error: errors.append(str(error)))
            view.goto(book.as_uri())
            view.wait_for_function("document.body.dataset.readerReady==='true' && [...document.images].every(i=>i.complete&&i.naturalWidth>0)")
            turns=0
            while not view.locator('#next').is_disabled():
                view.locator('#next').click();turns+=1
                assert turns < 100
            check(f'offline {width}px all pages reachable', turns > 2 and not overflow(view)['overflow'])
            view.emulate_media(media='print')
            check(f'print {width}px images remain loaded', view.evaluate('[...document.images].every(i=>i.naturalWidth>0)'))
            view.emulate_media(media='screen')
            view.wait_for_timeout(100)
            view.locator('#pagePicker').select_option('1')
            view.screenshot(path=str(output_dir / f'book-{width}.png'), animations='disabled')
            reader.close()
        check('no browser runtime errors', not errors)
        context.close()
        browser.close()
    server.shutdown()
    report = {'checks':checks,'passed':len(checks),'generation_starts':len(starts),'errors':errors}
    (output_dir / 'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({'passed':len(checks),'generation_starts':len(starts)}))


if __name__ == '__main__':
    main()
