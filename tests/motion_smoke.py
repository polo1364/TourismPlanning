"""Verify the installed Motion library, interruptions, keyboard and reduced motion.
Run: python tests/motion_smoke.py
All paid API calls are blocked or mocked by the shared test network.
"""
import json
import sys
import threading
from functools import partial
from http.server import ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright
from browser_smoke import Handler, Network, ROOT, ARTIFACTS, sample_day


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    ARTIFACTS.mkdir(exist_ok=True)
    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(Handler, directory=str(ROOT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{server.server_port}/"
    results = []

    def check(name, passed):
        results.append({"name": name, "passed": bool(passed)})
        assert passed, name

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            for name, width in [("desktop", 1440), ("mobile", 390)]:
                context = browser.new_context(viewport={"width": width, "height": 900}, has_touch=name == "mobile")
                context.add_init_script("localStorage.setItem('roamReadingMode','continuous')")
                network = Network()
                context.route("**/*", network.route)
                page = context.new_page()
                errors = []
                page.on("pageerror", lambda error: errors.append(str(error)))
                page.goto(url, wait_until="networkidle")
                check(name + ": Motion and adapter load locally", page.evaluate("typeof Motion.animate === 'function' && typeof TripMotion.init === 'function'"))
                page.evaluate("openModal('apiModal')")
                page.wait_for_function("document.getElementById('apiModal').getAnimations({subtree:true}).some(a => a.playState === 'running')")
                check(name + ": modal uses running Motion animations", True)
                page.evaluate("closeModal('apiModal'); openModal('apiModal')")
                page.wait_for_timeout(400)
                check(name + ": rapid close and reopen stays open", page.locator('#apiModal').is_visible() and page.locator('#apiModal').evaluate("el => getComputedStyle(el).opacity === '1'"))
                page.evaluate("closeModal('apiModal')")
                page.wait_for_function("document.getElementById('apiModal').style.display === 'none'")
                check(name + ": modal close cleans animation styles", page.evaluate("document.querySelector('#apiModal .modal-content').style.transform === '' && document.getElementById('apiModal').style.opacity === ''"))
                page.locator('.btn-setting').scroll_into_view_if_needed()
                page.evaluate("document.querySelector('.btn-setting').dispatchEvent(new PointerEvent('pointerdown', {bubbles:true, isPrimary:true, button:0, pointerId:9, pointerType:'touch'}))")
                page.wait_for_timeout(180)
                check(name + ": held button gives Motion press feedback", page.locator('.btn-setting').evaluate("el => el.style.transform === 'scale(0.97)'"))
                page.evaluate("document.dispatchEvent(new PointerEvent('pointercancel', {bubbles:true, isPrimary:true, pointerId:9}))")
                page.wait_for_timeout(200)
                check(name + ": cancelled press clears transform", page.locator('.btn-setting').evaluate("el => el.style.transform === ''"))
                page.evaluate("async days => { tripData = validateTrip(days); generationState = null; document.getElementById('city').value='台北'; await renderTrip(); TripMotion.settle(); }", [sample_day(), sample_day('2026-11-11')])
                page.evaluate("PlannerUI.switchView('itinerary', false)")
                check(name + ": hidden loading content can cancel active animations", page.evaluate("""() => {
                    const container = document.getElementById('tripContainer');
                    container.querySelector('.day-summary').textContent += ' 更新';
                    TripMotion.afterRender();
                    container.style.display = 'none';
                    TripMotion.settle(container);
                    container.style.display = 'flex';
                    return Array.from(container.querySelectorAll('details')).every(day => day.style.transform === '' && day.style.opacity === '');
                }"""))
                page.evaluate("""() => {
                    const summary = document.querySelectorAll('#tripContainer > details > summary')[1];
                    summary.dispatchEvent(new MouseEvent('click', {bubbles:true, detail:1}));
                }""")
                page.wait_for_timeout(40)
                check(name + ": accordion animates between measured heights", page.locator('#tripContainer > details').nth(1).evaluate("el => el.style.overflow === 'hidden' && el.getAnimations().length > 0"))
                page.evaluate("""() => {
                    const summary = document.querySelectorAll('#tripContainer > details > summary')[1];
                    summary.dispatchEvent(new MouseEvent('click', {bubbles:true, detail:1}));
                    summary.dispatchEvent(new MouseEvent('click', {bubbles:true, detail:1}));
                }""")
                page.wait_for_timeout(350)
                check(name + ": interrupted accordion ends open without clipped content", page.locator('#tripContainer > details').nth(1).evaluate("el => el.open && el.style.height === '' && el.style.overflow === ''"))
                page.evaluate("document.querySelectorAll('#tripContainer summary')[1].dispatchEvent(new MouseEvent('click', {bubbles:true, detail:1})); TripMotion.settle()")
                check(name + ": export settling completes pending accordion state", page.locator('#tripContainer > details').nth(1).evaluate("el => !el.open && el.style.height === '' && el.style.overflow === ''"))
                page.locator('#tripContainer summary').nth(1).focus()
                page.keyboard.press('Enter')
                check(name + ": keyboard accordion retains native instant behavior", page.locator('#tripContainer > details').nth(1).evaluate("el => el.open && el.style.height === ''"))
                page.evaluate("openModal('apiModal')")
                check(name + ": keyboard modal has no movement", page.locator('#apiModal').evaluate("el => el.getAnimations({subtree:true}).length === 0"))
                page.keyboard.press('Escape')
                check(name + ": Escape closes modal immediately", not page.locator('#apiModal').is_visible())
                page.emulate_media(reduced_motion='reduce')
                page.evaluate("PlannerUI.switchView('settings', false)")
                page.locator('.btn-setting').click()
                page.wait_for_timeout(30)
                check(name + ": reduced motion has no transform animations", page.locator('#apiModal').evaluate("el => el.getAnimations({subtree:true}).every(a => a.effect.getKeyframes().every(frame => !frame.transform || frame.transform === 'none'))"))
                page.evaluate("closeModal('apiModal')")
                check(name + ": reduced motion closes immediately", not page.locator('#apiModal').is_visible())
                page.emulate_media(reduced_motion='no-preference')
                page.evaluate("document.querySelector('.btn-setting').dispatchEvent(new PointerEvent('pointerdown', {bubbles:true, isPrimary:true, button:0, pointerId:10, pointerType:'touch'}))")
                page.wait_for_timeout(180)
                page.emulate_media(reduced_motion='reduce')
                page.wait_for_timeout(50)
                check(name + ": changing motion preference clears a held press", page.locator('.btn-setting').evaluate("el => el.style.transform === ''"))
                check(name + ": no horizontal overflow", page.evaluate("document.documentElement.scrollWidth <= innerWidth + 1"))
                check(name + ": no page exceptions or paid API requests", not errors and not network.ai_requests)
                page.screenshot(path=str(ARTIFACTS / f'motion-{name}.png'), full_page=True)
                context.close()

            context = browser.new_context()
            network = Network()
            context.route('**/*', network.route)
            context.route('**/vendor/motion.js', lambda route: route.abort())
            page = context.new_page()
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.goto(url, wait_until='networkidle')
            page.locator('.btn-setting').click()
            check('library failure: settings remain usable', page.locator('#apiModal').is_visible())
            page.locator('#apiModal .modal-close').click()
            check('library failure: close remains usable', not page.locator('#apiModal').is_visible())
            check('library failure: no uncaught exception', not errors)
            context.close()
            browser.close()
    finally:
        server.shutdown()
        (ARTIFACTS / 'motion-report.json').write_text(json.dumps({"checks": results}, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f"Motion checks: {len(results)} passed")


if __name__ == '__main__':
    main()
