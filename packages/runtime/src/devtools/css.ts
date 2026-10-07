// Devtools stylesheet. Lives only inside the overlay's shadow root: nothing here can reach the host page.

const LIGHT = `--bg:#fff;--bg2:#f8f8fa;--bg3:#f0f0f3;--hover:#f6f6f8;--line:#e7e7ec;--line2:#d8d8df;--fg:#15161b;--fg2:#4d505c;--fg3:#868a97;
--brand:#5145e6;--brand2:#7a5cf5;--brand-bg:#f1f0ff;--brand-line:#dddaff;--warn:#b45d09;--warn-bg:#fff6e5;--warn-line:#f8dfb3;
--note:#f5f5f8;--ok:#15803d;--ok-bg:#eaf8ef;--bad:#d12f22;--bad-bg:#fff0ee;--blue:#2563eb;--blue-bg:#eef4ff;--seg:#fff;
--sh:0 0 0 1px rgba(17,19,27,.03),0 2px 6px -2px rgba(17,19,27,.06),0 14px 34px -8px rgba(17,19,27,.16),0 36px 80px -24px rgba(17,19,27,.22);
--sh-sm:0 1px 2px rgba(17,19,27,.06),0 6px 20px -6px rgba(17,19,27,.2);color-scheme:light;`;

const DARK = `--bg:#111215;--bg2:#16171b;--bg3:#202127;--hover:#1a1b20;--line:#26272e;--line2:#34353e;--fg:#ececf1;--fg2:#a3a6b3;--fg3:#6d707e;
--brand:#958dff;--brand2:#b19bff;--brand-bg:rgba(149,141,255,.13);--brand-line:rgba(149,141,255,.3);--warn:#f4b552;--warn-bg:rgba(244,181,82,.11);--warn-line:rgba(244,181,82,.26);
--note:#1a1b20;--ok:#51d28e;--ok-bg:rgba(81,210,142,.11);--bad:#ff6f64;--bad-bg:rgba(255,111,100,.11);--blue:#6ea4ff;--blue-bg:rgba(110,164,255,.12);--seg:#2c2d35;
--sh:0 0 0 1px rgba(255,255,255,.05),0 18px 44px -10px rgba(0,0,0,.6),0 44px 100px -28px rgba(0,0,0,.7);
--sh-sm:0 0 0 1px rgba(255,255,255,.05),0 8px 24px -8px rgba(0,0,0,.6);color-scheme:dark;`;

