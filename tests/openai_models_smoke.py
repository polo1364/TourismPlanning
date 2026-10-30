"""Desktop and mobile model selection against an isolated Pages origin; mocked API only."""
import json
from playwright.sync_api import sync_playwright
from browser_smoke import ROOT
from openai_pages_smoke import PagesNetwork, BASE, KEY

MODELS = ['gpt-6-sol','gpt-5.3-codex','gpt-6.1-sol','gpt-6.1-terra','gpt-6-luna','gpt-6-astra']
LABELS = ['原有模型','舊版程式','多檔整合','掃描圖像','快速省費','複雜比對']


class ModelNetwork(PagesNetwork):
    def __init__(self):
        super().__init__(b'')
        self.available = MODELS + ['gpt-image-1.5','gpt-realtime','text-embedding-3-small','unknown']

    def route(self, route):
        if route.request.url == 'https://api.openai.com/v1/models' and route.request.method == 'GET':
            assert route.request.headers.get('authorization') == 'Bearer ' + KEY
            return route.fulfill(json={'data':[{'id':id} for id in self.available]})
        return super().route(route)


def main():
    output = ROOT/'artifacts/openai-models'
    output.mkdir(parents=True,exist_ok=True)
    checks=[]
    def check(name,value):
        checks.append({'name':name,'passed':bool(value)})
        assert value,name
    with sync_playwright() as p:
        for profile in ['desktop','android','iphone','small']:
            browser=(p.webkit if profile=='iphone' else p.chromium).launch()
            device=p.devices['iPhone 13' if profile=='iphone' else 'Pixel 7'] if profile in ['android','iphone'] else {'viewport':{'width':320 if profile=='small' else 1440,'height':850 if profile=='small' else 1000}}
            context=browser.new_context(**device,reduced_motion='reduce')
            network=ModelNetwork();context.route('**/*',network.route)
            page=context.new_page();errors=[]
            page.on('pageerror',lambda e:errors.append(str(e)))
            page.goto(BASE,wait_until='networkidle')
            page.evaluate("openModal('apiModal')")
            check(profile+' no unverified model recommendation',page.locator('#codexModelAdvice').is_hidden())
            page.locator('#openaiRememberKey').check()
            page.locator('#openaiApiKey').fill(KEY)
            page.locator('#openaiSaveKey').click()
            page.wait_for_function("document.getElementById('codexModel').options.length===7")
            ids=page.locator('#codexModel option').evaluate_all('options=>options.map(o=>o.value)')
            check(profile+' all six compatible models visible',ids==['']+MODELS)
            check(profile+' existing default preserved','預設' in page.locator('#codexModel option[value="gpt-6-sol"]').inner_text())
            check(profile+' model hint counts accessible models','6 個' in page.locator('#codexModelHint').inner_text())
            check(profile+' default advice names actual default','預設：gpt-6-sol' in page.locator('#codexModelAdviceTitle').inner_text())
            for model,label in zip(MODELS,LABELS):
                before=len(network.ai_requests)
                page.locator('#codexModel').select_option(model)
                check(profile+' '+model+' advice updates without API generation',model+' · '+label==page.locator('#codexModelAdviceTitle').inner_text() and len(network.ai_requests)==before)
                check(profile+' '+model+' short option label',label in page.locator(f'#codexModel option[value="{model}"]').inner_text())
                page.evaluate("CodexLocal.generate('JSON itinerary test')")
                check(profile+' selected '+model+' sent exactly',network.ai_requests[-1]['model']==model)
            page.locator('#codexModel').select_option('gpt-6.1-terra')
            page.reload(wait_until='networkidle')
            page.evaluate("openModal('apiModal')")
            page.wait_for_function("document.getElementById('codexModel').options.length===7")
            check(profile+' selected model and remembered key survive reload',page.locator('#codexModel').input_value()=='gpt-6.1-terra' and page.evaluate('OpenAIBrowser.ready() && OpenAIBrowser.remembered()'))
            check(profile+' scan advice restored and visible',page.locator('#codexModelAdvice').is_visible() and '掃描 PDF' in page.locator('#codexModelAdviceText').inner_text())
            page.locator('#codexModelAdvice').scroll_into_view_if_needed()
            check(profile+' model controls fit mobile width',page.locator('#apiModal .modal-content').evaluate('e=>e.scrollWidth<=e.clientWidth+1'))
            check(profile+' advice wraps without clipping',page.locator('#codexModelAdvice').evaluate('e=>e.scrollWidth<=e.clientWidth+1 && e.scrollHeight<=e.clientHeight+1'))
            page.screenshot(path=str(output/f'models-{profile}.png'),scale='css')
            network.available=['gpt-6-luna','gpt-image-1.5']
            page.reload(wait_until='networkidle')
            page.evaluate("openModal('apiModal')")
            page.wait_for_function("document.querySelector('#codexModel option[value=\"gpt-6.1-terra\"]')?.disabled")
            check(profile+' account list filters unavailable models',page.locator('#codexModel option:not([disabled])').evaluate_all('options=>options.map(o=>o.value)')==['','gpt-6-luna'])
            check(profile+' unavailable model has honest advice','無法確認' in page.locator('#codexModelAdviceText').inner_text() and '掃描圖像' not in page.locator('#codexModelAdviceTitle').inner_text())
            before=len(network.ai_requests)
            error=page.evaluate("async()=>{try{await CodexLocal.generate('JSON itinerary')}catch(e){return e.message}}")
            check(profile+' unavailable saved selection does not silently switch',bool(error) and len(network.ai_requests)==before)
            page.locator('#codexModel').select_option('')
            check(profile+' fallback default advice follows actual model','預設：gpt-6-luna · 快速省費'==page.locator('#codexModelAdviceTitle').inner_text())
            page.evaluate("CodexLocal.generate('JSON itinerary')")
            check(profile+' new-only account default works',network.ai_requests[-1]['model']=='gpt-6-luna')
            check(profile+' no private endpoint or browser errors',not network.foreign and not errors)
            context.close();browser.close()
    (output/'report.json').write_text(json.dumps({'checks':checks,'api':'mocked','physical_device':False},indent=2),encoding='utf-8')
    print(json.dumps({'passed':True,'checks':len(checks)}))


if __name__=='__main__':
    main()
