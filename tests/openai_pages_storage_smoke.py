"""Legacy draft compatibility and uncertain image jobs on the Pages origin; mocked API."""
import base64
import json
from playwright.sync_api import sync_playwright
from browser_smoke import ROOT
from itinerary_import_smoke import fixture_pdfs
from openai_pages_smoke import BASE, KEY, PagesNetwork


class StorageNetwork(PagesNetwork):
    def __init__(self, image):
        super().__init__(image)
        self.held_images = []

    def route(self, route):
        if route.request.url == 'https://api.openai.com/v1/images/generations':
            self.image_calls += 1
            self.held_images.append(route)
            return
        return super().route(route)


def main():
    checks = []
    def check(name, value):
        assert value, name
        checks.append(name)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        _, _, image, _ = fixture_pdfs(browser)
        context = browser.new_context()
        network = StorageNetwork(image.read_bytes())
        context.route('**/*', network.route)
        page = context.new_page()
        page.goto(BASE, wait_until='networkidle')
        page.locator('#openItineraryImport').click()
        page.wait_for_function("!document.getElementById('itinerarySourceFile').disabled")
        page.locator('#itinerarySourceFile').set_input_files({'name':'legacy.txt','mimeType':'text/plain','buffer':b'2027-05-11 09:00 Taipei'})
        page.wait_for_function("!isBusy && document.getElementById('itineraryDraftStatus').textContent.includes('草稿已儲存')")
        # Convert just this isolated fixture back to the previous File-based draft format.
        page.evaluate("""async()=>{const db=await new Promise(r=>{const q=indexedDB.open('roamItineraryDraft_v1',1);q.onsuccess=()=>r(q.result)});await new Promise((resolve,reject)=>{const t=db.transaction('draft','readwrite'),s=t.objectStore('draft'),q=s.get('sources');q.onsuccess=()=>{const v=q.result;v.originals=v.originals.map(f=>new File([f.bytes],f.name,{type:f.type}));s.put(v,'sources')};t.oncomplete=resolve;t.onabort=reject});db.close()}""")
        page.reload(wait_until='networkidle')
        page.locator('#openItineraryImport').click()
        page.wait_for_function("!document.getElementById('itinerarySourceFile').disabled")
        check('old File draft is restored', 'legacy.txt' in page.locator('#itineraryFileInfo').inner_text() and '2027-05-11' in page.locator('#itinerarySourceText').input_value())
        # Append another source so both restored originals are persisted in the portable format.
        page.locator('#itinerarySourceFile').set_input_files({'name':'new.txt','mimeType':'text/plain','buffer':b'2027-05-11 12:00 Lunch'})
        page.wait_for_function("!isBusy && document.getElementById('itineraryDraftStatus').textContent.includes('草稿已儲存')")
        originals = page.evaluate("""async()=>{const db=await new Promise(r=>{const q=indexedDB.open('roamItineraryDraft_v1',1);q.onsuccess=()=>r(q.result)});const v=await new Promise(r=>{const q=db.transaction('draft').objectStore('draft').get('sources');q.onsuccess=()=>r(q.result)});db.close();return v.originals.map(f=>[f.name,new TextDecoder().decode(f.bytes)])}""")
        check('legacy and new originals retain exact bytes', originals==[['legacy.txt','2027-05-11 09:00 Taipei'],['new.txt','2027-05-11 12:00 Lunch']])
        await_js = "key=>OpenAIBrowser.save(key)"
        page.evaluate(await_js, KEY)
        page.evaluate("dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}))")
        check('pagehide clears key for bfcache', not page.evaluate('OpenAIBrowser.ready()'))
        page.evaluate("dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}))")
        page.wait_for_function("document.getElementById('codexStatus').textContent.includes('尚未設定')")
        check('bfcache return refreshes key status', '尚未設定' in page.locator('#codexStatus').text_content())
        page.evaluate(await_js, KEY)
        image_id = page.evaluate('crypto.randomUUID()')
        page.evaluate("id=>CodexLocal.imageRequest('',{id,subject:{city:'Taipei'}})", image_id)
        page.wait_for_timeout(100)
        other = context.new_page()
        other.goto(BASE, wait_until='networkidle')
        other.evaluate(await_js, KEY)
        state = other.evaluate("id=>CodexLocal.imageRequest('',{id,subject:{city:'Taipei'}})", image_id)
        check('two tabs do not duplicate the same paid image job', state['status']=='running' and network.image_calls==1)
        network.held_images.pop().fulfill(json={'data':[{'b64_json':base64.b64encode(image.read_bytes()).decode()}]})
        page.evaluate("async id=>{for(let n=0;n<100;n++){const s=await CodexLocal.imageRequest('/'+id);if(s.status==='completed')return;if(s.status!=='running')throw Error(s.error);await new Promise(r=>setTimeout(r,100))}throw Error('image timeout')}", image_id)
        check('other tab can reuse completed image', other.evaluate("async id=>!!(await CodexLocal.imageRequest('/'+id+'/image')).base64", image_id))
        # Simulate the persisted state of an interrupted tab; no active Web Lock remains.
        interrupted_id = page.evaluate('crypto.randomUUID()')
        page.evaluate("""async id=>{const db=await new Promise(r=>{const q=indexedDB.open('roamOpenAIImageJobs_v1',1);q.onsuccess=()=>r(q.result)});await new Promise(r=>{const t=db.transaction('jobs','readwrite');t.objectStore('jobs').put({id,status:'running'});t.oncomplete=r});db.close()}""", interrupted_id)
        state = other.evaluate("id=>CodexLocal.imageRequest('/'+id)", interrupted_id)
        check('uncertain interrupted image clearly reported', state['status']=='interrupted' and '可能已計費' in state['error'])
        state = other.evaluate("id=>CodexLocal.imageRequest('',{id,subject:{city:'Taipei'}})", interrupted_id)
        check('uncertain image is not automatically resubmitted', state['status']=='interrupted' and network.image_calls==1)
        context.close(); browser.close()
    (ROOT/'artifacts/openai-pages/storage-report.json').write_text(json.dumps({'passed':len(checks),'checks':checks}),encoding='utf-8')
    print(json.dumps({'passed':len(checks)}))


if __name__ == '__main__':
    main()
