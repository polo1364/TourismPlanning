"""Compare settings against the previous release; validate disclosure access and mobile layout."""
import json
import subprocess
from playwright.sync_api import sync_playwright
from browser_smoke import ROOT
from openai_pages_smoke import BASE, KEY
from openai_models_smoke import ModelNetwork


class SettingsNetwork(ModelNetwork):
    def __init__(self, before):
        super().__init__()
        self.before = before

    def route(self, route):
        for name, data in self.before.items():
            if route.request.url == BASE+name or (name=='index.html' and route.request.url==BASE):
                return route.fulfill(body=data,content_type={'index.html':'text/html','codex-local.js':'text/javascript','styles.css':'text/css'}[name])
        return super().route(route)


def main():
    output=ROOT/'artifacts/settings-compact';output.mkdir(parents=True,exist_ok=True)
    before={name:subprocess.check_output(['git','show','8530b0a:'+name],cwd=ROOT/'artifacts/itinerary-release-repo') for name in ['index.html','codex-local.js','styles.css']}
    checks=[];metrics=[]
    def check(name,value):
        checks.append({'name':name,'passed':bool(value)});assert value,name
    with sync_playwright() as p:
        for profile in ['desktop','android','iphone']:
            browser=(p.webkit if profile=='iphone' else p.chromium).launch()
            device=p.devices['iPhone 13' if profile=='iphone' else 'Pixel 7'] if profile!='desktop' else {'viewport':{'width':1440,'height':1000}}
            sizes=[]
            for version in ['before','after']:
                context=browser.new_context(**device,reduced_motion='reduce')
                network=SettingsNetwork(before if version=='before' else {})
                context.route('**/*',network.route)
                page=context.new_page();errors=[]
                page.on('pageerror',lambda e:errors.append(str(e)))
                page.goto(BASE,wait_until='networkidle');page.locator('.header-status').click()
                page.locator('#openaiApiKey').fill(KEY);page.locator('#openaiSaveKey').click()
                page.wait_for_function("!document.getElementById('openaiSaveKey').disabled && OpenAIBrowser.ready()")
                page.locator('#apiModal').evaluate('e=>e.scrollTop=0')
                size=page.locator('#apiModal .modal-content').evaluate("e=>({height:e.scrollHeight,modelTop:document.getElementById('codexModel').getBoundingClientRect().top-e.getBoundingClientRect().top,width:e.clientWidth,scrollWidth:e.scrollWidth})")
                sizes.append(size)
                if version=='after':
                    check(profile+' settings at least 25 percent shorter',size['height']<=sizes[0]['height']*.75)
                    check(profile+' model appears at least 35 percent earlier',size['modelTop']<=sizes[0]['modelTop']*.65)
                    check(profile+' no horizontal overflow',size['scrollWidth']<=size['width']+1)
                    check(profile+' redundant browser connection button hidden',page.locator('#codexConnectionCheck').is_hidden())
                    check(profile+' both explanations initially collapsed',not page.locator('#apiSafetyDetails').evaluate('e=>e.open') and not page.locator('#codexUsageDetails').evaluate('e=>e.open'))
                    check(profile+' key actions remain side by side',page.evaluate("document.getElementById('openaiSaveKey').offsetTop === document.getElementById('openaiForgetKey').offsetTop"))
                    page.screenshot(path=str(output/f'after-{profile}.png'))
                    summary=page.locator('#apiSafetyDetails summary');summary.focus();page.keyboard.press('Enter')
                    check(profile+' safety explanation keyboard accessible',page.locator('#openaiKeyPrivacy').is_visible() and '不是加密' in page.locator('#openaiKeyPrivacy').inner_text())
                    page.keyboard.press('Enter')
                    check(profile+' keyboard collapses safety explanation',page.locator('#openaiKeyPrivacy').is_hidden())
                    page.evaluate("closeModal('apiModal')")
                    page.locator('#codexUsageSummary').click()
                    check(profile+' usage shortcut opens actual token and billing details',page.locator('#codexTokenUsage').is_visible() and page.locator('#codexUsageDetails a').is_visible())
                    page.locator('#codexUsageDetails summary').focus();page.keyboard.press('Escape')
                    check(profile+' Escape still closes settings',page.locator('#apiModal').is_hidden())
                    check(profile+' no runtime errors or provider fallback',not errors and not network.foreign)
                context.close()
            metrics.append({'profile':profile,'before':sizes[0],'after':sizes[1]})
            browser.close()
    (output/'report.json').write_text(json.dumps({'checks':checks,'metrics':metrics,'api':'mocked','physical_device':False},indent=2),encoding='utf-8')
    print(json.dumps({'passed':True,'checks':len(checks),'metrics':metrics}))


if __name__=='__main__':
    main()
