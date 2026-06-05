// Black & white server-rendered views. No frontend framework — fast + tiny.
// NOTE: the dashboard's client <script> lives inside this template literal, so it must
// NOT use backticks or ${...}. Build strings with single quotes + concatenation.

const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
:root{--fg:#000;--bg:#fff;--muted:#666;--line:#e5e5e5}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Helvetica,Arial,sans-serif;
  color:var(--fg);background:var(--bg);line-height:1.5;-webkit-font-smoothing:antialiased}
a{color:inherit}
.wrap{max-width:920px;margin:0 auto;padding:24px}
.nav{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--line);padding:18px 24px}
.brand{font-weight:700;letter-spacing:-.02em;font-size:18px}
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
  return page(
    'Lepton',
    `<div class="nav"><div class="brand"><span class="mark"></span>Lepton</div>
       <div class="row"><a class="btn ghost" href="/login">Log in</a><a class="btn" href="/signup">Sign up</a></div>
     </div>
     <div class="wrap">
       <div class="hero">
         <h1>Connect WhatsApp.<br>Automate your outreach.</h1>
         <p>Link your personal and business WhatsApp, send and receive messages, all from one secure dashboard.</p>
         <div class="row"><a class="btn" href="/signup">Sign up</a><a class="btn ghost" href="/login">Log in</a></div>
       </div>
     </div>`,
  )
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
       <p class="muted center mt">
         ${isSignup ? "Already have an account? <a href='/login'>Log in</a>" : "New here? <a href='/signup'>Create an account</a>"}
       </p>
     </div>`,
  )
}

export function dashboardView(email: string): string {
  return page(
    'Lepton',
    `<div class="nav"><a class="brand" href="/" style="text-decoration:none"><span class="mark"></span>Lepton</a>
       <div class="row"><span class="muted" style="align-self:center">${email}</span>
         <form method="post" action="/logout"><button class="btn ghost" type="submit">Log out</button></form>
       </div>
     </div>

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
       function loadAccounts(){return J('/api/accounts').then(function(j){if(!j.ok)return;ACCTS=j.accounts;
         $('#accList').innerHTML=ACCTS.map(function(a){var ctl='';
           if(a.type==='baileys'){
             if(a.status==='connected')ctl='<button class="btn ghost sm" onclick="accDis(\\''+a.id+'\\')">Disconnect</button>';
             else if(a.hasQr)ctl='<span class="qr"><img alt="QR" src="/api/accounts/'+a.id+'/qr.png?t='+Date.now()+'"></span>';
             else ctl='<button class="btn sm" onclick="accCon(\\''+a.id+'\\')">Connect</button>';
           }
           var badge='<span class="badge '+(a.status==='connected'?'connected':'disconnected')+'">'+(a.type==='cloud'?'Public':'Private')+' · '+a.status+'</span>';
           return '<div class="item">'
             +'<div class="flex"><b>'+esc(a.label)+'</b>'+badge+'</div>'
             +'<div class="acctmeta">'+acctMeta(a)+'</div>'
             +'<div class="flex mt">'+(ctl||'<span></span>')+'<button class="x" onclick="accDel(\\''+a.id+'\\')">remove</button></div>'
             +'</div>';
         }).join('')||'<p class="muted">No numbers yet.</p>';});}
       window.accCon=function(id){POST('/api/accounts/'+id+'/connect').then(function(){setTimeout(loadAccounts,600);});};
       window.accDis=function(id){POST('/api/accounts/'+id+'/disconnect').then(loadAccounts);};
       window.accDel=function(id){DEL('/api/accounts/'+id).then(loadAccounts);};

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
         $('#edAcctsBtn').innerHTML=names.length?'<span>'+names.join(', ')+'</span>':'<span class="ph">Select accounts…</span>';}
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
             +'<p class="hint">Leads are pulled from this source. Loop a Wait back to this block to keep pulling fresh leads on that cadence.</p>'
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
           +'<p class="hint">Personalize with <span class="mono">{{instagram_handle}}</span>, <span class="mono">{{instagram_link}}</span> and <span class="mono">{{category}}</span>.</p>'
           +'<div class="row2 mt"><button class="x" id="insIg">+ handle</button><button class="x" id="insLink">+ link</button><button class="x" id="insCat">+ category</button>'
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
         if(!id){box.innerHTML='<p class="hint">No list selected yet — import people below to create one.</p>';return;}
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
       function loadAttioObjectsInto(){J('/api/attio/objects').then(function(j){if(!j.ok){if($('#iAtResult'))$('#iAtResult').textContent=j.error||'connect Attio in Connections (left dashboard) first';return;}
         $('#iAtObj').innerHTML=j.objects.map(function(o){return '<option value="'+o.api_slug+'">'+esc(o.plural||o.api_slug)+'</option>';}).join('');$('#iAtObj').onchange=atObjChangeInto;atObjChangeInto();});}
       function atObjChangeInto(){var obj=$('#iAtObj').value;if(!obj)return;
         Promise.all([J('/api/attio/objects/'+obj+'/attributes'),J('/api/attio/objects/'+obj+'/lists'),J('/api/attio/objects/'+obj+'/suggest')]).then(function(r){
           ATTRS=(r[0].ok?r[0].attributes:[]);var lists=(r[1].ok?r[1].lists:[]);var sg=(r[2]&&r[2].ok)?r[2]:{};
           $('#iAtList').innerHTML='<option value="">— whole object —</option>'+lists.map(function(l){return '<option value="'+l.id+'">'+esc(l.name)+'</option>';}).join('');
           var opts=ATTRS.map(function(a){return '<option value="'+a.api_slug+'">'+esc(a.title)+' ('+a.type+')</option>';}).join('');
           var none='<option value="">— none —</option>';
           $('#iAtPhone').innerHTML=opts;$('#iAtName2').innerHTML=none+opts;$('#iAtEmail').innerHTML=none+opts;$('#iAtIg').innerHTML=none+opts;$('#iAtLink').innerHTML=none+opts;
           /* auto-fill from the server's suggestion (falls back to type-based picks) */
           var m=sg.mapping||{};
           var phType=(ATTRS.filter(function(a){return a.type==='phone-number';})[0]||{}).api_slug;
           var nmType=(ATTRS.filter(function(a){return a.type==='personal-name';})[0]||{}).api_slug;
           if(m.phone||phType)$('#iAtPhone').value=m.phone||phType;
           if(m.name||nmType)$('#iAtName2').value=m.name||nmType;
           if(m.email)$('#iAtEmail').value=m.email;
           if(m.instagram)$('#iAtIg').value=m.instagram;
           if(m.link)$('#iAtLink').value=m.link;
           /* channel filter options + has-email availability */
           var ch=sg.channelOptions||[];
           $('#iAtChannel').innerHTML='<option value="">— any channel —</option>'+ch.map(function(o){return '<option value="'+esc(o)+'">'+esc(o)+'</option>';}).join('');
           $('#iAtHasEmail').disabled=!sg.hasEmail;});}

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
