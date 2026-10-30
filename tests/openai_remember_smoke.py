"""Remembered browser credentials, mobile UI and backup exclusion; only fake API responses."""
import json
import tempfile
from playwright.sync_api import sync_playwright
from browser_smoke import ROOT, sample_day
from openai_pages_smoke import BASE, KEY, PagesNetwork


def main():
    output = ROOT / 'artifacts/openai-remember'
    output.mkdir(parents=True, exist_ok=True)
    checks = []
    def check(name, value):
        checks.append({'name':name,'passed':bool(value)})
        assert value, name
    with sync_playwright() as p:
        for profile in ['desktop','android','iphone']:
            browser = (p.webkit if profile == 'iphone' else p.chromium).launch()
            device = p.devices['iPhone 13' if profile == 'iphone' else 'Pixel 7'] if profile != 'desktop' else {'viewport':{'width':1440,'height':1000}}
            context = browser.new_context(**device, accept_downloads=True, reduced_motion='reduce')
            network = PagesNetwork(b'')
            context.route('**/*', network.route)
            page = context.new_page()
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            def settings():
                page.evaluate("openModal('apiModal')")
                page.locator('#openaiRememberKey').scroll_into_view_if_needed()
            def enter_key():
                page.locator('#openaiApiKey').fill(KEY)
                page.locator('#openaiSaveKey').click()
                page.wait_for_function('OpenAIBrowser.ready() && !document.getElementById("openaiSaveKey").disabled')
            page.goto(BASE, wait_until='networkidle')
            settings()
            check(profile+' remember defaults off', not page.locator('#openaiRememberKey').is_checked())
            page.locator('#openaiRememberKey').check()
            check(profile+' checking before key does not store anything', not page.evaluate('localStorage.getItem("roamOpenAIKey_v1")'))
            enter_key()
            check(profile+' key stored only in dedicated browser setting', page.evaluate('localStorage.getItem("roamOpenAIKey_v1")')==KEY and KEY not in page.evaluate('JSON.stringify(sessionStorage)'))
            check(profile+' key field remains empty', page.locator('#openaiApiKey').input_value()=='')
            check(profile+' remember feedback and mobile fit', '記住' in page.locator('#openaiKeyStatus').inner_text() and page.locator('#apiModal .modal-content').evaluate('e=>e.scrollWidth<=e.clientWidth+1'))
            page.locator('#openaiKeySettings').screenshot(path=str(output/f'settings-{profile}.png'))
            page.reload(wait_until='networkidle')
            page.wait_for_function('OpenAIBrowser.ready()')
            settings()
            check(profile+' reload restores key and checkbox', page.locator('#openaiRememberKey').is_checked() and page.locator('#openaiApiKey').input_value()=='')
            check(profile+' reload does not generate paid requests', not network.ai_requests and network.image_calls==0)
            page.close()
            page = context.new_page()
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.goto(BASE, wait_until='networkidle')
            page.wait_for_function('OpenAIBrowser.ready()')
            check(profile+' reopening page restores remembered key', page.evaluate('OpenAIBrowser.remembered()'))
            # Seed an isolated trip, then use actual download paths, not a whole-storage snapshot.
            page.evaluate("day=>{TripLibrary.write({myTrip_v27:JSON.stringify([day])});tripData=[day];return renderTrip()}", sample_day())
            for label, action in [('all','TripLibrary.exportAll()'),('current','exportData()'),('artwork','TripArtwork.backup(false)'),('all-artwork','TripArtwork.backup(true)'),('book','TripBookExport.download()')]:
                with page.expect_download() as download:
                    page.evaluate(action)
                file = output/f'{label}-{profile}.json'
                download.value.save_as(str(file))
                text = file.read_text(encoding='utf-8')
                check(profile+' '+label+' backup excludes key and key setting', KEY not in text and 'roamOpenAIKey_v1' not in text)
            # A restored key can be used without re-entering it.
            page.evaluate("CodexLocal.generate('JSON itinerary test')")
            check(profile+' restored key actually authenticates API request', len(network.ai_requests)==1 and KEY not in json.dumps(network.ai_requests))
            settings()
            page.locator('#openaiRememberKey').uncheck()
            check(profile+' uncheck removes persistence and keeps current page usable', page.evaluate('OpenAIBrowser.ready() && !localStorage.getItem("roamOpenAIKey_v1")'))
            page.reload(wait_until='networkidle')
            check(profile+' unchecked key is not restored', not page.evaluate('OpenAIBrowser.ready()'))
            settings(); enter_key()
            page.locator('#openaiRememberKey').check()
            other = context.new_page(); other.goto(BASE,wait_until='networkidle')
            other.wait_for_function('OpenAIBrowser.ready()')
            page.locator('#openaiForgetKey').click()
            other.wait_for_function('!OpenAIBrowser.ready()')
            check(profile+' clear removes key and updates other tabs', not page.evaluate('OpenAIBrowser.ready()') and not page.locator('#openaiRememberKey').is_checked() and not page.evaluate('localStorage.getItem("roamOpenAIKey_v1")'))
            other.close()
            # Storage failures must leave the existing memory key usable and show an error.
            enter_key()
            page.evaluate("() => {window.originalSetItem=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k==='roamOpenAIKey_v1')throw new DOMException('blocked','QuotaExceededError');return originalSetItem.call(this,k,v)};}")
            page.locator('#openaiRememberKey').click()
            check(profile+' failed save reports error without false remembered state', '無法更新' in page.locator('#openaiKeyStatus').inner_text() and not page.locator('#openaiRememberKey').is_checked() and page.evaluate('OpenAIBrowser.ready()'))
            page.evaluate('() => {Storage.prototype.setItem=originalSetItem;}')
            check(profile+' no private service requests or browser errors', not errors and not network.foreign)
            context.close();browser.close()
        # Use real browser profile files to verify a complete browser shutdown/restart.
        for name, engine in [('chromium',p.chromium),('webkit',p.webkit)]:
            with tempfile.TemporaryDirectory(prefix='roam-remember-test-') as profile_dir:
                network = PagesNetwork(b'')
                for step in ['save','reopen','cleared']:
                    context = engine.launch_persistent_context(profile_dir,headless=True)
                    context.route('**/*',network.route)
                    page = context.pages[0]
                    page.goto(BASE,wait_until='networkidle')
                    if step=='save':
                        page.evaluate("key=>OpenAIBrowser.save(key,true)",KEY)
                    elif step=='reopen':
                        check(name+' complete browser restart restores remembered key',page.evaluate('OpenAIBrowser.ready() && OpenAIBrowser.remembered()'))
                        page.evaluate('OpenAIBrowser.clear()')
                    else:
                        check(name+' clear remains cleared after browser restart',not page.evaluate('OpenAIBrowser.ready()'))
                    check(name+' restart '+step+' never generates',not network.ai_requests and network.image_calls==0)
                    context.close()
    (output/'report.json').write_text(json.dumps({'checks':checks,'api':'mocked','physical_device':False},indent=2),encoding='utf-8')
    print(json.dumps({'passed':True,'checks':len(checks)}))


if __name__=='__main__':
    main()
