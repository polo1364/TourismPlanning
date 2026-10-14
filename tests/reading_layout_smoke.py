"""Readable long itinerary, disclosure safety, and viewport checks with fixture data."""
import json
import threading
from functools import partial
from http.server import ThreadingHTTPServer
from playwright.sync_api import sync_playwright
from browser_smoke import ROOT, ARTIFACTS, Handler, Network, sample_day, overflow


def main():
    server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory=str(ROOT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    day = sample_day('2026-11-07', '高雄出發・花東縱谷牧場與夢幻湖打卡')
    day['summary'] = '清晨出發，沿途安排休息與午餐。此頁為長行程排版測試資料，交通時間與費用僅用於驗證顯示。'
    day['itinerary'] = [
        dict(time='06:00', endTime='06:15', title='高雄出發', type='TRANSPORT', durationMinutes=15, travelMinutes=0, cost='全日油資 NT$1,000–1,500／車，停車另計', address='高雄市，實際出發地依個人所在地', desc='吃完早餐、加滿油後出發，沿途預留休息時間。', tips='建議兩位駕駛輪替，勿疲勞駕駛。', transit=[dict(mode='自行開車', time='0 分鐘', desc='由實際出發地開始行程。')]),
        dict(time='09:15', endTime='09:35', title='大武之心南迴驛休息', type='TRANSPORT', durationMinutes=20, travelMinutes=180, cost='補給約 NT$50–100／人', address='臺東縣大武鄉，台 9 線沿線', desc='停車上洗手間、伸展與補水，讓長途駕駛有完整休息時間。', tips='出發前確認路況與休息站營業資訊。', transit=[dict(mode='自行開車', time='180 分鐘，含休息', desc='詳細道路說明僅供排版測試；請以實際導航與當日路況為準。' * 4)]),
        dict(time='11:55', endTime='12:40', title='午餐：玉里橋頭臭豆腐', type='FOOD', durationMinutes=45, travelMinutes=140, cost='約 NT$100–200／人', address='花蓮縣玉里鎮', desc='以在地小吃作為午餐，保留用餐與休息時間。', tips='若遇排隊，可彈性調整。', transit=[dict(mode='自行開車', time='140 分鐘', desc='<img src=x onerror="window.injected=true"> 沿途請預留休息時間。')]),
    ]
    for i in range(7):
        day['itinerary'].append(dict(time='', title=f'後續測試站點 {i+4}', type='SPOT', cost='待確認', desc='保留尚未確認的交通時間，不以零分鐘代替。', address='', tips='', transit=[]))
    day['itinerary'][-1]['title'] = '長標題與連續文字換行測試：' + 'LongPlaceNameWithoutSpaces' * 5
    day['itinerary'][1]['booking'] = True
    checks = []

    def check(name, value):
        checks.append({'name': name, 'passed': bool(value)})
        assert value, name

    with sync_playwright() as p:
        browser = p.chromium.launch()
        context = browser.new_context(viewport={'width': 1440, 'height': 1050})
        context.route('**/*', Network().route)
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto(f'http://127.0.0.1:{server.server_port}/', wait_until='networkidle')
        page.evaluate("""async day => {
            document.getElementById('city').value='高雄';
            tripData=validateTrip([day]); generationState=null;
            await renderTrip(); PlannerUI.switchView('itinerary',false); TripMotion.settle();
        }""", day)
        initial = page.evaluate('JSON.stringify(tripData)')
        check('all ten stops retained', page.locator('#tripContainer tbody tr').count() == 10)
        check('structured travel total and missing legs shown', '5 小時 20 分鐘' in page.locator('.chapter-facts').inner_text() and '7 段待確認' in page.locator('.chapter-facts').inner_text())
        check('daily cost discloses excluded shared costs', '共用費用' in page.locator('.chapter-cost-note').inner_text() and page.locator('.day-cost-badge').inner_text().endswith('225'))
        check('navigation title does not repeat chapter title', page.locator('#bookPageTitle').inner_text() == '第 1 天 · 11/07')
        check('duplicate next-stop labels removed', page.locator('.next-stop').count() == 0)
        check('long routes start collapsed', page.locator('.transit-details[open]').count() == 0)
        route = page.locator('.transit-details').nth(1)
        route.locator('summary').click()
        check('route opens without collapsing chapter', route.get_attribute('open') is not None and page.locator('#tripContainer > details').get_attribute('open') is not None)
        check('full route remains available', route.locator('.transit-option').is_visible())
        route.locator('summary').press('Enter')
        check('route collapses with keyboard', route.get_attribute('open') is None)
        check('untrusted route text remains text', page.locator('.transit-details img').count() == 0 and not page.evaluate('Boolean(window.injected)'))
        for width in [320, 390, 760, 900, 1440]:
            page.set_viewport_size({'width': width, 'height': 1050})
            check(f'{width} no horizontal overflow', not overflow(page)['overflow'])
            metrics = page.locator('#tripContainer').evaluate("""el => {
                const chapter=el.querySelector(':scope > details');
                const head=chapter.querySelector(':scope > summary').getBoundingClientRect();
                const content=chapter.querySelector('.day-content').getBoundingClientRect();
                return {above:head.bottom<=content.top+1,
                    font:parseFloat(getComputedStyle(el.querySelector('.desc-cell')).fontSize),
                    meta:parseFloat(getComputedStyle(el.querySelector('.stop-meta')).fontSize)};
            }""")
            check(f'{width} cover is above content', metrics['above'])
            check(f'{width} readable body and metadata', metrics['font'] >= 16 and metrics['meta'] >= 14)
            geometry = page.locator('#tripContainer').evaluate("""el => {
                const rows=[...el.querySelectorAll('tbody tr')];
                const fits=(child,parent)=>child.left>=parent.left-1 && child.right<=parent.right+1;
                return {
                    contained:rows.every(row=>[...row.querySelectorAll('td, .stop-name, .table-map-link, .stop-edit')].every(child=>fits(child.getBoundingClientRect(),row.getBoundingClientRect()) && child.scrollWidth<=child.clientWidth+1)),
                    controls:rows.every(row=>{
                        const map=row.querySelector('.table-map-link').getBoundingClientRect();
                        const edit=row.querySelector('.stop-edit').getBoundingClientRect();
                        return map.height>=44 && edit.height>=44 && (map.right<=edit.left+1 || map.bottom<=edit.top+1);
                    }),
                    timeAtTop:rows.every(row=>row.querySelector('.time-cell').getBoundingClientRect().top<=row.querySelector('.title-cell').getBoundingClientRect().top+4)
                };
            }""")
            check(f'{width} long content stays inside each stop', geometry['contained'])
            check(f'{width} map and edit controls do not overlap', geometry['controls'])
            check(f'{width} times align with the start of each stop', geometry['timeAtTop'])
            if width in [390, 1440]:
                page.locator('#tripContainer > details').evaluate('el=>el.scrollIntoView({block:"start"})')
                page.screenshot(path=str(ARTIFACTS / f'reading-layout-{width}.png'))
                page.locator('#tripContainer tbody tr').first.screenshot(path=str(ARTIFACTS / f'reading-stop-{width}.png'))
        check('reading changes do not modify trip data', page.evaluate('JSON.stringify(tripData)') == initial)
        check('no page errors', not errors)
        browser.close()
    server.shutdown()
    (ARTIFACTS / 'reading-layout-report.json').write_text(json.dumps({'checks': checks, 'passed': True}, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f'Reading layout: {len(checks)} checks passed')


if __name__ == '__main__':
    main()
