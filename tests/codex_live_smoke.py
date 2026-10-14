"""Explicit live check: consumes Codex plan usage, never part of default tests.

Requires the local web server on 8080 and Codex bridge on 8081.
Uses a new browser context, a demo one-day trip, and mocked weather/rates.
"""
import json
from playwright.sync_api import sync_playwright
from browser_smoke import ARTIFACTS, Network, START


def main():
    with sync_playwright() as p:
        browser=p.chromium.launch()
        context=browser.new_context(viewport={'width':1440,'height':1000})
        context.add_init_script("localStorage.setItem('aiProvider','codex')")
        net=Network();context.route('**/*',net.route)
        page=context.new_page();errors=[]
        page.on('pageerror',lambda e:errors.append(str(e)))
        page.goto('http://127.0.0.1:8080/',wait_until='networkidle')
        page.wait_for_function("document.getElementById('codexStatus').textContent.includes('已連接')")
        page.locator('#city').fill('台北')
        page.locator('#flightArrival').fill(START+'T09:00')
        page.locator('#flightDeparture').fill(START+'T18:00')
        page.locator('#customPrefs').fill('一天輕鬆散步，最多安排三個站點含午餐，費用以新台幣估算。')
        page.locator('#lodgingSection > summary').click();page.locator('#hasHotel').uncheck()
        page.locator('#planBtn').click()
        page.wait_for_function('!isBusy',timeout=210000)
        checks={
            'actual_codex_generated_one_day':page.evaluate('tripData.length===1 && tripData[0].itinerary.length>0'),
            'date_is_correct':page.evaluate(f"tripData[0]?.date==='{START}'"),
            'completed_and_saved': '100%' in page.locator('#operationText').inner_text() and page.evaluate('JSON.parse(localStorage.myTrip_v27||"[]").length===1'),
            'readable_book': page.locator('#bookNavigation').is_visible(),
            'no_paid_deepseek_calls':len(net.ai_requests)==0,
            'no_page_errors':not errors,
        }
        report={'checks':[{'name':k,'passed':bool(v)} for k,v in checks.items()], 'passed':all(checks.values()),'scope':'Real local Codex using ChatGPT login; isolated demo data; weather and exchange rates mocked.'}
        (ARTIFACTS/'codex-live-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
        page.screenshot(path=str(ARTIFACTS/'codex-live-book.png'))
        browser.close()
        assert report['passed'],report
        print(json.dumps(report,indent=2))


if __name__=='__main__':main()
