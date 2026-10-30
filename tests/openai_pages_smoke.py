"""Isolated HTTPS Pages origin, real file preparation, mocked official API; no billable calls."""
import base64
import hashlib
import json
import mimetypes
from urllib.parse import urlsplit, unquote
from playwright.sync_api import sync_playwright
from browser_smoke import ROOT, Network
from itinerary_import_smoke import fixture_pdfs, response, TEXT

BASE = 'https://polo1364.github.io/TourismPlanning/'
KEY = 'sk-fake-pages-test-only-1234567890'


class PagesNetwork(Network):
    def __init__(self, image):
        super().__init__()
        self.requests = []
        self.result = None
        self.status = 200
        self.image = image
        self.image_calls = 0
        self.foreign = []
        self.missing_review = False

    def route(self, route):
        req = route.request
        url = urlsplit(req.url)
        if not url.hostname or url.scheme == 'blob':
            return route.continue_()
        if req.url.startswith(BASE):
            relative = unquote(url.path[len('/TourismPlanning/'):]) or 'index.html'
            file = (ROOT / relative).resolve()
            if not file.is_relative_to(ROOT) or not file.is_file():
                return route.fulfill(status=404, body='Not found')
            mime = 'text/javascript' if file.suffix in ['.js', '.mjs'] else mimetypes.guess_type(str(file))[0] or 'application/octet-stream'
            return route.fulfill(path=str(file), content_type=mime)
        if url.hostname == 'api.openai.com':
            if req.method == 'OPTIONS':
                return route.fulfill(status=204, headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization,content-type','Access-Control-Allow-Methods':'GET,POST'})
            assert req.headers.get('authorization') == 'Bearer ' + KEY
            self.requests.append(url.path)
            if url.path == '/v1/models':
                return route.fulfill(json={'data': [{'id':'gpt-6-sol'},{'id':'unrecognized-model'}]})
            if url.path == '/v1/images/generations':
                self.image_calls += 1
                return route.fulfill(json={'data':[{'b64_json':base64.b64encode(self.image).decode()}]})
            assert url.path == '/v1/responses'
            body = req.post_data_json
            self.ai_requests.append(body)
            content = body['input'][0]['content']
            images = [x for x in content if x['type'] == 'input_image']
            data = response()
            data['sourceReviews'] = [{'index':i+1,'status':'clear','message':''} for i in range(len(images))]
            if self.missing_review:
                data['sourceReviews'] = data['sourceReviews'][:-1]
            result = self.result or {'status':'completed','output':[{'type':'message','content':[{'type':'output_text','text':json.dumps(data)}]}], 'usage':{'input_tokens':12,'output_tokens':8,'total_tokens':20}}
            if self.hold_ai:
                self.pending.append((route, result))
                return
            return route.fulfill(status=self.status, json=result)
        if url.hostname in ['127.0.0.1','localhost','api.deepseek.com'] or 'sslip.io' in url.hostname:
            self.foreign.append(req.url)
            return route.abort()
        return super().route(route)


def main():
    import sys
    sys.stdout.reconfigure(encoding='utf-8')
    output = ROOT / 'artifacts/openai-pages'
    output.mkdir(parents=True, exist_ok=True)
    checks = []
    def check(name, value):
        checks.append({'name':name,'passed':bool(value)})
        assert value, name
    with sync_playwright() as p:
        fixture_browser = p.chromium.launch()
        _, _, image, scan = fixture_pdfs(fixture_browser)
        fixture_browser.close()
        for profile in ['desktop','android','iphone']:
            browser = (p.webkit if profile == 'iphone' else p.chromium).launch()
            device = p.devices['iPhone 13' if profile == 'iphone' else 'Pixel 7'] if profile != 'desktop' else {'viewport':{'width':1440,'height':1000}}
            context = browser.new_context(**device, accept_downloads=True)
            network = PagesNetwork(image.read_bytes())
            context.route('**/*', network.route)
            page = context.new_page()
            page.set_default_timeout(20000)
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.goto(BASE, wait_until='networkidle')
            page.wait_for_function("CodexLocal.billing()==='api'")
            check(profile+' no automatic network calls', not network.requests and not network.foreign)
            page.evaluate("openModal('apiModal')")
            check(profile+' direct API settings visible', page.locator('#openaiKeySettings').is_visible() and page.locator('#aiProvider').input_value()=='codex')
            page.locator('#openaiApiKey').fill(KEY)
            page.locator('#openaiSaveKey').click()
            page.wait_for_function("OpenAIBrowser.ready()")
            check(profile+' key check only calls models', network.requests==['/v1/models'])
            check(profile+' key absent from input and browser storage', page.locator('#openaiApiKey').input_value()=='' and KEY not in page.evaluate('JSON.stringify([localStorage,sessionStorage])'))
            check(profile+' settings fit screen', page.locator('#apiModal .modal-content').evaluate('e=>e.scrollWidth<=e.clientWidth+1'))
            page.locator('#openaiKeySettings').screenshot(path=str(output/f'settings-{profile}.png'))
            page.evaluate("closeModal('apiModal')")
            page.locator('#openItineraryImport').click()
            page.wait_for_function("!document.getElementById('itinerarySourceFile').disabled")
            # Two scanned PDFs, one image and 47 text files reach the 50-file boundary.
            files = [{'name':f'scan-{i}.pdf','mimeType':'application/pdf','buffer':scan.read_bytes()} for i in range(2)]
            files += [{'name':'photo.png','mimeType':'image/png','buffer':image.read_bytes()}]
            files += [{'name':f'note-{i}.txt','mimeType':'text/plain','buffer':TEXT.encode()} for i in range(47)]
            page.locator('#itinerarySourceFile').set_input_files(files)
            page.wait_for_function("!isBusy && document.getElementById('itineraryFileInfo').textContent.includes('50 個檔案')", timeout=60000)
            page.locator('#itineraryAddCorrection').click()
            page.locator('#itineraryCorrection-0').fill('補充：晚餐餐盒與茶飲，請不要漏掉。')
            try:
                page.wait_for_function("document.getElementById('itineraryDraftStatus').textContent.includes('草稿已儲存')")
            except Exception:
                print(json.dumps({'profile':profile,'draft':page.locator('#itineraryDraftStatus').inner_text(),'errors':errors},ensure_ascii=False))
                raise
            page.locator('#itineraryParseButton').click()
            page.wait_for_function("!isBusy && !document.getElementById('itinerarySaveButton').disabled")
            sent = network.ai_requests[-1]
            content = sent['input'][0]['content']
            check(profile+' 50 sources and manual note sent together', 'note-46.txt' in content[0]['text'] and '晚餐餐盒與茶飲' in content[0]['text'])
            check(profile+' scanned PDFs and image all sent in order', [json.loads(x['text'])['source'] for x in content[1:] if x['type']=='input_text']==['scan-0.pdf','scan-1.pdf','photo.png'] and len([x for x in content if x['type']=='input_image'])==3)
            check(profile+' official API JSON and storage options', sent['store'] is False and sent['text']['format']['type']=='json_object' and 'tools' not in sent)
            check(profile+' merged duplicate and all activities preserved', '2 天' in page.locator('.import-preview-total').inner_text() and '3 個活動' in page.locator('.import-preview-total').inner_text() and '1 個重複' in page.locator('.import-preview-total').inner_text())
            check(profile+' no API key in itinerary payload', KEY not in json.dumps(sent))
            check(profile+' real usage mapping', '20 Token' in page.locator('#codexTokenUsage').text_content())
            check(profile+' preview fits screen', page.locator('#itineraryImportModal .modal-content').evaluate('e=>e.scrollWidth<=e.clientWidth+1'))
            page.locator('#itineraryImportPreview').screenshot(path=str(output/f'import-{profile}.png'))
            before = len(network.ai_requests)
            page.reload(wait_until='networkidle')
            check(profile+' key cleared on reload without paid retry', not page.evaluate('OpenAIBrowser.ready()') and len(network.ai_requests)==before)
            page.locator('#openItineraryImport').click()
            page.wait_for_function("!document.getElementById('itinerarySourceFile').disabled")
            check(profile+' files manual notes and preview restored', '50 個檔案' in page.locator('#itineraryFileInfo').inner_text() and '晚餐餐盒' in page.locator('#itineraryCorrection-0').input_value() and page.locator('#itineraryImportPreview').is_visible())
            originals = page.evaluate("""async()=>{const db=await new Promise(r=>{const q=indexedDB.open('roamItineraryDraft_v1',1);q.onsuccess=()=>r(q.result)});const s=await new Promise(r=>{const q=db.transaction('draft').objectStore('draft').get('sources');q.onsuccess=()=>r(q.result)});db.close();return Promise.all(s.originals.map(async f=>({name:f.name,hash:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',f.bytes || await f.arrayBuffer()))).map(x=>x.toString(16).padStart(2,'0')).join('')})))}""")
            check(profile+' all original bytes survive reload', originals==[{'name':f['name'],'hash':hashlib.sha256(f['buffer']).hexdigest()} for f in files])
            page.locator('#itineraryParseButton').click()
            page.wait_for_function('!isBusy')
            check(profile+' missing key blocks request with files retained', len(network.ai_requests)==before and 'API Key' in page.locator('#itineraryImportError').inner_text())
            page.evaluate("closeModal('itineraryImportModal');openModal('apiModal')")
            page.locator('#openaiApiKey').fill(KEY)
            page.locator('#openaiSaveKey').click()
            page.wait_for_function('OpenAIBrowser.ready()')
            page.evaluate("closeModal('apiModal')")
            page.locator('#openItineraryImport').click()
            network.missing_review = True
            page.locator('#itineraryParseButton').click()
            page.wait_for_function('!isBusy')
            check(profile+' missing page review cannot be silently saved', page.locator('#itinerarySaveButton').is_disabled() and bool(page.locator('#itineraryImportError').inner_text()))
            network.missing_review = False
            network.status = 429
            page.locator('#itineraryParseButton').click()
            page.wait_for_function('!isBusy')
            check(profile+' API error retains correction and blocks save', '晚餐餐盒' in page.locator('#itineraryCorrection-0').input_value() and page.locator('#itinerarySaveButton').is_disabled() and '額度不足' in page.locator('#itineraryImportError').inner_text())
            network.status = 200
            network.result = {'status':'incomplete'}
            page.locator('#itineraryParseButton').click()
            page.wait_for_function('!isBusy')
            check(profile+' incomplete response never becomes itinerary', page.locator('#itinerarySaveButton').is_disabled() and '完整回覆' in page.locator('#itineraryImportError').inner_text())
            network.result = None
            network.hold_ai = True
            page.locator('#itineraryParseButton').click()
            page.wait_for_function("document.getElementById('itineraryWorkTitle').textContent.includes('OpenAI API')")
            page.wait_for_timeout(500)
            page.locator('#itineraryImportCancel').click()
            page.wait_for_function('!isBusy')
            network.hold_ai = False
            for route, result in network.pending:
                try: route.fulfill(json=result)
                except Exception: pass
            check(profile+' cancel preserves sources and does not save', page.locator('#itinerarySaveButton').is_disabled() and '50 個檔案' in page.locator('#itineraryFileInfo').inner_text())
            page.locator('#itineraryParseButton').click()
            page.wait_for_function("!isBusy && !document.getElementById('itinerarySaveButton').disabled")
            check(profile+' successful retry uses same attachments', len(network.ai_requests[-1]['input'][0]['content'])==7)
            # Exercise durable direct image jobs, including a duplicate POST and reload recovery.
            page.evaluate("closeModal('itineraryImportModal');window.imageId=crypto.randomUUID()")
            page.evaluate("CodexLocal.imageRequest('',{id:window.imageId,subject:{city:'Taipei',places:['Park']}})")
            page.evaluate("async()=>{for(let n=0;n<100;n++){const s=await CodexLocal.imageRequest('/'+window.imageId);if(s.status==='completed')return;if(s.status!=='running')throw Error(s.error);await new Promise(r=>setTimeout(r,100))}throw Error('image timeout')}")
            page.evaluate("CodexLocal.imageRequest('',{id:window.imageId,subject:{city:'Taipei'}})")
            check(profile+' images billed once and reusable', network.image_calls==1 and page.evaluate("async()=>!!(await CodexLocal.imageRequest('/'+window.imageId+'/image')).base64"))
            image_id = page.evaluate('window.imageId')
            page.reload(wait_until='networkidle')
            check(profile+' completed images retrievable after reload without key', page.evaluate("async id=>(await CodexLocal.imageRequest('/'+id)).status", image_id)=='completed' and network.image_calls==1)
            check(profile+' no private localhost or DeepSeek dependency', not network.foreign)
            check(profile+' no browser errors', not errors)
            context.close()
            browser.close()
    (output/'report.json').write_text(json.dumps({'checks':checks,'api':'mocked','physical_device':False},indent=2),encoding='utf-8')
    print(json.dumps({'passed':True,'checks':len(checks)}))


if __name__ == '__main__':
    main()
