# Upcruit Hiring Pulse

A live booth screen for Upcruit.ai at Bengaluru Tech Summit 2026 (17–19 Nov, BIEC).

- **Job seekers** enter their name, email and mobile number (with consent), then their experience, top skills and (optionally) what they're training in. They instantly see up to 3 matching open jobs with an Apply link and QR code.
- **HR leaders** answer 3 questions (roles they're hiring, hardest-to-find skills, pain points).
- **The TV display** updates every few seconds: a live "Just matched" feed, how many job seekers matched to open jobs, skills, the skills gap, experience mix, roles in demand and HR pain points. It shows a QR code so visitors can sign up on their own phones. **Contact details never appear on the TV**; a first name and initial ("Priya S.") appears only if the person ticks the optional box.
- **The Staff desk** lists the latest candidates with their contact details and matches, so your team can follow up while they're still at the booth.

One Node.js app with a built-in SQLite database. No other services needed.

---

## Repository layout (monorepo)

This is an [npm workspaces](https://docs.npmjs.com/cli/using-npm/workspaces) monorepo. One `npm install` at the root installs every workspace, and all commands run from the repo root.

```
.
├── apps/
│   ├── server/          @upcruit/server  Express API, SQLite, job import, matching, QR, CSV export
│   │   ├── package.json
│   │   └── src/server.js
│   └── web/             @upcruit/web     Static screens served by the API
│       ├── package.json
│       └── public/index.html
├── packages/
│   └── questions/       @upcruit/questions  Shared question/answer bank (server + browser)
│       ├── package.json
│       └── questions.js
├── templates/           Jobs Excel template the recruitment team fills in
├── deploy/aws/          AWS setup: CloudFormation, deploy.sh, Docker Compose + Caddy (HTTPS)
├── data/                Local SQLite database (git-ignored)
├── Dockerfile           Container image for the monorepo (Node 20)
├── .env.example         Settings you can change
└── package.json         Workspaces + root scripts (start, dev)
```

| Path | What it is |
|---|---|
| `apps/server/src/server.js` | The whole backend: API, SQLite database, Excel/CSV job import, job matching, QR codes, staff PIN check, CSV export |
| `apps/web/public/index.html` | All screens (setup, TV display, booth tablet, visitor phone, staff desk) in one page |
| `packages/questions/questions.js` | Every question and answer option, shared by the screens and the server |
| `templates/Upcruit_BTS2026_Jobs_Template.xlsx` | The jobs template the recruitment team fills in |
| `Dockerfile` | Container image for the app (Node 20) |
| `deploy/aws/` | AWS deployment: CloudFormation template, `deploy.sh`, Docker Compose + Caddy (HTTPS), and its own [README](deploy/aws/README.md) |
| `.env.example` | The settings you can change |

Why these boundaries: the server and the browser must agree on every question and option, so that list lives in one package (`@upcruit/questions`) instead of being copied. The browser gets it as a plain script at `/questions.js`, so `apps/web` needs no build step.

## Screens

| Address | Use it on | What it does |
|---|---|---|
| `/` | Your laptop | Setup page with links to everything |
| `/#display` | Laptop connected to the booth TV | Live scoreboard, full screen |
| `/#kiosk` | Booth tablet | Sign-up + job matches; clears personal details and resets for the next visitor |
| `/#join` | Visitors' phones (QR on the TV) | Same sign-up, no auto-reset, Apply buttons, browser autofill on |
| `/#staff` | Staff laptop/phone | Latest candidates, upload jobs, download everything, clear test entries (needs `STAFF_PIN`) |
| `/#demo` | Anywhere | TV display with sample data for rehearsal; saves nothing |

---

## Settings (environment variables)

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `STAFF_PIN` | **Yes** | – | PIN for the Staff desk, which shows candidates' contact details. Without it, the desk is switched off. Use 8+ characters and share it only with booth staff. |
| `DATA_DIR` | In production | `./data` at the repo root (`/data` in Docker) | Folder for the database file `pulse.db`. **Must be on a persistent disk**, or answers and jobs are lost on restart. |
| `PORT` | No | `3000` | Port the app listens on. Most hosts set this for you. |
| `MAX_SUBMITS_PER_MIN` | No | `60` | Answers accepted per IP address per minute. Expo Wi-Fi often puts many phones behind one IP; raise it if visitors see "Too many answers". |

The app reads real environment variables; it does not load `.env` automatically. Set them in your shell (below) or in your hosting dashboard.

---

## Try it on your computer (5 minutes)

Needs Node.js 20 or newer.

```bash
npm install
# bash / macOS / Linux
STAFF_PIN=123456 npm start
# Windows PowerShell
$env:STAFF_PIN="123456"; npm start
```

Use `npm run dev` instead of `npm start` to restart the server automatically when files change.

Open http://localhost:3000, go to **Staff desk**, enter the PIN and upload `templates/Upcruit_BTS2026_Jobs_Template.xlsx` once you've filled it in.

---

## Deploy

> **Deploying on AWS?** Use the ready-made setup in [`deploy/aws/`](deploy/aws/README.md): one command in AWS CloudShell creates an encrypted EC2 server in Mumbai with HTTPS, daily backups and the staff PIN in Parameter Store.

Otherwise, pick one. All three give you an `https://` address; HTTPS matters because visitors scan the QR code on their phones.

> **Run exactly one copy of the app.** The database is a single file, so don't scale to multiple instances or use serverless hosts (Vercel, Netlify Functions, Cloud Run with scale-to-zero). They don't keep files between requests.

### Option A: Render (easiest, about 20 minutes)

1. Put this repository in a **private** GitHub repository.
2. In Render: **New → Web Service** → connect the repo. Render detects the `Dockerfile`.
3. Choose a paid instance type (persistent disks aren't available on the free tier) and region **Singapore** (closest to Bengaluru).
4. **Advanced → Add Disk**: mount path `/data`, size 1 GB.
5. **Environment**: add `STAFF_PIN` (and nothing else is required; `DATA_DIR=/data` is set by the Dockerfile).
6. **Health check path**: `/api/health`. Create the service.
7. Optional custom domain: **Settings → Custom Domains** → add `pulse.upcruit.ai`, then create the CNAME record Render shows you at your DNS provider. Render issues the HTTPS certificate automatically.

### Option B: Railway (about 20 minutes)

1. Put this repository in a private GitHub repository.
2. In Railway: **New Project → Deploy from GitHub repo**. Railway builds the `Dockerfile`.
3. On the service: **Volumes → New Volume**, mount path `/data`.
4. **Variables**: add `STAFF_PIN`.
5. **Settings → Networking → Generate Domain** (or add `pulse.upcruit.ai` as a custom domain and create the CNAME it shows).

### Option C: Your own server or cloud VM (AWS, GCP, Azure, DigitalOcean…)

Any Linux VM with Docker. Point a DNS record (e.g. `pulse.upcruit.ai`, type A) at the VM's public IP first.

```bash
# on the server, in this folder
docker build -t upcruit-hiring-pulse .
docker volume create pulse-data
docker run -d --name hiring-pulse --restart unless-stopped \
  -p 127.0.0.1:3000:3000 \
  -v pulse-data:/data \
  -e STAFF_PIN=your-pin \
  upcruit-hiring-pulse
```

Add HTTPS with Caddy (it gets the certificate automatically). Install Caddy, then put this in `/etc/caddy/Caddyfile` and run `sudo systemctl reload caddy`:

```
pulse.upcruit.ai {
    reverse_proxy 127.0.0.1:3000
}
```

Open ports 80 and 443 in the VM's firewall/security group. Using nginx instead? Proxy to `127.0.0.1:3000` as usual and pass `X-Forwarded-For` so the per-device limit sees real visitor IPs.

**Without Docker:** install Node.js 20+, run `npm ci --omit=dev`, then start `node apps/server/src/server.js` with the variables above using pm2 or systemd.

### Check it worked

- `https://YOUR-ADDRESS/api/health` shows `{"ok":true}`.
- `https://YOUR-ADDRESS/#demo` shows the TV screen with sample data.
- The Staff desk accepts your PIN.

---

## Loading jobs

1. Fill in `templates/Upcruit_BTS2026_Jobs_Template.xlsx` (one row per job from row 3; the **How to fill** tab explains every column).
2. **Staff desk → Open jobs → Upload jobs.** Each upload **replaces** the whole list, so always upload the full file.
3. The desk lists what loaded and warns about any row it skipped (missing skill, bad link, duplicate ID). A `.csv` export of the Jobs sheet also works.

**How matching works:**
1. **Experience first.** A job is only considered if the candidate's experience band overlaps the job's Min–Max experience (e.g. a 3–5 years candidate can match a 2–5 or a 3+ job, not a 6–10 job). Freshers only see jobs marked Fresher-friendly = Yes or with 0 minimum experience.
2. **Then skills.** Jobs are ranked by overlap between their Skill 1–3 and the candidate's skills (Skill 1 counts most), plus a small boost for the skill they're training in.
3. Only Active = Yes jobs are used. Each candidate sees their top 3. Freshers with no skill overlap still see the fresher-friendly jobs.

The TV's "Matched to open jobs" counter is the number of job seekers who got at least one match.

---

## Booth-day checklist

**Before Tuesday**
- [ ] Deploy and open `/#demo` on the actual TV to check readability.
- [ ] Upload the jobs file; test the questions on a phone and confirm Apply links open.
- [ ] Scan the TV's QR code from 2–3 metres away. If it's hard to scan, print a large QR for the counter: open `/api/qr?text=https://YOUR-ADDRESS/%23join`, save it and print it.

**Each morning**
- [ ] TV laptop: `/#display` → Full screen. Disable sleep/screensaver.
- [ ] Tablet: `/#kiosk` → Full screen. Turn on Guided Access (iPad) or Screen pinning (Android) so visitors can't leave the page. Staff can still use **Exit** (top right).
- [ ] Day 1 only, just before doors open: Staff desk → **Clear test entries**.
- [ ] Upload a fresh jobs file if openings changed.

**Each evening**
- [ ] Staff desk → **Download all answers with contact details (.csv)** as a backup and for follow-up. Store it somewhere access-controlled, not in a shared chat.

---

## Data, privacy and backups

The app now collects personal data (name, email, mobile), so treat it with care. This is practical guidance, not legal advice; check with whoever handles privacy at Upcruit, since India's Digital Personal Data Protection Act applies to this kind of data.

- **Consent:** job seekers must tick "I agree that Upcruit.ai can store these details and contact me about jobs that match my profile" before they can continue. Showing their first name on the TV is a separate, optional tick. Change the wording in `apps/web/public/index.html` (search for `cConsent`) if your privacy team wants different text or a link to your privacy policy.
- **Where it shows:** contact details are visible only on the Staff desk (PIN-protected) and in the CSV download. The TV, the tablet start screen and the public `/api/data` feed never include email or phone. The booth tablet clears the form as soon as a sign-up is saved, and the browser's autofill is off on the tablet so the next visitor can't see previous entries.
- **HTTPS is required** in production, since details travel from visitors' phones. All three deploy options above provide it.
- **Repeat sign-ups:** if someone signs up twice with the same email, the TV counts them once (latest answers). The Staff desk and CSV keep every entry.
- "Clear test entries" only hides older answers from the TV; the candidate list and CSV still include everything. "Show older answers again" undoes it.
- **Backups:** download the CSV, or copy `pulse.db` from the data folder/volume (`docker cp hiring-pulse:/data/pulse.db .`).
- **After the event:** move the candidates into your normal systems, then stop the app and delete `pulse.db` (and the volume/disk) so personal data doesn't linger on the event server.

## Troubleshooting

| Symptom | Fix |
|---|---|
| TV shows "Can't reach the server" | Check the laptop's internet. The screen recovers by itself when the connection returns. |
| Answers vanish after a restart/redeploy | `DATA_DIR` isn't on a persistent disk/volume. See your host's step above. |
| Staff desk says "Staff desk is off" | Set `STAFF_PIN` and restart. |
| Visitor sees "Please check your mobile number" | Enter 10 digits for an Indian number, or start with + and the country code for others. |
| Visitors see "Too many answers from this device" | Many phones share the expo Wi-Fi IP. Raise `MAX_SUBMITS_PER_MIN` (e.g. 300). |
| A job doesn't appear | Check Active = Yes, at least one skill picked from the dropdown, and an Apply link starting with `https://`. The upload message lists skipped rows. |
| `npm install` fails on `better-sqlite3` | Use Node 20+ and a normal dev machine (build tools or a prebuilt binary). The Docker image is the fallback. |

## Changing questions or wording

All answer options live in `packages/questions/questions.js` (shared by the screens and the server). The Skills and Role labels must stay identical to the **Lists** tab of the jobs template so uploads keep matching. Screens and styles are in `apps/web/public/index.html`; the API is in `apps/server/src/server.js`.

## API (for your developers)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/health` | Health check |
| GET | `/api/data` | Answers for the screens (no contact details), active job count |
| POST | `/api/responses` | Save an answer; job seekers get `matches` back |
| GET | `/api/staff/candidates` | Latest 100 job seekers with contact details |
| GET | `/api/qr?text=…` | QR code as SVG |
| POST | `/api/staff/login`, `/api/staff/clear`, `/api/staff/unclear` | Header `x-staff-pin` |
| GET/POST | `/api/staff/jobs` | List / upload jobs (multipart field `file`) |
| GET | `/api/staff/export.csv` | All answers |

To pull jobs live from Upcruit later, replace `allJobs()` in `apps/server/src/server.js` with a call to your jobs API and map each job to `{ id, title, company, skills: [skill ids], fresher, location, mode, salary, tools, minExp, maxExp, link, active }`.

---

## Publish to GitHub

The repo is a monorepo, so commit from the root once; every workspace is included.

```bash
git init -b main
git add .
git commit -m "Monorepo: split server, web screens and shared questions"
git remote add origin https://github.com/DheerajGowda22/BTS_Display.git
git push -u origin main
```

If the remote already has commits, pull first and resolve conflicts:

```bash
git pull origin main --rebase
git push -u origin main
```

`node_modules/`, `data/` (the SQLite database) and `.env` are ignored, so candidate data and the staff PIN never reach GitHub. Authentication uses your GitHub account: a Personal Access Token with `repo` scope, Git Credential Manager, or `gh auth login` when the `gh` CLI is installed.