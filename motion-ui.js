(function () {
    'use strict';
    if (!window.Motion?.animateMini) return;

    // Motion's native DOM animator avoids retaining application styles in motion values.
    const animate = window.Motion.animateMini;
    const easeOut = [0.23, 1, 0.32, 1];
    const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
    const finePointer = matchMedia('(hover: hover) and (pointer: fine)');
    const active = new Map();
    const daySignatures = new Map();
    const accordionTargets = new WeakMap();
    let initialized = false;
    let keyboardInput = false;
    let pressedButton = null;

    function stop(element, finish = false) {
        const record = active.get(element);
        if (!record) return;
        active.delete(element);
        // Cancel instead of committing styles: a loading state may already hide the target.
        record.control.cancel();
        record.restore();
        if (finish) record.onFinish?.();
    }

    function play(element, keyframes, options = {}, onFinish) {
        stop(element);
        const original = Object.keys(keyframes).map(key => [key, element.style[key]]);
        const restore = () => original.forEach(([key, value]) => { element.style[key] = value; });
        try {
            const control = animate(element, keyframes, { duration: 0.22, ease: easeOut, ...options });
            const record = { control, restore, onFinish };
            active.set(element, record);
            control.finished.then(() => {
                if (active.get(element) !== record) return;
                active.delete(element);
                restore();
                onFinish?.();
            }).catch(() => { if (active.get(element) === record) stop(element, true); });
        } catch (_) {
            restore();
            onFinish?.();
        }
    }

    function settle(scope = document) {
        for (const element of Array.from(active.keys())) {
            if (element === scope || scope.contains(element)) stop(element, true);
        }
    }

    function reveal(elements) {
        elements.filter(el => el && el.getClientRects().length).forEach((el, index) => {
            const frames = reduceMotion.matches
                ? { opacity: [0.7, 1] }
                : { opacity: [0, 1], transform: ['translateY(10px)', 'translateY(0px)'] };
            play(el, frames, { duration: reduceMotion.matches ? 0.1 : 0.24, delay: reduceMotion.matches ? 0 : Math.min(index * 0.04, 0.12) });
        });
    }

    function afterRender() {
        const container = document.getElementById('tripContainer');
        if (!container?.getClientRects().length) return;
        const dates = new Set();
        const changed = [];
        container.querySelectorAll(':scope > details').forEach(day => {
            const date = day.dataset.date;
            const signature = day.textContent;
            dates.add(date);
            if (daySignatures.get(date) !== signature) changed.push(day);
            daySignatures.set(date, signature);
        });
        for (const date of daySignatures.keys()) if (!dates.has(date)) daySignatures.delete(date);
        reveal(changed);
    }

    function openModal(modal) {
        const panel = modal.querySelector('.modal-content');
        stop(modal);
        if (panel) stop(panel);
        if (keyboardInput) return;
        play(modal, { opacity: [0, 1] }, { duration: reduceMotion.matches ? 0.1 : 0.2 });
        if (panel) play(panel, reduceMotion.matches ? { opacity: [0.7, 1] } : {
            opacity: [0, 1], transform: ['translateY(8px) scale(0.97)', 'translateY(0px) scale(1)']
        }, { duration: reduceMotion.matches ? 0.1 : 0.24 });
    }

    function closeModal(modal, finish) {
        const panel = modal.querySelector('.modal-content');
        stop(modal);
        if (panel) stop(panel);
        if (keyboardInput || reduceMotion.matches || modal.style.display === 'none') { finish(); return; }
        if (panel) play(panel, { transform: ['translateY(0px) scale(1)', 'translateY(6px) scale(0.98)'] }, { duration: 0.16 });
        play(modal, { opacity: [1, 0] }, { duration: 0.16 }, () => {
            if (panel) stop(panel);
            finish();
        });
    }

    function toggleDay(event) {
        const summary = event.target.closest('#tripContainer > details > summary');
        if (!summary) return;
        const day = summary.parentElement;
        if (!event.detail || reduceMotion.matches) { stop(day, true); return; }
        event.preventDefault();
        const previous = accordionTargets.get(day);
        const targetOpen = !(previous ? previous.open : day.open);
        const startHeight = day.getBoundingClientRect().height;
        stop(day);
        day.style.height = '';
        day.open = true;
        const endHeight = targetOpen ? day.getBoundingClientRect().height : summary.getBoundingClientRect().height + 2;
        const previousOverflow = previous ? previous.overflow : day.style.overflow;
        day.style.overflow = 'hidden';
        accordionTargets.set(day, { open: targetOpen, overflow: previousOverflow });
        play(day, { height: [`${startHeight}px`, `${endHeight}px`] }, { duration: 0.2 }, () => {
            day.open = targetOpen;
            day.style.height = '';
            day.style.overflow = previousOverflow;
            accordionTargets.delete(day);
        });
    }

    function buttonFor(event) {
        return event.target instanceof Element ? event.target.closest('button:not(:disabled), a.btn-route, a.table-map-link') : null;
    }

    function releaseButton() {
        if (!pressedButton) return;
        const button = pressedButton;
        pressedButton = null;
        stop(button);
        button.style.transform = '';
        if (button.isConnected && !reduceMotion.matches) play(button, { transform: ['scale(0.97)', 'scale(1)'] }, { duration: 0.14 });
    }

    function init() {
        if (initialized) return;
        initialized = true;
        document.documentElement.classList.add('motion-ready');
        document.addEventListener('keydown', () => { keyboardInput = true; }, true);
        document.addEventListener('pointerdown', event => {
            keyboardInput = false;
            if (!event.isPrimary || event.button !== 0 || reduceMotion.matches) return;
            const button = buttonFor(event);
            if (!button) return;
            releaseButton();
            pressedButton = button;
            play(button, { transform: ['scale(1)', 'scale(0.97)'] }, { duration: 0.12 }, () => {
                if (pressedButton === button && !reduceMotion.matches) button.style.transform = 'scale(0.97)';
            });
        }, true);
        document.addEventListener('pointerup', releaseButton, true);
        document.addEventListener('pointercancel', releaseButton, true);
        window.addEventListener('blur', releaseButton);
        document.addEventListener('pointerover', event => {
            if (!finePointer.matches || reduceMotion.matches || event.pointerType !== 'mouse') return;
            const button = buttonFor(event);
            if (!button || button === pressedButton || button.contains(event.relatedTarget)) return;
            play(button, { transform: ['translateY(0px)', 'translateY(-1px)', 'translateY(0px)'] }, { duration: 0.16 });
        });
        document.addEventListener('click', toggleDay);
        reduceMotion.addEventListener('change', () => { releaseButton(); settle(); });
        reveal(Array.from(document.querySelectorAll('.app-header, .container > .column > .card, .workspace-heading, #placeholderMsg')));
        afterRender();
    }

    function turnPage(day, direction) {
        if (reduceMotion.matches) return;
        play(day, { opacity: [0.5, 1], transform: [`translateX(${direction * 12}px)`, 'translateX(0px)'] }, { duration: 0.24 });
    }
    window.TripMotion = Object.freeze({ init, afterRender, openModal, closeModal, settle, turnPage });
    document.addEventListener('DOMContentLoaded', init, { once: true });
})();
