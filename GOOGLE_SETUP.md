# "Continue with Google" — Google Cloud setup

The app code is done (`src/google.ts` + routes). It needs an OAuth 2.0 **Web** client.
Two env vars switch it on: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.

> Heads-up: `gcloud` can create the project + enable the Gmail API, but **creating the OAuth
> client ID and the consent screen must be done in the Cloud Console** — there is no gcloud
> command for it. Steps 1–2 are CLI; steps 3–4 are the Console.

## 1. Install gcloud + log in (interactive — run these yourself)
In the Claude Code prompt, prefix with `!` so the browser login lands in this session:
```
! brew install --cask google-cloud-sdk
! gcloud auth login
```

## 2. Create the project + enable Gmail (CLI)
```
gcloud projects create lepton-mail --name="Lepton"
gcloud config set project lepton-mail
gcloud services enable gmail.googleapis.com
```

## 3. OAuth consent screen (Console)
https://console.cloud.google.com/apis/credentials/consent
- User type: **External** → Create
- App name **Lepton**, your support email, developer email → Save
- Scopes → Add: `.../auth/userinfo.email`, `.../auth/userinfo.profile`, `openid`,
  `.../auth/gmail.readonly`, `.../auth/gmail.send`
- Test users → add your own Google address (until you publish the app)

> The two Gmail scopes are **restricted** — fine in "Testing" mode for your own test users.
> Going public to arbitrary users later requires Google's security review (CASA). Not needed
> while you're building.

## 4. Create the OAuth client (Console)
https://console.cloud.google.com/apis/credentials → **Create credentials → OAuth client ID**
- Application type: **Web application**
- Authorized redirect URIs:
  - `https://www.lepton.live/auth/google/callback`
  - `http://localhost:8080/auth/google/callback`  (local dev)
- Create → copy the **Client ID** and **Client secret**.

## 5. Wire it up
**Railway** (production):
```
railway variables --set GOOGLE_CLIENT_ID=xxxx --set GOOGLE_CLIENT_SECRET=yyyy --service wa
```
(Optional `GOOGLE_REDIRECT_URI` if you ever host the callback off-host; otherwise it's
derived from the request host automatically.)

**Local**: put the same two vars in your shell/`.env` before `npm start`.

That's it — the "Continue with Google" button (login + signup pages) goes live, and signed-in
users can connect Gmail. Scopes granted: **read + send email**.
