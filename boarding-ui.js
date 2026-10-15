/* Boarding-pass presentation for the travel brief. Inputs keep their ids and handlers; only decoration is added. */
(function () {
    'use strict';
    const $ = id => document.getElementById(id);
    const codes = { 台北: 'TPE', 桃園: 'TPE', 高雄: 'KHH', 台中: 'RMQ', 台南: 'TNN', 花蓮: 'HUN', 台東: 'TTT', 京都: 'KYO', 大阪: 'OSA', 東京: 'TYO', 名古屋: 'NGO', 福岡: 'FUK', 札幌: 'SPK', 沖繩: 'OKA', 首爾: 'SEL', 釜山: 'PUS', 香港: 'HKG', 曼谷: 'BKK', 新加坡: 'SIN', 巴黎: 'PAR', 倫敦: 'LON', 紐約: 'NYC' };
    const plane = '<svg viewBox="0 0 24 24" aria-hidden="true"><path transform="rotate(90 12 12)" d="M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5z"/></svg>';

    function node(tag, className, html) {
        const element = document.createElement(tag);
        element.className = className;
        if (html) element.innerHTML = html;
        return element;
    }
    const code = value => {
        const name = value.trim();
        return codes[name] || (name ? name.slice(0, 3) : '---');
    };
    // Option labels start with an emoji; the stub shows the words only.
    const words = select => select?.selectedOptions[0]?.textContent.replace(/^[^\p{L}\p{N}]+/u, '').replace(/\s*[(（].*$/, '').trim() || '—';
    function days() {
        const start = $('flightArrival')?.value.slice(0, 10), end = $('flightDeparture')?.value.slice(0, 10);
        if (!start || !end) return 0;
        const count = Math.round((Date.parse(end) - Date.parse(start)) / 864e5) + 1;
        return count > 0 ? count : 0;
    }

    function build() {
        const card = document.querySelector('#settingsPanel > .card');
        if (!card || card.classList.contains('boarding-pass')) return false;
        const plan = $('planBtn'), hint = plan.nextElementSibling, reset = hint?.nextElementSibling;
        const main = node('div', 'pass-main');
        main.append(...card.childNodes);
        card.append(main);
        main.prepend(node('div', 'pass-band', '<b>漫遊<i>航空</i> · ROAM AIR</b><span>BOARDING PASS · 旅遊書登機證</span>'));
        main.firstChild.setAttribute('aria-hidden', 'true');

        const route = $('origin').closest('.input-group');
        route.classList.add('pass-route');
        route.insertBefore(node('div', 'pass-flight', `${plane}<small id="passFlightDays"></small>`), route.children[1]);
        $('origin').after(node('span', 'pass-code'));
        $('city').parentElement.after(node('span', 'pass-code'));
        route.querySelectorAll('.pass-code, .pass-flight').forEach(item => item.setAttribute('aria-hidden', 'true'));

        // Transport, times, pace, days and budget become one row-and-column ticket grid.
        const fields = node('div', 'pass-fields');
        const entry = node('div', '');
        entry.append(document.querySelector('label[for="entryType"]'), $('entryType'));
        const paceGroup = $('pace').closest('.input-group');
        fields.append(entry, $('flightArrival').closest('.input-group'), $('flightDeparture').closest('.input-group'), ...paceGroup.children, $('budget').closest('.input-group'));
        paceGroup.replaceWith(fields);

        const stub = node('aside', 'pass-stub');
        stub.setAttribute('aria-label', '登機證存根');
        stub.innerHTML = '<div class="pass-band" aria-hidden="true"><b>旅客聯</b><span>RA·001</span></div>'
            + '<div class="pass-stub-body"><dl class="pass-summary"><div class="pass-dest"><dt>DESTINATION 目的地</dt><dd data-pass="city">—</dd></div>'
            + '<div><dt>DATE 出發</dt><dd data-pass="date">—</dd></div><div><dt>DAYS 天數</dt><dd data-pass="days">—</dd></div>'
            + '<div><dt>CLASS 節奏</dt><dd data-pass="pace">—</dd></div><div><dt>GATE 交通</dt><dd data-pass="entry">—</dd></div></dl>'
            + '<div class="pass-barcode" aria-hidden="true"></div></div>';
        stub.lastChild.append(plan, ...[hint, reset].filter(Boolean));
        const stamp = node('div', 'pass-stamp', 'APPROVED<small>已出票</small>');
        stamp.setAttribute('aria-hidden', 'true');
        main.append(stamp);
        card.append(stub);
        card.classList.add('boarding-pass');
        return true;
    }

    function sync() {
        const card = document.querySelector('.boarding-pass');
        if (!card) return;
        const [originCode, cityCode] = card.querySelectorAll('.pass-code');
        originCode.textContent = code($('origin').value);
        cityCode.textContent = code($('city').value);
        const count = days(), start = $('flightArrival').value;
        const set = (key, text) => { card.querySelector(`[data-pass="${key}"]`).textContent = text; };
        set('city', $('city').value.trim() || '—');
        set('date', start ? start.slice(5, 10).replace('-', '/') : '—');
        set('days', count ? `${count}D${count - 1}N` : '—');
        set('pace', words($('pace')));
        set('entry', words($('entryType')));
        $('passFlightDays').textContent = count ? `${count} DAYS` : '';
    }

    function start() {
        if (!build()) return;
        const panel = $('settingsPanel');
        panel.addEventListener('input', sync);
        panel.addEventListener('change', sync);
        // Saved trips are restored by script without input events, so refresh while the brief is visible.
        setInterval(() => { if (!panel.offsetParent) return; sync(); }, 1000);
        sync();
        const status = $('operationStatus'), stamp = document.querySelector('.pass-stamp');
        if (status) new MutationObserver(() => stamp.classList.toggle('go', !status.hidden)).observe(status, { attributes: true, attributeFilter: ['hidden'] });
    }
    // Loaded right after the brief markup so the ticket exists before the first paint.
    if (document.querySelector('#settingsPanel > .card')) start();
    else document.addEventListener('DOMContentLoaded', start);
}());
