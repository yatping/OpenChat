export const CHAT_CSS = `
:host{--oc-bg:#fff;--oc-fg:#111827;--oc-muted:#4b5563;--oc-line:#e5e7eb;--oc-theirs:#f3f4f6;--oc-error:#b91c1c}
@media (prefers-color-scheme:dark){:host{--oc-bg:#111827;--oc-fg:#f9fafb;--oc-muted:#d1d5db;--oc-line:#374151;--oc-theirs:#1f2937;--oc-error:#fca5a5}}
*{box-sizing:border-box}
.oc-panel{position:fixed;right:20px;bottom:88px;z-index:2147483000;width:380px;height:min(600px,calc(100vh - 108px));display:flex;flex-direction:column;background:var(--oc-bg);color:var(--oc-fg);border:1px solid var(--oc-line);border-radius:14px;box-shadow:0 8px 32px rgba(0,0,0,.25);overflow:hidden;font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;text-align:left}
.oc-panel[hidden]{display:none}
.oc-head{display:flex;align-items:center;gap:8px;padding:12px 14px;background:var(--oc-primary);color:var(--oc-on-primary)}
.oc-head h2{margin:0;font-size:15px;font-weight:600}
.oc-head p{margin:0;font-size:12px}
.oc-head div{flex:1;min-width:0}
.oc-x{width:44px;height:44px;margin:-8px -8px -8px 0;border:0;background:none;color:inherit;font-size:22px;line-height:1;cursor:pointer;border-radius:8px}
.oc-x:focus-visible,.oc-link:focus-visible,.oc-send:focus-visible,.oc-input:focus-visible{outline:2px solid var(--oc-primary);outline-offset:1px}
.oc-head .oc-x:focus-visible{outline-color:currentColor;outline-offset:-3px}
.oc-log{flex:1;overflow-y:auto;padding:12px 14px;display:flex;flex-direction:column;gap:8px;overscroll-behavior:contain}
.oc-msg{max-width:85%;display:flex;flex-direction:column;align-items:flex-start;align-self:flex-start}
.oc-msg.mine{align-self:flex-end;align-items:flex-end}
.oc-msg.system{align-self:center;align-items:center;color:var(--oc-muted);font-size:12px}
.oc-who{font-size:11px;color:var(--oc-muted);margin:0 0 2px}
.oc-bubble{padding:8px 11px;border-radius:12px;background:var(--oc-theirs);white-space:pre-wrap;overflow-wrap:anywhere}
.mine .oc-bubble{background:var(--oc-primary);color:var(--oc-on-primary)}
.mine.sending .oc-bubble{opacity:.7}
.system .oc-bubble{background:none;padding:0}
.oc-state{font-size:11px;color:var(--oc-muted);margin-top:2px}
.oc-state.bad{color:var(--oc-error)}
.oc-link{border:0;background:none;padding:0;color:inherit;font:inherit;text-decoration:underline;cursor:pointer}
.oc-older{align-self:center;color:var(--oc-muted);font-size:12px;min-height:32px}
.oc-typing{min-height:18px;padding:0 14px;font-size:12px;color:var(--oc-muted)}
.oc-note{margin:0;padding:8px 14px;font-size:12px;color:var(--oc-muted);border-top:1px solid var(--oc-line)}
.oc-note.bad{color:var(--oc-error)}
.oc-compose{display:flex;gap:8px;padding:10px;border-top:1px solid var(--oc-line);align-items:flex-end}
.oc-input{flex:1;min-width:0;padding:8px 10px;border:1px solid var(--oc-line);border-radius:8px;background:var(--oc-bg);color:var(--oc-fg);font:inherit;font-size:16px;line-height:1.3;resize:none}
.oc-send{min-height:40px;padding:0 14px;border:0;border-radius:8px;background:var(--oc-primary);color:var(--oc-on-primary);font:inherit;font-weight:600;cursor:pointer}
.oc-send:disabled{opacity:.6;cursor:default}
.oc-form{display:flex;flex-direction:column;gap:8px;padding:12px 14px;border-top:1px solid var(--oc-line)}
.oc-form p{margin:0;font-weight:600}
.oc-form label{display:flex;flex-direction:column;gap:2px;font-size:12px}
.oc-actions{display:flex;gap:12px;align-items:center}
@media (max-width:480px){.oc-panel{inset:0;width:auto;height:100%;border:0;border-radius:0;z-index:2147483001}}
@media (prefers-reduced-motion:no-preference){.oc-panel{animation:oc-in .15s ease-out}@keyframes oc-in{from{opacity:0;transform:translateY(8px)}}}
`;
