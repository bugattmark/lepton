// Black & white server-rendered views. No frontend framework — fast + tiny.

const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
:root{--fg:#000;--bg:#fff;--muted:#666;--line:#e5e5e5}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Helvetica,Arial,sans-serif;
  color:var(--fg);background:var(--bg);line-height:1.5;-webkit-font-smoothing:antialiased}
a{color:inherit}
.wrap{max-width:920px;margin:0 auto;padding:24px}
.nav{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--line);padding:18px 24px}
.brand{font-weight:700;letter-spacing:-.02em;font-size:18px}
.btn{display:inline-block;background:#000;color:#fff;border:1px solid #000;border-radius:8px;
  padding:10px 18px;font-size:15px;font-weight:600;cursor:pointer;text-decoration:none;text-align:center}
.btn:hover{background:#222}
.btn.ghost{background:#fff;color:#000}
.btn.ghost:hover{background:#f4f4f4}
.hero{padding:90px 0 60px;text-align:center}
.hero h1{font-size:54px;letter-spacing:-.03em;line-height:1.05;margin-bottom:18px}
.hero p{font-size:19px;color:var(--muted);max-width:560px;margin:0 auto 32px}
.row{display:flex;gap:12px;justify-content:center;flex-wrap:wrap}
.features{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-top:64px}
.card{border:1px solid var(--line);border-radius:14px;padding:22px}
.card h3{font-size:16px;margin-bottom:6px}
.card p{font-size:14px;color:var(--muted)}
.authbox{max-width:380px;margin:64px auto;border:1px solid var(--line);border-radius:16px;padding:32px}
.authbox h2{font-size:24px;letter-spacing:-.02em;margin-bottom:20px}
label{display:block;font-size:13px;font-weight:600;margin:14px 0 6px}
input{width:100%;border:1px solid #000;border-radius:8px;padding:11px 12px;font-size:15px;font-family:inherit}
input:focus{outline:2px solid #000;outline-offset:1px}
.full{width:100%;margin-top:22px}
.muted{color:var(--muted);font-size:14px}
.center{text-align:center}
.err{background:#000;color:#fff;border-radius:8px;padding:10px 12px;font-size:14px;margin-bottom:8px}
.mt{margin-top:18px}
.badge{display:inline-block;border:1px solid #000;border-radius:999px;padding:3px 12px;font-size:13px;font-weight:600;text-transform:capitalize}
.badge.connected{background:#000;color:#fff}
.badge.qr,.badge.connecting{background:#fff}
.badge.disconnected{border-color:var(--line);color:var(--muted)}
.qr{display:flex;justify-content:center;margin:18px 0}
.qr img{background:#fff;border:1px solid var(--line);border-radius:12px;padding:14px;width:300px;height:300px}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
hr{border:none;border-top:1px solid var(--line);margin:24px 0}
footer{border-top:1px solid var(--line);padding:24px;text-align:center;color:var(--muted);font-size:13px;margin-top:64px}
@media(max-width:680px){.features{grid-template-columns:1fr}.hero h1{font-size:38px}}
`

export function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>${CSS}</style></head><body>${body}</body></html>`
}

export function landingView(): string {
  return page(
    'WhatsApp Connector',
    `<div class="nav"><div class="brand">◼ WA Connect</div>
       <div class="row"><a class="btn ghost" href="/login">Log in</a><a class="btn" href="/signup">Get started</a></div>
     </div>
     <div class="wrap">
       <div class="hero">
         <h1>Connect WhatsApp.<br>Automate your outreach.</h1>
         <p>Link your WhatsApp in seconds, send and receive programmatically, and run it from one secure dashboard.</p>
         <div class="row"><a class="btn" href="/signup">Get started — free</a><a class="btn ghost" href="/login">Log in</a></div>
       </div>
       <div class="features">
         <div class="card"><h3>Link in 30 seconds</h3><p>Scan one QR code. No app store, no phone number verification.</p></div>
         <div class="card"><h3>Send & receive</h3><p>Programmatic messaging with every conversation logged to your account.</p></div>
         <div class="card"><h3>Secure & isolated</h3><p>Each account is sandboxed. Your session, your data — nobody else's.</p></div>
       </div>
     </div>
     <footer>◼ WA Connect</footer>`,
  )
}

export function authView(mode: 'login' | 'signup', error?: string): string {
  const isSignup = mode === 'signup'
  return page(
    isSignup ? 'Sign up' : 'Log in',
    `<div class="nav"><a class="brand" href="/" style="text-decoration:none">◼ WA Connect</a></div>
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
       <p class="muted center mt">
         ${isSignup ? "Already have an account? <a href='/login'>Log in</a>" : "New here? <a href='/signup'>Create an account</a>"}
       </p>
     </div>`,
  )
}

export function dashboardView(email: string): string {
  return page(
    'Dashboard',
    `<div class="nav"><a class="brand" href="/" style="text-decoration:none">◼ WA Connect</a>
       <div class="row"><span class="muted" style="align-self:center">${email}</span>
         <form method="post" action="/logout"><button class="btn ghost" type="submit">Log out</button></form>
       </div>
     </div>
     <div class="wrap">
       <div class="card">
         <div style="display:flex;justify-content:space-between;align-items:center">
           <h3>WhatsApp connection</h3>
           <span id="status" class="badge disconnected">…</span>
         </div>
         <div class="qr" id="qr"></div>
         <p class="mono center" id="who"></p>
         <p class="muted center" id="hint">Click connect, then scan the QR in WhatsApp → Settings → Linked devices.</p>
         <div class="row mt">
           <button class="btn" id="connectBtn">Connect WhatsApp</button>
           <button class="btn ghost" id="disconnectBtn" style="display:none">Disconnect</button>
         </div>
       </div>

       <div class="card mt" id="sendCard" style="display:none">
         <h3>Send a test message</h3>
         <form id="sendForm" class="mt">
           <div class="grid2">
             <div><label for="to">To (number, no +)</label><input id="to" placeholder="447700900123" required></div>
             <div><label for="text">Message</label><input id="text" placeholder="Hello from WA Connect" required></div>
           </div>
           <button class="btn full" type="submit">Send</button>
         </form>
         <p class="mono mt" id="sendResult"></p>
       </div>
     </div>
     <footer>◼ WA Connect</footer>
     <script>
       const $=s=>document.querySelector(s);
       async function refresh(){
         try{
           const s=await (await fetch('/api/status')).json();
           $('#status').textContent=s.status; $('#status').className='badge '+s.status;
           const qr=$('#qr');
           if(s.status==='connected'){qr.innerHTML='';$('#who').textContent=s.jid?('Connected: '+s.jid.split(':')[0]):'Connected';$('#hint').style.display='none';$('#connectBtn').style.display='none';$('#disconnectBtn').style.display='';$('#sendCard').style.display='';}
           else if(s.hasQr){qr.innerHTML='<img alt="QR" src="/api/qr.png?t='+Date.now()+'">';$('#who').textContent='';$('#hint').style.display='';$('#connectBtn').style.display='none';$('#disconnectBtn').style.display='';$('#sendCard').style.display='none';}
           else{qr.innerHTML='';$('#who').textContent='';$('#connectBtn').style.display=(s.status==='connecting')?'none':'';$('#disconnectBtn').style.display=(s.status==='disconnected')?'none':'';$('#sendCard').style.display='none';}
         }catch(e){}
       }
       $('#connectBtn').onclick=async()=>{$('#connectBtn').disabled=true;await fetch('/api/connect',{method:'POST'});setTimeout(()=>{$('#connectBtn').disabled=false;refresh()},800);};
       $('#disconnectBtn').onclick=async()=>{await fetch('/api/disconnect',{method:'POST'});refresh();};
       $('#sendForm').onsubmit=async(e)=>{e.preventDefault();$('#sendResult').textContent='sending…';const r=await fetch('/api/send',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({to:$('#to').value,text:$('#text').value})});const j=await r.json();$('#sendResult').textContent=j.ok?('sent ✓ '+(j.id||'')):('error: '+(j.error||'failed'));};
       setInterval(refresh,2500);refresh();
     </script>`,
  )
}
