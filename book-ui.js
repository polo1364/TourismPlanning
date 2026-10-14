(function () {
    'use strict';
    const $ = id => document.getElementById(id);
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    let selectedDate = null;
    let selectedIndex = 0;
    let previousCount = 0;
    let journeyId = null;
    let continuous = false;
    try { continuous = localStorage.getItem('roamReadingMode') === 'continuous'; } catch (_) { /* Local preferences are optional. */ }

    // A pending fresh generation uses temporary model data; the visible book stays readable.
    function chapters() {
        return Array.from(document.querySelectorAll('#tripContainer > details'), day => ({ date: day.dataset.date, day_title: day.querySelector('.day-summary').textContent }));
    }

    function refresh() {
        if (!$('bookNavigation')) return;
        const days = chapters();
        const id = $('tripSelect')?.value || '';
        if (id !== journeyId) {
            journeyId = id;
            selectedIndex = 0;
            selectedDate = days[0]?.date || null;
            previousCount = days.length;
        } else if (days.length > previousCount) {
            selectedDate = days.at(-1)?.date || null;
        }
        previousCount = days.length;
        const found = days.findIndex(day => day.date === selectedDate);
        selectedIndex = found >= 0 ? found : Math.max(0, Math.min(selectedIndex, days.length - 1));
        selectedDate = days[selectedIndex]?.date || null;
        const travelling = document.querySelector('.container').dataset.travelling === 'true';
        document.body.dataset.bookView = document.querySelector('.container').dataset.view;
        document.body.dataset.bookReading = continuous ? 'continuous' : 'paged';
        document.body.dataset.bookHasPages = String(days.length > 0);
        $('bookNavigation').hidden = !days.length || travelling;
        document.querySelectorAll('#tripContainer > details').forEach((day, index) => {
            day.hidden = !continuous && index !== selectedIndex;
            if (!continuous && index === selectedIndex) day.open = true;
        });
        document.querySelectorAll('#dayIndex button').forEach((button, index) => {
            if (index === selectedIndex) button.setAttribute('aria-current', 'page');
            else button.removeAttribute('aria-current');
        });
        $('bookPrevious').disabled = selectedIndex <= 0;
        $('bookNext').disabled = selectedIndex >= days.length - 1;
        $('bookPageNumber').textContent = `${String(selectedIndex + 1).padStart(2, '0')} / ${String(days.length).padStart(2, '0')}`;
        $('bookPageTitle').textContent = selectedDate ? `第 ${selectedIndex + 1} 天 · ${selectedDate.slice(5).replace('-', '/')}` : '';
        $('bookReadMode').textContent = continuous ? '切換逐日翻閱' : '連續閱讀';
        $('bookReadMode').setAttribute('aria-pressed', String(continuous));
        $('bookProgress').max = Math.max(1, days.length);
        $('bookProgress').value = days.length ? selectedIndex + 1 : 0;
    }
    function select(index, scroll = true, animate = false) {
        const days = chapters();
        if (!Number.isInteger(index) || index < 0 || index >= days.length) return;
        window.TripMotion?.settle();
        const direction = index >= selectedIndex ? 1 : -1;
        selectedIndex = index;
        selectedDate = days[index].date;
        refresh();
        const day = document.querySelectorAll('#tripContainer > details')[index];
        if (!day) return;
        day.open = true;
        if (animate && !reduced.matches && !continuous) {
            window.TripMotion?.turnPage(day, direction);
        }
        if (scroll) {
            day.scrollIntoView({ block: 'start' });
            day.querySelector('summary').focus({ preventScroll: true });
        }
    }
    $('tripContainer').insertAdjacentHTML('beforebegin', `<nav id="bookNavigation" class="book-navigation" aria-label="旅遊書翻頁" hidden><div class="book-page-label"><span class="eyebrow">CHAPTER / 每一天，都是一頁風景</span><strong id="bookPageTitle"></strong></div><div class="book-page-controls"><button type="button" id="bookPrevious" aria-label="上一頁">←</button><output id="bookPageNumber" aria-live="polite"></output><button type="button" id="bookNext" aria-label="下一頁">→</button><button type="button" id="bookReadMode" aria-pressed="false">連續閱讀</button></div><progress id="bookProgress" max="1" value="0" aria-label="旅遊書閱讀頁次"></progress></nav>`);
    $('bookPrevious').addEventListener('click', event => select(selectedIndex - 1, true, event.detail > 0));
    $('bookNext').addEventListener('click', event => select(selectedIndex + 1, true, event.detail > 0));
    $('bookReadMode').addEventListener('click', () => {
        continuous = !continuous;
        try { localStorage.setItem('roamReadingMode', continuous ? 'continuous' : 'paged'); } catch (_) { /* Keep the current session usable. */ }
        refresh();
    });
    $('bookNavigation').addEventListener('keydown', event => {
        if (event.altKey || event.ctrlKey || event.metaKey || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
        event.preventDefault();
        select(selectedIndex + (event.key === 'ArrowRight' ? 1 : -1), false);
    });
    // In paged reading a chapter stays open; continuous reading retains the accordion.
    $('tripContainer').addEventListener('click', event => {
        if (!continuous && event.target.closest('#tripContainer > details > summary')) {
            event.preventDefault();
            event.stopPropagation();
        }
    });
    document.querySelectorAll('[data-brief]').forEach(button => button.addEventListener('click', () => {
        const input = $('customPrefs');
        const idea = button.dataset.brief;
        if (!input.value.includes(idea)) {
            input.value = [input.value.trim(), idea].filter(Boolean).join('；');
            input.dispatchEvent(new Event('input', { bubbles: true }));
        }
        input.focus();
    }));
    document.querySelector('.container').after($('tripLibrary'));
    window.TripBook = Object.freeze({ refresh, select, showCurrent: () => select(selectedIndex), openLibrary: () => {
        $('tripLibrary').scrollIntoView({ block: 'center' });
        $('tripSelect')?.focus({ preventScroll: true });
    } });
    document.body.classList.add('book-ready');
    refresh();
})();
