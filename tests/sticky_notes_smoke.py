"""Personal note lifecycle, persistence, rollback and safe inline place labels."""
import json
import threading
from functools import partial
from http.server import ThreadingHTTPServer
from playwright.sync_api import sync_playwright
from browser_smoke import ROOT, ARTIFACTS, Handler, Network, sample_day, overflow


def main():
    server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory=str(ROOT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    day = sample_day()
    day['itinerary'][0]['time'] = ''  # Notes must not require completing unrelated fields.
    day['summary'] = '取消瑞穗牧場、北回歸線標誌公園與公正包子，下午僅安排雲山水夢幻湖。'
    checks = []

    def check(name, result):
        checks.append({'name': name, 'passed': bool(result)})
        assert result, name

    with sync_playwright() as p:
        browser = p.chromium.launch()
        for width in [1440, 390]:
            context = browser.new_context(viewport={'width': width, 'height': 1000}, reduced_motion='reduce', accept_downloads=True)
            network = Network()
            context.route('**/*', network.route)
            context.add_init_script("sessionStorage.setItem('deepseekApiKey','mock-not-a-real-key')")
            context.add_init_script("if(!localStorage.notesSeeded){localStorage.setItem('myTrip_v27',JSON.stringify([DAY]));localStorage.notesSeeded='true';}".replace('DAY', json.dumps(day, ensure_ascii=False)))
            page = context.new_page()
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.on('dialog', lambda d: d.accept())
            page.goto(f'http://127.0.0.1:{server.server_port}/', wait_until='networkidle')
            original = page.evaluate('JSON.stringify(tripData)')
            source = page.locator('#tripSelect').input_value()

            def open_note(index=0):
                page.locator('#tripContainer .note-open').nth(index).click()

            def save_note(text):
                page.locator('#noteText').fill(text)
                page.locator('#noteForm button[type="submit"]').click()
                page.wait_for_function('!isBusy')
                page.locator('#noteModal').wait_for(state='hidden')

            check(f'{width} empty legacy journey has add buttons', page.locator('.stop-note').count() == 0 and page.locator('#tripContainer .note-open').count() == len(day['itinerary']))
            check(f'{width} names are labels inside intact sentence', page.locator('.chapter-intro').inner_text() == day['summary'] and page.locator('.chapter-intro .inline-place').count() == 4)
            open_note()
            page.locator('#noteText').fill('未儲存草稿')
            page.keyboard.press('Escape')
            check(f'{width} cancel leaves data unchanged', page.evaluate('JSON.stringify(tripData)') == original)
            open_note()
            save_note('已訂位 12:00，提前 10 分鐘到。\n記得帶訂位簡訊；只收現金。')
            check(f'{width} add works without a stop time', page.evaluate("tripData[0].itinerary[0].userNote.includes('只收現金') && tripData[0].itinerary[0].time === ''"))
            check(f'{width} focus returns to a live note control', page.evaluate("document.activeElement.matches('[data-note-day]')"))
            page.reload(wait_until='networkidle')
            check(f'{width} reload retains multiline note', '\n' in page.locator('#tripContainer .stop-note-text').inner_text())
            page.locator('#tripContainer .note-pencil').first.click()
            save_note('記得帶現金\n<img src=x onerror=window.noteInjected=true>')
            check(f'{width} edited text cannot execute markup', page.locator('.stop-note img').count() == 0 and not page.evaluate('Boolean(window.noteInjected)'))
            page.locator('#undoTrip').click()
            page.wait_for_function('!isBusy')
            check(f'{width} undo restores note text', '只收現金' in page.locator('#tripContainer .stop-note-text').inner_text())
            open_note()
            page.locator('#noteText').fill('不應覆蓋的內容')
            page.evaluate("()=>{window.realNoteSet=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k==='tourismTrips_v1')throw new Error('quota');return realNoteSet.call(this,k,v)}}")
            page.locator('#noteForm button[type="submit"]').click()
            page.wait_for_function('!isBusy')
            check(f'{width} storage failure preserves saved note and draft', '無法儲存' in page.locator('#noteError').inner_text() and page.locator('#noteText').input_value() == '不應覆蓋的內容' and page.evaluate("tripData[0].itinerary[0].userNote.includes('只收現金')"))
            page.evaluate('()=>{Storage.prototype.setItem=realNoteSet}')
            page.keyboard.press('Escape')
            open_note()
            page.locator('#deleteNote').click()
            page.wait_for_function('!isBusy')
            page.locator('#noteModal').wait_for(state='hidden')
            check(f'{width} delete affects only note', page.locator('#tripContainer .stop-note').count() == 0 and page.locator('#tripContainer tbody tr').count() == len(day['itinerary']))
            page.locator('#undoTrip').click()
            page.wait_for_function('!isBusy')
            check(f'{width} delete can be undone', page.locator('#tripContainer .stop-note').count() == 1)
            page.locator('#tripContainer .stop-edit').first.click()
            page.locator('#moveDown').click()
            page.wait_for_function('!isBusy')
            page.keyboard.press('Escape')
            check(f'{width} reorder moves note with its stop', page.evaluate("tripData[0].itinerary[1].userNote.includes('只收現金') && !tripData[0].itinerary[0].userNote"))
            with page.expect_download() as download:
                page.evaluate('exportData()')
            backup = ARTIFACTS / f'notes-backup-{width}.json'
            download.value.save_as(str(backup))
            check(f'{width} backup contains personal note', '只收現金' in backup.read_text(encoding='utf-8'))
            page.locator('#libraryManagement > summary').click()
            page.locator('#tripLibrary button[onclick="TripLibrary.openName(\'duplicate\')"]').click()
            page.locator('#tripName').fill('便利貼複本')
            with page.expect_navigation(wait_until='load'):
                page.locator('#tripNameForm button').click()
            open_note(1)
            save_note('複本專屬提醒')
            with page.expect_navigation(wait_until='load'):
                page.locator('#tripSelect').select_option(source)
            check(f'{width} switching trips isolates notes', '只收現金' in page.locator('#tripContainer .stop-note-text').inner_text())
            open_note(1)
            page.locator('#deleteNote').click()
            page.wait_for_function('!isBusy')
            with page.expect_navigation(wait_until='load'):
                page.locator('#importFile').set_input_files(str(backup))
            check(f'{width} import restores note', '只收現金' in page.locator('#tripContainer .stop-note-text').inner_text())
            network.result_override = {'item': {'title': '替換後的室內景點', 'type': 'SPOT', 'desc': '測試替代站點', 'address': '測試地址', 'userNote': 'AI 不可覆寫個人便利貼'}}
            page.locator('#tripContainer .stop-edit').nth(1).click()
            page.locator('#stopModal .form-disclosure > summary').click()
            page.locator('#stop_replaceInstruction').fill('改成室內景點')
            page.locator('#stopModal button[onclick="PlannerUI.replaceStop()"] ').click()
            page.wait_for_function("!isBusy && tripData[0].itinerary[1].title==='替換後的室內景點'")
            check(f'{width} AI replacement retains original personal note', page.evaluate("tripData[0].itinerary[1].userNote.includes('只收現金')"))
            page.locator('#undoTrip').click()
            page.wait_for_function('!isBusy')
            page.locator('#travelModeButton').click()
            check(f'{width} travel mode also shows note', page.locator('#journeyPanel .stop-note').count() == 1)
            page.locator('#travelModeButton').click()
            for viewport in [320, 390, 760, 900, 1440]:
                page.set_viewport_size({'width': viewport, 'height': 1000})
                check(f'{width}/{viewport} note and inline labels fit', not overflow(page)['overflow'] and page.locator('#tripContainer .stop-note').evaluate('e=>e.scrollWidth<=e.clientWidth+1'))
            page.set_viewport_size({'width': width, 'height': 1000})
            page.locator('#tripContainer tbody tr').nth(1).screenshot(path=str(ARTIFACTS / f'sticky-note-{width}.png'))
            page.locator('.chapter-overview').screenshot(path=str(ARTIFACTS / f'inline-places-{width}.png'))
            check(f'{width} no browser errors and only explicit AI replacement calls AI', not errors and len(network.ai_requests) == 1)
            context.close()
        browser.close()
    server.shutdown()
    (ARTIFACTS / 'sticky-notes-report.json').write_text(json.dumps({'checks': checks, 'passed': True}, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f'Sticky notes: {len(checks)} checks passed')


if __name__ == '__main__':
    main()
