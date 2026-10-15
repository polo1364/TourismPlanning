/* A self-contained, read-only snapshot. No app state or storage is shipped. */
(() => {
    'use strict';
    const css = `
*{box-sizing:border-box}html{color-scheme:light}body{margin:0;background:#122333;color:#294354;font:17px/1.85 'Microsoft JhengHei','PingFang TC',system-ui,sans-serif;overflow-wrap:anywhere}
button,select{font:inherit}button,a,select{-webkit-tap-highlight-color:transparent}button,select{min-height:44px;border:1px solid #748c9c;border-radius:6px;padding:8px 14px;background:#fff;color:#183b51}button:not(:disabled),select{cursor:pointer}button:disabled{opacity:.45}a{color:#245b71;text-underline-offset:4px}:focus-visible{outline:3px solid #cc8b26;outline-offset:4px}[hidden]{display:none!important}
.reader-nav{position:sticky;top:0;z-index:10;background:#122333f5;color:#edf6fa;border-bottom:1px solid #4b6678;padding:12px max(16px,calc((100vw - 1040px)/2));display:flex;align-items:center;gap:10px;flex-wrap:wrap}.reader-nav label{font-size:14px}.reader-nav select{flex:1;min-width:0;max-width:420px;background:#20394c;color:#fff}.reader-nav button{background:#20394c;color:#fff}.reader-nav output{min-width:64px;text-align:center;font-variant-numeric:tabular-nums;font-size:14px}.reader-nav .print{margin-left:auto}
main{max-width:1040px;margin:28px auto 50px;padding:0 14px}.book-page{margin-bottom:30px;background:#f1f5f8;border:1px solid #91a5b3;border-radius:4px 16px 16px 4px;box-shadow:4px 4px #9bb0bd,8px 8px #405b6b,0 20px 60px #0003;overflow:hidden;min-height:560px;scroll-margin-top:140px}.book-page:focus{outline:none}.cover{padding:clamp(28px,6vw,72px);background:linear-gradient(90deg,#102c3ff2,#102c3fa8),var(--cover-art,none) center/cover,#102c3f;color:#f0f7fb}.eyebrow{font-size:13px;letter-spacing:.16em;color:#a9e5e1}.cover h1{font-size:clamp(30px,5vw,48px);line-height:1.4;margin:20px 0}.cover .dates{font-variant-numeric:tabular-nums;color:#cbdee7}.cover-intro{max-width:36em;color:#dbe8ef}.toc{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;list-style:none;padding:0;margin:30px 0}.toc a{display:block;padding:16px 20px;border:1px solid #819ea9;border-radius:7px;background:#102c3fde;color:#fff;text-decoration:none;height:100%}.toc a:hover{background:#254d60}.toc small{display:block;color:#b2ddd9;font-size:14px}.cover-foot{border-top:1px solid #8cabb166;padding-top:20px;font-size:14px;color:#c3d7e1}
.chapter-heading{display:flex;gap:24px;padding:30px 36px;background:linear-gradient(90deg,#102c3ff2,#102c3fb8),var(--cover-art,none) center/cover,#102c3f;color:#edf6fa}.day-number{flex:0 0 60px;font-size:40px;line-height:1.4;color:#a9e5e1;font-variant-numeric:tabular-nums}.day-number small{display:block;font-size:11px;letter-spacing:.16em}.day-header{min-width:0}.day-date{font-size:15px;color:#c7dfe9}.day-summary{font-size:28px;line-height:1.5;margin:8px 0 16px}.chapter-facts{display:flex;flex-wrap:wrap;gap:8px 16px;font-size:15px;margin-bottom:12px}.travel-caution{color:#ffe0ad}.day-cost-badge,.weather-badge{display:inline-block;border:1px solid #7296a7;border-radius:4px;padding:3px 8px;font-size:14px;margin:0 8px 8px 0}.chapter-stops{display:block;font-size:12px;color:#c7dfe9}
.day-content{padding:28px}.chapter-context{display:grid;grid-template-columns:2fr 1fr;gap:24px;padding:24px;background:#fff;border:1px solid #d1dee7;border-radius:10px;margin-bottom:24px}.chapter-context h3{font-size:18px;color:#183b51;margin:0 0 10px}.chapter-context p{margin:0}.chapter-budget{border-left:1px solid #d9e3ea;padding-left:24px;font-size:15px;color:#536271}.itinerary-table,.itinerary-table tbody{display:block;width:100%}.itinerary-table thead{display:none}.itinerary-table tr{display:grid;grid-template-columns:80px minmax(0,1fr) auto;gap:12px 20px;background:#fff;border:1px solid #cfdee7;border-radius:10px;margin-bottom:20px;padding:24px}.itinerary-table td{display:block;min-width:0}.time-cell{grid-column:1;grid-row:1 / span 3;font-size:20px;color:#235b73;font-weight:700;font-variant-numeric:tabular-nums}.end-time{display:block;font-size:14px;font-weight:400}.type-cell{grid-column:3;grid-row:1;display:flex!important;flex-direction:column;align-items:flex-end;gap:8px;max-width:130px}.title-cell{grid-column:2;grid-row:1}.stop-name{font-size:22px;font-weight:700;color:#15314a;line-height:1.5}.stop-meta{font-size:14px;color:#435c6b;display:flex;flex-wrap:wrap;gap:5px 12px;margin-top:8px}.desc-cell{grid-column:2 / -1}.action-cell{grid-column:2 / -1;border-top:1px solid #e0e8ee;padding-top:12px}.table-cost{color:#765125;font-size:15px;margin:10px 0}.table-address{font-size:15px;margin:10px 0}.shared-cost-label{font-weight:700}.table-map-link,.btn-route{display:inline-block;min-height:44px;padding:8px 14px;border-radius:5px;background:#245b71;color:#fff;text-decoration:none;font-size:15px}.day-actions{margin-top:24px}.watermark{display:none}
.inline-place{padding:.08em .32em;border:1px solid #a9cfc2;border-radius:5px;background:#e4f3ec;color:#245d4e;font-weight:600;box-decoration-break:clone;-webkit-box-decoration-break:clone}.inline-place.food{background:#fff0df;color:#82451e;border-color:#e5bc91}.place-sticker{display:inline-flex;align-items:center;gap:5px;padding:5px 8px;border:1px solid #8cbcb5;border-radius:11px 5px 11px 5px;background:#e2f3ec;color:#215e50;box-shadow:inset 0 0 0 2px white;font-size:14px;font-weight:700;line-height:1.5}.place-sticker.food{background:#fff0df;color:#884517;border-color:#d4a572}.place-sticker.transport{background:#e7f0fc;color:#305a8c;border-color:#9bb7d8}.place-sticker.booking{background:#f1eafa;color:#6b4287;border-color:#bca2cf}.sticker-icon{width:17px;height:17px;flex:0 0 17px}
.transit-details{margin:12px 0;border:1px solid #c9dbe5;border-radius:6px;background:#e8f0f6;font-size:15px}.transit-details summary{cursor:pointer;padding:12px 14px}.transit-toggle{margin-left:12px;font-size:13px}.transit-option{padding:0 14px 12px}.transit-option p{margin:4px 0}.table-tips{padding:12px 14px;background:#eff6f4;border-left:3px solid #73a49a;border-radius:4px;color:#365d5b;font-size:15px;margin:12px 0}
.stop-note{position:relative;margin:28px 0 18px;padding:20px 22px 26px;border:1px solid #ecd990;border-radius:3px 3px 24px 3px;background:linear-gradient(135deg,#fff7c5,#fff0a6);box-shadow:0 5px 10px #624b1524;color:#513c16;break-inside:avoid}.stop-note::before{content:'';position:absolute;width:76px;height:24px;top:-13px;left:calc(50% - 38px);transform:rotate(-4deg);background:#eadfbbb3;border:1px solid #d5c79d66}.stop-note::after{content:'';position:absolute;bottom:0;right:0;width:24px;height:24px;border-radius:22px 0 22px 0;background:linear-gradient(135deg,#e3cb74,#fff6ba)}.stop-note-heading{padding-bottom:10px;margin-bottom:12px;border-bottom:1px solid #d4bd7480}.stop-note-text{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}.reader-footer{text-align:center;color:#c1d6e2;font-size:14px;margin:24px 16px}
@media(max-width:650px){body{font-size:17px}.reader-nav{gap:8px;padding:10px 12px}.reader-nav label{display:none}.reader-nav select{flex-basis:100%;max-width:none}.reader-nav .print{margin-left:auto;font-size:14px}.reader-nav button{padding:8px 12px}main{margin-top:16px;padding:0 12px 0 8px}.cover{padding:28px 24px}.toc{grid-template-columns:1fr}.chapter-heading{padding:24px 18px;gap:14px}.day-number{flex-basis:44px;font-size:32px}.day-summary{font-size:24px}.day-content{padding:16px 12px}.chapter-context{grid-template-columns:1fr;padding:18px;gap:16px}.chapter-budget{border-left:0;border-top:1px solid #d9e3ea;padding:16px 0 0}.itinerary-table tr{grid-template-columns:minmax(0,1fr) auto;gap:14px;padding:18px 14px}.time-cell{grid-column:1;grid-row:1}.type-cell{grid-column:2;grid-row:1;max-width:130px}.title-cell{grid-column:1 / -1;grid-row:2}.desc-cell,.action-cell{grid-column:1 / -1}.stop-name{font-size:21px}.stop-note{padding:18px 16px 24px}}
@media print{body{background:#fff;color:#183b51;font-size:11pt}.reader-nav,.reader-footer,.cover-foot{display:none!important}main{max-width:none;margin:0;padding:0}.book-page,.book-page[hidden]{display:block!important;box-shadow:none;min-height:0;border:0;border-radius:0;break-after:page;margin:0}.book-page:last-child{break-after:auto}.cover{min-height:85vh}.cover,.chapter-heading{background:#edf4f5;color:#183b51}.cover a,.cover p,.cover small,.day-date,.chapter-stops,.day-number,.travel-caution{color:#183b51}.toc a{background:#fff;color:#183b51}.day-summary{font-size:22pt}.day-content{padding:18px 0}.itinerary-table tr{break-inside:avoid}.stop-note{box-shadow:none}.chapter-context{grid-template-columns:2fr 1fr}.turning{animation:none}}
`;

    // CSS columns perform real text fragmentation, including long notes and headings.
    // The continuous layout above remains available for print and disabled JavaScript.
    const boundCss = `
.manual-kicker{font-size:13px;letter-spacing:.12em;color:#486876;margin:0 0 22px;padding-bottom:10px;border-bottom:1px solid #8aa7ab}
.chapter-scenery{position:relative;height:160px;margin:18px 0 22px;background:var(--cover-art,linear-gradient(135deg,#bed8d6,#769f97)) center 48%/cover;break-inside:avoid}
.chapter-scenery figcaption{position:absolute;bottom:0;right:0;padding:3px 8px;background:#122333dd;color:#fff;font-size:11px;line-height:1.6}
.without-art .chapter-scenery{display:none}
.manual-heading{font-size:22px;line-height:1.5;border-left:5px solid #427e80;padding-left:12px;margin:20px 0 14px;color:#183b51;break-after:avoid}
.schedule{font-size:14px;line-height:1.6;margin-bottom:20px;border-top:1px solid #789c9e}
.schedule-row{display:grid;grid-template-columns:66px minmax(0,1fr) 48px;gap:12px;padding:9px 8px;border-bottom:1px solid #bfccca;break-inside:avoid}
.schedule-head{background:#dce9e6;color:#1a414b;font-weight:700;break-after:avoid}.schedule-time{font-variant-numeric:tabular-nums}.schedule-kind{font-size:12px;color:#486876;text-align:right}
.manual-overview .chapter-intro{font-size:15px;margin:16px 0;line-height:1.85}.manual-overview .chapter-budget{font-size:14px;color:#536271;border-top:1px solid #c6d4d0;padding-top:12px}.manual-overview .chapter-budget h3{font-size:16px;margin:0 0 6px}.manual-overview .chapter-budget p{margin:0}
.manual-details>.manual-heading{margin-top:0}.stop-entry.stop-food .stop-name{color:#884517}.stop-entry.stop-spot .stop-name{color:#245d4e}.stop-entry.stop-transport .stop-name{color:#305a8c}
.reader-brand{display:flex;align-items:center;gap:10px;min-width:0;margin-right:auto;color:#e3eff6;font-size:18px}.reader-brand svg{width:36px;height:28px;flex-shrink:0}.reader-brand span{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.reader-controls{display:flex;justify-content:center;align-items:center;gap:20px}.reader-controls button{width:42px;min-height:42px;border:1px solid #a8bfc9;border-radius:50%;padding:4px;background:#183448;color:#fff;font-size:22px;line-height:1}.reader-controls output{font-size:14px;min-width:110px;font-variant-numeric:tabular-nums}.reader-hint{font-size:12px;color:#b4cad5}
@media screen{
html:has(body.bound){height:100%;overflow:hidden}
body.bound{height:100vh;height:100dvh;overflow:hidden;display:grid;grid-template-columns:minmax(0,1fr);grid-template-rows:auto minmax(0,1fr) auto;background:radial-gradient(ellipse at 50% 40%,#2c4b60,#102334 85%)}
.bound .reader-nav{position:relative;padding:10px 20px;flex-wrap:nowrap;gap:10px}
.bound .reader-nav select{max-width:320px;font-size:14px}.bound .reader-nav output{min-width:105px}
.bound main{position:relative;width:calc(100% - 40px);max-width:1240px;min-height:0;margin:18px auto 12px;padding:0;perspective:1600px;touch-action:pan-y pinch-zoom}
.sheet-window{position:absolute;inset:0;padding:28px 32px 42px;border:1px solid #a3b6bf;border-radius:6px 14px 14px 6px;background:linear-gradient(90deg,#faf9f3,#f7f6f0 47%,#e5e4dc 49.8%,#f4f3ec 50.2%,#faf9f3 53%);box-shadow:1px 1px #e8e6db,3px 3px #8d9696,5px 5px #e4e4d9,7px 7px #708087,9px 9px #203d50,0 16px 48px #0005;overflow:hidden}
.sheet-window.cover-sheet{background:linear-gradient(90deg,#102c3feb,#102c3fb8),var(--cover-art,none) center/cover,#102c3f}
.bound[data-spread='2'] .sheet-window::after{content:'';position:absolute;top:0;bottom:0;left:50%;width:1px;background:#acb3aa;box-shadow:-5px 0 14px 4px #263d3b14;pointer-events:none}
.bound .book-page{column-fill:auto;column-gap:48px;column-width:var(--leaf-width);width:var(--leaf-width);height:var(--leaf-height);min-height:0;max-height:none;overflow:visible;margin:0;padding:0;border:0;border-radius:0;box-shadow:none;background:none;transform:translateX(var(--leaf-offset,0px));transition:none}
.bound .cover{color:#f0f7fb}.bound .cover h1{font-size:36px;line-height:1.4;margin:12px 0 24px}.bound .cover .eyebrow{margin-top:20px}.bound .cover-intro{margin-bottom:28px}.bound .cover h2{font-size:22px}.bound .toc{display:block;margin:18px 0;padding:0}.bound .toc li{margin-bottom:12px;break-inside:avoid}.bound .toc a{padding:12px 16px}.bound .cover-foot{font-size:14px;line-height:1.8}
.bound .chapter-heading{display:block;padding:0;background:none;color:#15314a;border:0;margin-bottom:16px}.bound .day-number{font-size:62px;font-family:Georgia,serif;line-height:1;letter-spacing:-.06em;color:#153d53;float:left;margin:0 20px 12px 0;padding:0 18px 0 0;border-right:1px solid #8ca5ab}.bound .day-number small{display:none}.bound .day-date{color:#496775;font-size:14px}.bound .day-summary{font-size:26px;margin:8px 0 16px;line-height:1.45}.bound .chapter-facts{clear:both;font-size:13px;line-height:1.7;gap:6px 12px;margin-bottom:8px}.bound .travel-caution{color:#815619}.bound .day-cost-badge,.bound .weather-badge{font-size:12px;background:none;border:0;border-radius:0;padding:0 10px 0 0;color:#425d6a;margin-bottom:0}.bound .chapter-stops{display:none}
.bound .chapter-scenery{height:clamp(75px,calc(var(--leaf-height) * .21),180px)}.bound .manual-details{break-before:column}.bound .manual-kicker{break-after:avoid}.bound .manual-overview .chapter-budget{border-left:0;padding-left:0;margin-top:12px}
.bound .day-content{padding:0}.bound .chapter-context{display:block;padding:0;border:0;border-radius:0;background:none;margin:0 0 20px}.bound .chapter-budget{padding:12px 0 0;margin:14px 0 0;border:0;border-top:1px solid #d1ddd9}.bound .chapter-context h3{break-after:avoid}.bound p{orphans:2;widows:2}
.stop-entry{margin:0 0 24px;padding:16px 0 0;border-top:1px solid #afc3c8;break-inside:auto}.stop-topline{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px;break-inside:avoid;break-after:avoid}.stop-topline .type-cell{display:flex;flex-direction:row;flex-wrap:wrap;max-width:none;gap:6px}.bound .time-cell{font-size:18px}.bound .end-time{display:inline;margin-left:6px}.bound .title-cell{margin-bottom:14px}.bound .stop-name{font-size:21px;line-height:1.5;break-after:avoid}.bound .stop-meta{font-size:13px}.bound .stop-description{margin-bottom:12px}.bound .action-cell{padding-top:8px}.bound .table-map-link,.bound .btn-route{font-size:14px;padding:6px 12px;min-height:40px;break-inside:avoid}
.bound .transit-details{padding:12px 14px;break-inside:auto}.bound .transit-option{padding:0 0 10px}.bound .transit-option:last-child{padding-bottom:0}.bound .stop-note{padding:18px 18px 24px;box-decoration-break:clone;-webkit-box-decoration-break:clone}.bound .stop-note-heading{break-after:avoid}.bound .table-tips{box-decoration-break:clone;-webkit-box-decoration-break:clone}
.sheet-numbers{position:absolute;bottom:9px;left:32px;right:32px;display:flex;justify-content:space-between;color:#607681;font-size:12px;line-height:20px;pointer-events:none;border-top:1px solid #99afb0;padding-top:4px}.cover-sheet .sheet-numbers{color:#c1dcd9}.bound .reader-footer{margin:0;padding:4px 20px 8px;display:flex;align-items:center;justify-content:center;gap:30px;min-height:58px}.bound .reader-hint{position:absolute;right:24px}
.page-turn{position:absolute;inset:0;z-index:5;perspective:1800px;pointer-events:none;overflow:clip}
.turn-rest{position:absolute;inset:0;clip-path:inset(0 50% 0 0)}.page-turn.backward .turn-rest{clip-path:inset(0 0 0 50%)}
.turn-leaf{position:absolute;top:0;bottom:0;left:50%;width:50%;transform-origin:left center;transform-style:preserve-3d;will-change:transform}
.page-turn.backward .turn-leaf{left:0;transform-origin:right center}
.turn-face{position:absolute;inset:0;overflow:hidden;backface-visibility:hidden;background:#faf9f3;box-shadow:0 0 16px #142b3b35}
.turn-back{transform:rotateY(180deg)}.turn-shadow{position:absolute;inset:0;background:linear-gradient(90deg,#14304035,transparent 22%,#fff7e512 70%,#142b3b30);opacity:0;pointer-events:none}
.page-turn .sheet-window{height:100%;max-width:none;margin:0;pointer-events:none}.page-turn .sheet-window:focus{outline:none}
.bound[data-spread='1'] .turn-rest{display:none}.bound[data-spread='1'] .turn-leaf{left:0;width:100%}
@media(prefers-reduced-motion:reduce){.page-turn{display:none}}
@media(max-width:899px){.bound .reader-nav{gap:6px;padding:8px 12px}.bound .reader-nav label,.bound .reader-brand{display:none}.bound .reader-nav select{flex-basis:0;max-width:none}.bound main{width:calc(100% - 24px);margin:10px auto 8px}.sheet-window{padding:20px 20px 36px;background:#faf9f3}.bound .book-page{column-gap:40px}.bound .cover h1{font-size:28px}.bound .day-summary{font-size:22px}.bound .day-number{font-size:44px;margin-right:12px;padding-right:12px}.bound .chapter-facts{display:block}.sheet-numbers{left:20px;right:20px}.bound .reader-nav .print{font-size:12px;white-space:nowrap}.bound .reader-nav output{flex:1}.bound .reader-nav button{padding:5px 10px}.bound .reader-hint{display:none}.bound .reader-footer{padding:4px 12px 6px;min-height:54px}.bound .manual-kicker{margin-bottom:16px}.bound .schedule-row{grid-template-columns:48px minmax(0,1fr) 34px;gap:8px;padding:8px 4px}.bound .schedule{font-size:13px}.bound .manual-heading{font-size:20px}}
@media(max-height:500px){.bound .reader-nav{padding:4px 8px}.bound .reader-nav select{min-height:36px}.bound .reader-nav button{min-height:36px}.bound main{margin:6px auto}.sheet-window{padding-top:12px;padding-bottom:28px}.bound .reader-footer{min-height:42px;padding:2px 12px}.reader-controls button{min-height:36px;height:36px;width:36px}.bound .cover .eyebrow{margin-top:0}.bound .chapter-scenery{height:70px}}
}
@media print{.page-turn{display:none!important}.sheet-window{display:block!important;position:static;overflow:visible;break-after:page}.sheet-window:last-child{break-after:auto}.sheet-numbers{display:none}.book-page{columns:auto!important;transform:none!important;width:auto!important;height:auto!important}.stop-entry{break-inside:avoid}.stop-topline{display:flex;justify-content:space-between}.stop-topline .type-cell{display:flex;gap:8px}.book-page.cover{color:#183b51}}
`;

    // Postcard theme: a wooden desk, cream card stock, stamps, washi tape and wax seals. Screen only; print stays plain.
    const postcardCss = `
@media screen{
:root{--card:#fbf6ea;--card-ink:#3a2f25;--card-blue:#2c4a7a;--card-muted:#8b775e;--card-rule:#d9cbb0;--card-dash:#c9b896;--seal:#a8261d;--kai:'LXGW WenKai TC','Kaiti TC',STKaiti,BiauKai,DFKai-SB,'Noto Serif TC',serif;--paper-grain:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence baseFrequency='.9' numOctaves='2'/%3E%3CfeColorMatrix values='0 0 0 0 .5 0 0 0 0 .4 0 0 0 0 .3 0 0 0 .06 0'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23n)'/%3E%3C/svg%3E")}
body,body.bound{color:var(--card-ink);background:radial-gradient(ellipse at 30% 20%,#ffffff40,transparent 60%),repeating-linear-gradient(92deg,#5a371e0f 0 3px,transparent 3px 11px),repeating-linear-gradient(88deg,#3c230f0d 0 1px,transparent 1px 7px),#b98a5e}
a{color:var(--card-blue)}:focus-visible{outline-color:var(--seal)}
.reader-nav,.bound .reader-nav{background:#3b2a1cf2;color:#f3e6d0;border-bottom:1px solid #6b4f36}.reader-nav select,.reader-nav button{background:#5a412c;color:#fbf1df;border-color:#8b6a4a}
.reader-brand{color:#fbf1df;font-family:var(--kai)}
.book-page{background:var(--card) var(--paper-grain);border:0;border-radius:6px;box-shadow:0 2px 0 #e8dcc4,0 30px 50px #28140566,0 6px 12px #28140540}
.sheet-window{border:0;border-radius:6px;background:var(--paper-grain),linear-gradient(90deg,var(--card),var(--card) 47%,#eadfc8 49.8%,#f6efdf 50.2%,var(--card) 53%);box-shadow:0 2px 0 #e8dcc4,0 30px 50px #28140566,0 6px 12px #28140540}
.bound[data-spread='1'] .sheet-window:not(.cover-sheet){background:var(--paper-grain),var(--card)}
.bound[data-spread='2'] .sheet-window::after{background:var(--card-rule);box-shadow:-5px 0 14px 4px #3a24140f}
.turn-face{background:var(--card) var(--paper-grain);box-shadow:0 0 16px #2814053d}
.cover,.sheet-window.cover-sheet{background:linear-gradient(180deg,#1a0e0426 25%,#1a0e04d9),var(--cover-art,none) center/cover,#6b4a2c;color:#fff7ea}
.eyebrow{color:#ffe2b8;letter-spacing:.32em}.cover h1,.bound .cover h1{font-family:var(--kai);font-weight:700;text-shadow:0 4px 20px #0006}.cover .dates,.cover-intro,.cover-foot{color:#f6e7cf}.cover-foot{border-top:1px dashed #f6e7cf66}
.toc a,.bound .toc a{background:#fbf6eaeb;color:var(--card-ink);border:1px dashed var(--card-dash);border-radius:3px;box-shadow:0 4px 10px #1a0e0433;font-family:var(--kai);font-size:18px}.toc a:hover{background:#fff}.toc small{color:var(--card-muted);font-family:system-ui,sans-serif}
.chapter-heading{background:linear-gradient(90deg,#3a2414f0,#3a2414b8),var(--cover-art,none) center/cover,#3a2414}
.bound .chapter-heading{color:var(--card-ink)}
.bound .day-number{display:grid;place-items:center;width:84px;height:100px;padding:7px;margin:0 22px 12px 0;border:0;font-family:var(--kai);font-size:44px;letter-spacing:0;color:#fff7ea;background:linear-gradient(160deg,#e2572b,#a8261d) content-box,#fff;-webkit-mask:linear-gradient(#000 0 0) content-box,radial-gradient(circle 4px,#0000 97%,#000) -6px -6px/12px 12px round;mask:linear-gradient(#000 0 0) content-box,radial-gradient(circle 4px,#0000 97%,#000) -6px -6px/12px 12px round;transform:rotate(-3deg)}
.bound .day-date{display:inline-block;padding:4px 14px;border:2px solid #3c466e8c;border-radius:999px;color:#3c466ebf;font-family:Consolas,ui-monospace,monospace;font-size:13px;letter-spacing:.08em;transform:rotate(-4deg)}
.bound .day-summary{font-family:var(--kai);font-weight:700;color:var(--card-ink)}
.bound .travel-caution{color:#9b4a1b}.bound .day-cost-badge,.bound .weather-badge{color:var(--card-muted)}
.manual-kicker{color:var(--card-muted);border-bottom:1px dashed var(--card-dash);font-family:var(--kai);letter-spacing:.2em}
.manual-heading{display:table;margin:22px 0 14px -4px;padding:2px 16px;border-left:0;background:#bfe0d0;color:var(--card-ink);font-family:var(--kai);transform:rotate(-1deg);clip-path:polygon(2% 0,98% 6%,100% 50%,97% 100%,1% 94%,0 50%)}
.manual-details>.manual-heading{background:#f2c4b3}
.chapter-scenery{border:8px solid #fff;box-shadow:0 6px 14px #3a24142e;transform:rotate(-.6deg)}.chapter-scenery figcaption{background:#3a2414cc}
.schedule{border-top:1.5px solid var(--card-dash)}.schedule-row{border-bottom:1px solid var(--card-rule);color:var(--card-blue)}.schedule-head{background:transparent;color:var(--card-muted);font-family:var(--kai)}.schedule-kind{color:var(--card-muted)}
.manual-overview .chapter-intro{color:var(--card-ink)}.manual-overview .chapter-budget,.chapter-budget{color:var(--card-muted);border-color:var(--card-rule)}
.stop-entry{border-top:1px dashed var(--card-dash)}.time-cell,.bound .time-cell{color:var(--card-blue);font-family:var(--kai)}
.stop-name{font-family:var(--kai);color:var(--card-ink)}.stop-entry.stop-food .stop-name{color:#a0522d}.stop-entry.stop-spot .stop-name{color:#3d6b4f}.stop-entry.stop-transport .stop-name{color:var(--card-blue)}
.stop-meta{color:var(--card-muted)}.table-cost{color:#8a5a22}
.inline-place{border:0;border-radius:0;background:#bfe0d0b3;color:#2f5a44}.inline-place.food{background:#f2c4b3b3;color:#7a3a17}
.place-sticker{border:0;border-radius:0;box-shadow:0 1px 2px #3a241426;background:#bfe0d0;color:#2f5a44;transform:rotate(-2deg);clip-path:polygon(3% 0,97% 5%,100% 50%,96% 100%,2% 95%,0 50%)}.place-sticker.food{background:#f2c4b3;color:#7a3a17}.place-sticker.transport{background:#c9d6f2;color:#2c4a7a}.place-sticker.booking{background:#e5c9ef;color:#5d3a77}
.table-tips{background:#fffaf0;border-left:3px solid #e2c792;color:#5b4a36}
.transit-details{background:#f5eedd;border:1px dashed var(--card-dash)}
.table-map-link,.btn-route{border-radius:999px;background:radial-gradient(circle at 35% 30%,#d9534a,#9b1d16 70%);color:#fbe3d3;box-shadow:inset 0 -3px 6px #0000004d,0 4px 10px #3c0a0540}
.sheet-numbers{color:var(--card-muted);border-top:1px dashed var(--card-dash);font-family:var(--kai)}.cover-sheet .sheet-numbers{color:#f6e7cf;border-top-color:#f6e7cf55}
.reader-footer{color:#fbf1df}.reader-hint{color:#f3e6d0}
.reader-controls button{border:0;background:radial-gradient(circle at 35% 30%,#d9534a,#9b1d16 70%);color:#fbe3d3;box-shadow:inset 0 -3px 6px #0000004d,0 6px 12px #3c0a0559}
.reader-controls output{color:#fff7ea;font-family:var(--kai);font-size:16px}
/* Content layout: details follow the overview without a forced blank column, stops read as a timeline. */
body{counter-reset:day}.book-page:not(.cover){counter-increment:day}
.bound .manual-details{break-before:auto;margin-top:30px}
.bound .manual-overview .chapter-budget{margin-top:16px;padding:12px 14px;border:1px dashed var(--card-dash);background:#fffaf0}
.manual-overview .chapter-intro{font-size:16px;line-height:1.95}
.manual-overview .chapter-intro::first-letter{float:left;margin:6px 8px 0 0;font-family:var(--kai);font-size:2.2em;line-height:1;color:#a8261d}
.bound .chapter-facts{display:flex;flex-wrap:wrap;gap:6px 8px;margin:4px 0 10px}.bound .chapter-facts>span,.bound .day-cost-badge,.bound .weather-badge{padding:1px 10px;border:1px dashed var(--card-dash);border-radius:999px;color:var(--card-muted);margin:0 6px 6px 0}.bound .chapter-facts>span .day-cost-badge,.bound .chapter-facts>span .weather-badge{border:0;padding:0;margin:0}
.schedule{border-top:0;margin:4px 0 18px}.schedule-head{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.schedule-row{grid-template-columns:56px minmax(0,1fr) auto;align-items:baseline;gap:10px;padding:7px 2px;border-bottom:0}
.schedule-time{font-family:var(--kai);color:var(--card-blue);font-size:15px}.schedule-name{display:flex;align-items:baseline;gap:8px;color:var(--card-ink);font-size:15px}.schedule-name::after{content:'';flex:1 1 12px;min-width:12px;border-bottom:1.5px dotted var(--card-dash)}
.schedule-kind{padding:0 8px;white-space:nowrap;font-size:12px;color:#2f5a44;background:#bfe0d0b3}.schedule-food .schedule-kind{color:#7a3a17;background:#f2c4b3b3}.schedule-transport .schedule-kind{color:var(--card-blue);background:#c9d6f2b3}
.stop-entry,.bound .stop-entry{position:relative;margin:0 0 26px;padding:4px 0 0 30px;border-top:0}
.stop-entry::before{content:'';position:absolute;left:8px;top:28px;bottom:-22px;border-left:2px dashed var(--card-dash)}.stop-list>.stop-entry:last-child::before{bottom:0}
.stop-entry::after{content:'';position:absolute;left:1px;top:9px;width:16px;height:16px;border-radius:50%;background:var(--card);box-shadow:0 0 0 4px #3d6b4f inset}.stop-entry.stop-food::after{box-shadow:0 0 0 4px #a0522d inset}.stop-entry.stop-transport::after{box-shadow:0 0 0 4px var(--card-blue) inset}
.bound .stop-topline{margin-bottom:2px}.bound .time-cell{font-size:20px;letter-spacing:.02em}.bound .end-time{color:var(--card-muted);font-size:14px}
.bound .title-cell{margin-bottom:12px}.bound .stop-name{font-size:23px;line-height:1.45}
.bound .stop-meta{gap:6px}.bound .stop-meta>span{padding:0 8px;border:1px dashed var(--card-dash);border-radius:999px}
.bound .stop-description{font-size:16.5px;line-height:1.95;color:var(--card-ink)}
.bound .table-cost,.bound .table-address{font-size:14.5px;margin:6px 0}
.bound .stop-note{break-inside:avoid;margin-top:26px}
.bound .action-cell{padding-top:4px}
@media (orientation:landscape) and (max-height:500px){
.bound .reader-nav{position:fixed;top:0;left:0;right:0;z-index:30;transition:opacity .3s ease,transform .3s ease}
.bound .reader-footer{position:fixed;left:0;right:0;bottom:0;z-index:30;min-height:46px;background:#3b2a1ce6;transition:opacity .3s ease,transform .3s ease}
.bound main{grid-row:1 / -1;margin:8px auto}
body[data-chrome='hidden'] .reader-nav{opacity:0;transform:translateY(-6px);pointer-events:none}
body[data-chrome='hidden'] .reader-footer{opacity:0;transform:translateY(6px);pointer-events:none}
}
.sheet-fade{animation:sheet-fade .28s ease-out}
@keyframes sheet-fade{from{opacity:.25}to{opacity:1}}
.arriving .day-number{animation:stamp-drop .55s cubic-bezier(.2,1.5,.4,1) .35s backwards}
.arriving .day-date{animation:postmark .45s ease-out .75s backwards}
.arriving .stop-entry::after{animation:dot-in .35s ease-out backwards}
.arriving .stop-entry:nth-child(1)::after{animation-delay:.9s}.arriving .stop-entry:nth-child(2)::after{animation-delay:1s}.arriving .stop-entry:nth-child(3)::after{animation-delay:1.1s}.arriving .stop-entry:nth-child(4)::after{animation-delay:1.2s}.arriving .stop-entry:nth-child(n+5)::after{animation-delay:1.3s}
@keyframes stamp-drop{from{opacity:0;transform:translateY(-12px) rotate(-12deg) scale(1.15)}to{opacity:1;transform:rotate(-3deg)}}
@keyframes postmark{0%{opacity:0;transform:rotate(-4deg) scale(1.25)}60%{opacity:1}100%{opacity:1;transform:rotate(-4deg)}}
@keyframes dot-in{from{opacity:0;transform:scale(.3)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.arriving .day-number,.arriving .day-date,.arriving .stop-entry::after{animation:none}.reader-nav,.reader-footer{transition:none}}
.manual-details::after{content:'— 第 ' counter(day) ' 天 · 完 —';display:block;margin:26px 0 6px;text-align:center;font-family:var(--kai);font-size:14px;letter-spacing:.3em;color:var(--card-muted);break-before:avoid}
}
`;

    // This function is embedded verbatim. It deliberately has no app dependencies.
    function reader() {
        const chapters = [...document.querySelectorAll('.book-page')];
        const picker = document.getElementById('pagePicker');
        const previous = document.getElementById('previous');
        const next = document.getElementById('next');
        const counter = document.getElementById('pageNumber');
        const book = document.querySelector('main');
        const sheets = chapters.map(chapter => {
            const sheet = document.createElement('section');
            sheet.className = 'sheet-window' + (chapter.classList.contains('cover') ? ' cover-sheet' : '');
            sheet.tabIndex = -1;
            chapter.before(sheet); sheet.append(chapter);
            const numbers = document.createElement('div');
            numbers.className = 'sheet-numbers'; numbers.setAttribute('aria-hidden', 'true');
            sheet.append(numbers);
            return sheet;
        });
        let pages = [], columns = 1, stride = 0, totalLeaves = 0;
        let current = 0;
        let activeTurn = null;
        const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
        const TURN_MS = 720;
        const canAnimate = () => !reducedMotion.matches && typeof book.animate === 'function';
        const seen = new Set();
        // First visit to a day: the stamp drops in and the postmark lands (CSS, skipped for reduced motion).
        function arrive() {
            const page = pages[current], sheet = sheets[page.chapter];
            if (page.offset !== 0 || seen.has(page.chapter) || sheet.classList.contains('cover-sheet')) return;
            seen.add(page.chapter);
            sheet.classList.remove('arriving'); void sheet.offsetWidth; sheet.classList.add('arriving');
            setTimeout(() => sheet.classList.remove('arriving'), 2200);
        }
        // Reduced motion replaces the leaf with a short fade.
        function fade(sheet) {
            sheet.classList.remove('sheet-fade'); void sheet.offsetWidth; sheet.classList.add('sheet-fade');
        }
        function finishTurn() {
            if (!activeTurn) return;
            const turn = activeTurn;
            activeTurn = null;
            turn.animations.forEach(animation => animation.cancel());
            turn.layer.remove();
            delete document.body.dataset.turning;
        }
        function snapshot(sheet) {
            const copy = sheet.cloneNode(true);
            copy.hidden = false;
            copy.style.width = `${book.clientWidth}px`;
            // Clones are visual surfaces only, never duplicate interactive reader content.
            copy.removeAttribute('tabindex');
            copy.querySelectorAll('[id],[tabindex]').forEach(node => { node.removeAttribute('id'); node.removeAttribute('tabindex'); });
            return copy;
        }
        function turnPage(oldSheet, newSheet, forward, manual = false) {
            const layer = document.createElement('div');
            layer.className = 'page-turn ' + (forward ? 'forward' : 'backward');
            layer.setAttribute('aria-hidden', 'true'); layer.inert = true;
            const rest = document.createElement('div'); rest.className = 'turn-rest';
            rest.append(oldSheet.cloneNode(true)); layer.append(rest);
            const leaf = document.createElement('div'); leaf.className = 'turn-leaf';
            const front = document.createElement('div'); front.className = 'turn-face turn-front';
            const back = document.createElement('div'); back.className = 'turn-face turn-back';
            const half = columns === 2 ? book.clientWidth / 2 : 0;
            oldSheet.style.left = forward ? `${-half}px` : '0px';
            const newCopy = snapshot(newSheet);
            newCopy.style.left = forward ? '0px' : `${-half}px`;
            front.append(oldSheet); back.append(newCopy); leaf.append(front, back); layer.append(leaf);
            const shadows = [front, back].map(face => {
                const shadow = document.createElement('div'); shadow.className = 'turn-shadow'; face.append(shadow); return shadow;
            });
            book.append(layer);
            // A finger-driven turn is linear so the leaf stays under the finger; buttons keep the eased turn.
            const options = {duration:TURN_MS, easing:manual ? 'linear' : 'cubic-bezier(.3,.08,.2,1)', fill:'forwards'};
            const flip = leaf.animate([{transform:'rotateY(0deg)'},{transform:`rotateY(${forward ? -180 : 180}deg)`}], options);
            const shading = shadows.map(shadow => shadow.animate([{opacity:0},{opacity:1,offset:.5},{opacity:0}], options));
            const turn = {layer, animations:[flip, ...shading], done:null}; activeTurn = turn;
            if (manual) turn.animations.forEach(animation => animation.pause());
            document.body.dataset.turning = forward ? 'forward' : 'backward';
            flip.finished.then(() => { if (activeTurn === turn) { finishTurn(); turn.done?.(); } }).catch(() => {});
            return turn;
        }
        function select(index, moveFocus = true) {
            if (!Number.isInteger(index) || index < 0 || index >= pages.length) return;
            finishTurn();
            const forward = index > current;
            const moved = moveFocus && index !== current;
            const oldSheet = moved && canAnimate() ? snapshot(sheets[pages[current].chapter]) : null;
            current = index;
            const page = pages[index], sheet = sheets[page.chapter];
            sheets.forEach((item, i) => { item.hidden = i !== page.chapter; });
            chapters[page.chapter].style.setProperty('--leaf-offset', `${-page.offset * stride}px`);
            picker.value = String(page.chapter);
            previous.disabled = index === 0;
            next.disabled = index === pages.length - 1;
            const first = page.number, last = Math.min(first + columns - 1, page.end);
            counter.textContent = `${first === last ? first : `${first}–${last}`} / ${totalLeaves} 頁`;
            sheet.querySelector('.sheet-numbers').replaceChildren(...[first, ...(last > first ? [last] : [])].map(number => {
                const span = document.createElement('span'); span.textContent = String(number); return span;
            }));
            sheet.setAttribute('aria-label', `${picker.selectedOptions[0].textContent}，${counter.textContent}`);
            // Offscreen column links must not pull the book sideways when tabbed to.
            const bounds = sheet.getBoundingClientRect();
            sheet.querySelectorAll('a').forEach(link => {
                const rect = link.getBoundingClientRect();
                link.tabIndex = rect.left >= bounds.left && rect.right <= bounds.right ? 0 : -1;
            });
            document.body.dataset.readerPage = String(index);
            if (moveFocus) sheet.focus({ preventScroll: true });
            if (oldSheet) turnPage(oldSheet, sheet, forward);
            else if (moved && reducedMotion.matches) fade(sheet);
            if (moved) arrive();
        }
        function layout() {
            finishTurn();
            if (matchMedia('print').matches) return;
            const old = pages[current];
            const oldCount = old ? Number(chapters[old.chapter].dataset.leaves) : 1;
            const fraction = old ? old.offset / oldCount : 0;
            // Landscape phones open the book as a spread, like a desktop.
            columns = innerWidth >= 900 || (innerWidth >= 640 && innerWidth > innerHeight * 1.25) ? 2 : 1;
            document.body.dataset.spread = String(columns);
            pages = []; totalLeaves = 0;
            sheets.forEach((sheet, chapter) => {
                sheet.hidden = false;
                const flow = chapters[chapter], style = getComputedStyle(sheet);
                const gap = parseFloat(getComputedStyle(flow).columnGap);
                const width = (sheet.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - gap * (columns - 1)) / columns;
                const height = sheet.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
                stride = width + gap;
                flow.style.setProperty('--leaf-width', `${width}px`);
                flow.style.setProperty('--leaf-height', `${height}px`);
                flow.style.setProperty('--leaf-offset', '0px');
                // scrollWidth includes every overflow column, not just the visible spread.
                const count = Math.max(1, Math.round((flow.scrollWidth + gap) / stride));
                flow.dataset.leaves = String(count);
                const end = totalLeaves + count;
                for (let offset = 0; offset < count; offset += columns) pages.push({chapter, offset, number: totalLeaves + offset + 1, end});
                totalLeaves = end;
            });
            const target = old ? pages.findIndex(page => page.chapter === old.chapter && page.offset + columns > fraction * Number(chapters[old.chapter].dataset.leaves)) : 0;
            select(Math.max(0, target), false);
            document.body.dataset.readerReady = 'true';
        }
        previous.addEventListener('click', () => select(current - 1));
        next.addEventListener('click', () => select(current + 1));
        const selectChapter = chapter => select(pages.findIndex(page => page.chapter === chapter));
        picker.addEventListener('change', () => selectChapter(Number(picker.value)));
        document.querySelectorAll('.toc a').forEach(link => link.addEventListener('click', event => {
            event.preventDefault(); selectChapter(Number(link.dataset.page));
        }));
        document.addEventListener('keydown', event => {
            if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.target.closest('select,input,textarea,[contenteditable]')) return;
            if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
                event.preventDefault(); select(current + (event.key === 'ArrowRight' ? 1 : -1));
            } else if (event.key === 'Home' || event.key === 'End') {
                event.preventDefault(); select(event.key === 'Home' ? 0 : pages.length - 1);
            }
        });
        // Landscape phones: the toolbars float over the book and fade away while reading.
        const nav = document.querySelector('.reader-nav'), footer = document.querySelector('.reader-footer');
        const compact = matchMedia('(orientation: landscape) and (max-height: 500px)');
        let touched = false, chromeTimer = 0;
        function showChrome(stay = false) {
            delete document.body.dataset.chrome;
            clearTimeout(chromeTimer);
            if (!stay && touched && compact.matches) chromeTimer = setTimeout(hideChrome, 2800);
        }
        function hideChrome() {
            if (!compact.matches || nav.contains(document.activeElement) || footer.contains(document.activeElement)) return;
            document.body.dataset.chrome = 'hidden';
        }
        [nav, footer].forEach(bar => {
            bar.addEventListener('focusin', () => showChrome(true));
            bar.addEventListener('focusout', () => showChrome());
            bar.addEventListener('pointerdown', () => showChrome());
        });
        compact.addEventListener('change', () => showChrome());

        let touch = null, suppressClickUntil = 0;
        // Drag the leaf with the finger; on release it completes or falls back depending on distance and speed.
        function startDrag(forward) {
            const target = current + (forward ? 1 : -1);
            if (!canAnimate() || target < 0 || target >= pages.length) return 'edge';
            const from = current, oldSnap = snapshot(sheets[pages[current].chapter]);
            select(target, false);
            const turn = turnPage(oldSnap, sheets[pages[target].chapter], forward, true);
            return { turn, from, forward, width: columns === 2 ? book.clientWidth / 2 : book.clientWidth };
        }
        function dragProgress(drag, dx) {
            return Math.max(0, Math.min(1, (drag.forward ? -dx : dx) / (drag.width * .9)));
        }
        function releaseDrag(drag, progress, speed) {
            if (drag.turn !== activeTurn) return;
            const complete = progress > .35 || (speed > .45 && progress > .06);
            drag.turn.done = complete
                ? () => { sheets[pages[current].chapter].focus({ preventScroll: true }); arrive(); }
                : () => select(drag.from, false);
            drag.turn.animations.forEach(animation => { animation.playbackRate = complete ? 1.8 : -1.8; animation.play(); });
        }
        book.addEventListener('touchstart', event => {
            touched = true;
            touch = event.touches.length === 1 && !event.target.closest('button,summary,select,input,textarea')
                ? { x: event.touches[0].clientX, y: event.touches[0].clientY, horizontal: false, drag: null, last: [] } : null;
        }, { passive: true });
        book.addEventListener('touchmove', event => {
            if (!touch) return;
            if (event.touches.length !== 1) { if (touch.drag?.turn) releaseDrag(touch.drag, 0, 0); touch = null; return; }
            const dx = event.touches[0].clientX - touch.x, dy = event.touches[0].clientY - touch.y;
            if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.5 && !String(window.getSelection())) touch.horizontal = true;
            // Safari must know this is a book gesture before it starts native panning.
            // Leave vertical motion and two-finger zoom to the browser.
            if (touch.horizontal && event.cancelable) event.preventDefault();
            if (!touch.horizontal) return;
            if (!touch.drag) touch.drag = startDrag(dx < 0);
            touch.last.push({ dx, t: event.timeStamp });
            if (touch.last.length > 5) touch.last.shift();
            if (touch.drag.turn && touch.drag.turn === activeTurn) {
                const time = dragProgress(touch.drag, dx) * TURN_MS;
                touch.drag.turn.animations.forEach(animation => { animation.currentTime = time; });
            }
        }, { passive: false });
        book.addEventListener('touchcancel', () => {
            if (touch?.drag?.turn) releaseDrag(touch.drag, 0, 0);
            touch = null;
        }, { passive: true });
        book.addEventListener('touchend', event => {
            if (!touch || !event.changedTouches.length) return;
            const dx = event.changedTouches[0].clientX - touch.x;
            const dy = event.changedTouches[0].clientY - touch.y;
            const gesture = touch;
            touch = null;
            if (gesture.drag?.turn) {
                const first = gesture.last[0], last = gesture.last.at(-1);
                const speed = first && last && last.t > first.t ? (gesture.drag.forward ? first.dx - last.dx : last.dx - first.dx) / (last.t - first.t) : 0;
                suppressClickUntil = Date.now() + 500;
                releaseDrag(gesture.drag, dragProgress(gesture.drag, dx), speed);
                return;
            }
            if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5 && !String(window.getSelection())) {
                suppressClickUntil = Date.now() + 500;
                select(current + (dx < 0 ? 1 : -1));
            } else if (Math.abs(dx) < 10 && Math.abs(dy) < 10 && compact.matches && !event.target.closest('a,button,summary,select')) {
                // A plain tap on the page toggles the floating toolbars.
                if (document.body.dataset.chrome === 'hidden') showChrome(); else hideChrome();
            }
        }, { passive: true });
        book.addEventListener('click', event => {
            if (Date.now() < suppressClickUntil) { event.preventDefault(); event.stopPropagation(); }
        }, true);
        document.getElementById('printBook').addEventListener('click', () => window.print());
        document.querySelector('.reader-nav').hidden = false;
        document.querySelector('.reader-controls').hidden = false;
        document.body.classList.add('bound');
        let pending;
        const scheduleLayout = () => { cancelAnimationFrame(pending); pending = requestAnimationFrame(layout); };
        new ResizeObserver(scheduleLayout).observe(book);
        reducedMotion.addEventListener('change', finishTurn);
        showChrome();
        window.addEventListener('beforeprint', finishTurn);
        matchMedia('print').addEventListener('change', scheduleLayout);
        document.fonts.ready.then(scheduleLayout);
        layout();
    }

    function chapter(source, index) {
        const copy = source.cloneNode(true);
        copy.querySelectorAll('button,script,style,link,iframe,object,embed,img,input,textarea,select,form').forEach(node => node.remove());
        // Retain presentation/accessible markup only; never export app handlers or data.
        const attributes = new Set(['class', 'href', 'aria-label', 'aria-hidden', 'viewBox', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'd', 'cx', 'cy', 'r']);
        copy.querySelectorAll('*').forEach(node => {
            [...node.attributes].forEach(attribute => { if (!attributes.has(attribute.name)) node.removeAttribute(attribute.name); });
            if (node.tagName === 'A') {
                const href = node.getAttribute('href') || '';
                const url = new URL(href, location.href);
                if (url.protocol !== 'https:' || url.hostname !== 'www.google.com' || !url.pathname.startsWith('/maps')) node.removeAttribute('href');
                else { node.target = '_blank'; node.rel = 'noopener noreferrer'; }
            }
        });
        const heading = copy.querySelector(':scope > summary');
        const title = heading.querySelector('.day-summary');
        const h2 = document.createElement('h2');
        h2.className = title.className; h2.textContent = title.textContent; title.replaceWith(h2);
        const stops = document.createElement('div');
        stops.className = 'stop-list';
        const schedule = document.createElement('div');
        schedule.className = 'schedule';
        schedule.setAttribute('role', 'table'); schedule.setAttribute('aria-label', '今日行程時間表');
        schedule.innerHTML = '<div class="schedule-row schedule-head" role="row"><span role="columnheader">時間</span><span role="columnheader">行程安排</span><span role="columnheader">類別</span></div>';
        copy.querySelectorAll('.itinerary-table tbody tr').forEach(row => {
            const entry = document.createElement('section');
            const kind = ['food', 'spot', 'transport'].find(name => row.querySelector('.place-sticker.' + name)) || 'spot';
            entry.className = 'stop-entry stop-' + kind;
            const scheduleRow = document.createElement('div');
            scheduleRow.className = 'schedule-row schedule-' + kind; scheduleRow.setAttribute('role', 'row');
            const time = row.querySelector('.time-cell').childNodes[0]?.textContent.trim() || '待確認';
            const name = row.querySelector('.stop-name').textContent;
            const type = row.querySelector('.place-sticker > span').textContent;
            for (const [text, className] of [[time, 'schedule-time'], [name, 'schedule-name'], [type, 'schedule-kind']]) {
                const cell = document.createElement('span'); cell.className = className;
                cell.setAttribute('role', 'cell'); cell.textContent = text; scheduleRow.append(cell);
            }
            schedule.append(scheduleRow);
            const top = document.createElement('div'); top.className = 'stop-topline';
            for (const name of ['time-cell', 'type-cell', 'title-cell', 'desc-cell', 'action-cell']) {
                const original = row.querySelector('.' + name);
                const block = document.createElement('div');
                block.className = name; block.innerHTML = original.innerHTML;
                (name === 'time-cell' || name === 'type-cell' ? top : entry).append(block);
            }
            entry.prepend(top); stops.append(entry);
        });
        copy.querySelector('.itinerary-table').replaceWith(stops);
        // Expanding a route would change column counts; print all route text into the book.
        copy.querySelectorAll('.transit-details').forEach(details => {
            const route = document.createElement('div'); route.className = details.className;
            details.querySelector('summary')?.remove();
            route.innerHTML = details.innerHTML; details.replaceWith(route);
        });
        const intro = copy.querySelector('.chapter-intro').outerHTML;
        const budget = copy.querySelector('.chapter-budget').outerHTML;
        const actions = copy.querySelector('.day-actions').outerHTML;
        return `<article class="book-page" id="page-${index + 1}" tabindex="-1" aria-label="第 ${index + 1} 天">
<section class="manual-overview"><p class="manual-kicker">行程篇 / DAY ${String(index + 1).padStart(2, '0')}</p>
<header class="chapter-heading">${heading.innerHTML}</header>
<figure class="chapter-scenery" role="img" aria-label="旅行意象插畫，非景點實拍"><figcaption>旅行意象插畫 · 非景點實拍</figcaption></figure>
<h3 class="manual-heading">今日行程</h3>${schedule.outerHTML}${intro}${budget}</section>
<section class="manual-details"><p class="manual-kicker">行程詳解 / 旅途備忘</p><h3 class="manual-heading">各站安排與重點提醒</h3>${stops.outerHTML}${actions}</section></article>`;
    }

    function coverArt() {
        return new Promise(resolve => {
            const picture = new Image();
            const timer = setTimeout(() => { picture.onload = picture.onerror = null; resolve(''); }, 5000);
            picture.onload = () => {
                clearTimeout(timer);
                try {
                    const canvas = document.createElement('canvas');
                    canvas.width = Math.min(picture.naturalWidth, 1440);
                    canvas.height = Math.round(picture.naturalHeight * canvas.width / picture.naturalWidth);
                    canvas.getContext('2d').drawImage(picture, 0, 0, canvas.width, canvas.height);
                    resolve(canvas.toDataURL('image/jpeg', .78));
                } catch { resolve(''); }
            };
            picture.onerror = () => { clearTimeout(timer); resolve(''); };
            picture.src = document.body.dataset.scene === 'town' ? 'assets/roam-town.png' : 'assets/roam-coast.png';
        });
    }

    async function snapshot() {
        window.TripMotion?.settle();
        const days = [...document.querySelectorAll('#tripContainer > details')];
        if (days.length !== tripData.length) throw new Error('行程畫面尚未準備好，請稍後重試。');
        const city = String(generationState?.city || document.getElementById('city').value || '漫遊');
        const title = `${city}・旅行手冊`;
        const chapters = days.map(chapter).join('\n');
        const labels = tripData.map((day, i) => `第 ${i + 1} 天 · ${day.date} · ${day.day_title}`);
        const toc = labels.map((text, i) => `<li><a href="#page-${i + 1}" data-page="${i + 1}"><small>DAY ${String(i + 1).padStart(2, '0')} · ${escapeHtml(tripData[i].date)}</small>${escapeHtml(tripData[i].day_title)}</a></li>`).join('');
        const options = ['封面與目錄', ...labels].map((text, i) => `<option value="${i}">${escapeHtml(text)}</option>`).join('');
        const dates = `${tripData[0].date} — ${tripData[tripData.length - 1].date}`;
        const art = await coverArt();
        const html = `<!doctype html>
<html lang="zh-Hant" data-roam-book="1"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>${escapeHtml(title)}</title><style>${css}${boundCss}${postcardCss}${art ? `:root{--cover-art:url('${art}')}` : ''}</style></head><body class="${art ? '' : 'without-art'}">
<nav class="reader-nav" aria-label="小冊目錄" hidden><div class="reader-brand"><svg viewBox="0 0 40 28" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M2 24 13 8l6 8L27 3l11 21H2Z"/><path d="m10 12 3 3 3-3m8-4 3 4 3-4"/></svg><span>${escapeHtml(title)}</span></div><label for="pagePicker">目錄</label><select id="pagePicker" aria-label="選擇章節">${options}</select><button id="printBook" class="print">列印 / PDF</button></nav>
<noscript><aside class="preview-notice" style="margin:16px;padding:16px;background:#fff3d6;color:#533d13;border:1px solid #cfb46e;border-radius:6px"><strong>目前為靜態預覽，無法翻頁。</strong><br>此開啟方式未執行互動程式，仍可閱讀下方完整行程。若從 iPhone「檔案」開啟，請向提供者索取小冊的網頁網址，再用 Safari 開啟以使用翻書功能。</aside></noscript>
<main><section class="book-page cover" id="page-0" tabindex="-1" aria-label="封面與目錄"><div class="eyebrow">GREETINGS FROM · ROAM TRAVEL BOOK</div><h1>${escapeHtml(title)}</h1><p class="dates">${escapeHtml(dates)} · ${days.length} 天</p><p class="cover-intro">把沿途的風景、美食與小提醒，收進同一本旅行小冊。</p><h2>旅程目錄</h2><ol class="toc">${toc}</ol><div class="cover-foot">使用左右箭頭翻頁，手機可左右滑動。內容會自動接續到下一頁。<br>這是行程與便利貼的閱讀副本，需使用支援互動程式的瀏覽器；地圖需連網。修改後請重新下載。<br>iPhone「檔案」預覽若無法翻頁，請改用 Safari 開啟小冊的網頁網址。<br>製作於 ${escapeHtml(new Date().toLocaleString('zh-TW'))} · 封面為旅行意象插畫</div></section>${chapters}</main>
<footer class="reader-footer"><div class="reader-controls" aria-label="書本翻頁" hidden><button id="previous" aria-label="上一頁">‹</button><output id="pageNumber" aria-live="polite"></output><button id="next" aria-label="下一頁">›</button></div><span class="reader-hint">左右翻頁 · 可離線分享</span></footer>
<script>(${reader.toString()})();<\/script></body></html>`;
        const filename = `${city.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 60)}_${tripData[0].date}_旅行小冊.html`;
        return { html, title, filename };
    }

    async function download() {
        if (isBusy || !tripData.length) return;
        const button = document.getElementById('downloadBook');
        const status = document.getElementById('bookExportStatus');
        const label = button.textContent;
        setBusy(true);
        button.textContent = '正在裝訂小冊…';
        status.hidden = false;
        status.textContent = '正在整理行程與便利貼、壓縮封面圖片…';
        try {
            const { html, filename } = await snapshot();
            downloadBlob(new Blob([html], { type: 'text/html;charset=utf-8' }), filename);
            status.textContent = '小冊已下載，包含目前行程與便利貼。HTML 檔需以支援互動程式的瀏覽器開啟；iPhone「檔案」預覽若不能翻頁，需另將小冊放上網站，再以 Safari 開啟網址。';
        } catch (error) {
            status.textContent = `小冊下載失敗：${error.message} 原行程已保留，請重試。`;
        } finally {
            button.textContent = label;
            setBusy(false);
        }
    }
    const cloudSharing = window.ROAM_CLOUD === true && location.protocol === 'https:';
    let sharing = false;
    let shareToken = '';
    const shareStatus = message => { document.getElementById('bookShareStatus').textContent = message; };
    async function shareRequest(url, options = {}) {
        const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(30000), ...options });
        let body;
        try { body = await response.json(); } catch { throw new Error('分享服務尚未就緒，請確認雲端網站已更新。'); }
        if (!response.ok) throw new Error(body.error || '分享操作失敗，請稍後再試。');
        return body;
    }
    function showShares(items) {
        const list = document.getElementById('bookShareList');
        list.replaceChildren();
        for (const item of items) {
            if (!/^[a-f0-9]{48}$/.test(item.id)) continue;
            const url = `${location.origin}/s/${item.id}`;
            const row = document.createElement('li');
            const title = document.createElement('span');
            title.className = 'share-heading'; title.textContent = item.title;
            const date = document.createElement('span');
            date.className = 'share-date'; date.textContent = `建立於 ${new Date(item.createdAt).toLocaleString('zh-TW')}`;
            const input = document.createElement('input');
            input.className = 'share-url'; input.readOnly = true; input.value = url;
            input.setAttribute('aria-label', `${item.title} 分享網址`);
            const actions = document.createElement('div'); actions.className = 'share-actions';
            const copy = document.createElement('button'); copy.type = 'button'; copy.textContent = '複製網址';
            copy.addEventListener('click', async () => {
                try { await navigator.clipboard.writeText(url); shareStatus('網址已複製，可以傳給旅伴用 Safari 或 Chrome 開啟。'); }
                catch { input.focus(); input.select(); shareStatus('請長按或複製上方已選取的網址。'); }
            });
            const open = document.createElement('a'); open.href = url; open.target = '_blank'; open.rel = 'noopener noreferrer'; open.textContent = '開啟小冊';
            const revoke = document.createElement('button'); revoke.type = 'button'; revoke.className = 'share-revoke'; revoke.textContent = '取消分享';
            revoke.addEventListener('click', () => revokeShare(item.id));
            actions.append(copy, open, revoke); row.append(title, date, input, actions); list.append(row);
        }
    }
    async function loadShares() {
        const data = await shareRequest('/api/shares');
        shareToken = data.token;
        showShares(data.shares);
        return data.shares;
    }
    function canShare() {
        document.getElementById('bookShares').open = true;
        if (cloudSharing) return true;
        shareStatus('請在私人雲端版建立或取消分享。本機版與 GitHub Pages 無法儲存分享小冊；可先匯出行程 JSON，再到雲端版匯入。');
        return false;
    }
    async function refreshShares() {
        if (isBusy || sharing || !canShare()) return;
        sharing = true;
        shareStatus('正在讀取分享清單…');
        try { const items = await loadShares(); shareStatus(items.length ? `目前有 ${items.length} 份分享。取消後，原網址將無法再開啟；已下載的副本無法收回。` : '目前沒有分享的小冊。'); }
        catch (error) { shareStatus(error.message); }
        finally { sharing = false; }
    }
    async function share() {
        if (isBusy || sharing || !canShare()) return;
        if (!tripData.length) { shareStatus('請先產生或匯入行程。'); return; }
        sharing = true; setBusy(true);
        const button = document.getElementById('createBookShare');
        button.textContent = '正在建立分享…';
        shareStatus('正在整理行程與便利貼，完成後會顯示分享網址…');
        let submitted = false;
        try {
            await loadShares();
            const { html, title } = await snapshot();
            submitted = true;
            const created = await shareRequest('/api/shares', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Roam-Token': shareToken }, body: JSON.stringify({ html, title: title.slice(0, 200) }) });
            // Keep a successful result visible even if refreshing the complete list fails.
            showShares([created]);
            try { await loadShares(); } catch { /* The created URL above remains usable. */ }
            shareStatus('分享網址已建立。複製網址傳給旅伴，用 Safari 或 Chrome 開啟即可翻閱；不需要登入。');
        } catch (error) {
            shareStatus(`${error.message}${submitted ? ' 若連線中斷，請先重新整理分享清單，確認是否已建立，再決定是否重試。' : ''} 原行程已保留。`);
        } finally {
            button.textContent = '🔗 建立分享網址'; setBusy(false); sharing = false;
        }
    }
    async function revokeShare(id) {
        if (isBusy || sharing || !canShare()) return;
        sharing = true; setBusy(true); shareStatus('正在取消分享…');
        try {
            // Refresh the CSRF token after a service restart, without relying on generation access.
            await loadShares();
            await shareRequest(`/api/shares/${id}`, { method: 'DELETE', headers: { 'X-Roam-Token': shareToken } });
            try { await loadShares(); }
            catch { document.getElementById('bookShareList').replaceChildren(); }
            shareStatus('已取消分享，原網址無法再開啟。你的行程與便利貼仍保留。已開啟或下載的內容無法收回。');
        } catch (error) { shareStatus(`${error.message} 請重新整理清單確認分享狀態。`); }
        finally { setBusy(false); sharing = false; }
    }
    document.getElementById('bookShares').addEventListener('toggle', () => {
        if (document.getElementById('bookShares').open && !sharing) refreshShares();
    });
    if (!cloudSharing) document.getElementById('bookShareHelp').textContent = '建立分享網址需使用私人雲端版。本機版與 GitHub Pages 可下載小冊，或匯出 JSON 後到雲端版匯入。';
    window.TripBookExport = { download, share, refreshShares };
})();
