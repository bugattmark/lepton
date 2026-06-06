// Black & white server-rendered views. No frontend framework — fast + tiny.
// NOTE: the dashboard's client <script> lives inside this template literal, so it must
// NOT use backticks or ${...}. Build strings with single quotes + concatenation.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
const LANDING_HTML = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'landing.html'), 'utf8')
const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
:root{--fg:#000;--bg:#fff;--muted:#666;--line:#e5e5e5}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Helvetica,Arial,sans-serif;
  color:var(--fg);background:var(--bg);line-height:1.5;-webkit-font-smoothing:antialiased}
a{color:inherit}
.wrap{max-width:920px;margin:0 auto;padding:24px}
.nav{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--line);padding:18px 24px}
.brand{font-weight:700;letter-spacing:-.02em;font-size:18px}
.ptabs{display:flex;gap:4px}
.ptab{padding:8px 16px;border-radius:8px;font-weight:600;font-size:14px;color:var(--muted);text-decoration:none}
.ptab:hover{background:#f4f4f4;color:#000}
.ptab.on{background:#000;color:#fff}
.brand .mark{display:inline-block;width:14px;height:14px;border:2px solid #000;border-radius:50%;background:#fff;vertical-align:-1px;margin-right:6px}
.btn{display:inline-block;background:#000;color:#fff;border:1px solid #000;border-radius:8px;
  padding:10px 18px;font-size:15px;font-weight:600;cursor:pointer;text-decoration:none;text-align:center}
.btn:hover{background:#222}
.btn.ghost{background:#fff;color:#000}
.btn.ghost:hover{background:#f4f4f4}
.btn.sm{padding:6px 12px;font-size:13px;border-radius:7px}
.hero{padding:90px 0 60px;text-align:center}
.hero h1{font-size:54px;letter-spacing:-.03em;line-height:1.05;margin-bottom:18px}
.hero p{font-size:19px;color:var(--muted);max-width:560px;margin:0 auto 32px}
.row{display:flex;gap:12px;justify-content:center;flex-wrap:wrap}
.card{border:1px solid var(--line);border-radius:14px;padding:22px}
.card h3{font-size:16px;margin-bottom:6px}
.card p{font-size:14px;color:var(--muted)}
.authbox{max-width:380px;margin:64px auto;border:1px solid var(--line);border-radius:16px;padding:32px}
.authbox h2{font-size:24px;letter-spacing:-.02em;margin-bottom:20px}
.authdiv{display:flex;align-items:center;gap:12px;margin:18px 0;color:var(--muted);font-size:13px}
.authdiv:before,.authdiv:after{content:'';flex:1;height:1px;background:var(--line)}
.gbtn{display:flex;align-items:center;justify-content:center;gap:10px;text-decoration:none}
label{display:block;font-size:13px;font-weight:600;margin:14px 0 6px}
input,select,textarea{width:100%;border:1px solid #000;border-radius:8px;padding:11px 12px;font-size:15px;font-family:inherit;background:#fff}
input:focus,select:focus,textarea:focus{outline:2px solid #000;outline-offset:1px}
.row2{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.item{border:1px solid var(--line);border-radius:12px;padding:14px;margin-top:10px}
.x{cursor:pointer;color:var(--muted);font-size:13px;background:none;border:none;text-decoration:underline}
h4{font-size:14px;margin:18px 0 4px}
h5{font-size:13px;margin:0}
.dashwrap{max-width:none;width:100%;margin:0;display:flex;gap:18px;align-items:flex-start}
.col-left{flex:0 0 300px;width:300px;position:sticky;top:18px}
.col-right{flex:1;min-width:0}
@media(max-width:860px){.dashwrap{flex-direction:column}.col-left{flex:none;width:100%;position:static}}
.full{width:100%;margin-top:22px}
.muted{color:var(--muted);font-size:14px}
.hint{color:var(--muted);font-size:12px;margin-top:3px}
.center{text-align:center}
.err{background:#000;color:#fff;border-radius:8px;padding:10px 12px;font-size:14px;margin-bottom:8px}
.mt{margin-top:18px}
.badge{display:inline-block;border:1px solid #000;border-radius:6px;padding:3px 10px;font-size:12px;font-weight:600;text-transform:capitalize;white-space:nowrap}
.acctmeta{font-size:12px;color:var(--muted);font-family:ui-monospace,Menlo,monospace;margin-top:8px}
.badge.connected,.badge.running{background:#000;color:#fff}
.badge.disconnected,.badge.draft,.badge.paused{border-color:var(--line);color:var(--muted)}
.qr img{background:#fff;border:1px solid var(--line);border-radius:12px;padding:14px;width:160px;height:160px}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}
hr{border:none;border-top:1px solid var(--line);margin:24px 0}
@media(max-width:680px){.hero h1{font-size:38px}}
/* editor */
.tabs{display:flex;gap:6px;border-bottom:1px solid var(--line);margin:16px 0}
.tab{padding:10px 14px;cursor:pointer;font-weight:600;font-size:14px;border-bottom:2px solid transparent;color:var(--muted)}
.tab.on{color:#000;border-bottom-color:#000}
.cfg3{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
.checklist{display:flex;flex-wrap:wrap;gap:8px}
.chk{border:1px solid var(--line);border-radius:10px;padding:8px 12px;display:flex;gap:8px;align-items:center;cursor:pointer}
.chk input{width:auto}
.msdd{position:relative}
.msdd-btn{width:100%;text-align:left;border:1px solid #000;border-radius:8px;padding:11px 12px;background:#fff;cursor:pointer;font-size:15px;display:flex;justify-content:space-between;align-items:center;gap:8px}
.msdd-btn .ph{color:var(--muted)}
.msdd-btn:after{content:'▾';color:#000;flex:0 0 auto}
.msdd-panel{position:absolute;z-index:30;left:0;right:0;margin-top:4px;border:1px solid #000;border-radius:8px;background:#fff;box-shadow:0 8px 24px rgba(0,0,0,.14);max-height:260px;overflow:auto;padding:6px}
.msdd-opt{display:flex;gap:8px;align-items:center;padding:9px 8px;border-radius:6px;cursor:pointer;font-size:14px}
.msdd-opt:hover{background:#f4f4f4}
.msdd-opt input{width:auto}
.canvas{position:relative;height:460px;border:1px solid var(--line);border-radius:12px;overflow:auto;
  background-image:radial-gradient(#e5e5e5 1px,transparent 1px);background-size:18px 18px;background-color:#fff}
.cstage{position:relative;width:1200px;height:1000px}
.node{position:absolute;width:200px;background:#fff;border:1px solid #000;border-radius:12px;padding:10px;
  box-shadow:0 1px 0 rgba(0,0,0,.04);user-select:none}
.node.sel{outline:2px solid #000;outline-offset:2px}
.node .nh{display:flex;justify-content:space-between;align-items:center;cursor:grab;font-weight:700;font-size:13px}
.node .nb{font-size:12px;color:var(--muted);margin-top:6px;white-space:pre-wrap;word-break:break-word;max-height:48px;overflow:hidden}
.node.start{border-style:dashed}
.handle{position:absolute;bottom:-7px;width:14px;height:14px;border-radius:50%;background:#fff;border:2px solid #000;cursor:crosshair;z-index:3}
.handle:hover{background:#000;transform:scale(1.25)}
.handle.single{left:50%;margin-left:-7px}
.handle.yes{left:30%;margin-left:-7px}
.handle.no{left:70%;margin-left:-7px}
.hlabel{position:absolute;bottom:-21px;font-size:9px;font-weight:700;color:#777;transform:translateX(-50%);pointer-events:none}
.node.droptarget{outline:2px dashed #000;outline-offset:3px}
.edges{position:absolute;top:0;left:0;pointer-events:none}
.tbl{width:100%;border-collapse:collapse;font-size:13px;margin-top:12px}
.tbl th{text-align:left;border-bottom:1px solid #000;padding:8px 10px;cursor:grab;font-size:12px;white-space:nowrap;background:#fafafa}
.tbl td{border-bottom:1px solid var(--line);padding:8px 10px;vertical-align:top}
.tbl th.drag{opacity:.4}
.pill{display:inline-block;border-radius:999px;padding:2px 10px;font-size:12px;font-weight:600;border:1px solid var(--line)}
.pill.replied{background:#000;color:#fff;border-color:#000}
.pill.contacted{border-color:#000}
.flex{display:flex;justify-content:space-between;align-items:center;gap:10px}
.tbox{border:1px solid var(--line);border-radius:10px;padding:12px;margin-top:10px;background:#fafafa}
.ibackdrop{position:fixed;inset:0;background:rgba(0,0,0,.18);z-index:55}
.ipanel{position:fixed;top:0;right:0;height:100vh;width:480px;max-width:94vw;background:#fff;border-left:1px solid #000;box-shadow:-10px 0 36px rgba(0,0,0,.16);padding:22px;overflow:auto;transform:translateX(102%);transition:transform .2s ease;z-index:60}
.ipanel.open{transform:translateX(0)}
.ipanel-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
`

export function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>${CSS}</style></head><body>${body}</body></html>`
}

export function landingView(): string {
  return LANDING_HTML
}

export function authView(mode: 'login' | 'signup', error?: string): string {
  const isSignup = mode === 'signup'
  return page(
    isSignup ? 'Sign up' : 'Log in',
    `<div class="nav"><a class="brand" href="/" style="text-decoration:none"><span class="mark"></span>Lepton</a></div>
     <div class="authbox">
       <h2>${isSignup ? 'Create your account' : 'Welcome back'}</h2>
       ${error ? `<div class="err">${error}</div>` : ''}
       <form method="post" action="/${mode}">
         <label for="email">Email</label>
         <input id="email" name="email" type="email" autocomplete="email" required>
         <label for="password">Password</label>
         <input id="password" name="password" type="password" autocomplete="${isSignup ? 'new-password' : 'current-password'}" minlength="8" required>
         <button class="btn full" type="submit">${isSignup ? 'Create account' : 'Log in'}</button>
       </form>
       <div class="authdiv"><span>or</span></div>
       <a class="btn ghost full gbtn" href="/auth/google">
         <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>
         Continue with Google
       </a>
       <p class="muted center mt">
         ${isSignup ? "Already have an account? <a href='/login'>Log in</a>" : "New here? <a href='/signup'>Create an account</a>"}
       </p>
     </div>`,
  )
}

// Onboarding dashboard (/dashboard). Layout + copy mirror the reference exactly; rendered B&W.
export function onboardingView(_email: string): string {
  const linkIcon =
    '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>'
  const lockIcon =
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>'
  const tickIcon =
    '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>'
  const pencilIcon =
    '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>'
  const fileIcon =
    '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>'
  const sendIcon =
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>'
  const icoSet = (step: string) =>
    `<span class="ico-step">${step}</span><span class="ico-done">${tickIcon}</span><span class="ico-lock">${lockIcon}</span>`

  const locked = (title: string, note: string, desc: string, extra = ''): string =>
    `<div class="ob-step ob-locked">
       <div class="ob-ico ob-ico-lock">${lockIcon}</div>
       <div class="ob-body">
         <div class="ob-title">${title} <span class="ob-note">${note}</span></div>
         <p class="ob-desc">${desc}</p>
         ${extra}
       </div>
     </div>`

  return page(
    'Dashboard',
    `<div class="ob-page">
       <div class="ob-panel">
         <div class="ob-label">ONBOARDING STEPS</div>

         <div class="ob-step" id="ob-s1" data-badge="&lt;1 min">
           <div class="ob-ico">${icoSet(linkIcon)}</div>
           <div class="ob-body">
             <div class="ob-title">Add a Link <span class="ob-tag"></span></div>
             <p class="ob-desc">Social link, website, portfolio, company page — anywhere brands can see your work.</p>
             <a class="ob-btn" href="#" id="obAddLink">ADD A LINK <span class="ob-arrow">→</span></a>
           </div>
         </div>

         <div class="ob-step" id="ob-s2" data-badge="&lt;1 min" data-note="· Finish 1 step above first">
           <div class="ob-ico">${icoSet(pencilIcon)}</div>
           <div class="ob-body">
             <div class="ob-title">Create Your Pitch Template <span class="ob-tag"></span></div>
             <p class="ob-desc">Write the email Bento sends to brands. Strong templates roughly 3x your reply rate.</p>
             <a class="ob-btn" href="#" id="obPitch">CREATE TEMPLATE <span class="ob-arrow">→</span></a>
           </div>
         </div>

         <div class="ob-step" id="ob-s3" data-note="· Finish 2 steps above first">
           <div class="ob-ico">${icoSet(fileIcon)}</div>
           <div class="ob-body">
             <div class="ob-title">Create Follow-Up Template <span class="ob-tag"></span></div>
             <p class="ob-desc">Most replies come from follow-ups — set this up once and Bento sends them automatically.</p>
           </div>
         </div>

         <div class="ob-step" id="ob-s4" data-note="· Finish 3 steps above first">
           <div class="ob-ico">${icoSet(sendIcon)}</div>
           <div class="ob-body">
             <div class="ob-title">Send a first email with a follow up <span class="ob-tag"></span></div>
             <p class="ob-desc">Send a pitch with a follow-up scheduled right after — Bento sends it automatically if they don't reply.</p>
           </div>
         </div>
       </div>
     </div>

     <!-- Add Portfolio Link modal -->
     <div id="lnkBackdrop" class="lnk-backdrop" style="display:none">
       <div class="lnk-modal" role="dialog" aria-modal="true">
         <div class="lnk-h">Add Portfolio Link</div>
         <div class="lnk-card">
           <div class="lnk-sub">Please share your most active social links below</div>
           <div id="lnkRows"></div>
           <a href="#" id="lnkAdd" class="lnk-add">ADD LINK +</a>
         </div>
         <div class="lnk-foot">
           <a href="#" id="lnkCancel" class="lnk-cancel">CANCEL</a>
           <button id="lnkSave" class="lnk-save" disabled>SAVE</button>
         </div>
       </div>
     </div>
     <!-- How do you want to write your pitch? modal -->
     <div id="pchBackdrop" class="pch-backdrop" style="display:none">
       <div class="pch-modal" role="dialog" aria-modal="true">
         <button class="pch-x" id="pchClose">&times;</button>
         <div class="pch-h">How do you want to write your pitch?</div>

         <div class="pch-cards">
           <div class="pch-card sel" data-v="ai">
             <span class="pch-card-mark"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span>
             <span class="pch-card-radio"></span>
             <div class="pch-card-ico"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3v4M3 5h4M6 17v4m-2-2h4"/><path d="m13 7 6 6L7 21l-2-2L13 7z"/><path d="m16 4 1 1"/></svg></div>
             <div class="pch-card-t">Bento writes it</div>
             <div class="pch-card-d">AI draft, fully editable</div>
           </div>
           <div class="pch-card" data-v="own">
             <span class="pch-card-mark"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span>
             <span class="pch-card-radio"></span>
             <div class="pch-card-ico"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg></div>
             <div class="pch-card-t">Write my own</div>
             <div class="pch-card-d">Start from scratch</div>
           </div>
         </div>

         <div class="pch-lbl">Tell us about yourself <span class="req">*</span></div>
         <div class="pf-dd" id="ddAbout">
           <button type="button" class="pf-dd-btn">
             <span class="pf-dd-val">Portfolio</span>
             <span class="pf-dd-right"><span class="pf-rec">RECOMMENDED</span><svg class="pf-chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg></span>
           </button>
           <div class="pf-dd-menu" style="display:none">
             <div class="pf-opt sel" data-v="portfolio"><div class="pf-opt-t">Portfolio</div><div class="pf-opt-d">Full work example</div></div>
             <div class="pf-opt" data-v="write"><div class="pf-opt-t">Write about yourself</div><div class="pf-opt-d">A short paragraph in your own words</div></div>
           </div>
         </div>
         <!-- portfolio: later we grab the website html/json/text to use -->
         <div id="aboutPortfolio" class="pch-inp"><span class="pch-pre">https://</span><input type="text" id="aboutUrl" placeholder="website.com"></div>
         <textarea id="aboutText" class="pch-ta" placeholder="A short paragraph about yourself, in your own words…" style="display:none"></textarea>

         <div class="pch-lbl" style="margin-top:24px">Show your best work</div>
         <div class="pch-sub">We'll highlight this in your template</div>
         <div class="pf-dd" id="ddWork">
           <button type="button" class="pf-dd-btn">
             <span class="pf-dd-val">Top performing post</span>
             <span class="pf-dd-right"><svg class="pf-chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg></span>
           </button>
           <div class="pf-dd-menu" style="display:none">
             <div class="pf-opt sel" data-v="top"><div class="pf-opt-t">Top performing post</div><div class="pf-opt-d">Your best performing content</div></div>
             <div class="pf-opt" data-v="collab"><div class="pf-opt-t">Brand collab post</div><div class="pf-opt-d">Social proof from a past brand</div></div>
             <div class="pf-opt" data-v="page"><div class="pf-opt-t">Social media page</div><div class="pf-opt-d">Let brands browse your feed</div></div>
             <div class="pf-opt" data-v="partnership"><div class="pf-opt-t">Describe your most impressive partnership</div><div class="pf-opt-d">Highlight a notable past brand collaboration</div></div>
           </div>
         </div>
         <div class="pch-inp" id="workLink"><span class="pch-pre">https://</span><input type="text" id="workUrl" placeholder="www.instagram.com/p/your-post-id"></div>

         <div class="pch-foot">
           <button class="pch-back" id="pchBack">BACK</button>
           <button class="pch-gen" id="pchGen">GENERATE PITCH</button>
         </div>
       </div>
     </div>
     <!-- Modify your template modal -->
     <div id="tplBackdrop" class="tpl-backdrop" style="display:none">
       <div class="tpl-modal" role="dialog" aria-modal="true">
         <button class="tpl-x" id="tplClose">&times;</button>
         <div class="tpl-h">Modify your template</div>

         <div class="tpl-sel">
           <select class="tpl-folder"><option>Folder</option></select>
           <svg class="tpl-chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
         </div>

         <label class="tpl-lbl">Template Name <span class="req">*</span></label>
         <input class="tpl-inp" id="tplName" placeholder="Template Name">

         <label class="tpl-lbl">Subject <span class="req">*</span></label>
         <div class="tpl-field">
           <div class="tpl-tags">Personalization Tags: <button class="tpl-tag" data-tag="{{first_name}}" data-target="tplSubject">{{first_name}}</button><button class="tpl-tag" data-tag="{{last_name}}" data-target="tplSubject">{{last_name}}</button><button class="tpl-tag" data-tag="{{brand_name}}" data-target="tplSubject">{{brand_name}}</button></div>
           <input class="tpl-subj" id="tplSubject" placeholder="Email Subject">
         </div>

         <div class="tpl-field" style="margin-top:16px">
           <div class="tpl-toolbar">
             <button type="button" class="tpl-tb" title="Text"><b>T</b></button>
             <button type="button" class="tpl-tb" title="Link"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg></button>
           </div>
           <div class="tpl-tags">Personalization Tags: <button class="tpl-tag" data-tag="{{first_name}}" data-target="tplBody">{{first_name}}</button><button class="tpl-tag" data-tag="{{last_name}}" data-target="tplBody">{{last_name}}</button><button class="tpl-tag" data-tag="{{brand_name}}" data-target="tplBody">{{brand_name}}</button></div>
           <textarea class="tpl-area" id="tplBody" placeholder="Email Body"></textarea>
         </div>

         <div class="tpl-foot">
           <button class="tpl-back" id="tplBack"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="13 8 9 12 13 16"/><line x1="9" y1="12" x2="16" y2="12"/></svg> BACK</button>
           <button class="tpl-save" id="tplSave">SAVE TEMPLATE</button>
         </div>
       </div>
     </div>
     <style>
       .ob-page{max-width:860px;margin:0 auto;padding:40px 24px}
       .ob-panel{border:1px solid var(--line);border-radius:18px;padding:28px}
       .ob-label{font-size:12px;font-weight:700;letter-spacing:.12em;color:var(--muted);margin-bottom:18px}
       .ob-step{display:flex;gap:18px;border-radius:14px;padding:22px 24px;margin-bottom:14px}
       .ob-step:last-child{margin-bottom:0}
       .ob-active{background:#fff;border:1px solid #000;box-shadow:0 1px 2px rgba(0,0,0,.05)}
       .ob-locked{background:#f6f6f6;border:1px solid #f6f6f6}
       .ob-ico{flex:0 0 auto;width:48px;height:48px;border-radius:50%;display:flex;align-items:center;justify-content:center}
       .ob-ico-link{background:#efefef;color:#000}
       .ob-ico-lock{background:#ececec;color:#aaa}
       .ob-body{flex:1;min-width:0}
       .ob-title{font-size:20px;font-weight:700;letter-spacing:-.01em;color:#000;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
       .ob-locked .ob-title{color:#9a9a9a}
       .ob-note{font-size:15px;font-weight:400;color:#b3b3b3}
       .ob-badge{display:inline-block;background:#000;color:#fff;border-radius:999px;padding:2px 9px;font-size:12px;font-weight:600}
       .ob-desc{margin-top:8px;font-size:16px;color:#444}
       .ob-locked .ob-desc{color:#b3b3b3}
       .ob-btn{display:inline-flex;align-items:center;gap:10px;margin-top:16px;background:#fff;color:#000;border:1px solid #000;border-radius:10px;padding:11px 18px;font-size:14px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;text-decoration:none;cursor:pointer}
       .ob-btn:hover{background:#000;color:#fff}
       .ob-arrow{font-weight:400}

       /* Add Portfolio Link modal */
       .lnk-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:200;padding:20px}
       .lnk-modal{background:#fff;border-radius:16px;width:100%;max-width:660px;padding:28px 30px;box-shadow:0 20px 60px rgba(0,0,0,.25)}
       .lnk-h{font-size:24px;font-weight:700;color:#111;margin-bottom:20px}
       .lnk-card{border:1px solid #e3e3e3;border-radius:14px;padding:20px}
       .lnk-sub{font-size:16px;color:#222;margin-bottom:14px}
       .lnk-row{display:flex;align-items:center;gap:12px;margin-bottom:12px}
       .lnk-row:last-child{margin-bottom:0}
       .lnk-sel{position:relative;flex:0 0 185px}
       .lnk-sel select{width:100%;appearance:none;-webkit-appearance:none;background:#fff;border:1px solid #d9d9d9;border-radius:12px;padding:14px 36px 14px 16px;font-size:16px;color:#111;cursor:pointer;font-weight:500}
       .lnk-sel select:focus{outline:none;border-color:#14532d;box-shadow:0 0 0 1px #14532d}
       .lnk-chev{position:absolute;right:14px;top:50%;transform:translateY(-50%);pointer-events:none;color:#666}
       .lnk-inp{flex:1;display:flex;align-items:center;border:1px solid #d9d9d9;border-radius:12px;padding:0 14px;background:#fff;min-width:0}
       .lnk-inp:focus-within{border-color:#14532d;box-shadow:0 0 0 1px #14532d}
       .lnk-pre{color:#444;font-size:16px;white-space:nowrap}
       .lnk-inp input{border:none;outline:none;flex:1;padding:14px 6px;font-size:16px;color:#111;min-width:0;background:transparent}
       .lnk-inp input::placeholder{color:#9a9a9a}
       .lnk-del{flex:0 0 auto;background:none;border:none;cursor:pointer;color:#9aa0c2;padding:6px;line-height:0}
       .lnk-del:hover{color:#e0556b}
       .lnk-add{display:inline-block;color:#14532d;font-weight:700;font-size:16px;letter-spacing:.02em;text-decoration:none;cursor:pointer}
       .lnk-foot{display:flex;justify-content:flex-end;align-items:center;gap:24px;margin-top:22px}
       .lnk-cancel{color:#14532d;font-weight:700;font-size:16px;letter-spacing:.04em;text-decoration:none;cursor:pointer;text-transform:uppercase}
       .lnk-save{background:#e6e6e6;color:#9a9a9a;border:none;border-radius:10px;padding:12px 26px;font-size:16px;font-weight:700;letter-spacing:.04em;cursor:not-allowed;text-transform:uppercase}
       .lnk-save.on{background:#14532d;color:#fff;cursor:pointer}

       /* How do you want to write your pitch? modal */
       .pch-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:flex-start;justify-content:center;z-index:200;padding:40px 20px;overflow:auto}
       .pch-modal{position:relative;background:#fff;border-radius:16px;width:100%;max-width:920px;padding:40px 46px;box-shadow:0 20px 60px rgba(0,0,0,.25)}
       .pch-x{position:absolute;top:18px;right:24px;background:none;border:none;font-size:26px;line-height:1;color:#b3b3b3;cursor:pointer}
       .pch-h{font-size:30px;font-weight:700;color:#111;margin-bottom:28px;letter-spacing:-.01em}
       .pch-cards{display:flex;gap:16px;margin-bottom:26px}
       .pch-card{position:relative;flex:1;border:1px solid #d9d9d9;border-radius:14px;padding:16px 18px;cursor:pointer;background:#fff}
       .pch-card.sel{background:linear-gradient(135deg,#0c3522,#14532d);border-color:#14532d}
       .pch-card-ico{width:34px;height:34px;border-radius:50%;background:#f1f1f1;display:flex;align-items:center;justify-content:center;color:#14532d;margin-bottom:10px}
       .pch-card.sel .pch-card-ico{background:#fff;color:#14532d}
       .pch-card-t{font-size:20px;font-weight:700;color:#111;letter-spacing:-.01em}
       .pch-card.sel .pch-card-t{color:#fff}
       .pch-card-d{font-size:14px;color:#777;margin-top:2px}
       .pch-card.sel .pch-card-d{color:#cfe3d8}
       .pch-card-mark{position:absolute;top:14px;right:14px;width:22px;height:22px;border-radius:50%;background:#fff;color:#14532d;display:none;align-items:center;justify-content:center}
       .pch-card-radio{position:absolute;top:14px;right:14px;width:21px;height:21px;border-radius:50%;border:2px solid #d3d3d3;box-sizing:border-box}
       .pch-card.sel .pch-card-mark{display:flex}
       .pch-card.sel .pch-card-radio{display:none}
       .pch-lbl{font-size:18px;font-weight:700;color:#111;margin-bottom:10px}
       .pch-sub{font-size:15px;color:#555;margin:-4px 0 10px}
       .pf-dd{position:relative;margin-bottom:12px}
       .pf-dd-btn{width:100%;display:flex;align-items:center;justify-content:space-between;background:#fff;border:1px solid #d9d9d9;border-radius:12px;padding:16px 18px;font-size:17px;color:#111;cursor:pointer}
       .pf-dd.open .pf-dd-btn{border-color:#14532d;box-shadow:0 0 0 1px #14532d}
       .pf-dd-right{display:flex;align-items:center;gap:14px;color:#444}
       .pf-rec{background:#14532d;color:#fff;border-radius:999px;padding:4px 12px;font-size:12px;font-weight:700;letter-spacing:.04em}
       .pf-dd.open .pf-chev{transform:rotate(180deg)}
       .pf-dd-menu{position:absolute;left:0;right:0;top:calc(100% + 6px);background:#fff;border:1px solid #e0e0e0;border-radius:12px;box-shadow:0 12px 32px rgba(0,0,0,.16);z-index:5;overflow:hidden}
       .pf-opt{padding:14px 18px;cursor:pointer}
       .pf-opt:hover,.pf-opt.sel{background:#eef1f0}
       .pf-opt-t{font-size:17px;font-weight:700;color:#111}
       .pf-opt-d{font-size:14px;color:#777;margin-top:2px}
       .pch-inp{display:flex;align-items:center;border:1px solid #d9d9d9;border-radius:12px;padding:0 16px;background:#fff;margin-bottom:6px}
       .pch-inp:focus-within{border-color:#14532d;box-shadow:0 0 0 1px #14532d}
       .pch-pre{color:#9a9a9a;font-size:16px}
       .pch-inp input{border:none;outline:none;flex:1;padding:15px 8px;font-size:16px;color:#111;background:transparent;min-width:0}
       .pch-inp input::placeholder{color:#bdbdbd}
       .pch-ta{width:100%;box-sizing:border-box;border:1px solid #d9d9d9;border-radius:12px;padding:14px 16px;font-size:16px;color:#111;min-height:110px;resize:vertical;font-family:inherit}
       .pch-ta:focus{outline:none;border-color:#14532d;box-shadow:0 0 0 1px #14532d}
       .pch-foot{display:flex;justify-content:space-between;align-items:center;margin-top:34px}
       .pch-back{background:#fff;border:1px solid #cfcfcf;border-radius:12px;padding:14px 30px;font-size:15px;font-weight:700;letter-spacing:.06em;color:#14532d;cursor:pointer;text-transform:uppercase}
       .pch-gen{background:#14532d;border:none;border-radius:12px;padding:15px 32px;font-size:15px;font-weight:700;letter-spacing:.06em;color:#fff;cursor:pointer;text-transform:uppercase}

       /* Modify your template modal */
       .tpl-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:flex-start;justify-content:center;z-index:210;padding:40px 20px;overflow:auto}
       .tpl-modal{position:relative;background:#fff;border-radius:16px;width:100%;max-width:720px;padding:34px 40px;box-shadow:0 20px 60px rgba(0,0,0,.25)}
       .tpl-x{position:absolute;top:18px;right:24px;background:none;border:none;font-size:26px;line-height:1;color:#b3b3b3;cursor:pointer}
       .tpl-h{font-size:30px;font-weight:700;color:#111;margin-bottom:22px;letter-spacing:-.01em}
       .tpl-sel{position:relative;display:inline-block;margin-bottom:6px}
       .tpl-folder{appearance:none;-webkit-appearance:none;background:#fff;border:1px solid #d9d9d9;border-radius:10px;padding:12px 42px 12px 16px;font-size:16px;color:#111;cursor:pointer;min-width:240px}
       .tpl-folder:focus{outline:none;border-color:#14532d;box-shadow:0 0 0 1px #14532d}
       .tpl-chev{position:absolute;right:14px;top:50%;transform:translateY(-50%);pointer-events:none;color:#666}
       .tpl-lbl{display:block;font-size:17px;font-weight:700;color:#111;margin:18px 0 8px}
       .tpl-lbl .req{color:#111}
       .tpl-inp{width:100%;box-sizing:border-box;border:1px solid #d9d9d9;border-radius:12px;padding:15px 16px;font-size:16px;color:#111}
       .tpl-inp:focus{outline:none;border-color:#14532d;box-shadow:0 0 0 1px #14532d}
       .tpl-field{border:1px solid #d9d9d9;border-radius:12px;overflow:hidden}
       .tpl-toolbar{display:flex;align-items:center;gap:4px;background:#fff;padding:10px 12px;border-bottom:1px solid #eee}
       .tpl-tb{background:none;border:none;cursor:pointer;color:#222;padding:6px 9px;border-radius:6px;font-size:16px;display:flex;align-items:center}
       .tpl-tb:hover{background:#f0f0f0}
       .tpl-tags{background:#f3f3f3;padding:11px 16px;font-size:15px;color:#333;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
       .tpl-tag{background:#fff;border:1px solid #c5bdf0;color:#6b5fd0;border-radius:999px;padding:4px 12px;font-size:14px;cursor:pointer}
       .tpl-subj,.tpl-area{width:100%;box-sizing:border-box;border:none;outline:none;padding:15px 16px;font-size:16px;color:#111;font-family:inherit;background:transparent}
       .tpl-area{min-height:150px;resize:vertical;display:block}
       .tpl-foot{display:flex;justify-content:center;gap:18px;margin-top:28px}
       .tpl-back{background:#f1f1f1;border:none;border-radius:12px;padding:14px 26px;font-size:15px;font-weight:700;letter-spacing:.04em;color:#14532d;cursor:pointer;text-transform:uppercase;display:inline-flex;align-items:center;gap:8px}
       .tpl-save{background:#14532d;border:none;border-radius:12px;padding:14px 30px;font-size:15px;font-weight:700;letter-spacing:.04em;color:#fff;cursor:pointer;text-transform:uppercase}

       /* onboarding step states (tick-off + sequential lock) */
       .ob-done{background:#fff;border:1px solid #cfe0d6}
       .ob-ico>span{display:none;align-items:center;justify-content:center}
       .ob-active .ob-ico{background:#efefef;color:#000}
       .ob-active .ico-step{display:flex}
       .ob-done .ob-ico{background:#14532d;color:#fff}
       .ob-done .ico-done{display:flex}
       .ob-locked .ob-ico{background:#ececec;color:#aaa}
       .ob-locked .ico-lock{display:flex}
       .ob-done .ob-title{color:#000}
     </style>
     <script>
       (function(){
         var PLAT={Instagram:{pre:'https://instagram.com/',ph:'handle'},TikTok:{pre:'https://tiktok.com/@',ph:'handle'},YouTube:{pre:'https://youtube.com/@',ph:'handle'},Twitch:{pre:'https://www.twitch.tv/',ph:'handle'},Portfolio:{pre:'https://',ph:'website.com'}};
         var ORDER=['Instagram','TikTok','YouTube','Twitch','Portfolio'];
         var KEY='lepton_portfolio_links';
         var rows=[];
         var bd=document.getElementById('lnkBackdrop'),rowsEl=document.getElementById('lnkRows'),addEl=document.getElementById('lnkAdd'),saveEl=document.getElementById('lnkSave');
         function trash(){return '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>';}
         function chev(){return '<svg class="lnk-chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>';}
         function opts(sel){return ORDER.map(function(p){return '<option value="'+p+'"'+(p===sel?' selected':'')+'>'+p+'</option>';}).join('');}
         function esc(s){return (''+(s==null?'':s)).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
         function render(){
           rowsEl.innerHTML=rows.map(function(r,i){var p=PLAT[r.platform]||PLAT.Portfolio;
             return '<div class="lnk-row" data-i="'+i+'"><div class="lnk-sel"><select class="lnk-plat">'+opts(r.platform)+'</select>'+chev()+'</div>'
               +'<div class="lnk-inp"><span class="lnk-pre">'+p.pre+'</span><input class="lnk-handle" type="text" placeholder="'+p.ph+'" value="'+esc(r.handle)+'"></div>'
               +'<button class="lnk-del" title="Remove">'+trash()+'</button></div>';}).join('');
           addEl.style.display=rows.length>=ORDER.length?'none':'inline-block';
           validate();
         }
         function validate(){var ok=rows.some(function(r){return (r.handle||'').trim().length>0;});saveEl.disabled=!ok;saveEl.className='lnk-save'+(ok?' on':'');}
         function nextPlatform(){for(var i=0;i<ORDER.length;i++){var p=ORDER[i];if(!rows.some(function(r){return r.platform===p;}))return p;}return ORDER[0];}
         rowsEl.addEventListener('input',function(e){if(e.target.classList.contains('lnk-handle')){rows[+e.target.closest('.lnk-row').dataset.i].handle=e.target.value;validate();}});
         rowsEl.addEventListener('change',function(e){if(e.target.classList.contains('lnk-plat')){rows[+e.target.closest('.lnk-row').dataset.i].platform=e.target.value;render();}});
         rowsEl.addEventListener('click',function(e){var b=e.target.closest('.lnk-del');if(b){rows.splice(+b.closest('.lnk-row').dataset.i,1);render();}});
         addEl.addEventListener('click',function(e){e.preventDefault();rows.push({platform:nextPlatform(),handle:''});render();});
         function open(){try{rows=JSON.parse(localStorage.getItem(KEY))||[];}catch(_){rows=[];}if(!Array.isArray(rows))rows=[];render();bd.style.display='flex';}
         function close(){bd.style.display='none';}
         var trig=document.getElementById('obAddLink');if(trig)trig.addEventListener('click',function(e){e.preventDefault();open();});
         document.getElementById('lnkCancel').addEventListener('click',function(e){e.preventDefault();close();});
         bd.addEventListener('click',function(e){if(e.target===bd)close();});
         function fullUrl(r){var h=(r.handle||'').trim();if(!h)return '';if(/^https?:\/\//i.test(h))return h;var p=(PLAT[r.platform]||PLAT.Portfolio).pre;return p+h.replace(/^@+/,'');}
         saveEl.addEventListener('click',function(){if(saveEl.disabled)return;
           var kept=rows.filter(function(r){return (r.handle||'').trim();});
           localStorage.setItem(KEY,JSON.stringify(kept));
           var url=kept[0]?fullUrl(kept[0]):'';
           var done=function(){close();if(window.__refreshSteps)window.__refreshSteps();};
           fetch('/api/onboarding/link',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({link:url})}).then(done,done);
         });
       })();
     </script>
     <script>
       (function(){
         var bd=document.getElementById('pchBackdrop');
         if(!bd)return;
         function initDD(id,onChange){
           var dd=document.getElementById(id);if(!dd)return;
           var btn=dd.querySelector('.pf-dd-btn'),val=dd.querySelector('.pf-dd-val'),menu=dd.querySelector('.pf-dd-menu');
           btn.addEventListener('click',function(e){e.preventDefault();e.stopPropagation();var open=dd.classList.toggle('open');menu.style.display=open?'block':'none';});
           dd.querySelectorAll('.pf-opt').forEach(function(o){o.addEventListener('click',function(){
             val.textContent=o.querySelector('.pf-opt-t').textContent;
             dd.querySelectorAll('.pf-opt').forEach(function(x){x.classList.remove('sel');});o.classList.add('sel');
             dd.classList.remove('open');menu.style.display='none';
             if(onChange)onChange(o.getAttribute('data-v'));});});
         }
         document.addEventListener('click',function(){document.querySelectorAll('.pf-dd.open').forEach(function(dd){dd.classList.remove('open');dd.querySelector('.pf-dd-menu').style.display='none';});});
         initDD('ddAbout',function(v){
           document.getElementById('aboutPortfolio').style.display=(v==='write')?'none':'flex';
           document.getElementById('aboutText').style.display=(v==='write')?'block':'none';
         });
         initDD('ddWork');
         var cards=bd.querySelectorAll('.pch-card');
         cards.forEach(function(c){c.addEventListener('click',function(){cards.forEach(function(x){x.classList.remove('sel');});c.classList.add('sel');});});
         function chosenMode(){var s=bd.querySelector('.pch-card.sel');return s?s.getAttribute('data-v'):'ai';}
         function open(){bd.style.display='flex';}
         function close(){bd.style.display='none';}
         var t=document.getElementById('obPitch');if(t)t.addEventListener('click',function(e){e.preventDefault();open();});
         document.getElementById('pchClose').addEventListener('click',close);
         document.getElementById('pchBack').addEventListener('click',close);
         bd.addEventListener('click',function(e){if(e.target===bd)close();});
         var genBtn=document.getElementById('pchGen');
         genBtn.addEventListener('click',function(){
           var data={mode:chosenMode(),about:document.querySelector('#ddAbout .pf-dd-val').textContent,aboutUrl:(document.getElementById('aboutUrl')||{}).value,aboutText:(document.getElementById('aboutText')||{}).value,work:document.querySelector('#ddWork .pf-dd-val').textContent,workUrl:(document.getElementById('workUrl')||{}).value};
           localStorage.setItem('lepton_pitch_setup',JSON.stringify(data));
           if(data.mode!=='ai'){close();if(window.__openTemplate)window.__openTemplate();return;}
           // Bento writes it: ask the server (GPT-5.4-mini + pitch guide) for a draft, then open the editor prefilled.
           genBtn.disabled=true;var label=genBtn.textContent;genBtn.textContent='GENERATING…';
           fetch('/api/onboarding/generate-pitch',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)})
             .then(function(r){return r.json();})
             .then(function(j){
               genBtn.disabled=false;genBtn.textContent=label;
               close();
               if(window.__openTemplate)window.__openTemplate(j&&j.ok?{subject:j.subject,body:j.body}:null);
               if(!(j&&j.ok))alert((j&&j.error)||'Could not generate a pitch. You can write your own.');
             })
             .catch(function(){genBtn.disabled=false;genBtn.textContent=label;close();if(window.__openTemplate)window.__openTemplate(null);});
         });
       })();
     </script>
     <script>
       (function(){
         var bd=document.getElementById('tplBackdrop');if(!bd)return;
         window.__openTemplate=function(prefill){
           if(prefill){
             var s=document.getElementById('tplSubject');if(s&&prefill.subject)s.value=prefill.subject;
             var b=document.getElementById('tplBody');if(b&&prefill.body)b.value=prefill.body;
           }
           bd.style.display='flex';
         };
         function close(){bd.style.display='none';}
         var pch=function(){return document.getElementById('pchBackdrop');};
         document.getElementById('tplClose').addEventListener('click',function(){close();if(pch())pch().style.display='none';});
         document.getElementById('tplBack').addEventListener('click',function(){close();if(pch())pch().style.display='flex';});
         bd.addEventListener('click',function(e){if(e.target===bd)close();});
         bd.querySelectorAll('.tpl-tag').forEach(function(t){t.addEventListener('click',function(){
           var tgt=document.getElementById(t.getAttribute('data-target'));if(!tgt)return;
           var ins=t.getAttribute('data-tag'),s=tgt.selectionStart,e=tgt.selectionEnd;
           if(typeof s==='number'){tgt.value=tgt.value.slice(0,s)+ins+tgt.value.slice(e);tgt.focus();tgt.selectionStart=tgt.selectionEnd=s+ins.length;}
           else{tgt.value+=ins;tgt.focus();}});});
         document.getElementById('tplSave').addEventListener('click',function(){
           var body=(document.getElementById('tplBody')||{}).value||'';
           localStorage.setItem('lepton_email_template',JSON.stringify({name:(document.getElementById('tplName')||{}).value,subject:(document.getElementById('tplSubject')||{}).value,body:body}));
           var done=function(){close();if(pch())pch().style.display='none';if(window.__refreshSteps)window.__refreshSteps();};
           fetch('/api/onboarding/pitch-template',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({body:body})}).then(done,done);
         });
       })();
     </script>
     <script>
       (function(){
         // Source of truth is the backend (/api/onboarding); localStorage is only a pre-load fallback.
         var SNAP=null;
         function hasLinksLS(){try{var a=JSON.parse(localStorage.getItem('lepton_portfolio_links'));return Array.isArray(a)&&a.length>0;}catch(_){return false;}}
         function hasTemplateLS(){try{return !!JSON.parse(localStorage.getItem('lepton_email_template'));}catch(_){return false;}}
         function doneStates(){
           if(SNAP){
             var sd=SNAP.stepsDone||[];
             return [!!SNAP.link, !!SNAP.pitchTemplate, !!SNAP.followupTemplate, sd.indexOf('first_send')>=0];
           }
           return [hasLinksLS(),hasTemplateLS(),false,false];
         }
         function compute(){
           var done=doneStates(),prevAll=true;
           for(var i=0;i<4;i++){
             var el=document.getElementById('ob-s'+(i+1));if(!el)continue;
             var state=done[i]?'done':(prevAll?'active':'locked');
             el.classList.remove('ob-active','ob-locked','ob-done');el.classList.add('ob-'+state);
             var tag=el.querySelector('.ob-tag');
             if(tag){if(state==='active')tag.innerHTML=el.getAttribute('data-badge')?'<span class="ob-badge">'+el.getAttribute('data-badge')+'</span>':'';
               else if(state==='locked')tag.innerHTML=el.getAttribute('data-note')?'<span class="ob-note">'+el.getAttribute('data-note')+'</span>':'';
               else tag.innerHTML='';}
             var btn=el.querySelector('.ob-btn');if(btn)btn.style.display=(state==='active')?'inline-flex':'none';
             prevAll=prevAll&&done[i];
           }
         }
         function refresh(){return fetch('/api/onboarding').then(function(r){return r.json();}).then(function(j){if(j&&j.ok)SNAP=j;compute();}).catch(function(){compute();});}
         window.__refreshSteps=refresh;
         refresh();
       })();
     </script>`,
  )
}

export function startOnboardingView(_email: string): string {
  return page(
    'Get started',
    `<div class="sob">
       <div class="sob-top"><span class="sob-pill" id="stepPill">Step 1/2</span></div>
       <h1 class="sob-h" id="stepTitle">Let's Get To Know You ✍️</h1>
       <div id="errBar" class="sob-err" style="display:none"></div>

       <section id="step1" class="sob-card">
         <label class="sob-lab">Your Name <span class="req">*</span></label>
         <input id="f_name" class="sob-in" placeholder="Your name" autocomplete="name">

         <label class="sob-lab">Who are you? <span class="req">*</span></label>
         <div class="sob-dd" id="rolesDD">
           <button type="button" class="sob-ddbtn" id="rolesBtn"><span class="ph">Select all that apply</span><span class="car">▾</span></button>
           <div class="sob-ddpanel" id="rolesPanel" style="display:none"></div>
         </div>

         <label class="sob-lab">Who do you want to pitch to? <span class="req">*</span></label>
         <input id="f_pitch" class="sob-in" placeholder="Restaurant managers, PR team, Event sponsors, Influencers, Marketing managers...">

         <div class="sob-sub">
           <div class="sob-subh">Where are you in your brand deal journey?</div>
           <div class="sob-subnote">Select an option below.</div>
           <div class="sob-pills" id="journeyPills"></div>
         </div>

         <div class="sob-sub">
           <div class="sob-subh">How did you hear about us?</div>
           <div class="sob-subnote">Select an option below.</div>
           <div class="sob-pills" id="heardPills"></div>
         </div>
       </section>

       <section id="step2" class="sob-card" style="display:none">
         <div class="sob-subh">What brand categories do you want to see?</div>
         <div class="sob-subnote">Select all categories you want to see. You can always change this later.</div>
         <div class="sob-pills" id="catPills" style="margin-top:18px"></div>
       </section>

       <div class="sob-foot">
         <button type="button" class="sob-back" id="backBtn" style="visibility:hidden">⟵ BACK</button>
         <button type="button" class="sob-next" id="nextBtn">NEXT <span>➔</span></button>
       </div>
     </div>
     <style>
       body{background:#f6f5f1}
       .sob{max-width:1000px;margin:0 auto;padding:36px 24px 80px}
       .sob-top{display:flex;justify-content:center;margin-bottom:22px}
       .sob-pill{border:1px solid #111;border-radius:999px;padding:8px 20px;font-size:15px;font-weight:600;background:#fff}
       .sob-h{text-align:center;font-size:46px;letter-spacing:-.02em;margin-bottom:26px}
       .sob-err{max-width:880px;margin:0 auto 16px;background:#111;color:#fff;border-radius:10px;padding:12px 16px;font-size:14px}
       .sob-card{background:#fff;border-radius:22px;padding:34px 38px;box-shadow:0 1px 2px rgba(0,0,0,.04);max-width:880px;margin:0 auto}
       .sob-lab{display:block;font-size:17px;font-weight:500;margin:22px 0 8px;color:#111}
       .sob-lab:first-child{margin-top:0}
       .req{color:#111}
       .sob-in{width:100%;border:1px solid #d9d7d0;border-radius:14px;padding:16px 18px;font-size:16px;background:#fff;font-family:inherit}
       .sob-in:focus{outline:none;border-color:#111}
       .sob-in::placeholder{color:#a8a49a}
       .sob-dd{position:relative}
       .sob-ddbtn{width:100%;text-align:left;border:1px solid #d9d7d0;border-radius:14px;padding:16px 18px;font-size:16px;background:#fff;cursor:pointer;display:flex;justify-content:space-between;align-items:center}
       .sob-ddbtn .ph{color:#a8a49a}
       .sob-ddpanel{position:absolute;z-index:20;left:0;right:0;margin-top:6px;background:#fff;border:1px solid #111;border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.14);padding:8px;max-height:280px;overflow:auto}
       .sob-ddopt{display:flex;align-items:center;gap:10px;padding:11px 12px;border-radius:10px;cursor:pointer;font-size:15px}
       .sob-ddopt:hover{background:#f4f3ef}
       .sob-ddopt input{width:auto}
       .sob-sub{border:1px solid #ece9e2;border-radius:16px;padding:22px 24px;margin-top:22px}
       .sob-subh{font-size:18px;font-weight:600;color:#111}
       .sob-subnote{font-size:14px;color:#8a867c;margin-top:4px}
       .sob-pills{display:flex;flex-wrap:wrap;gap:12px;margin-top:16px}
       .sob-chip{border:1px solid #d9d7d0;border-radius:999px;padding:11px 18px;font-size:15px;background:#fff;cursor:pointer;user-select:none;line-height:1.2}
       .sob-chip:hover{border-color:#111}
       .sob-chip.on{background:#111;color:#fff;border-color:#111}
       .sob-foot{max-width:880px;margin:26px auto 0;display:flex;justify-content:space-between;align-items:center}
       .sob-back{background:none;border:none;color:#14492e;font-weight:700;font-size:15px;letter-spacing:.04em;cursor:pointer}
       .sob-next{background:#14492e;color:#fff;border:none;border-radius:12px;padding:15px 30px;font-size:15px;font-weight:700;letter-spacing:.04em;cursor:pointer;display:inline-flex;gap:10px;align-items:center}
       .sob-next:hover{background:#0e3a24}
       .sob-next[disabled]{opacity:.6;cursor:default}
       @media(max-width:680px){.sob-h{font-size:32px}.sob-card{padding:24px}}
     </style>
     <script>
       (function(){
         var ROLES=["Creator / Influencer","UGC Creator","Founder / Business Owner","Marketer","Agency / Manager","Freelancer","Other"];
         var JOURNEY=[
           {e:"\\uD83C\\uDF31",t:"Brand new - working toward my first deal"},
           {e:"\\u2709\\uFE0F",t:"Done some creator work, but new to pitching"},
           {e:"\\uD83D\\uDD01",t:"Tried pitching, want better results"},
           {e:"\\uD83D\\uDCBC",t:"I work with brands regularly and want to streamline my workflow"}
         ];
         var HEARD=["From a friend or colleague","Instagram","TikTok","Google","Twitter / X","Community Group/Course","YouTube","Other"];
         var CATS=["Fashion","Women's Fashion","Men's Fashion","Activewear","Fashion Accessories","Beauty & Personal Care","Travel","Vehicles & Transportation","Baby, Kids, & Family","Apps & Software","Games & Entertainment","Home","Technology & Electronics","Lifestyle","Arts & Crafts","Health & Wellness","Sports & Fitness","Pets","Food & Beverage","Professional Services","Education","General Retailers & E-Commerce Platforms"];
         var state={name:"",roles:[],pitchTo:"",journey:"",heardFrom:"",brandCategories:[]};
         var step=1;
         function el(id){return document.getElementById(id);}
         function showErr(m){var b=el("errBar");if(!m){b.style.display="none";return;}b.textContent=m;b.style.display="block";window.scrollTo({top:0,behavior:"smooth"});}

         // roles multiselect
         var panel=el("rolesPanel");
         ROLES.forEach(function(r){
           var lab=document.createElement("label");lab.className="sob-ddopt";
           var cb=document.createElement("input");cb.type="checkbox";cb.value=r;
           cb.addEventListener("change",function(){
             if(cb.checked){if(state.roles.indexOf(r)<0)state.roles.push(r);}
             else{state.roles=state.roles.filter(function(x){return x!==r;});}
             paintRoles();
           });
           lab.appendChild(cb);lab.appendChild(document.createTextNode(r));panel.appendChild(lab);
         });
         function paintRoles(){
           var btn=el("rolesBtn");
           if(state.roles.length){btn.innerHTML="<span>"+state.roles.join(", ")+"</span><span class=car>\\u25BE</span>";}
           else{btn.innerHTML="<span class=ph>Select all that apply</span><span class=car>\\u25BE</span>";}
         }
         el("rolesBtn").addEventListener("click",function(e){e.stopPropagation();panel.style.display=panel.style.display==="none"?"block":"none";});
         document.addEventListener("click",function(e){if(!el("rolesDD").contains(e.target))panel.style.display="none";});

         // single-select pills
         function pills(container,items,key){
           var box=el(container);
           items.forEach(function(it){
             var label=(typeof it==="string")?it:(it.e+" "+it.t);
             var val=(typeof it==="string")?it:it.t;
             var c=document.createElement("div");c.className="sob-chip";c.textContent=label;
             c.addEventListener("click",function(){
               state[key]=(state[key]===val)?"":val;
               Array.prototype.forEach.call(box.children,function(ch){ch.classList.remove("on");});
               if(state[key])c.classList.add("on");
             });
             box.appendChild(c);
           });
         }
         pills("journeyPills",JOURNEY,"journey");
         pills("heardPills",HEARD,"heardFrom");

         // multi-select category pills
         var catBox=el("catPills");
         CATS.forEach(function(cat){
           var c=document.createElement("div");c.className="sob-chip";c.textContent=cat;
           c.addEventListener("click",function(){
             var i=state.brandCategories.indexOf(cat);
             if(i<0){state.brandCategories.push(cat);c.classList.add("on");}
             else{state.brandCategories.splice(i,1);c.classList.remove("on");}
           });
           catBox.appendChild(c);
         });

         function gotoStep(n){
           step=n;
           el("step1").style.display=(n===1)?"block":"none";
           el("step2").style.display=(n===2)?"block":"none";
           el("stepPill").textContent="Step "+n+"/2";
           el("stepTitle").textContent=(n===1)?"Let's Get To Know You \\u270D\\uFE0F":"Your Brand Types \\uD83D\\uDDC2\\uFE0F";
           el("backBtn").style.visibility=(n===2)?"visible":"hidden";
           showErr("");window.scrollTo({top:0,behavior:"smooth"});
         }
         el("backBtn").addEventListener("click",function(){gotoStep(1);});

         el("nextBtn").addEventListener("click",function(){
           if(step===1){
             state.name=el("f_name").value.trim();
             state.pitchTo=el("f_pitch").value.trim();
             if(!state.name)return showErr("Please enter your name.");
             if(!state.roles.length)return showErr("Please select who you are.");
             if(!state.pitchTo)return showErr("Please tell us who you want to pitch to.");
             gotoStep(2);return;
           }
           if(!state.brandCategories.length)return showErr("Pick at least one brand category.");
           var btn=el("nextBtn");btn.disabled=true;btn.textContent="Saving…";
           fetch("/api/onboarding/intake",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(state)})
             .then(function(r){return r.json();})
             .then(function(j){
               if(j&&j.ok){window.location=j.next||"/dashboard";}
               else{btn.disabled=false;btn.innerHTML="NEXT <span>\\u2794</span>";showErr((j&&j.error)||"Something went wrong. Try again.");}
             })
             .catch(function(){btn.disabled=false;btn.innerHTML="NEXT <span>\\u2794</span>";showErr("Network error. Try again.");});
         });

         paintRoles();
       })();
     </script>`,
  )
}

// Shared top bar with the three product tabs (Source / Qualifying / Outbound).
function shellNav(email: string, active: 'source' | 'qualifying' | 'outbound'): string {
  const tab = (href: string, label: string, key: string) =>
    `<a href="${href}" class="ptab${active === key ? ' on' : ''}">${label}</a>`
  return `<div class="nav"><a class="brand" href="/outbound" style="text-decoration:none"><span class="mark"></span>Lepton</a>
     <div class="ptabs">${tab('/source', 'Source', 'source')}${tab('/qualifying', 'Qualifying', 'qualifying')}${tab('/outbound', 'Outbound', 'outbound')}</div>
     <div class="row"><span class="muted" style="align-self:center">${email}</span>
       <form method="post" action="/logout"><button class="btn ghost" type="submit">Log out</button></form>
     </div>
   </div>`
}

export function sourceView(email: string): string {
  return page(
    'Source — Lepton',
    shellNav(email, 'source') +
      `<div class="wrap" style="max-width:1320px">
       <div class="flex"><h3>Source leads</h3>
         <div class="row2">
           <label class="hint" for="listSel" style="margin:0">List</label>
           <select id="listSel" style="width:260px"></select>
           <button class="btn sm" id="newList">+ New list</button>
         </div>
       </div>
       <p class="hint">A list is a container of leads. Create one with <b>+ New list</b>, then fill it three ways: add rows by hand, <b>Source from Instagram</b> (HikerAPI), or <b>Import from Attio</b>. Lists persist and are shared with Outbound. <span id="hikerNote"></span></p>

       <!-- FILL THE CURRENT LIST: Attio (left) + Source from Instagram (right) -->
       <div class="row2 mt" style="align-items:stretch;gap:14px">
         <!-- LEFT: Import from Attio -->
         <div class="card" style="flex:1">
           <h4 style="margin-top:0">Import from Attio</h4>
           <!-- not connected: paste key inline -->
           <div id="atConnect" style="display:none">
             <div class="hint">Connect Attio to import records. Paste a workspace API key (Attio → Settings → Developers).</div>
             <input id="atKey" type="password" placeholder="Attio API key" class="mt">
             <button class="btn sm mt" id="atConnectBtn">Connect Attio</button>
             <p class="mono mt" id="atConnMsg"></p>
           </div>
           <!-- connected: pick object → map columns → import -->
           <div id="atConnected" class="flex" style="display:none;align-items:center;margin-bottom:6px">
             <span class="mono" style="color:var(--green,#1f9d63)">● Attio connected</span>
             <button class="x" id="atDisconnect" title="remove key">✕ remove key</button>
           </div>
           <div id="atBox" style="display:none">
             <label>1. Object type</label><select id="atObj"></select>
             <label class="mt">From list <span class="hint">(optional — pick a subset instead of the whole object)</span></label><select id="atList"></select>
             <div class="hint mt">2. Map each table column → an Attio attribute:</div>
             <div id="atMap" class="mt">
               <div style="display:flex;align-items:center;gap:10px;margin-top:8px"><span style="width:96px;color:var(--mut);font-size:13px;flex:0 0 auto">Instagram</span><select id="mapIg" style="flex:1"></select></div>
               <div style="display:flex;align-items:center;gap:10px;margin-top:8px"><span style="width:96px;color:var(--mut);font-size:13px;flex:0 0 auto">Name</span><select id="mapName" style="flex:1"></select></div>
               <div style="display:flex;align-items:center;gap:10px;margin-top:8px"><span style="width:96px;color:var(--mut);font-size:13px;flex:0 0 auto">Phone</span><select id="mapPhone" style="flex:1"></select></div>
               <div style="display:flex;align-items:center;gap:10px;margin-top:8px"><span style="width:96px;color:var(--mut);font-size:13px;flex:0 0 auto">Link</span><select id="mapLink" style="flex:1"></select></div>
               <div style="display:flex;align-items:center;gap:10px;margin-top:8px"><span style="width:96px;color:var(--mut);font-size:13px;flex:0 0 auto">Category</span><select id="mapCat" style="flex:1"></select></div>
             </div>
             <div class="hint mt" id="atFilterLbl" style="display:none">3. Filters <span class="hint">(optional — narrow the pull in Attio)</span></div>
             <div id="atFilters" class="mt" style="display:none">
               <div style="display:flex;align-items:center;gap:10px;margin-top:8px"><span style="width:96px;color:var(--mut);font-size:13px;flex:0 0 auto">Channel</span><select id="atChannel" style="flex:1"><option value="">— any channel —</option></select></div>
               <label class="row2 mt" style="margin:8px 0 0;align-items:center"><input type="checkbox" id="atHasEmail" style="width:auto"> <span class="hint">only records with an email</span></label>
             </div>
             <button class="btn sm mt" id="atImport">Import rows → add to current list</button>
             <p class="hint" style="margin-top:6px">Adds the pulled rows onto the list selected above. If none is selected, a new list is created.</p>
             <p class="mono mt" id="atMsg"></p>
           </div>
         </div>
         <!-- RIGHT: Source from Instagram (per-list config) -->
         <div id="cfgCard" class="card" style="flex:1;display:none">
         <div class="flex"><h4 style="margin:0" id="cfgTitle">List</h4>
           <div class="row2"><span class="mono" id="srcStatus"></span>
             <button class="btn ghost sm" id="srcSave">Save</button>
             <button class="btn sm" id="srcStart">Turn on</button>
             <button class="x" id="srcDel">delete</button>
           </div>
         </div>
         <h5 style="margin:14px 0 2px">Source from Instagram</h5>
         <p class="hint" style="margin:0 0 8px">HikerAPI searches the hashtags below and returns the <b>handles</b> posting under them. For each handle we pull its profile (followers, bio link, any public number), keep those in your follower range, then gpt-5.4 web-searches the owner's WhatsApp number. <b>Handles to scan</b> caps how many to examine; <b>Numbers to add</b> stops once that many have a phone. Hit <b>Turn on</b> and rows fill the table below.</p>
         <div class="cfg3 mt">
           <div><label>Handles to scan</label><input type="number" id="cHandles" value="40" min="1"><div class="hint">candidates to examine before stopping</div></div>
           <div><label>Numbers to add</label><input type="number" id="cTarget" value="10" min="1"><div class="hint">stop once this many have a number</div></div>
           <div><label>Refresh every (days)</label><input type="number" id="cRefresh" value="2"><div class="hint">re-run cadence</div></div>
         </div>
         <div class="cfg3 mt">
           <div><label>Followers</label><div class="row2"><input type="number" id="cMin" value="500" style="width:70px"><span class="hint">to</span><input type="number" id="cMax" value="100000" style="width:80px"></div></div>
           <div></div><div></div>
         </div>
         <label class="mt">Hashtags <span class="hint">(comma-separated)</span></label><input id="cTags">
         <label class="row2 mt" style="margin:12px 0 0;cursor:pointer;align-items:center"><input type="checkbox" id="cInstrToggle" style="width:auto"> <span>Phone-finder instruction <span class="hint">(advanced — gpt-5.4 prompt)</span></span></label>
         <div id="cInstrBox" style="display:none;margin-top:6px"><textarea id="cInstr" rows="3"></textarea></div>
       </div>
       </div>

       <!-- LIVE TABLE -->
       <div id="tblWrap" class="mt" style="display:none">
         <div class="muted" style="font-size:12px" id="tblMeta"></div>
         <div style="overflow-x:auto"><table class="tbl" id="srcTbl" style="width:100%"></table></div>
         <div id="addRow" class="row2 mt" style="display:none;gap:10px">
           <button class="btn ghost sm" id="addRowBtn">+ Add row</button>
           <button class="btn ghost sm" id="dedupeBtn" title="AI dedupe + cleanup of the rows">Dedupe (AI)</button>
           <span class="mono" id="dedupeMsg" style="font-size:12px"></span>
         </div>
       </div>
     </div>

     <script>
       var $=function(s){return document.querySelector(s);};
       var J=function(u,o){return fetch(u,o).then(function(r){return r.json();}).catch(function(){return {ok:false,error:'bad response'};});};
       var POST=function(u,b){return J(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b||{})});};
       var PUT=function(u,b){return J(u,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(b||{})});};
       var DEL=function(u){return J(u,{method:'DELETE'});};
       var esc=function(s){return (''+(s==null?'':s)).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});};
       var LISTS=[],CUR=null,POLL=null,ATTRS=[];

       /* ---- sourced lists ---- */
       function loadLists(){return J('/api/source/lists').then(function(j){if(!j.ok)return;LISTS=j.lists;
         if($('#hikerNote'))$('#hikerNote').textContent=j.hiker?'':'(HikerAPI key not set on server — Instagram sourcing will fail.)';
         var sel=$('#listSel');sel.innerHTML='<option value="">— select a list —</option>'+LISTS.map(function(l){return '<option value="'+l.id+'"'+(CUR==l.id?' selected':'')+'>'+esc(l.name)+' ('+(l.size||0)+')</option>';}).join('');});}
       $('#listSel').onchange=function(){var id=$('#listSel').value;openList(id?Number(id):null);};
       /* + New list: create a persistent blank list ("New list N") and open its empty table */
       $('#newList').onclick=function(){$('#newList').disabled=true;
         POST('/api/source/lists/blank').then(function(j){$('#newList').disabled=false;
           if(!j.ok)return;CUR=j.id;loadLists().then(function(){openList(j.id);});});};
       $('#addRowBtn').onclick=function(){if(CUR==null)return;$('#addRowBtn').disabled=true;
         POST('/api/source/lists/'+CUR+'/rows',{}).then(function(){$('#addRowBtn').disabled=false;fetchStatus();});};
       /* AI dedupe + cleanup pass over the current list's rows */
       $('#dedupeBtn').onclick=function(){if(CUR==null)return;
         $('#dedupeBtn').disabled=true;$('#dedupeMsg').textContent='thinking… (gpt-5.4)';
         POST('/api/source/lists/'+CUR+'/dedupe').then(function(j){$('#dedupeBtn').disabled=false;
           if(!j.ok){$('#dedupeMsg').textContent='error: '+(j.error||'failed');return;}
           $('#dedupeMsg').textContent='removed '+(j.removed||0)+' · merged '+(j.modified||0)+(j.capped?' (first 300 rows)':'')+' ✓';
           fetchStatus();loadLists();});};

       function openList(id){CUR=id;if(POLL){clearInterval(POLL);POLL=null;}
         if(!id){$('#cfgCard').style.display='none';$('#tblWrap').style.display='none';$('#addRow').style.display='none';return;}
         $('#listSel').value=id;$('#cfgCard').style.display='';$('#tblWrap').style.display='';$('#addRow').style.display='';
         fetchStatus(true);}

       function fetchStatus(loadCfg){if(CUR==null)return;
         J('/api/source/lists/'+CUR+'/status').then(function(j){if(!j.ok)return;
           var running=(j.status==='running');
           $('#srcStatus').textContent=(running?'● sourcing… ':'')+ (j.found||0)+'/'+(j.target||0)+' phones · '+(j.scanned||0)+' scanned'+(j.status==='error'?' · error':'');
           $('#srcStart').textContent=running?'Sourcing…':'Turn on';$('#srcStart').disabled=running;
           /* editable when idle (manual fill); read-only snapshot while sourcing runs */
           renderTbl(j.rows||[], !running);
           if(running){ if(!POLL)POLL=setInterval(fetchStatus,3000); }
           else { if(POLL){clearInterval(POLL);POLL=null;} }
           if(loadCfg){ /* hydrate config inputs once on open */
             var l=LISTS.filter(function(x){return x.id==CUR;})[0];$('#cfgTitle').textContent=l?l.name:'Source';
             hydrateCfg(j.config);}});}

       $('#srcStart').onclick=function(){if(CUR==null)return;saveCfg(true).then(function(){
         $('#srcStatus').textContent='starting…';POST('/api/source/lists/'+CUR+'/start').then(function(j){
           if(!j.ok){$('#srcStatus').textContent='error: '+(j.error||'failed');return;}
           fetchStatus();/* fetchStatus starts polling while running */});});};
       $('#srcSave').onclick=function(){saveCfg(false);};
       $('#cInstrToggle').onchange=function(){$('#cInstrBox').style.display=this.checked?'':'none';};
       $('#srcDel').onclick=function(){if(CUR==null)return;if(!confirm('Delete this source?'))return;
         DEL('/api/source/lists/'+CUR).then(function(){CUR=null;openList(null);loadLists();});};
       function saveCfg(quiet){if(CUR==null)return Promise.resolve();
         var body={targetHandles:Number($('#cHandles').value)||40,targetPhones:Number($('#cTarget').value)||10,refreshDays:Number($('#cRefresh').value)||2,
           minFollowers:Number($('#cMin').value)||0,maxFollowers:Number($('#cMax').value)||100000,
           hashtags:$('#cTags').value.split(',').map(function(t){return t.trim();}).filter(Boolean),
           instruction:$('#cInstr').value};
         return PUT('/api/source/lists/'+CUR,body).then(function(j){if(!quiet)$('#srcSave').textContent=j.ok?'Saved ✓':'Error';setTimeout(function(){$('#srcSave').textContent='Save';},1200);return j;});}

       /* hydrate the config inputs the first time a list opens (status doesn't return cfg, so pull defaults from server on create) */
       function hydrateCfg(s){if(!s)return;$('#cHandles').value=(s.targetHandles!=null?s.targetHandles:40);$('#cTarget').value=s.targetPhones;$('#cRefresh').value=s.refreshDays;$('#cMin').value=s.minFollowers;$('#cMax').value=s.maxFollowers;$('#cTags').value=(s.hashtags||[]).join(', ');$('#cInstr').value=s.instruction||'';}

       /* ---- live table — editable when idle, read-only snapshot while sourcing ---- */
       var CAP=300; /* cap rendered rows for performance; all rows persist regardless */
       function renderTbl(rows,editable){
         var withPh=rows.filter(function(r){return r.phone;}).length;
         var shown=Math.min(rows.length,CAP);
         $('#tblMeta').textContent=rows.length+' rows · '+withPh+' with a phone'+(rows.length>CAP?(' · showing first '+CAP):'');
         var head='<thead><tr><th>Instagram</th><th>Name</th><th>Phone</th><th>Link</th><th>Category</th><th style="width:28px"></th></tr></thead>';
         var dash='<span class="hint">—</span>';
         var body;
         if(editable){
           body=rows.slice(0,CAP).map(function(r,i){
             function inp(f,v){return '<input class="rcell" data-idx="'+i+'" data-field="'+f+'" value="'+esc(v||'')+'" style="width:100%;border:1px solid #eee;border-radius:6px;background:#fff;padding:7px 8px;font-size:13px">';}
             return '<tr>'
               +'<td>'+inp('instagram_handle',r.instagram_handle)+'</td>'
               +'<td>'+inp('name',r.name)+'</td>'
               +'<td>'+inp('phone',r.phone)+'</td>'
               +'<td>'+inp('event_link',r.event_link)+'</td>'
               +'<td>'+inp('category',r.category)+'</td>'
               +'<td><button class="x" title="delete row" onclick="delRow('+i+')">✕</button></td></tr>';}).join('');
         } else {
           body=rows.slice(0,CAP).map(function(r){
             return '<tr><td>'+(r.instagram_handle?'@'+esc(r.instagram_handle):dash)+'</td>'
               +'<td>'+(r.name?esc(r.name):dash)+'</td>'
               +'<td>'+(r.phone?'<span class="mono">'+esc(r.phone)+'</span>':dash)+'</td>'
               +'<td>'+(r.event_link?('<a href="'+esc(r.event_link)+'" target="_blank" rel="noopener">link ↗</a>'):dash)+'</td>'
               +'<td>'+(r.category?esc(r.category):dash)+'</td><td></td></tr>';}).join('');
         }
         $('#srcTbl').innerHTML=head+'<tbody>'+(body||'<tr><td colspan="6" class="muted">Empty list — click <b>+ Add row</b> to fill it manually, set hashtags &amp; Turn on, or import from Attio.</td></tr>')+'</tbody>';
         if(editable)wireCells();
         void shown;}
       function wireCells(){Array.prototype.slice.call(document.querySelectorAll('#srcTbl .rcell')).forEach(function(inp){
         inp.onchange=function(){if(CUR==null)return;var idx=inp.getAttribute('data-idx');var row={};
           Array.prototype.slice.call(document.querySelectorAll('#srcTbl .rcell[data-idx="'+idx+'"]')).forEach(function(x){row[x.getAttribute('data-field')]=x.value;});
           PUT('/api/source/lists/'+CUR+'/rows/'+idx,row).then(function(){var l=LISTS.filter(function(x){return x.id==CUR;})[0];});};});}
       window.delRow=function(idx){if(CUR==null)return;DEL('/api/source/lists/'+CUR+'/rows/'+idx).then(function(){fetchStatus();loadLists();});};

       /* ---- Attio import (ported here, with column→attribute mapping) ---- */
       function loadAttio(){J('/api/settings').then(function(j){
         var connected=j&&j.attioConnected;
         $('#atConnect').style.display=connected?'none':'';
         $('#atConnected').style.display=connected?'':'none';
         $('#atBox').style.display=connected?'':'none';
         if(connected)loadObjects();});}
       $('#atConnectBtn').onclick=function(){var k=$('#atKey').value.trim();if(k.length<10){$('#atConnMsg').textContent='paste your Attio API key';return;}
         $('#atConnMsg').textContent='connecting…';$('#atConnectBtn').disabled=true;
         POST('/api/attio/connect',{key:k}).then(function(j){$('#atConnectBtn').disabled=false;
           if(!j.ok){$('#atConnMsg').textContent='error: '+(j.error||'failed');return;}
           $('#atConnMsg').textContent='';$('#atKey').value='';loadAttio();});};
       $('#atDisconnect').onclick=function(){if(!confirm('Remove the Attio key? Imports will stop until you paste a key again.'))return;
         POST('/api/attio/disconnect').then(function(){$('#atMsg').textContent='';loadAttio();});};
       function loadObjects(){J('/api/attio/objects').then(function(j){if(!j.ok){$('#atMsg').textContent=j.error||'connect Attio first';return;}
         $('#atObj').innerHTML=j.objects.map(function(o){return '<option value="'+o.api_slug+'">'+esc(o.plural||o.singular||o.api_slug)+'</option>';}).join('');$('#atObj').onchange=objChange;objChange();});}
       var ATEMAIL='';
       function objChange(){var obj=$('#atObj').value;if(!obj)return;
         /* lists for the optional subset */
         J('/api/attio/objects/'+obj+'/lists').then(function(r){var lists=(r&&r.ok&&r.lists)||[];
           $('#atList').innerHTML='<option value="">— whole object —</option>'+lists.map(function(l){return '<option value="'+l.id+'">'+esc(l.name)+'</option>';}).join('');});
         /* attributes + server-side coverage-aware suggestion (auto-map) + filter options */
         Promise.all([J('/api/attio/objects/'+obj+'/attributes'),J('/api/attio/objects/'+obj+'/suggest')]).then(function(r){
           ATTRS=(r[0]&&r[0].ok)?r[0].attributes:[];var sg=(r[1]&&r[1].ok)?r[1]:{};var m=sg.mapping||{};
           var opts=ATTRS.map(function(a){return '<option value="'+a.api_slug+'">'+esc(a.title)+' ('+a.type+')</option>';}).join('');
           var none='<option value="">— none —</option>';
           $('#mapPhone').innerHTML=none+opts;$('#mapName').innerHTML=none+opts;$('#mapIg').innerHTML=none+opts;$('#mapLink').innerHTML=none+opts;$('#mapCat').innerHTML=none+opts;
           var bySlug=function(s){return (ATTRS.filter(function(a){return a.api_slug===s;})[0]||{}).api_slug;};
           var byType=function(t){return (ATTRS.filter(function(a){return a.type===t;})[0]||{}).api_slug;};
           /* prefer the server's suggestion (skips empty columns); fall back to local heuristics */
           $('#mapPhone').value=m.phone||byType('phone-number')||'';
           $('#mapName').value=m.name||byType('personal-name')||bySlug('name')||'';
           $('#mapIg').value=m.instagram||bySlug('instagram')||'';
           $('#mapLink').value=m.link||bySlug('external_url')||bySlug('bio_links')||bySlug('linkedin')||'';
           $('#mapCat').value=bySlug('instagram_category')||bySlug('categories')||bySlug('lead_source')||'';
           ATEMAIL=m.email||'';
           /* filters: channel options + has-email availability (hidden if the object offers neither) */
           var ch=sg.channelOptions||[];
           $('#atChannel').innerHTML='<option value="">— any channel —</option>'+ch.map(function(o){return '<option value="'+esc(o)+'">'+esc(o)+'</option>';}).join('');
           $('#atHasEmail').checked=false;$('#atHasEmail').disabled=!sg.hasEmail;
           var hasFilters=(ch.length||sg.hasEmail);
           $('#atFilterLbl').style.display=hasFilters?'':'none';$('#atFilters').style.display=hasFilters?'':'none';});}
       $('#atImport').onclick=function(){
         var vars=[];if(ATEMAIL)vars.push(ATEMAIL);
         var mapping={phone:$('#mapPhone').value||undefined,name:$('#mapName').value||undefined,
           instagram:$('#mapIg').value||undefined,link:$('#mapLink').value||undefined,category:$('#mapCat').value||undefined,vars:vars};
         var filter={};if($('#atChannel').value)filter.primaryChannel=$('#atChannel').value;if($('#atHasEmail').checked)filter.hasEmail=true;
         var body={object:$('#atObj').value,listId:$('#atList').value||undefined,mapping:mapping,filter:Object.keys(filter).length?filter:undefined};
         function doImport(listId){
           $('#atMsg').textContent='importing… (a whole object can take a moment)';$('#atImport').disabled=true;
           POST('/api/source/lists/'+listId+'/import-attio',body).then(function(j){
             $('#atImport').disabled=false;
             if(!j.ok){$('#atMsg').textContent='error: '+(j.error||'failed');return;}
             $('#atMsg').textContent='added '+j.added+' rows ✓'+(j.skippedNoPhone?(' ('+j.skippedNoPhone+' no phone)'):'')+(j.skippedSuppressed?(' ('+j.skippedSuppressed+' recently contacted)'):'');
             CUR=listId;loadLists().then(function(){openList(listId);});
           });
         }
         /* add onto the currently-open list, or spin up a new one to receive the rows */
         if(CUR!=null){doImport(CUR);}
         else{POST('/api/source/lists/blank').then(function(j){if(j.ok)doImport(j.id);});}};

       loadLists();loadAttio();
     </script>`,
  )
}

export function qualifyingView(email: string): string {
  return page(
    'Qualifying — Lepton',
    shellNav(email, 'qualifying') +
      `<div class="wrap" style="max-width:1320px">
       <div class="flex"><h3>Qualify leads</h3>
         <div class="row2">
           <label class="hint" for="qListSel" style="margin:0">List</label>
           <select id="qListSel" style="width:280px"></select>
         </div>
       </div>
       <p class="hint">Pick a list, describe your <b>ideal lead</b> in the box, and gpt-5.4 scores every row <b>0–100</b> with a <b>tier</b> and a one-sentence <b>reason</b>. Each Instagram handle is re-checked against live profile data (followers, bio, business flag) first, so the score is grounded — the model judges only the data shown, it doesn't guess. <span id="qAiNote"></span></p>

       <!-- CRITERIA + RUN -->
       <div id="qCfg" class="card mt" style="display:none">
         <div class="flex"><h4 style="margin:0" id="qTitle">List</h4>
           <div class="row2"><span class="mono" id="qStatus"></span>
             <button class="btn ghost sm" id="qSave">Save</button>
             <button class="btn sm" id="qRun">Qualify</button>
           </div>
         </div>
         <label class="mt">How to qualify <span class="hint">(plain English — your ideal lead + disqualifiers)</span></label>
         <textarea id="qCriteria" rows="6"></textarea>
         <div id="qBreak" class="row2 mt" style="display:none;gap:14px;align-items:center">
           <span class="badge hot" id="qHot">hot 0</span>
           <span class="badge warm" id="qWarm">warm 0</span>
           <span class="badge cold" id="qCold">cold 0</span>
           <span style="flex:1"></span>
           <button class="btn ghost sm" id="qSpinHot" title="new list of leads scoring 70+">＋ List from hot</button>
           <button class="btn ghost sm" id="qSpinWarm" title="new list of leads scoring 40+">＋ List from warm+</button>
           <span class="mono" id="qSpinMsg" style="font-size:12px"></span>
         </div>
       </div>

       <!-- LIVE SCORED TABLE -->
       <div id="qTblWrap" class="mt" style="display:none">
         <div class="muted" style="font-size:12px" id="qMeta"></div>
         <div style="overflow-x:auto"><table class="tbl" id="qTbl" style="width:100%"></table></div>
       </div>
     </div>

     <style>
       .badge{display:inline-block;padding:2px 9px;border-radius:999px;font-size:12px;font-weight:600;border:1px solid #ddd}
       .badge.hot{background:#fdecea;color:#b3261e;border-color:#f3c0bb}
       .badge.warm{background:#fff5e6;color:#9a6400;border-color:#f0d9a8}
       .badge.cold{background:#eef1f4;color:#5b6670;border-color:#dde2e7}
       #qTbl td .rs{font-variant-numeric:tabular-nums;font-weight:600}
     </style>

     <script>
       var $=function(s){return document.querySelector(s);};
       var J=function(u,o){return fetch(u,o).then(function(r){return r.json();}).catch(function(){return {ok:false,error:'bad response'};});};
       var POST=function(u,b){return J(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b||{})});};
       var PUT=function(u,b){return J(u,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(b||{})});};
       var esc=function(s){return (''+(s==null?'':s)).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});};
       var LISTS=[],CUR=null,POLL=null,HYDRATED=false;

       function loadLists(){return J('/api/qualify/lists').then(function(j){if(!j.ok)return;LISTS=j.lists;
         if($('#qAiNote'))$('#qAiNote').textContent=j.ai?'':'(OPENAI_API_KEY not set on server — qualifying will fail.)';
         var sel=$('#qListSel');sel.innerHTML='<option value="">— select a list —</option>'+LISTS.map(function(l){return '<option value="'+l.id+'"'+(CUR==l.id?' selected':'')+'>'+esc(l.name)+' ('+(l.size||0)+')</option>';}).join('');});}
       $('#qListSel').onchange=function(){var id=$('#qListSel').value;openList(id?Number(id):null);};

       function openList(id){CUR=id;HYDRATED=false;if(POLL){clearInterval(POLL);POLL=null;}
         if(!id){$('#qCfg').style.display='none';$('#qTblWrap').style.display='none';return;}
         $('#qListSel').value=id;$('#qCfg').style.display='';$('#qTblWrap').style.display='';
         var l=LISTS.filter(function(x){return x.id==CUR;})[0];$('#qTitle').textContent=l?l.name:'List';
         fetchStatus();}

       function fetchStatus(){if(CUR==null)return;
         J('/api/qualify/lists/'+CUR+'/status').then(function(j){if(!j.ok)return;
           var running=(j.status==='running');
           $('#qStatus').textContent=(running?'● scoring… ':'')+(j.scanned||0)+'/'+(j.total||0)+' scored'+(j.status==='error'?' · error':'');
           $('#qRun').textContent=running?'Qualifying…':'Qualify';$('#qRun').disabled=running;
           if(!HYDRATED){$('#qCriteria').value=j.criteria||'';HYDRATED=true;}
           var c=j.counts||{hot:0,warm:0,cold:0,scored:0};
           $('#qBreak').style.display=c.scored?'flex':'none';
           $('#qHot').textContent='hot '+c.hot;$('#qWarm').textContent='warm '+c.warm;$('#qCold').textContent='cold '+c.cold;
           renderTbl(j.rows||[]);
           if(running){if(!POLL)POLL=setInterval(fetchStatus,3000);}else{if(POLL){clearInterval(POLL);POLL=null;}}});}

       $('#qSave').onclick=function(){if(CUR==null)return;
         PUT('/api/qualify/lists/'+CUR,{criteria:$('#qCriteria').value}).then(function(j){
           $('#qSave').textContent=j.ok?'Saved ✓':'Error';setTimeout(function(){$('#qSave').textContent='Save';},1200);});};
       $('#qRun').onclick=function(){if(CUR==null)return;$('#qStatus').textContent='starting…';
         POST('/api/qualify/lists/'+CUR+'/run',{criteria:$('#qCriteria').value}).then(function(j){
           if(!j.ok){$('#qStatus').textContent='error: '+(j.error||'failed');return;}fetchStatus();});};

       function spin(min){if(CUR==null)return;$('#qSpinMsg').textContent='creating…';
         POST('/api/qualify/lists/'+CUR+'/spinoff',{min:min}).then(function(j){
           if(!j.ok){$('#qSpinMsg').textContent='error: '+(j.error||'failed');return;}
           $('#qSpinMsg').textContent='created "'+esc(j.name)+'" ('+j.count+') ✓ — find it in Source & Outbound';loadLists();});}
       $('#qSpinHot').onclick=function(){spin(70);};
       $('#qSpinWarm').onclick=function(){spin(40);};

       var CAP=300;
       function renderTbl(rows){
         var scored=rows.filter(function(r){return r.tier;}).length;
         $('#qMeta').textContent=rows.length+' rows · '+scored+' scored'+(rows.length>CAP?(' · showing first '+CAP):'');
         var head='<thead><tr><th>Instagram</th><th>Name</th><th>Phone</th><th style="width:56px">Score</th><th style="width:64px">Tier</th><th>Reason</th></tr></thead>';
         var dash='<span class="hint">—</span>';
         var body=rows.slice(0,CAP).map(function(r){
           var tier=r.tier?'<span class="badge '+r.tier+'">'+r.tier+'</span>':dash;
           var score=(r.score!=null)?'<span class="rs">'+r.score+'</span>':dash;
           return '<tr><td>'+(r.instagram_handle?'@'+esc(r.instagram_handle):dash)+'</td>'
             +'<td>'+(r.name?esc(r.name):dash)+'</td>'
             +'<td>'+(r.phone?'<span class="mono">'+esc(r.phone)+'</span>':dash)+'</td>'
             +'<td>'+score+'</td><td>'+tier+'</td>'
             +'<td>'+(r.reason?esc(r.reason):dash)+'</td></tr>';}).join('');
         $('#qTbl').innerHTML=head+'<tbody>'+(body||'<tr><td colspan="6" class="muted">This list has no rows yet. Add leads in the Source tab first.</td></tr>')+'</tbody>';}

       loadLists();
     </script>`,
  )
}

export function dashboardView(email: string): string {
  return page(
    'Lepton',
    shellNav(email, 'outbound') + `

     <!-- ============ MAIN SCREEN ============ -->
     <div id="screenMain" class="wrap dashwrap">
       <aside class="col-left">
         <div class="card">
           <h3>WhatsApp accounts</h3>
           <div id="accList" class="mt"></div>
           <h4>Add an account</h4>
           <input id="accLabel" placeholder="Give a name e.g. Public Biz 1" style="padding:14px 12px">
           <div class="row2 mt">
             <select id="accType" style="flex:1;min-width:0">
               <option value="baileys">Private business</option>
               <option value="cloud">Public business</option>
             </select>
             <button class="btn" id="accAdd">Add</button>
           </div>
           <div id="cloudFields" style="display:none" class="mt">
             <label for="cloudPid">Phone Number ID</label><input id="cloudPid" placeholder="1210327805491209">
             <label for="cloudTok">Access token</label><input id="cloudTok" type="password" placeholder="permanent system-user token">
           </div>
           <p class="mono mt" id="accResult"></p>
         </div>
       </aside>

       <div class="col-right">
         <div id="rightHome">
         <!-- CAMPAIGNS (top) -->
         <div class="card">
           <div class="flex"><h3>Campaigns</h3><button class="btn sm" id="newCamp">+ New campaign</button></div>
           <p class="hint">A campaign pulls leads from a list and runs them through your sequence. Click one to edit.</p>
           <div id="campList" class="mt"></div>
         </div>

         <!-- API TOKEN -->
         <div class="card mt">
           <h3>API token (Claude Code / MCP)</h3>
           <p class="hint">Drive campaigns from an agent. Keep this secret.</p>
           <div class="row2 mt"><button class="btn sm" id="tokBtn">Show token</button><span class="mono" id="tokVal"></span></div>
         </div>
         </div><!-- /rightHome -->

         <!-- CAMPAIGN EDITOR (opens here, in the right panel) -->
         <div id="rightEditor" style="display:none">
       <div class="flex">
         <div class="row2">
           <button class="x" id="edBack">&larr; back</button>
           <input id="edName" style="width:260px;font-weight:700" placeholder="Campaign name">
           <span id="edStatus" class="badge draft">draft</span>
         </div>
         <div class="row2">
           <button class="btn ghost sm" id="edSave">Save</button>
           <button class="btn sm" id="edToggle">Turn on</button>
         </div>
       </div>
       <div class="tabs">
         <div class="tab on" data-tab="seq">Sequence</div>
         <div class="tab" data-tab="preview">Preview</div>
       </div>

       <!-- SEQUENCE TAB -->
       <div id="tabSeq">
         <label>WhatsApp accounts <span class="hint">(sends rotate across the ones you pick)</span></label>
         <div class="msdd mt" id="edAcctsDD">
           <button type="button" class="msdd-btn" id="edAcctsBtn"><span class="ph">Select accounts…</span></button>
           <div class="msdd-panel" id="edAcctsPanel" style="display:none"></div>
         </div>
         <div id="acctBudget"></div>

         <div class="flex mt">
           <div class="row2">
             <button class="btn ghost sm" id="addSend">+ Send WhatsApp</button>
             <button class="btn ghost sm" id="addWait">+ Wait</button>
             <button class="btn ghost sm" id="addIf">+ If reply</button>
           </div>
           <span class="hint" id="connHint">Tip: drag from the <b>dot at the bottom</b> of a block onto another block to link them. Drag a Wait back onto Send to loop.</span>
         </div>
         <div class="canvas mt" id="canvas"><div class="cstage" id="cstage"><svg class="edges" id="edges"></svg></div></div>
         <p class="hint mt">Click any block to open its settings on the right.</p>
       </div>

       <!-- PREVIEW TAB -->
       <div id="tabPreview" style="display:none">
         <p class="hint">Exactly what goes out for your first few leads, with personalization filled in.</p>
         <div id="previewBox" class="mt"></div>
       </div>
         </div><!-- /rightEditor -->
       </div><!-- /col-right -->

       <!-- BLOCK EDITOR: slides in from the right when a node is clicked -->
       <div id="inspectorBackdrop" class="ibackdrop" style="display:none"></div>
       <div id="inspectorPanel" class="ipanel">
         <div class="ipanel-head"><span class="mono" id="ipKind"></span><button class="x" id="ipClose">close ✕</button></div>
         <div id="inspector"></div>
       </div>
     </div><!-- /dashwrap -->

     <script>
       var $=function(s){return document.querySelector(s);};
       var J=function(u,o){return fetch(u,o).then(function(r){return r.json();}).catch(function(){return {ok:false,error:'bad response'};});};
       var esc=function(s){return (''+(s==null?'':s)).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});};
       var POST=function(u,b){return J(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b||{})});};
       var PUT=function(u,b){return J(u,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(b||{})});};
       var DEL=function(u){return J(u,{method:'DELETE'});};
       var uid=function(){return 'n'+Date.now().toString(36)+Math.floor(Math.random()*1000);};
       var ACCTS=[],PROFILES=[],LISTS=[],ATTRS=[];

       /* ===================== MAIN: accounts ===================== */
       $('#accType').onchange=function(){$('#cloudFields').style.display=$('#accType').value==='cloud'?'':'none';};
       $('#accAdd').onclick=function(){var type=$('#accType').value;var label=$('#accLabel').value.trim();if(!label){$('#accResult').textContent='label required';return;}
         var config=type==='cloud'?{phoneNumberId:$('#cloudPid').value.trim(),token:$('#cloudTok').value.trim()}:{};
         $('#accResult').textContent='adding…';POST('/api/accounts',{type:type,label:label,config:config}).then(function(j){
           $('#accResult').textContent=j.ok?'added ✓':('error: '+(j.error||'failed'));
           if(j.ok){$('#accLabel').value='';$('#cloudPid').value='';$('#cloudTok').value='';loadAccounts();}});};
       function acctMeta(a){
         if(a.type==='cloud')return a.jid?('Phone number ID: '+esc(a.jid)):'No Cloud number set';
         /* baileys: a.jid is like 447...@s.whatsapp.net when connected */
         if(a.status==='connected'&&a.jid){var num=String(a.jid).split('@')[0].split(':')[0];return '+'+esc(num);}
         if(a.hasQr)return 'Scan the QR code to connect';
         return 'Not connected yet';}
       /* Accounts list updates IN PLACE: each row's DOM (incl. its open policy panel,
          focused inputs, and QR img) is built once and reused. Polls only patch the
          bits that change — so the 4s refresh never closes panels or reloads the QR. */
       var ACCT_EL={};
       function loadAccounts(){return J('/api/accounts').then(function(j){if(!j.ok)return;ACCTS=j.accounts;reconcileAccounts(j.accounts);});}
       function reconcileAccounts(list){var host=$('#accList');if(!host)return;
         if(!list.length){host.innerHTML='<p class="muted">No numbers yet.</p>';ACCT_EL={};return;}
         var muted=host.querySelector('.muted');if(muted)muted.remove();
         var seen={};
         list.forEach(function(a,i){seen[a.id]=1;
           var row=ACCT_EL[a.id];
           if(!row){row=buildAcctRow(a);ACCT_EL[a.id]=row;}
           updateAcctRow(row,a);
           var at=host.children[i];if(at!==row)host.insertBefore(row,at||null);});
         Object.keys(ACCT_EL).forEach(function(id){if(!seen[id]){ACCT_EL[id].remove();delete ACCT_EL[id];}});}
       function buildAcctRow(a){var el=document.createElement('div');el.className='item';
         el.innerHTML='<div class="flex"><b class="ar-label"></b><span class="ar-badge badge"></span></div>'
           +'<div class="acctmeta ar-meta"></div>'
           +'<div class="acctmeta ar-warm"></div>'
           +'<div class="flex mt"><span class="ar-ctl"></span><button class="x" onclick="accDel(\\''+a.id+'\\')">remove</button></div>'
           +'<button class="x" onclick="accPol(\\''+a.id+'\\')">⚙ Sending policy</button>'
           +polEditor(a);
         return el;}
       function updateAcctRow(row,a){var q=function(c){return row.querySelector('.'+c);};
         q('ar-label').textContent=a.label;
         var badge=q('ar-badge');badge.textContent=(a.type==='cloud'?'Public':'Private')+' · '+a.status;
         badge.className='ar-badge badge '+(a.status==='connected'?'connected':'disconnected');
         q('ar-meta').innerHTML=acctMeta(a);
         q('ar-warm').textContent=warmChip(a);
         var ctl=q('ar-ctl');
         var sig=a.type==='cloud'?'cloud':(a.status==='connected'?'conn':(a.hasQr?'qr':'disc'));
         if(ctl.getAttribute('data-sig')!==sig){ctl.setAttribute('data-sig',sig);
           if(sig==='conn')ctl.innerHTML='<button class="btn ghost sm" onclick="accDis(\\''+a.id+'\\')">Disconnect</button>';
           else if(sig==='disc')ctl.innerHTML='<button class="btn sm" onclick="accCon(\\''+a.id+'\\')">Connect</button>';
           else if(sig==='qr'){ctl.innerHTML='<span class="qr"><img alt="QR" src="/api/accounts/'+a.id+'/qr.png?t='+Date.now()+'"></span>';ctl.setAttribute('data-qrt',String(Date.now()));}
           else ctl.innerHTML='<span></span>';}
         else if(sig==='qr'){var last=Number(ctl.getAttribute('data-qrt')||0);
           if(Date.now()-last>15000){var img=ctl.querySelector('img');if(img){img.src='/api/accounts/'+a.id+'/qr.png?t='+Date.now();ctl.setAttribute('data-qrt',String(Date.now()));}}}}
       function warmChip(a){var p=a.policy||{};var cap=(a.dailyCapToday!=null?a.dailyCapToday:(p.dailyCap||0));
         var warm=(p.warmupEnabled&&cap<(p.dailyCap||0))?('Warming · day '+(a.warmupDay||1)+' · '):'';
         return warm+cap+'/day · '+(a.sentToday||0)+' sent today';}
       function polEditor(a){var p=a.policy||{};
         return '<div id="pol_'+a.id+'" class="tbox" style="display:none">'
           +'<label class="row2" style="margin:0"><input type="checkbox" id="wu_'+a.id+'" style="width:auto"'+(p.warmupEnabled?' checked':'')+'> Auto warm-up <span class="hint">(ramp daily sends up over ~2 weeks)</span></label>'
           +'<div class="cfg3 mt">'
           +'<div><label>Usage weight</label><input type="number" id="wt_'+a.id+'" value="'+(p.weight||1)+'"><div class="hint">higher = more leads vs other numbers</div></div>'
           +'<div><label>Daily cap</label><input type="number" id="dc_'+a.id+'" value="'+(p.dailyCap||200)+'"><div class="hint">max sends/day</div></div>'
           +'<div><label>Send window</label><div class="row2"><input type="number" id="ws_'+a.id+'" value="'+(p.windowStart!=null?p.windowStart:8)+'" style="width:56px"><span class="hint">to</span><input type="number" id="we_'+a.id+'" value="'+(p.windowEnd!=null?p.windowEnd:21)+'" style="width:56px"></div><div class="hint">local hours, e.g. 8–21</div></div>'
           +'</div>'
           +'<div class="row2 mt"><button class="btn sm" onclick="accPolSave(\\''+a.id+'\\')">Save policy</button><span class="mono" id="polmsg_'+a.id+'"></span></div>'
           +'</div>';}
       window.accCon=function(id){POST('/api/accounts/'+id+'/connect').then(function(){setTimeout(loadAccounts,600);});};
       window.accDis=function(id){POST('/api/accounts/'+id+'/disconnect').then(loadAccounts);};
       window.accDel=function(id){DEL('/api/accounts/'+id).then(loadAccounts);};
       window.accPol=function(id){var d=document.getElementById('pol_'+id);if(d)d.style.display=(d.style.display==='none')?'':'none';};
       window.accPolSave=function(id){var g=function(p){return document.getElementById(p+id);};
         var body={warmupEnabled:g('wu_').checked,weight:Number(g('wt_').value),dailyCap:Number(g('dc_').value),windowStart:Number(g('ws_').value),windowEnd:Number(g('we_').value)};
         var m=document.getElementById('polmsg_'+id);if(m)m.textContent='saving…';
         PUT('/api/accounts/'+id+'/policy',body).then(function(j){if(m)m.textContent=j.ok?'saved ✓':'error';loadAccounts();});};

       /* ===================== MAIN: connections + token ===================== */
       if($('#attioBtn'))$('#attioBtn').onclick=function(){$('#attioBtn').disabled=true;$('#attioBtn').textContent='Connecting…';
         POST('/api/attio/connect',{key:$('#attioKey').value}).then(function(j){$('#attioBtn').disabled=false;$('#attioBtn').textContent='Connect Attio';
           if(j.ok){$('#attioConnect').style.display='none';$('#attioOk').style.display='';$('#attioWs').textContent=j.workspace;}else alert(j.error||'failed');});};
       if($('#wbToggle'))$('#wbToggle').onchange=function(){POST('/api/settings/writeback',{on:$('#wbToggle').checked});};
       function loadSettings(){return J('/api/settings').then(function(j){if(!j.ok)return;
         if($('#aiNote'))$('#aiNote').textContent=j.ai?'AI personalization available.':'AI off — set ANTHROPIC_API_KEY on the server to enable per-lead AI openers.';
         if($('#wbToggle'))$('#wbToggle').checked=j.writeback;
         if(j.attioConnected&&$('#attioConnect')){$('#attioConnect').style.display='none';$('#attioOk').style.display='';$('#attioWs').textContent='connected';}});}
       $('#tokBtn').onclick=function(){J('/api/token').then(function(j){$('#tokVal').textContent=j.ok?j.token:(j.error||'failed');});};

       /* ===================== MAIN: campaign list ===================== */
       function loadCampaigns(){return J('/api/campaigns').then(function(j){if(!j.ok)return;
         $('#campList').innerHTML=j.campaigns.map(function(c){var st=c.stats;
           return '<div class="item"><div class="flex"><div><b>'+esc(c.name)+'</b> <span class="badge '+c.status+'" style="margin-left:6px">'+c.status+'</span></div>'
             +'<div class="row2"><button class="btn ghost sm" onclick="openCampaign('+c.id+')">Edit</button><button class="x" onclick="delCampaign('+c.id+')">delete</button></div></div>'
             +'<p class="mono mt" style="font-size:12px">no contact '+st.pending+' · contacted '+(st.sent+st.completed)+' · replied '+st.replied+(st.failed?(' · failed '+st.failed):'')+'</p></div>';
         }).join('')||'<p class="muted">No campaigns yet. Click “New campaign”.</p>';});}
       window.delCampaign=function(id){if(!confirm('Delete this campaign?'))return;DEL('/api/campaigns/'+id).then(loadCampaigns);};
       $('#newCamp').onclick=function(){
         var sid=uid();
         var seq={nodes:[{id:'start',type:'start',x:60,y:30,data:{listId:null}},
                          {id:sid,type:'send',x:60,y:170,data:{message:'Hey {{instagram_handle}} 👋 ',hourlyCap:25,minGap:25,maxGap:70}}],
                  edges:[{from:'start',to:sid}]};
         POST('/api/campaigns',{name:'Untitled campaign',sequence:seq,accountIds:[]}).then(function(j){if(j.ok)openCampaign(j.id);else alert(j.error||'failed');});};

       /* ===================== EDITOR ===================== */
       var ED={id:null,name:'',status:'draft',seq:{nodes:[],edges:[]},accountIds:[],leads:[]};
       var SEL=null; /* SEL=selected node id */

       function showMain(){$('#rightHome').style.display='';$('#rightEditor').style.display='none';loadCampaigns();}
       function showEditor(){$('#rightHome').style.display='none';$('#rightEditor').style.display='';}
       $('#edBack').onclick=showMain;
       /* block editor slide-out (right) */
       function openInspector(){renderInspector();$('#inspectorPanel').classList.add('open');$('#inspectorBackdrop').style.display='';}
       function closeInspector(){$('#inspectorPanel').classList.remove('open');$('#inspectorBackdrop').style.display='none';if(SEL){SEL=null;renderCanvas();}}
       $('#ipClose').onclick=closeInspector;
       $('#inspectorBackdrop').onclick=closeInspector;

       window.openCampaign=function(id){J('/api/campaigns/'+id).then(function(j){if(!j.ok){alert(j.error||'failed');return;}
         ED.id=id;ED.name=j.campaign.name;ED.status=j.campaign.status;ED.seq=j.sequence;ED.accountIds=j.accountIds||[];ED.leads=j.leads||[];
         $('#edName').value=ED.name;setStatusBadge();
         renderAccts();renderCanvas();renderLists();switchTab('seq');showEditor();});};

       function setStatusBadge(){var b=$('#edStatus');b.className='badge '+ED.status;b.textContent=ED.status;
         $('#edToggle').textContent=(ED.status==='running')?'Turn off':'Turn on';}

       /* tabs */
       function switchTab(t){['seq','preview'].forEach(function(x){
         $('#tab'+x.charAt(0).toUpperCase()+x.slice(1)).style.display=(x===t)?'':'none';});
         document.querySelectorAll('.tab').forEach(function(el){el.classList.toggle('on',el.getAttribute('data-tab')===t);});
         if(t==='preview')loadPreview();
         if(t==='seq')renderCanvas();};
       document.querySelectorAll('.tab').forEach(function(el){el.onclick=function(){switchTab(el.getAttribute('data-tab'));};});

       /* account multi-select dropdown */
       function updateAcctsBtn(){
         var names=ACCTS.filter(function(a){return ED.accountIds.indexOf(a.id)>=0;}).map(function(a){return esc(a.label);});
         $('#edAcctsBtn').innerHTML=names.length?'<span>'+names.join(', ')+'</span>':'<span class="ph">Select accounts…</span>';
         renderAcctBudget();}
       /* read-only: how many each picked number can still send TODAY, with warm-up applied */
       function renderAcctBudget(){
         var box=$('#acctBudget');if(!box)return;
         var picked=ACCTS.filter(function(a){return ED.accountIds.indexOf(a.id)>=0;});
         if(!picked.length){box.innerHTML='';return;}
         var totalLeft=0,anyWarming=false;
         var rows=picked.map(function(a){
           var p=a.policy||{};
           var cap=(a.dailyCapToday!=null?a.dailyCapToday:(p.dailyCap||0));
           var left=Math.max(0,cap-(a.sentToday||0));
           totalLeft+=left;
           var warming=(p.warmupEnabled&&cap<(p.dailyCap||0));
           if(warming)anyWarming=true;
           var tag=warming?('<span class="mono"> · warming day '+(a.warmupDay||1)+'</span>'):(p.warmupEnabled?'':'<span class="mono"> · warm-up off</span>');
           return '<div style="display:flex;justify-content:space-between;gap:10px;padding:2px 0">'
             +'<span>'+esc(a.label)+tag+'</span>'
             +'<span class="mono">'+cap+'/day · '+left+' left today</span></div>';
         }).join('');
         box.innerHTML='<div class="tbox" style="margin-top:8px">'
           +'<div style="font-weight:700;font-size:12px;margin-bottom:4px">Today\\'s send budget'+(anyWarming?' (warm-up applied)':'')+'</div>'
           +rows
           +'<div style="display:flex;justify-content:space-between;gap:10px;border-top:1px solid var(--line);margin-top:6px;padding-top:6px;font-weight:700"><span>Total left today</span><span class="mono">~'+totalLeft+' messages</span></div>'
           +(anyWarming?'<div class="hint">Caps grow automatically each day as the new numbers warm up. Edit per number under ⚙ Sending policy (left).</div>':'<div class="hint">Set per-number caps/weights under ⚙ Sending policy (left).</div>')
           +'</div>';}
       function renderAccts(){
         $('#edAcctsPanel').innerHTML=ACCTS.map(function(a){
           var on=ED.accountIds.indexOf(a.id)>=0;
           return '<label class="msdd-opt"><input type="checkbox" data-acc="'+a.id+'"'+(on?' checked':'')+'> <b>'+esc(a.label)+'</b> <span class="hint">'+(a.type==='cloud'?'public':'private')+'</span></label>';
         }).join('')||'<p class="hint" style="padding:8px">Add a WhatsApp number first (left side of the dashboard).</p>';
         Array.prototype.slice.call($('#edAcctsPanel').querySelectorAll('input')).forEach(function(cb){cb.onchange=function(){
           var id=cb.getAttribute('data-acc');var i=ED.accountIds.indexOf(id);
           if(cb.checked&&i<0)ED.accountIds.push(id);if(!cb.checked&&i>=0)ED.accountIds.splice(i,1);updateAcctsBtn();};});
         updateAcctsBtn();}
       $('#edAcctsBtn').onclick=function(e){e.stopPropagation();var p=$('#edAcctsPanel');p.style.display=p.style.display==='none'?'':'none';};
       document.addEventListener('click',function(e){var dd=$('#edAcctsDD');if(dd&&!dd.contains(e.target))$('#edAcctsPanel').style.display='none';});

       /* ---- canvas ---- */
       function nodeId(n){return n.id;}
       function findNode(id){for(var i=0;i<ED.seq.nodes.length;i++)if(ED.seq.nodes[i].id===id)return ED.seq.nodes[i];return null;}
       function nodeSummary(n){
         if(n.type==='start'){var l=LISTS.filter(function(x){return x.id==(n.data&&n.data.listId);})[0];return l?('Pull from: '+l.name):'Click to pick / create a list';}
         if(n.type==='send'){return (n.data&&n.data.message)?n.data.message:'Click to write the message';}
         if(n.type==='wait'){return 'Wait '+((n.data&&n.data.minutes)||0)+' min';}
         if(n.type==='ifreply'){return 'Replied? yes → / no →';}
         return '';}
       function nodeTitle(n){return {start:'◤ Lead list',send:'✉ Send WhatsApp',wait:'⏱ Wait',ifreply:'↩ If reply'}[n.type]||n.type;}
       function renderCanvas(){
         var stage=$('#cstage');
         /* remove existing node els (keep svg) */
         Array.prototype.slice.call(stage.querySelectorAll('.node')).forEach(function(el){el.remove();});
         ED.seq.nodes.forEach(function(n){
           var el=document.createElement('div');
           el.className='node '+n.type+(SEL===n.id?' sel':'');
           el.style.left=(n.x||20)+'px';el.style.top=(n.y||20)+'px';el.setAttribute('data-id',n.id);
           var ports='';
           if(n.type==='ifreply'){ports='<div class="handle yes" data-port="yes" title="drag from here if replied"></div><div class="hlabel" style="left:30%">yes</div><div class="handle no" data-port="no" title="drag from here if no reply"></div><div class="hlabel" style="left:70%">no</div>';}
           else{ports='<div class="handle single" data-port="" title="drag onto another block to link"></div>';}
           var rm=(n.type==='start')?'':'<button class="x" data-rm="1">✕</button>';
           el.innerHTML='<div class="nh"><span>'+nodeTitle(n)+'</span>'+rm+'</div><div class="nb">'+esc(nodeSummary(n))+'</div>'+ports;
           stage.appendChild(el);
           wireNode(el,n);
         });
         drawEdges();}
       function wireNode(el,n){
         var nh=el.querySelector('.nh');
         /* drag move */
         nh.onmousedown=function(e){
           if(e.target.getAttribute('data-rm'))return;
           e.preventDefault();var sx=e.clientX,sy=e.clientY,ox=n.x||0,oy=n.y||0;
           function mv(ev){n.x=Math.max(0,ox+(ev.clientX-sx));n.y=Math.max(0,oy+(ev.clientY-sy));
             el.style.left=n.x+'px';el.style.top=n.y+'px';drawEdges();}
           function up(){document.removeEventListener('mousemove',mv);document.removeEventListener('mouseup',up);}
           document.addEventListener('mousemove',mv);document.addEventListener('mouseup',up);};
         /* select */
         el.onclick=function(e){
           if(e.target.classList.contains('handle'))return;
           if(e.target.getAttribute('data-rm')){if(confirm('Remove this block?'))removeNode(n.id);return;}
           SEL=n.id;renderCanvas();openInspector();};
         /* connector handles: drag a wire onto another block */
         Array.prototype.slice.call(el.querySelectorAll('.handle')).forEach(function(p){
           p.onmousedown=function(e){startWire(n.id,p.getAttribute('data-port')||'',e);};});
       }
       function startWire(from,branch,e){
         e.preventDefault();e.stopPropagation();
         var stage=$('#cstage');var rect=stage.getBoundingClientRect();
         var p1=portXY(findNode(from),branch);
         var sx=e.clientX,sy=e.clientY,moved=false,hover=null;
         function mv(ev){
           if(Math.abs(ev.clientX-sx)>3||Math.abs(ev.clientY-sy)>3)moved=true;
           var mx=ev.clientX-rect.left,my=ev.clientY-rect.top;
           drawEdges({from:p1,x:mx,y:my});
           var t=document.elementFromPoint(ev.clientX,ev.clientY);
           var ne=t?t.closest('.node'):null;var nid=ne?ne.getAttribute('data-id'):null;
           if(nid!==hover){if(hover){var h0=stage.querySelector('.node[data-id="'+hover+'"]');if(h0)h0.classList.remove('droptarget');}
             hover=(nid&&nid!==from)?nid:null;
             if(hover){var h1=stage.querySelector('.node[data-id="'+hover+'"]');if(h1)h1.classList.add('droptarget');}}}
         function up(ev){
           document.removeEventListener('mousemove',mv);document.removeEventListener('mouseup',up);
           if(hover){var h2=stage.querySelector('.node[data-id="'+hover+'"]');if(h2)h2.classList.remove('droptarget');}
           if(!moved){ /* a click on the handle toggles off an existing wire */
             ED.seq.edges=ED.seq.edges.filter(function(ed){return !(ed.from===from&&(ed.branch||'')===(branch||''));});
             renderCanvas();saveCampaign(true);return;}
           if(hover&&hover!==from){
             ED.seq.edges=ED.seq.edges.filter(function(ed){return !(ed.from===from&&(ed.branch||'')===(branch||''));});
             ED.seq.edges.push({from:from,to:hover,branch:branch||undefined});
             saveCampaign(true);}
           renderCanvas();}
         document.addEventListener('mousemove',mv);document.addEventListener('mouseup',up);}
       function removeNode(id){ED.seq.nodes=ED.seq.nodes.filter(function(n){return n.id!==id;});
         ED.seq.edges=ED.seq.edges.filter(function(e){return e.from!==id&&e.to!==id;});
         if(SEL===id){SEL=null;closeInspector();}renderCanvas();}
       $('#canvas').onclick=function(e){if(e.target.id==='canvas'||e.target.id==='cstage'){closeInspector();}};

       function addNode(type){var data=type==='send'?{message:'',hourlyCap:25,minGap:25,maxGap:70}:type==='wait'?{minutes:1440}:{};
         var n={id:uid(),type:type,x:300,y:60+ED.seq.nodes.length*30,data:data};ED.seq.nodes.push(n);SEL=n.id;renderCanvas();openInspector();}
       $('#addSend').onclick=function(){addNode('send');};
       $('#addWait').onclick=function(){addNode('wait');};
       $('#addIf').onclick=function(){addNode('ifreply');};

       function nodeH(n){var el=$('#cstage').querySelector('.node[data-id="'+n.id+'"]');return el?el.offsetHeight:80;}
       function portXY(n,branch){ /* connector anchor (bottom of block) in stage coords */
         var w=200,h=nodeH(n);var bx=(n.x||0),by=(n.y||0);
         if(branch==='yes')return {x:bx+w*0.30,y:by+h};
         if(branch==='no')return {x:bx+w*0.70,y:by+h};
         return {x:bx+w/2,y:by+h};}
       function topXY(n){return {x:(n.x||0)+100,y:(n.y||0)};}
       function curvePath(p1,p2,dashed){
         var my=(p1.y+p2.y)/2;
         return '<path d="M '+p1.x+' '+p1.y+' C '+p1.x+' '+my+', '+p2.x+' '+my+', '+p2.x+' '+p2.y+'" fill="none" stroke="#000" stroke-width="1.5"'+(dashed?' stroke-dasharray="4 4" opacity="0.6"':'')+'></path>';}
       function drawEdges(temp){var svg=$('#edges');var stage=$('#cstage');
         svg.setAttribute('width',stage.scrollWidth);svg.setAttribute('height',stage.scrollHeight);
         var paths='';
         ED.seq.edges.forEach(function(e){var a=findNode(e.from),b=findNode(e.to);if(!a||!b)return;
           var p1=portXY(a,e.branch||''),p2=topXY(b);
           paths+=curvePath(p1,p2,false);
           paths+='<circle cx="'+p2.x+'" cy="'+p2.y+'" r="3" fill="#000"></circle>';});
         if(temp){paths+=curvePath(temp.from,{x:temp.x,y:temp.y},true);}
         svg.innerHTML=paths;}

       /* ---- inspector (block editor) ---- */
       function renderInspector(){var box=$('#inspector');var n=SEL?findNode(SEL):null;
         if($('#ipKind'))$('#ipKind').textContent=n?nodeTitle(n):'';
         if(!n){box.innerHTML='<p class="muted">Select a block to edit it.</p>';return;}
         if(n.type==='start'){
           var cur=(n.data&&n.data.listId)||'';
           var opts='<option value="">— no list —</option>'+LISTS.map(function(l){return '<option value="'+l.id+'"'+(l.id==cur?' selected':'')+'>'+esc(l.name)+' ('+l.type+(l.size?(' · '+l.size):'')+')</option>';}).join('');
           box.innerHTML=
             '<h5>Lead list</h5>'
             +'<p class="hint">Leads are pulled from this source. Build lists in the <a href="/source">Source</a> tab. Loop a Wait back to this block to keep pulling fresh leads on that cadence.</p>'
             +'<label>Choose a list</label><select id="iList">'+opts+'</select>'
             +'<div id="iListTbl" class="mt"></div>'
             +'<div class="row2 mt"><button class="btn ghost sm" id="iAddCsv">Import from CSV</button><button class="btn ghost sm" id="iAddAttio">Import from Attio</button><button class="x" id="iDelList">delete list</button></div>'
             +'<div id="iCsvBox" class="tbox" style="display:none"><label>List name</label><input id="iCsvName" placeholder="e.g. June IG leads"><label class="mt">Upload CSV <span class="hint">(needs a phone column; instagram / link auto-detected)</span></label><input type="file" id="iCsvFile" accept=".csv,text/csv"><button class="btn sm mt" id="iCsvSave">Save list</button><p class="mono mt" id="iCsvResult"></p></div>'
             +'<div id="iAttioBox" class="tbox" style="display:none"><label>List name</label><input id="iAtName" placeholder="e.g. Attio – Prospects"><div class="cfg3 mt"><div><label>Object</label><select id="iAtObj"></select></div><div><label>List (optional)</label><select id="iAtList"></select></div><div><label>Phone field</label><select id="iAtPhone"></select></div></div><p class="hint mt">Columns auto-detected from the object — adjust any if needed.</p><div class="cfg3 mt"><div><label>Name</label><select id="iAtName2"></select></div><div><label>Email</label><select id="iAtEmail"></select></div><div><label>IG handle</label><select id="iAtIg"></select></div></div><div class="cfg3 mt"><div><label>Link</label><select id="iAtLink"></select></div><div><label>Channel filter</label><select id="iAtChannel"><option value="">— any channel —</option></select></div><div><label>Has email</label><label class="row2" style="margin:0"><input type="checkbox" id="iAtHasEmail" style="width:auto"> only with email</label></div></div><button class="btn sm mt" id="iAtSave">Save list</button><p class="mono mt" id="iAtResult"></p></div>';
           loadListTable();
           $('#iList').onchange=function(){n.data=n.data||{};n.data.listId=$('#iList').value?Number($('#iList').value):null;renderCanvas();saveCampaign(true);loadListTable();};
           $('#iDelList').onclick=function(){var id=$('#iList').value;if(!id)return;if(!confirm('Delete this list?'))return;DEL('/api/lists/'+id).then(function(){if(n.data)n.data.listId=null;renderLists();});};
           $('#iAddCsv').onclick=function(){var b=$('#iCsvBox');b.style.display=b.style.display==='none'?'':'none';$('#iAttioBox').style.display='none';};
           $('#iAddAttio').onclick=function(){var b=$('#iAttioBox');b.style.display=b.style.display==='none'?'':'none';$('#iCsvBox').style.display='none';if(b.style.display==='')loadAttioObjectsInto();};
           $('#iCsvSave').onclick=function(){var f=$('#iCsvFile').files[0];if(!f){$('#iCsvResult').textContent='choose a file';return;}var rd=new FileReader();rd.onload=function(){$('#iCsvResult').textContent='uploading…';POST('/api/lists/csv',{name:$('#iCsvName').value||f.name,csv:rd.result}).then(function(j){$('#iCsvResult').textContent=j.ok?('saved ✓ '+j.size+' leads ('+j.noPhone+' had no phone)'):('error: '+(j.error||'failed'));if(j.ok){n.data=n.data||{};n.data.listId=j.id;renderLists().then(function(){saveCampaign(true);renderInspector();});}});};rd.readAsText(f);};
           $('#iAtSave').onclick=function(){var phone=$('#iAtPhone').value;if(!phone){$('#iAtResult').textContent='pick a phone field';return;}var mapping={phone:phone,name:$('#iAtName2').value||undefined,vars:[]};if($('#iAtEmail').value)mapping.vars.push($('#iAtEmail').value);if($('#iAtIg').value)mapping.vars.push($('#iAtIg').value);if($('#iAtLink').value)mapping.vars.push($('#iAtLink').value);var filter={};if($('#iAtChannel').value)filter.primaryChannel=$('#iAtChannel').value;if($('#iAtHasEmail').checked)filter.hasEmail=true;$('#iAtResult').textContent='saving…';POST('/api/lists/attio',{name:$('#iAtName').value||'Attio list',object:$('#iAtObj').value,listId:$('#iAtList').value,mapping:mapping,filter:filter}).then(function(j){$('#iAtResult').textContent=j.ok?'saved ✓':('error: '+(j.error||'failed'));if(j.ok){n.data=n.data||{};n.data.listId=j.id;renderLists().then(function(){saveCampaign(true);renderInspector();});}});};

           return;}
         if(n.type==='wait'){box.innerHTML='<h5>Wait</h5><label>Minutes to wait</label><input type="number" id="iWait" value="'+((n.data&&n.data.minutes)||0)+'"><p class="hint">e.g. 1440 = 1 day. Link this block back to Send to create a follow-up loop.</p>';
           $('#iWait').onchange=function(){n.data.minutes=Number($('#iWait').value)||0;renderCanvas();};return;}
         if(n.type==='ifreply'){box.innerHTML='<h5>If reply</h5><p class="hint">Splits leads who replied (<b>yes</b> port) from those who didn’t (<b>no</b> port). By default a reply already stops sending, so the <b>no</b> branch is where follow-ups go.</p>';return;}
         /* send */
         var d=n.data||{};
         var tmpl='<option value="">Apply a template…</option>'+PROFILES.map(function(p){return '<option value="'+p.id+'">'+esc(p.name)+'</option>';}).join('');
         box.innerHTML=
           '<h5>Send WhatsApp</h5>'
           +'<label>Message</label><textarea id="iMsg" rows="4">'+esc(d.message||'')+'</textarea>'
           +'<p class="hint">Personalize with <span class="mono">{{instagram_handle}}</span>, <span class="mono">{{instagram_link}}</span>, <span class="mono">{{category}}</span>. Vary wording with spintax <span class="mono">{hey|hi|hello}</span> — each lead gets a random pick, so no two messages are identical.</p>'
           +'<div class="row2 mt"><button class="x" id="insIg">+ handle</button><button class="x" id="insLink">+ link</button><button class="x" id="insCat">+ category</button><button class="x" id="insSpin">+ spin</button>'
           +'<label class="row2" style="margin:0"><input type="checkbox" id="iAi" style="width:auto"'+(d.aiPersonalize?' checked':'')+'> AI-personalize</label></div>'
           +'<div id="aiPromptBox" style="'+(d.aiPersonalize?'':'display:none')+'"><label class="mt">AI instruction</label><textarea id="iAiPrompt" rows="2" placeholder="e.g. keep it casual, mention the event">'+esc(d.aiPrompt||'')+'</textarea></div>'
           +'<hr><div class="flex"><h5>Engine ⚙</h5><select id="iTmpl" style="width:200px">'+tmpl+'</select></div>'
           +'<div class="cfg3 mt">'
           +'<div><label>Per-hour cap</label><input type="number" id="iCap" value="'+(d.hourlyCap||25)+'"><div class="hint">max sends/hr on each number</div></div>'
           +'<div><label>Min gap (s)</label><input type="number" id="iMin" value="'+(d.minGap||25)+'"><div class="hint">shortest pause between sends</div></div>'
           +'<div><label>Max gap (s)</label><input type="number" id="iMax" value="'+(d.maxGap||70)+'"><div class="hint">longest pause between sends</div></div>'
           +'</div>'
           +'<div class="row2 mt"><input id="iTmplName" placeholder="template name" style="flex:1"><button class="btn ghost sm" id="saveTmpl">Save as template</button></div>'
           +'<div id="tmplList" class="mt"></div>';
         function setMsg(v){n.data.message=v;renderCanvas();}
         $('#iMsg').oninput=function(){setMsg($('#iMsg').value);};
         $('#insIg').onclick=function(){var t=$('#iMsg');t.value+='{{instagram_handle}}';setMsg(t.value);};
         $('#insLink').onclick=function(){var t=$('#iMsg');t.value+='{{instagram_link}}';setMsg(t.value);};
         $('#insCat').onclick=function(){var t=$('#iMsg');t.value+='{{category}}';setMsg(t.value);};
         $('#insSpin').onclick=function(){var t=$('#iMsg');t.value+='{hey|hi|hello}';setMsg(t.value);};
         $('#iAi').onchange=function(){n.data.aiPersonalize=$('#iAi').checked;$('#aiPromptBox').style.display=$('#iAi').checked?'':'none';};
         var bind=function(id,key){$(id).onchange=function(){n.data[key]=Number($(id).value)||0;};};
         bind('#iCap','hourlyCap');bind('#iMin','minGap');bind('#iMax','maxGap');
         if($('#iAiPrompt'))$('#iAiPrompt').onchange=function(){n.data.aiPrompt=$('#iAiPrompt').value;};
         $('#iTmpl').onchange=function(){var p=PROFILES.filter(function(x){return x.id==$('#iTmpl').value;})[0];if(!p)return;
           var cfg={};try{cfg=JSON.parse(p.config);}catch(e){}
           n.data.hourlyCap=cfg.hourlyCap;n.data.minGap=cfg.minGap;n.data.maxGap=cfg.maxGap;renderInspector();};
         $('#saveTmpl').onclick=function(){var nm=$('#iTmplName').value.trim();if(!nm){alert('name the template');return;}
           POST('/api/profiles',{name:nm,config:{hourlyCap:n.data.hourlyCap,minGap:n.data.minGap,maxGap:n.data.maxGap}}).then(function(j){if(j.ok)loadProfiles().then(renderInspector);else alert(j.error||'failed');});};
         renderTmplList();}
       function renderTmplList(){var box=$('#tmplList');if(!box)return;
         box.innerHTML=PROFILES.map(function(p){return '<div class="row2" style="justify-content:space-between"><span class="mono">'+esc(p.name)+'</span><button class="x" onclick="delTmpl('+p.id+')">delete</button></div>';}).join('');}
       window.delTmpl=function(id){DEL('/api/profiles/'+id).then(function(){loadProfiles().then(renderInspector);});};
       function loadProfiles(){return J('/api/profiles').then(function(j){if(j.ok)PROFILES=j.profiles;});}

       /* ---- lead lists (managed inside the Lead-list block's inspector) ---- */
       function startNode(){return findNode('start')||ED.seq.nodes.filter(function(n){return n.type==='start';})[0];}
       function renderLists(){return J('/api/lists').then(function(j){if(j.ok)LISTS=j.lists;renderCanvas();
         var s=SEL?findNode(SEL):null;if(s&&s.type==='start')renderInspector();});}
       function loadListTable(){var sel=$('#iList');if(!sel)return;var id=sel.value;var box=$('#iListTbl');if(!box)return;
         if(!id){box.innerHTML='<p class="hint">No list selected yet — pick one above, or build lists in the <a href="/source">Source</a> tab.</p>';return;}
         box.innerHTML='<p class="hint">loading…</p>';
         J('/api/lists/'+id+'/contacts').then(function(j){if(!j.ok){box.innerHTML='<p class="hint">'+(j.error||'could not load this list')+'</p>';return;}
           var rows=j.contacts||[];
           if(!rows.length){box.innerHTML='<p class="hint">This list is empty.</p>';return;}
           var dash='<span class="hint">—</span>';
           var body=rows.slice(0,200).map(function(r){
             var ig=r.instagram_handle?esc(r.instagram_handle):dash;
             var cat=r.category?esc(r.category):dash;
             var lk=r.event_link?('<a href="'+esc(r.event_link)+'" target="_blank" rel="noopener">link ↗</a>'):dash;
             return '<tr><td>'+ig+'</td><td>'+cat+'</td><td>'+lk+'</td></tr>';}).join('');
           box.innerHTML='<div class="muted" style="font-size:12px">'+rows.length+' people in this list'+(rows.length>200?' (showing 200)':'')+'</div>'
             +'<table class="tbl"><thead><tr><th>Instagram</th><th>Category</th><th>Link</th></tr></thead><tbody>'+body+'</tbody></table>';});}
       /* lead table with draggable columns */
       var COLS=[{k:'status',l:'Status'},{k:'instagram_handle',l:'Instagram handle'},{k:'category',l:'Category'},{k:'account',l:'WA account (sending from)'},{k:'event_link',l:'Event (Instagram link)'}];
       var STMAP={pending:'No contact',sent:'Contacted',completed:'Contacted',replied:'Replied',failed:'Failed',skipped:'Skipped'};
       function acctLabel(id){var a=ACCTS.filter(function(x){return x.id===id;})[0];return a?(esc(a.label)+' ('+(a.type==='cloud'?'public':'private')+')'):'—';}
       function cellHTML(col,l){
         if(col==='status'){var s=STMAP[l.status]||l.status;var cl=(l.status==='replied')?'replied':((l.status==='sent'||l.status==='completed')?'contacted':'');return '<span class="pill '+cl+'">'+s+'</span>';}
         if(col==='instagram_handle')return l.instagram_handle?esc(l.instagram_handle):'<span class="hint">—</span>';
         if(col==='category')return l.category?esc(l.category):'<span class="hint">—</span>';
         if(col==='account')return acctLabel(l.account_id);
         if(col==='event_link')return l.event_link?('<a href="'+esc(l.event_link)+'" target="_blank" rel="noopener">link ↗</a>'):'<span class="hint">—</span>';
         if(col==='phone')return '<span class="mono">'+esc(l.phone)+'</span>';
         return '';}
       function renderLeads(stats){
         if(!$('#leadTbl'))return; /* leads table removed; people now show in the Lead-list block */
         if(stats&&$('#leadStats'))$('#leadStats').textContent=(stats.total||0)+' leads · contacted '+((stats.sent||0)+(stats.completed||0))+' · replied '+(stats.replied||0);
         var th=COLS.map(function(c,i){return '<th draggable="true" data-i="'+i+'">'+c.l+'</th>';}).join('');
         var body=ED.leads.map(function(l){return '<tr>'+COLS.map(function(c){return '<td>'+cellHTML(c.k,l)+'</td>';}).join('')+'</tr>';}).join('');
         $('#leadTbl').innerHTML='<thead><tr>'+th+'</tr></thead><tbody>'+(body||'<tr><td colspan="'+COLS.length+'" class="muted">No leads yet — pick a list above and they’ll fetch in.</td></tr>')+'</tbody>';
         wireColDrag();}
       var dragCol=null;
       function wireColDrag(){if(!$('#leadTbl'))return;Array.prototype.slice.call($('#leadTbl').querySelectorAll('th')).forEach(function(th){
         th.ondragstart=function(){dragCol=Number(th.getAttribute('data-i'));th.classList.add('drag');};
         th.ondragend=function(){th.classList.remove('drag');};
         th.ondragover=function(e){e.preventDefault();};
         th.ondrop=function(e){e.preventDefault();var to=Number(th.getAttribute('data-i'));if(dragCol==null||dragCol===to)return;
           var moved=COLS.splice(dragCol,1)[0];COLS.splice(to,0,moved);dragCol=null;renderLeads();};});}
       function refreshLeads(){if(ED.id==null)return;J('/api/campaigns/'+ED.id+'/leads').then(function(j){if(j.ok){ED.leads=j.leads;renderLeads(j.stats);}});}

       /* preview */
       function loadPreview(){if(ED.id==null)return;
         saveCampaign(true).then(function(){return J('/api/campaigns/'+ED.id+'/preview');}).then(function(j){if(!j||!j.ok){$('#previewBox').innerHTML='<p class="muted">Nothing to preview.</p>';return;}
           if(!j.hasLeads){$('#previewBox').innerHTML='<div class="tbox"><b>Template</b><div class="mt">'+esc(j.message||'(empty)')+'</div><p class="hint mt">Add leads to see them filled in.</p></div>';return;}
           $('#previewBox').innerHTML=j.samples.map(function(s){return '<div class="tbox"><div class="hint">to '+esc(s.to)+(s.handle?(' · '+esc(s.handle)):'')+'</div><div class="mt">'+esc(s.text)+'</div></div>';}).join('');});}

       /* save / toggle */
       function saveCampaign(quiet){if(ED.id==null)return Promise.resolve();
         ED.name=$('#edName').value.trim()||'Untitled campaign';
         return PUT('/api/campaigns/'+ED.id,{name:ED.name,sequence:ED.seq,accountIds:ED.accountIds}).then(function(j){
           if(!quiet){$('#edSave').textContent=j.ok?'Saved ✓':'Error';setTimeout(function(){$('#edSave').textContent='Save';},1200);}
           setTimeout(refreshLeads,400);return j;});}
       $('#edSave').onclick=function(){saveCampaign(false);};
       $('#edToggle').onclick=function(){
         if(ED.status==='running'){POST('/api/campaigns/'+ED.id+'/pause').then(function(){ED.status='paused';setStatusBadge();});}
         else{saveCampaign(true).then(function(){return POST('/api/campaigns/'+ED.id+'/start');}).then(function(j){
           if(j.ok){ED.status='running';setStatusBadge();}else alert(j.error||'could not start');});}};

       /* boot */
       loadAccounts().then(loadProfiles).then(loadCampaigns);loadSettings();
       setInterval(function(){loadAccounts();},4000);
     </script>`,
  )
}