export const CSS = `
*,*::before,*::after{box-sizing:border-box}
.root{${LIGHT}
--font:Inter,"Inter Variable",ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
--mono:"JetBrains Mono","JetBrains Mono Variable",ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;
position:relative;display:flex;font:400 13px/1.45 var(--font);color:var(--fg);-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;
text-align:left;letter-spacing:0;font-feature-settings:"cv11","ss01"}
.root[data-theme=dark]{${DARK}}
@media (prefers-color-scheme:dark){.root[data-theme=auto]{${DARK}}}
.root[data-pos^=top]{align-items:flex-start}
.root[data-pos$=left]{justify-content:flex-start}
.root[data-pos$=right]{justify-content:flex-end}
button{font:inherit;color:inherit;background:none;border:0;padding:0;margin:0;cursor:pointer;text-align:inherit;-webkit-tap-highlight-color:transparent}
button:focus-visible,input:focus-visible,[tabindex]:focus-visible{outline:2px solid var(--brand);outline-offset:1px}
input{font:inherit;color:inherit}
svg{display:block;flex:none}
.i{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
[hidden]{display:none!important}
code,.mono{font-family:var(--mono)}

/* pill */
.pill{position:relative;display:flex;align-items:center;gap:9px;height:38px;padding:0 13px 0 7px;border-radius:999px;background:var(--bg);
border:1px solid var(--line);box-shadow:var(--sh-sm);font-size:12.5px;font-weight:500;color:var(--fg);transition:transform .18s cubic-bezier(.2,.8,.2,1),box-shadow .18s}
.pill:hover{transform:translateY(-1px);box-shadow:var(--sh)}
.pill:focus-visible{outline-offset:3px;border-radius:999px}
.mark{width:24px;height:24px;border-radius:7px}
.pn{font-weight:600;letter-spacing:-.01em}
.pm{margin-left:-3px;font-size:11.5px;color:var(--fg3)}
.vs{width:1px;height:16px;background:var(--line2)}
.pc{display:inline-flex;align-items:center;gap:4px;color:var(--fg3);font-variant-numeric:tabular-nums}
.pc .i{width:14px;height:14px}
.pc b{font-weight:600}
.pc.on.a{color:var(--brand)}
.pc.on.d{color:var(--warn)}
.pd{width:7px;height:7px;border-radius:50%;background:var(--fg3);margin-left:1px}
.s-ready .pd,.s-ready .dot{background:var(--ok);box-shadow:0 0 0 3px var(--ok-bg)}
.s-error .pd,.s-error .dot{background:var(--bad);box-shadow:0 0 0 3px var(--bad-bg)}
.s-loading .pd,.s-loading .dot{background:var(--brand);animation:blink 1.1s ease-in-out infinite}
.pb{position:absolute;left:16px;right:16px;bottom:3px;height:2px;border-radius:2px;background:var(--bg3);overflow:hidden}
.pb i,.sb i{display:block;height:100%;width:0;background:linear-gradient(90deg,var(--blue),var(--brand2));transition:width .3s ease}
.pill::after{content:"";position:absolute;inset:-1px;border-radius:inherit;pointer-events:none;opacity:0}
.pill.pa::after{--ring:var(--brand);animation:ring 1.5s cubic-bezier(.2,.7,.3,1)}
.pill.pdd::after{--ring:var(--warn);animation:ring 1.5s cubic-bezier(.2,.7,.3,1)}
.pill.pa .pc.a b,.pill.pdd .pc.d b{animation:bump .5s cubic-bezier(.2,.8,.2,1)}
@keyframes ring{0%{opacity:.7;box-shadow:0 0 0 0 var(--ring)}100%{opacity:0;box-shadow:0 0 0 14px var(--ring)}}
@keyframes bump{40%{transform:scale(1.25)}}
@keyframes blink{50%{opacity:.35}}
@keyframes spin{to{transform:rotate(360deg)}}

/* panel */
.panel{display:flex;flex-direction:column;width:min(444px,calc(100vw - 24px));height:min(660px,calc(100vh - 24px));background:var(--bg);
border:1px solid var(--line);border-radius:14px;box-shadow:var(--sh);overflow:hidden;animation:pop .22s cubic-bezier(.2,.8,.2,1)}
.root[data-pos^=bottom] .panel{transform-origin:bottom right}
.root[data-pos^=top] .panel{transform-origin:top right;animation-name:popd}
@keyframes pop{from{opacity:0;transform:translateY(10px) scale(.985)}}
@keyframes popd{from{opacity:0;transform:translateY(-10px) scale(.985)}}
.hd{display:flex;align-items:center;gap:10px;padding:10px 10px 10px 14px}
.brand{display:flex;align-items:center;gap:8px;flex:1;min-width:0}
.brand .mark{width:22px;height:22px;border-radius:6.5px}
.bn{font-weight:650;font-size:13.5px;letter-spacing:-.015em}
.bt{font-size:11px;font-weight:500;color:var(--fg3);padding:1px 7px;border:1px solid var(--line);border-radius:999px}
.modes{display:flex;gap:2px;padding:2px;border-radius:8px;background:var(--bg3)}
.modes button{display:flex;align-items:center;gap:6px;height:24px;padding:0 9px;border-radius:6px;font-size:12px;font-weight:500;color:var(--fg2);transition:color .15s,background .15s}
.modes button:hover{color:var(--fg)}
.modes button[aria-checked=true]{background:var(--seg);color:var(--fg);box-shadow:0 1px 2px rgba(0,0,0,.08),0 0 0 .5px rgba(0,0,0,.06)}
.modes .md{width:6px;height:6px;border-radius:50%;background:var(--fg3);opacity:0;transition:opacity .15s}
.modes [aria-checked=true] .md{opacity:1}
.m-observe .md{background:var(--blue)}.m-guard .md{background:var(--brand)}.m-heal .md{background:var(--ok)}
.ib{display:grid;place-items:center;width:28px;height:28px;border-radius:7px;color:var(--fg2);transition:background .12s,color .12s}
.ib:hover{background:var(--bg3);color:var(--fg)}
.ib[aria-pressed=true]{color:var(--warn);background:var(--warn-bg)}

.st{position:relative;display:flex;align-items:center;gap:8px;min-height:32px;padding:6px 14px;font-size:12px;color:var(--fg2);
background:var(--bg2);border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
.st b{font-weight:600;color:var(--fg);white-space:nowrap}
.dot{width:7px;height:7px;border-radius:50%;background:var(--fg3);flex:none;margin-right:2px}
.sm{margin-left:auto;color:var(--fg3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums;min-width:0}
.s-error .sm{color:var(--bad)}
.sb{position:absolute;left:0;right:0;bottom:-1px;height:2px}

.tabs{display:flex;align-items:center;gap:2px;padding:4px 8px 0;border-bottom:1px solid var(--line)}
.tabs-in{display:flex;gap:2px}
.tab{position:relative;display:flex;align-items:center;gap:6px;height:36px;padding:0 9px;font-size:12.5px;font-weight:500;color:var(--fg2);transition:color .15s}
.tab:hover{color:var(--fg)}
.tab[aria-selected=true]{color:var(--fg)}
.tab[aria-selected=true]::after{content:"";position:absolute;left:9px;right:9px;bottom:-1px;height:2px;border-radius:2px 2px 0 0;background:var(--fg)}
.n{display:inline-grid;place-items:center;min-width:18px;height:17px;padding:0 5px;border-radius:999px;background:var(--bg3);color:var(--fg3);
font-size:11px;font-weight:600;font-variant-numeric:tabular-nums}
.ta .n.on{background:var(--brand-bg);color:var(--brand)}
.td .n.on{background:var(--warn-bg);color:var(--warn)}
.sp{flex:1}
.pz{display:flex;align-items:center;gap:8px;padding:6px 14px;font-size:12px;font-weight:500;color:var(--warn);background:var(--warn-bg);border-bottom:1px solid var(--warn-line)}
.pz .i{width:14px;height:14px}
.pz button{margin-left:auto;font-weight:600;text-decoration:underline;text-underline-offset:2px}

.body{position:relative;flex:1;min-height:0}
.pane{position:absolute;inset:0;overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:var(--line2) transparent}
.pane::-webkit-scrollbar{width:10px}
.pane::-webkit-scrollbar-thumb{background:var(--line2);border-radius:10px;border:3px solid var(--bg)}
.list{display:flex;flex-direction:column;gap:8px;padding:10px}

/* cards */
.card{display:flex;gap:11px;padding:12px 14px 8px 12px;border:1px solid var(--line);border-radius:11px;background:var(--bg);transition:border-color .15s,box-shadow .15s}
.card:hover{border-color:var(--line2)}
.card.new{animation:enter .45s cubic-bezier(.2,.8,.2,1)}
@keyframes enter{0%{opacity:0;transform:translateY(-6px);border-color:var(--brand-line)}60%{border-color:var(--brand-line)}}
.ci{display:grid;place-items:center;width:28px;height:28px;border-radius:8px;flex:none;color:var(--brand);background:var(--brand-bg)}
.det .ci{color:var(--warn);background:var(--warn-bg)}
.ci .i{width:15px;height:15px}
.cb{flex:1;min-width:0}
.ch{display:flex;align-items:baseline;gap:8px;min-height:20px}
.ct{flex:1;min-width:0;font-weight:600;letter-spacing:-.005em;line-height:1.35;padding-top:3px}
.ago{font-size:11.5px;color:var(--fg3);white-space:nowrap;font-variant-numeric:tabular-nums}
.rep{align-self:center;height:18px;padding:0 6px;border-radius:999px;font-size:11px;font-weight:650;line-height:18px;color:var(--warn);background:var(--warn-bg);font-variant-numeric:tabular-nums}
.cx{margin:3px 0 0;font-size:12.5px;line-height:1.5;color:var(--fg2);overflow-wrap:anywhere}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.chip{display:inline-flex;align-items:center;gap:6px;height:22px;padding:0 8px;border-radius:6px;font-size:11.5px;font-weight:500;
color:var(--fg2);background:var(--bg3);white-space:nowrap}
.chip b{font-weight:600;color:var(--fg)}
.chip .p{font-variant-numeric:tabular-nums;color:var(--fg2)}
.chip .cd{width:6px;height:6px;border-radius:50%;background:var(--fg3)}
.t-brand .cd{background:var(--brand)}.t-warn .cd{background:var(--warn)}.t-bad .cd{background:var(--bad)}.t-ok .cd{background:var(--ok)}
.chip code{font-size:11px;font-weight:500;color:var(--fg)}
.chip .tier{color:var(--fg3)}
.chip .tier::before{content:"·";margin-right:5px}
.note{display:flex;gap:8px;margin-top:8px;padding:7px 10px;border-radius:8px;font-size:12px;line-height:1.45;color:var(--fg2);background:var(--note)}
.note .i{width:14px;height:14px;margin-top:1.5px;color:var(--fg3)}
.note b{font-weight:600;color:var(--fg)}
.note code{font-size:11.5px;color:var(--fg)}
.note.chg{background:var(--brand-bg);color:var(--fg)}
.note.chg .i{color:var(--brand)}
.note.fail{background:var(--bad-bg);color:var(--bad)}
.note.fail .i{color:var(--bad)}
.cf{display:flex;align-items:center;gap:2px;margin:7px 0 0 -7px}
.btn{display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 8px;border-radius:7px;font-size:12px;font-weight:500;color:var(--fg2);transition:background .12s,color .12s}
.btn:hover{background:var(--bg3);color:var(--fg)}
.btn .i{width:14px;height:14px}
.btn.u{color:var(--brand)}
.btn.u:hover{background:var(--brand-bg)}
.btn .chev{width:13px;height:13px;transition:transform .18s}
.btn[aria-expanded=true] .chev{transform:rotate(90deg)}
.done{display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 8px;font-size:12px;font-weight:500;color:var(--ok)}
.done .i{width:14px;height:14px}
.err{font-size:12px;color:var(--bad);padding:0 8px}
.card.undone .ci{color:var(--fg3);background:var(--bg3)}
.card.undone .ct{color:var(--fg2)}

/* evidence */
.evd{display:flex;flex-direction:column;gap:14px;margin:6px 0 4px;padding-top:12px;border-top:1px solid var(--line)}
.sec h4{display:flex;align-items:center;gap:6px;margin:0 0 7px;font-size:10.5px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--fg3)}
.sec h4 .sp{flex:1}
.facts{display:flex;flex-direction:column;gap:5px;margin:0;padding:0;list-style:none}
.facts li{position:relative;padding-left:14px;font-size:12px;line-height:1.5;color:var(--fg2)}
.facts li::before{content:"";position:absolute;left:3px;top:.62em;width:4px;height:4px;border-radius:50%;background:var(--fg3)}
.code{margin:0;padding:8px 10px;border-radius:8px;background:var(--bg2);border:1px solid var(--line);font:11px/1.6 var(--mono);color:var(--fg2);
white-space:pre-wrap;overflow-wrap:anywhere;max-height:220px;overflow:auto;scrollbar-width:thin;scrollbar-color:var(--line2) transparent}
.ans{display:grid;grid-template-columns:minmax(64px,max-content) 1fr 34px;gap:5px 10px;align-items:center}
.ans+.ans{margin-top:10px}
.aq{grid-column:1/-1;font-size:11.5px;font-weight:500;color:var(--fg2)}
.bl{font:11px/1.4 var(--mono);color:var(--fg3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt2{height:6px;border-radius:3px;background:var(--bg3);overflow:hidden}
.bt2 i{display:block;height:100%;border-radius:3px;background:var(--line2)}
.bp{font-size:11px;text-align:right;color:var(--fg3);font-variant-numeric:tabular-nums}
.bl.top,.bp.top{color:var(--fg);font-weight:600}
.bt2.top i{background:linear-gradient(90deg,var(--blue),var(--brand))}
.meta{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:11px;color:var(--fg3)}
.meta code{font-size:10.5px;color:var(--fg2)}
.cp{display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 6px;border-radius:5px;font-size:10.5px;font-weight:600;letter-spacing:.02em;text-transform:none;color:var(--fg3)}
.cp:hover{background:var(--bg3);color:var(--fg)}
.cp .i{width:12px;height:12px}

/* empty states */
.empty{display:flex;flex-direction:column;align-items:center;text-align:center;gap:5px;padding:56px 32px;color:var(--fg3);font-size:12.5px;line-height:1.5}
.empty .ei{display:grid;place-items:center;width:40px;height:40px;margin-bottom:8px;border-radius:12px;background:var(--bg3);color:var(--fg3)}
.empty .ei .i{width:18px;height:18px}
.empty b{font-size:13px;font-weight:600;color:var(--fg)}

/* activity */
.fb{position:sticky;top:0;z-index:1;display:flex;flex-wrap:wrap;align-items:center;gap:4px;padding:7px 10px;background:var(--bg);border-bottom:1px solid var(--line)}
.f{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 7px;border-radius:999px;font-size:11px;font-weight:500;color:var(--fg3);border:1px solid var(--line);transition:all .12s}
.f .cd{width:6px;height:6px;border-radius:50%;background:var(--c,var(--fg3))}
.f.g-user{--c:var(--blue)}.f.g-op{--c:var(--fg2)}.f.g-state{--c:var(--ok)}.f.g-error{--c:var(--bad)}.f.g-gc{--c:var(--brand)}
.f[aria-pressed=true]{color:var(--fg);background:var(--bg3);border-color:var(--bg3)}
.f[aria-pressed=false]{text-decoration:line-through;opacity:.7}
.q{flex:1;min-width:60px;height:22px;padding:0 9px;border-radius:999px;border:1px solid var(--line);background:var(--bg);font-size:11.5px;outline:none;-webkit-appearance:none;appearance:none}
.q:focus{border-color:var(--brand)}
.q::placeholder{color:var(--fg3)}
.evs{padding:4px 0 10px}
.ev{display:grid;grid-template-columns:48px 44px minmax(0,1fr) auto;gap:8px;align-items:baseline;padding:3.5px 12px;font-size:12px;cursor:pointer}
.ev:hover{background:var(--hover)}
.ev .t{font:10.5px/1.5 var(--mono);color:var(--fg3);text-align:right;font-variant-numeric:tabular-nums}
.ev .k{font-size:9.5px;font-weight:650;line-height:17px;letter-spacing:.05em;text-transform:uppercase;text-align:center;border-radius:4px;color:var(--fg2);background:var(--bg3)}
.g-user .k{color:var(--blue);background:var(--blue-bg)}
.g-op .k{color:var(--fg2)}
.g-state .k{color:var(--ok);background:var(--ok-bg)}
.g-error .k{color:var(--bad);background:var(--bad-bg)}
.g-gc .k{color:var(--brand);background:var(--brand-bg)}
.ev .m{color:var(--fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ev .id{margin-left:6px;font:10.5px var(--mono);color:var(--fg3)}
.ev .x{display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--fg3);white-space:nowrap;font-variant-numeric:tabular-nums}
.x .ok{color:var(--ok)}.x .bad{color:var(--bad)}.x .brand{color:var(--brand)}.x .dim{color:var(--fg3)}
.ev.open{background:var(--hover)}
.ev.open .m{white-space:normal;overflow-wrap:anywhere}
.evx{grid-column:3/-1;margin:2px 0 4px;font:10.5px/1.6 var(--mono);color:var(--fg2);white-space:pre-wrap;overflow-wrap:anywhere}
.ev.fresh{animation:fresh 1.2s ease-out}
@keyframes fresh{from{background:var(--brand-bg)}}
.spin{width:10px;height:10px;border-radius:50%;border:1.5px solid var(--line2);border-top-color:var(--brand);animation:spin .8s linear infinite}

/* now */
.now{display:flex;flex-direction:column;gap:14px;padding:12px 14px 16px}
.nh{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--fg3)}
.live{display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:650;letter-spacing:.05em;text-transform:uppercase;color:var(--ok)}
.live::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor;animation:blink 1.6s ease-in-out infinite}
.paused .live{color:var(--fg3)}.paused .live::before{animation:none}
.subj{padding:11px 12px;border-radius:10px;border:1px solid var(--line);background:var(--bg2)}
.subj p{margin:7px 0 0;font-size:12.5px;line-height:1.5;color:var(--fg)}
.kv{display:flex;flex-direction:column;gap:3px}
.op{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:center;padding:7px 10px;border-radius:8px;border:1px solid var(--line);font-size:12px}
.op+.op{margin-top:5px}
.op .m{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.op .x{display:flex;align-items:center;gap:6px;color:var(--fg3);font-variant-numeric:tabular-nums}
.none{font-size:12px;color:var(--fg3)}
.acts{display:flex;flex-wrap:wrap;gap:6px}
.m0{margin:0}

@media (prefers-reduced-motion:reduce){.root *,.root *::before,.root *::after{animation:none!important;transition:none!important}}
`;
