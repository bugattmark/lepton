# Deploy WA Connect to Railway + your domain

The app is committed and deploy-ready (`Dockerfile` builds it; `node src/server.ts` runs it). You run the steps below — they need your Railway login and your domain's DNS.

## 1. Deploy to Railway

### Option A — Railway CLI (fastest, no GitHub needed)
```
npm i -g @railway/cli          # install CLI
railway login                  # opens browser to log in
cd ~/Downloads/wa-saas
railway init                   # create a new project (give it a name)
railway up                     # builds the Dockerfile + deploys this folder
```

### Option B — GitHub (auto-deploy on every push)
```
# create an empty repo at github.com/new (e.g. wa-connect), then:
cd ~/Downloads/wa-saas
git remote add origin git@github.com:<you>/wa-connect.git
git push -u origin main
```
Then Railway → **New Project → Deploy from GitHub repo** → pick it. It detects the `Dockerfile`.

## 2. Configure the service (Railway dashboard)
- **Volume**: Service → *Volumes* → add one mounted at **`/app/data`**. ⚠️ Critical — this persists the SQLite DB + each tenant's WhatsApp auth across restarts/deploys. Without it, everyone re-scans the QR after every deploy.
- **Variable**: add **`NODE_ENV=production`** (enables Secure cookies). `PORT` is injected automatically.
- **Replicas**: keep **1** (sessions live in memory on one machine; multiple replicas would split them).
- **Health check** (optional): path `/healthz`.

## 3. Your domain
- Railway → Service → **Settings → Networking → Custom Domain** → enter your domain → Railway shows a **CNAME target**.
- At your registrar (or Cloudflare DNS), add that **CNAME**. Done — HTTPS is automatic.

### Optional: Cloudflare in front (free speed + WAF)
- Add the domain to Cloudflare, point the CNAME at Railway's target, **proxy ON** (orange cloud).
- Set SSL mode to **Full (strict)**. Cloudflare now caches/edges your pages globally; Railway still runs the app.

## 4. Verify
- Visit `https://yourdomain` → landing loads.
- Sign up → Connect WhatsApp → scan QR → send a test.

## Notes
- Single instance by design (in-memory sessions). Scaling later = move auth state to the DB/object storage + a session router.
- Baileys = unofficial; ban risk on cold outbound. Stopgap transport; official Cloud API is the long-term spine.
