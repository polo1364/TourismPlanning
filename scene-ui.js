(function () {
    'use strict';
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    const pointer = matchMedia('(hover: hover) and (pointer: fine)');
    const header = document.querySelector('.app-header');
    const scenery = header.querySelector('.hero-scenery');
    const effectButton = document.getElementById('sceneEffects');
    let effects = true;
    let frame = 0;
    let position = null;
    const read = key => { try { return localStorage.getItem(key); } catch (_) { return null; } };
    const save = (key, value) => { try { localStorage.setItem(key, value); } catch (_) { /* Preferences still work for this visit. */ } };

    function reset() {
        cancelAnimationFrame(frame);
        frame = 0;
        position = null;
        scenery.style.transform = '';
    }
    function updateEffects() {
        const enabled = effects && !reduced.matches;
        document.body.dataset.sceneEffects = String(enabled);
        effectButton.setAttribute('aria-pressed', String(enabled));
        effectButton.textContent = reduced.matches ? '封面動態：依系統關閉' : `封面動態：${effects ? '開' : '關'}`;
        effectButton.disabled = reduced.matches;
        reset();
    }
    function chooseScene(scene) {
        if (!['coast', 'town'].includes(scene)) return;
        document.body.dataset.scene = scene;
        document.querySelectorAll('[data-scene-choice]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.sceneChoice === scene)));
        save('roamScene', scene);
    }
    document.querySelectorAll('[data-scene-choice]').forEach(button => {
        button.addEventListener('click', () => {
            chooseScene(button.dataset.sceneChoice);
            reset();
        });
    });
    effectButton.addEventListener('click', () => {
        effects = !effects;
        save('roamSceneEffects', String(effects));
        updateEffects();
    });
    header.addEventListener('pointermove', event => {
        if (!effects || reduced.matches || !pointer.matches || event.pointerType !== 'mouse' || document.hidden) return;
        const box = header.getBoundingClientRect();
        position = { x: (event.clientX - box.left) / box.width - .5, y: (event.clientY - box.top) / box.height - .5 };
        if (frame) return;
        frame = requestAnimationFrame(() => {
            frame = 0;
            if (position) scenery.style.transform = `translate3d(${position.x * 12}px, ${position.y * 8}px, 0)`;
        });
    });
    header.addEventListener('pointerleave', reset);
    window.addEventListener('blur', reset);
    document.addEventListener('visibilitychange', () => { if (document.hidden) reset(); });
    reduced.addEventListener('change', updateEffects);
    pointer.addEventListener('change', reset);
    // Keyboard navigation changes the theme instantly and never moves the imagery.
    document.addEventListener('keydown', () => { document.body.dataset.sceneKeyboard = 'true'; reset(); }, true);
    document.addEventListener('pointerdown', () => { delete document.body.dataset.sceneKeyboard; }, true);
    document.querySelectorAll('.scene-image').forEach(img => img.addEventListener('error', () => { img.hidden = true; }));
    effects = read('roamSceneEffects') !== 'false';
    const savedScene = read('roamScene');
    document.body.dataset.scene = ['coast', 'town'].includes(savedScene) ? savedScene : 'coast';
    document.querySelectorAll('[data-scene-choice]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.sceneChoice === document.body.dataset.scene)));
    updateEffects();
    document.getElementById('sceneControls').hidden = false;
})();
