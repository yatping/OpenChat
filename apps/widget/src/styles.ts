export const CHAT_CSS = `
:host{--oc-bg:#fff;--oc-fg:#0b1437;--oc-muted:#4d5a80;--oc-line:#dee4f0;--oc-soft:#f5f7fc;--oc-theirs:#fff;--oc-error:#b42318;--oc-shadow:0 16px 48px rgba(14,26,79,.22)}
@media (prefers-color-scheme:dark){:host{--oc-bg:#0a1233;--oc-fg:#eef2ff;--oc-muted:#a3aed0;--oc-line:#26315f;--oc-soft:#0f1a45;--oc-theirs:#1e2a55;--oc-error:#fda29b;--oc-shadow:0 16px 48px rgba(0,0,0,.5)}}
*{box-sizing:border-box}
.oc-panel{position:fixed;right:20px;bottom:96px;z-index:2147483000;width:380px;height:min(640px,calc(100vh - 116px));display:flex;flex-direction:column;background:var(--oc-bg);color:var(--oc-fg);border:1px solid var(--oc-line);border-radius:20px;box-shadow:var(--oc-shadow);overflow:hidden;font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;text-align:left}
.oc-panel[hidden]{display:none}
.oc-head{display:flex;align-items:center;gap:12px;padding:18px 16px 20px 18px;background:var(--oc-primary);background-image:linear-gradient(135deg,rgba(255,255,255,.14),rgba(0,0,0,.1));color:var(--oc-on-primary)}
.oc-face{flex:none;width:40px;height:40px;border-radius:50%;background:rgba(255,255,255,.2);display:flex;align-items:center;justify-content:center}
.oc-face svg{width:22px;height:22px;fill:currentColor}
.oc-head h2{margin:0;font-size:17px;font-weight:700;letter-spacing:-.01em}
.oc-head p{margin:2px 0 0;font-size:12.5px;display:flex;align-items:center;gap:6px}
.oc-head p.on::before{content:"";width:8px;height:8px;border-radius:50%;background:#32d583;box-shadow:0 0 0 2px rgba(255,255,255,.6)}
.oc-head div{flex:1;min-width:0}
.oc-x{width:44px;height:44px;margin:-8px -6px -8px 0;border:0;background:none;color:inherit;font-size:24px;line-height:1;cursor:pointer;border-radius:12px}
.oc-x:hover{background:rgba(255,255,255,.15)}
.oc-x:focus-visible,.oc-link:focus-visible,.oc-send:focus-visible,.oc-input:focus-visible{outline:2px solid var(--oc-primary);outline-offset:1px}
.oc-head .oc-x:focus-visible{outline-color:currentColor;outline-offset:-3px}
.oc-log{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px;overscroll-behavior:contain;background:var(--oc-soft)}
.oc-msg{max-width:82%;display:flex;flex-direction:column;align-items:flex-start;align-self:flex-start}
.oc-msg.mine{align-self:flex-end;align-items:flex-end}
.oc-msg.system{align-self:center;align-items:center;color:var(--oc-muted);font-size:12px}
.oc-who{font-size:11.5px;color:var(--oc-muted);margin:0 0 3px 4px}
.oc-bubble{padding:9px 13px;border-radius:18px 18px 18px 6px;background:var(--oc-theirs);box-shadow:0 1px 2px rgba(14,26,79,.08);white-space:pre-wrap;overflow-wrap:anywhere}
.mine .oc-bubble{border-radius:18px 18px 6px 18px;background:var(--oc-primary);color:var(--oc-on-primary);box-shadow:none}
.mine.sending .oc-bubble{opacity:.7}
.system .oc-bubble{background:none;padding:0;box-shadow:none}
.oc-state{font-size:11px;color:var(--oc-muted);margin:3px 4px 0}
.oc-state.bad{color:var(--oc-error)}
.oc-link{border:0;background:none;padding:0;color:inherit;font:inherit;text-decoration:underline;cursor:pointer}
.oc-older{align-self:center;color:var(--oc-muted);font-size:12px;min-height:32px}
.oc-file{margin-top:4px;font-size:12px;overflow-wrap:anywhere}
.oc-image{display:block;max-width:100%;max-height:220px;margin-bottom:4px;border-radius:12px}
.oc-attach{width:40px;height:40px;flex:none;padding:9px;border:0;border-radius:50%;background:none;color:var(--oc-muted);cursor:pointer}
.oc-attach:hover{background:var(--oc-soft);color:var(--oc-fg)}
.oc-attach svg,.oc-send svg{display:block;width:100%;height:100%;fill:currentColor}
.oc-attach:focus-visible{outline:2px solid var(--oc-primary);outline-offset:1px}
.oc-challenge{padding:0 16px;max-width:100%;overflow:auto;background:var(--oc-soft)}
.oc-typing{min-height:20px;padding:0 18px 2px;font-size:12px;color:var(--oc-muted);background:var(--oc-soft)}
.oc-note{margin:0;padding:8px 16px;font-size:12px;color:var(--oc-muted);border-top:1px solid var(--oc-line)}
.oc-note.bad{color:var(--oc-error)}
.oc-compose{display:flex;gap:6px;padding:10px 10px 10px 14px;border-top:1px solid var(--oc-line);align-items:flex-end;background:var(--oc-bg)}
.oc-input{flex:1;min-width:0;padding:8px 10px;border:1px solid var(--oc-line);border-radius:12px;background:var(--oc-bg);color:var(--oc-fg);font:inherit;font-size:16px;line-height:1.3;resize:none}
.oc-compose .oc-input{border-color:transparent;padding-left:2px;max-height:120px}
.oc-send{min-height:40px;padding:0 16px;border:0;border-radius:12px;background:var(--oc-primary);color:var(--oc-on-primary);font:inherit;font-weight:600;cursor:pointer}
.oc-compose .oc-send{flex:none;width:40px;height:40px;padding:9px;border-radius:50%}
.oc-send:disabled{opacity:.45;cursor:default}
.oc-form{display:flex;flex-direction:column;gap:10px;padding:14px 16px;border-top:1px solid var(--oc-line)}
.oc-form p{margin:0;font-weight:600}
.oc-form label{display:flex;flex-direction:column;gap:4px;font-size:12px}
.oc-form label.oc-check{flex-direction:row;align-items:flex-start;gap:6px}
.oc-actions{display:flex;gap:12px;align-items:center}
@media (max-width:480px){.oc-panel{inset:0;width:auto;height:100%;border:0;border-radius:0;z-index:2147483001}}
@media (prefers-reduced-motion:no-preference){.oc-panel{animation:oc-in .2s ease-out;transform-origin:bottom right}@keyframes oc-in{from{opacity:0;transform:translateY(12px) scale(.98)}}}
`;
