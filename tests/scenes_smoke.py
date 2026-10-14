"""Illustrated UI interaction checks, isolated data and no live external requests."""
import json
import threading
from functools import partial
from http.server import ThreadingHTTPServer
from playwright.sync_api import sync_playwright
from browser_smoke import ROOT, ARTIFACTS, Handler, Network, START, END, sample_day, overflow


def main():
    server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory=str(ROOT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f'http://127.0.0.1:{server.server_port}/'
    checks = []
    def check(name, passed):
        checks.append({'name': name, 'passed': bool(passed)})
    with sync_playwright() as p:
        browser = p.chromium.launch()
        context = browser.new_context(viewport={'width': 1440, 'height': 1050})
        net = Network()
        context.route('**/*', net.route)
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(url, wait_until='networkidle')
        page.evaluate('TripMotion.settle()')
        page.wait_for_function("[...document.querySelectorAll('.hero-scenery img')].every(i=>i.complete && i.naturalWidth>0)")
        check('both original cover images load', page.locator('.hero-scenery img').count() == 2)
        page.locator('#itineraryTab').click()
        page.wait_for_function("document.querySelector('.postcard-photo .scene-coast').naturalWidth > 0")
        check('postcard photo has visible area', page.locator('.postcard-photo').bounding_box()['width'] > 200)
        check('postcard does not inherit the legacy perpetual float', page.locator('.postcard-photo').evaluate("e=>getComputedStyle(e).animationName==='none'"))
        before = page.evaluate("localStorage.getItem('tourismTrips_v1')")
        page.screenshot(path=str(ARTIFACTS/'scene-empty-desktop.png'), full_page=True)
        page.locator('[data-scene-choice="town"]').click()
        check('town cover selected and announced', page.locator('[data-scene-choice="town"]').get_attribute('aria-pressed') == 'true')
        page.reload(wait_until='networkidle')
        check('cover preference survives reload', page.locator('[data-scene-choice="town"]').get_attribute('aria-pressed') == 'true')
        box = page.locator('.app-header').bounding_box()
        page.mouse.move(box['x'] + box['width'] * .85, box['y'] + box['height'] * .4)
        page.wait_for_function("document.querySelector('.hero-scenery').style.transform.includes('translate3d')")
        check('mouse gives cover a subtle offset', page.locator('.hero-scenery').evaluate("e=>e.style.transform!==''"))
        page.locator('#sceneEffects').click()
        check('turning effects off resets scenery and flight', page.locator('.hero-scenery').evaluate("e=>e.style.transform==='' && getComputedStyle(document.querySelector('.flight-plane')).animationName==='none'"))
        page.reload(wait_until='networkidle')
        check('effect preference survives reload', page.locator('#sceneEffects').get_attribute('aria-pressed') == 'false')
        page.locator('[data-scene-choice="coast"]').focus()
        page.keyboard.press('Enter')
        check('keyboard switches cover without transition', page.locator('.scene-coast').first.evaluate("e=>getComputedStyle(e).opacity==='1' && getComputedStyle(e).transitionDuration==='0s'"))
        check('appearance never changes saved journey', before == page.evaluate("localStorage.getItem('tourismTrips_v1')"))
        page.locator('#sceneEffects').click()
        page.evaluate('setBusy(true)')
        page.emulate_media(reduced_motion='reduce')
        page.wait_for_function("document.getElementById('sceneEffects').getAttribute('aria-pressed')==='false'")
        check('system reduced motion overrides effects', page.locator('#sceneEffects').is_disabled() and page.locator('#sceneEffects').get_attribute('aria-pressed') == 'false')
        page.evaluate('setBusy(false)')
        check('ending an operation preserves system motion setting', page.locator('#sceneEffects').is_disabled())
        check('system reduced motion stops flight', page.locator('.flight-plane').evaluate("e=>getComputedStyle(e).animationName==='none'"))
        page.emulate_media(reduced_motion='no-preference')
        page.wait_for_function("document.getElementById('sceneEffects').getAttribute('aria-pressed')==='true'")
        check('restoring system motion restores chosen preference', page.locator('#sceneEffects').is_enabled() and page.locator('#sceneEffects').get_attribute('aria-pressed') == 'true')
        for width in [320, 390, 760, 900, 1440]:
            page.set_viewport_size({'width': width, 'height': 950})
            page.locator('[data-scene-choice="town"]').click()
            check(f'{width}px has no horizontal overflow', not overflow(page)['overflow'])
            check(f'{width}px controls stay reachable', page.locator('#sceneEffects').is_visible() and page.locator('.header-status').is_visible())
            if width == 390:
                page.evaluate('TripMotion.settle();window.scrollTo(0,0)')
                page.screenshot(path=str(ARTIFACTS/'scene-settings-mobile.png'), full_page=True)
                page.locator('#itineraryTab').click()
                page.locator('.postcard-photo').scroll_into_view_if_needed()
                check('mobile postcard remains visible', page.locator('.postcard-photo').bounding_box()['width'] > 200)
                page.evaluate('TripMotion.settle();window.scrollTo(0,0)')
                page.screenshot(path=str(ARTIFACTS/'scene-empty-mobile.png'), full_page=True)
        page.evaluate('TripMotion.settle();window.scrollTo(0,0)')
        page.screenshot(path=str(ARTIFACTS/'scene-town-desktop.png'), full_page=True)
        legacy = {'i': {'city': '台北', 'hasHotel': False, 'flightArrival': START+'T08:00', 'flightDeparture': END+'T20:00'}, 't': [sample_day(), sample_day(END)], 'g': {'city': '台北', 'flightArr': START+'T08:00', 'flightDep': END+'T20:00', 'tags': []}}
        mobile = browser.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True, device_scale_factor=1)
        mobile.route('**/*', Network().route)
        mobile.add_init_script("""if(!localStorage.seeded){const d=PAYLOAD;for(const [k,v] of Object.entries({tripDraft_v27:d.i,myTrip_v27:d.t,generationState_v27:d.g}))localStorage.setItem(k,JSON.stringify(v));localStorage.seeded='1';}""".replace('PAYLOAD', json.dumps(legacy)))
        phone = mobile.new_page()
        phone.goto(url, wait_until='networkidle')
        phone.evaluate('TripMotion.settle()')
        phone.mouse.move(250, 140)
        check('touch devices do not apply parallax', phone.locator('.hero-scenery').evaluate("e=>e.style.transform===''") )
        phone.screenshot(path=str(ARTIFACTS/'scene-itinerary-mobile.png'), full_page=True)
        normal_height = phone.locator('.app-header').bounding_box()['height']
        phone.locator('#travelModeButton').click()
        check('travel mode keeps the compact atlas header', phone.locator('.app-header').bounding_box()['height'] < 220)
        check('travel mode retains stop navigation', phone.locator('.journey-stop').first.is_visible())
        phone.evaluate('TripMotion.settle();window.scrollTo(0,0)')
        phone.screenshot(path=str(ARTIFACTS/'scene-travel-mobile.png'), full_page=True)
        mobile.close()
        page.route('**/assets/roam-*.png', lambda route: route.abort())
        page.reload(wait_until='networkidle')
        check('failed illustrations leave title and settings usable', page.locator('h1').is_visible() and page.locator('.header-status').is_enabled())
        page.locator('.header-status').click()
        check('settings opens even without illustrations', page.locator('#apiModal').is_visible())
        check('no live AI calls', len(net.ai_requests) == 0)
        check('no uncaught errors', not errors)
        context.close()
        browser.close()
    server.shutdown()
    report = {'checks': checks, 'passed': all(c['passed'] for c in checks)}
    (ARTIFACTS/'scenes-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
