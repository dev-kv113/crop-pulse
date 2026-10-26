# Deploying Crop Analytics

Written for someone who has an AWS account and has not deployed a server before.
Every step says **what you are doing and why**, not just what to type.

By the end, shipping a change is:

```bash
git push
```

…and you get a **staging** environment where you can break things without a
farmer noticing.

| | Time | Cost |
|---|---|---|
| Parts 1–4 (get it live) | ~2 hours the first time | ~US$20–25/month |
| Part 5 (automatic deploys + staging) | ~45 minutes | ~US$1/month more |

Getting the app onto farmers' phones needs no app store and no extra
infrastructure — see **[DEPLOY-ANDROID.md](DEPLOY-ANDROID.md)**. It works as soon
as Part 4 is done, because the only requirement is HTTPS.

---

## Contents

**Part 0 — [Before you start](#part-0--before-you-start)**

**Part 1 — The server**
1. [What we are building](#1-what-we-are-building-in-plain-terms)
2. [Create the server](#2-create-the-server-ec2)
3. [Connect to it](#3-connect-to-the-server)
4. [Install Docker](#4-install-docker)

**Part 2 — The backend**
5. [Lay out the folders](#5-lay-out-the-folders)
6. [Production settings](#6-write-the-production-settings)
7. [Start it](#7-start-the-backend)

**Part 3 — Domains and HTTPS**
8. [Point your domain at the server](#8-point-your-domain-at-the-server)
9. [Turn on HTTPS](#9-turn-on-https)

**Part 4 — The web app**
10. [Publish to S3 and CloudFront](#10-publish-the-web-app)
11. [Load your data](#11-load-your-data)
12. [Back-ups](#12-back-ups--do-not-skip-this)

**Part 5 — Automatic deploys and staging**
13. [Add the staging stack](#13-add-a-staging-stack)
14. [Staging domains](#14-give-staging-its-own-addresses)
15. [Let GitHub into the server](#15-let-github-into-the-server)
16. [Configure GitHub](#16-configure-github)
17. [Try it](#17-create-develop-and-try-it)
18. [The everyday routine](#18-the-everyday-routine)
19. [Rolling back](#19-rolling-back)

**[When something breaks](#when-something-breaks)**

---

# Part 0 — Before you start

## 0.1 The OTP problem — start this today, it takes weeks

Right now the app runs `SMS_PROVIDER=console`: the verification code is
**returned in the API response** instead of being texted. That is deliberate for
development and **must not reach farmers** — anyone could sign in as anyone.

To send real SMS to Indian numbers you need **DLT registration** (a TRAI rule).
This is paperwork, not code:

1. Pick a provider. **MSG91** or **Kaleyra** are the usual choices in India
   because they walk you through DLT. (AWS's own SNS is poor for India SMS.)
2. Register your business on their DLT portal — company details, GST, PAN.
3. Register a **sender ID**: the six letters recipients see as the sender, e.g.
   `GEOTRN`.
4. Register a **message template** — the exact wording, with a placeholder:
   `Your Crop Analytics verification code is {#var#}. Valid 5 minutes.`
5. Wait for operator approval: **days to weeks.**

Start it now, in parallel with everything below. When approved, switching over is
one small class in `backend/app/sms.py` plus `SMS_PROVIDER=msg91` in the
settings. Nothing else changes.

> You can deploy and test with your own team before DLT is approved — just
> understand that with `console` the code is visible to anyone who calls the API.
> **Do not give the link to farmers until real SMS works.**

## 0.2 Generate a real JWT secret

**What this is, in plain terms.** When a farmer types their code correctly, the
server hands their phone a small pass — like a wristband at an event. Every later
request shows the wristband instead of the code again. That is why a farmer signs
in once and stays signed in.

Anyone can *read* a wristband. What stops forgery is that the server stamps each
one with a secret only it knows, and checks the stamp every time. **`JWT_SECRET`
is that stamp.**

The value in the repository is `dev-secret-change-me` — public, for anyone to
see. Deploy with it and someone could forge a wristband saying "I am an admin",
and the server would believe it.

Generate a real one on your Mac:

```bash
python3 -c "import secrets; print(secrets.token_urlsafe(48))"
```

All that command does is print unguessable text. **Copy it somewhere safe** —
you paste it in step 6.

- **Never commit it.** It belongs only in `backend/.env` on the server, which is
  git-ignored.
- **Changing it later signs everybody out.** Old wristbands stop matching. Not
  harmful — people log in again — but do not do it casually.
- **Set it before your first real farmer signs in, not after.** A farmer's
  wristband lasts ten years (`FARMER_JWT_EXPIRY_HOURS`), so changing the secret
  later means every farmer needs a fresh OTP — an SMS each, that you pay for.

*(JWT stands for JSON Web Token. The name does not matter; the wristband does.)*

## 0.3 Decide your admin phone numbers

Whoever should reach the admin screen. Include your own.

## 0.4 Buy a domain

About ₹1,000/year. Buying it in **Route 53** keeps everything in one AWS
account: Console → **Route 53** → **Registered domains** → **Register domain**.
Registration can take up to an hour.

Already have one at GoDaddy or Namecheap? Fine — you will add DNS records there
in step 8 instead.

## 0.5 Have your data ready

The plot register GeoJSON, ideally with phone numbers in it. See
**[DATA-FORMAT.md](DATA-FORMAT.md)** for exactly which column names the importer
reads.

> **Regions.** Pick **Asia Pacific (Mumbai) `ap-south-1`** in the top-right
> region selector and stay in it. Resources in different regions cannot see each
> other, and Mumbai is closest to your users. (The one exception is a
> certificate in step 10 — AWS forces that one into N. Virginia.)

---

# Part 1 — The server

## 1. What we are building, in plain terms

| Piece | Plain meaning | Where it runs |
|---|---|---|
| **EC2 instance** | A computer you rent from Amazon, always on | AWS |
| **Docker** | Runs the API and database in sealed boxes, so the server needs almost nothing installed | on that computer |
| **Caddy** | Faces the internet, provides HTTPS (the padlock), forwards traffic to the API | on that computer |
| **S3 + CloudFront** | Stores and serves the web app's files, fast, worldwide | AWS |

Two addresses at the end:

- `https://api.yourdomain.com` — the backend
- `https://app.yourdomain.com` — what farmers open

**Why one server instead of many managed AWS services?** It is far cheaper,
there is one place to look when something breaks, and the load here is modest —
a farmer's request takes about 5 milliseconds. The last section covers when it is
worth growing.

## 2. Create the server (EC2)

1. Console → **EC2** → **Instances** → **Launch instances**.
2. **Name**: `crop-analytics`.
3. **Application and OS image**: **Amazon Linux 2023**.
4. **Architecture**: **64-bit (Arm)** ← important. Arm is cheaper, and this app
   is tested on it.
5. **Instance type**: **t4g.small** (2 GB RAM, ~US$12/month). `t4g.micro` is half
   the price, but 1 GB is tight while a large GeoJSON is processing.
6. **Key pair** — your door key:
   - **Create new key pair**, name `crop-analytics-key`, type **RSA**, format
     **.pem**.
   - It downloads once. **Lose it and you lose access to the server.**
7. **Network settings → Edit**, and allow:

   | Type | Port | Source | Why |
   |---|---|---|---|
   | SSH | 22 | **My IP** | So you can log in |
   | HTTP | 80 | Anywhere | Certificate renewal |
   | HTTPS | 443 | Anywhere | The app itself |

   Do **not** open 5432 or 8000. Nothing outside the server needs them.
8. **Storage**: change 8 GB to **30 GB gp3**.
9. **Launch instance**.

Then give it a permanent address — by default the IP changes on restart, which
would break your domain:

1. EC2 → **Elastic IPs** → **Allocate Elastic IP address** → **Allocate**.
2. Select it → **Actions** → **Associate** → your instance → **Associate**.
3. **Write this IP down.**

## 3. Connect to the server

```bash
# SSH refuses to use a key that others could read
chmod 400 ~/Downloads/crop-analytics-key.pem

ssh -i ~/Downloads/crop-analytics-key.pem ec2-user@YOUR_ELASTIC_IP
```

Say `yes` to the fingerprint prompt. A prompt ending in `$` means you are on the
server. **Everything until step 10 is typed there.**

## 4. Install Docker

```bash
sudo dnf update -y
sudo dnf install -y docker git
sudo systemctl enable --now docker
sudo usermod -aG docker ec2-user
```

That last line only takes effect on a fresh login, so:

```bash
exit
ssh -i ~/Downloads/crop-analytics-key.pem ec2-user@YOUR_ELASTIC_IP
docker --version
```

---

# Part 2 — The backend

## 5. Lay out the folders

One folder per environment from the start, so adding staging in Part 5 is not a
reorganisation:

```bash
mkdir -p ~/apps/prod
cd ~/apps/prod
git clone https://github.com/dev-kv113/crop-pulse.git
cd crop-pulse
```

Private repo? Generate a GitHub personal access token and use
`https://YOUR_TOKEN@github.com/dev-kv113/crop-pulse.git`.

## 6. Write the production settings

Two files. The first tells Docker Compose which stack this is:

```bash
nano ~/apps/prod/crop-pulse/.env
```

```ini
STACK=crop-prod
API_PORT=8010
DB_PORT=5433
POSTGRES_PASSWORD=PICK_A_LONG_PASSWORD
```

The second holds the application settings:

```bash
nano ~/apps/prod/crop-pulse/backend/.env
```

```ini
DATABASE_URL=postgresql://croppulse:PICK_A_LONG_PASSWORD@db:5432/croppulse
DB_POOL_MIN=2
DB_POOL_MAX=20

JWT_SECRET=PASTE_THE_SECRET_FROM_STEP_0.2
# Staff sessions: admin, read-only admin, unit head. 720 hours = 30 days.
JWT_EXPIRY_HOURS=720
# Farmers stay signed in. 87600 hours = 10 years, i.e. one OTP and then the app
# just opens. Set this to 720 as well if you want farmers signed out monthly.
FARMER_JWT_EXPIRY_HOURS=87600

ADMIN_PHONES=+919999999999,+918888888888

# console = the code is printed to the log and returned by the API. Never use
# it once farmers have the link. msg91 = real SMS.
SMS_PROVIDER=msg91
MSG91_AUTH_KEY=PASTE_YOUR_MSG91_AUTHKEY
MSG91_SENDER_ID=GEOTRN
# MSG91's own flow id from their panel, not the 19-digit DLT template id.
MSG91_TEMPLATE_ID=6a8c5a06235d7ea171092d72
MSG91_OTP_VAR=OTP

OTP_LENGTH=6
OTP_TTL_SECONDS=300
OTP_MAX_ATTEMPTS=5

UPLOAD_DIR=/data/uploads

CORS_ORIGINS=https://app.yourdomain.com
```

Save with `Ctrl+O`, `Enter`, `Ctrl+X`. Use the **same password** in both files.

Three of these are worth understanding:

- **`@db:5432`** — inside Docker the database answers to the name `db`, not
  `localhost`.
- **`CORS_ORIGINS`** — browsers block a web page from calling an API on a
  different domain unless the API says that domain is allowed. This is that list.
  The installed phone app runs from the same domain, so one entry covers both.
- **`SMS_PROVIDER=console`** — change the moment DLT is approved.

Finally, close the database to the outside world:

```bash
nano docker-compose.yml
```

Delete the two `ports:` lines under `db` (the `- "${DB_PORT:-5433}:5432"` one).
Only the API needs the database, and it reaches it inside Docker.

## 7. Start the backend

```bash
cd ~/apps/prod/crop-pulse
docker compose up -d --build
```

First run takes a few minutes. Then:

```bash
curl http://localhost:8010/health
# {"status":"ok"}
```

Tables are created automatically on first start. `docker compose logs -f api`
shows what it is doing (`Ctrl+C` stops watching, not the server).

---

# Part 3 — Domains and HTTPS

## 8. Point your domain at the server

Add two DNS records, both pointing at your Elastic IP:

| Name | Type | Value |
|---|---|---|
| `api.yourdomain.com` | A | your Elastic IP |
| `app.yourdomain.com` | A | your Elastic IP |

**Route 53:** Hosted zones → your domain → **Create record** → name `api`,
type **A**, value your IP → **Create**. Repeat for `app`.

DNS takes 5–30 minutes to spread. From your Mac:

```bash
dig +short api.yourdomain.com
```

Move on once it prints your IP.

## 9. Turn on HTTPS

HTTPS is the padlock. Without it browsers warn users, and Android refuses to let
the app call your API. **Caddy** gets and renews certificates automatically.

```bash
nano ~/apps/prod/Caddyfile
```

```
api.yourdomain.com {
    reverse_proxy localhost:8010
}
```

That says: for requests to `api.yourdomain.com`, get a certificate, then hand
them to the API on port 8010.

```bash
docker run -d --name caddy --restart unless-stopped --network host \
  -v ~/apps/prod/Caddyfile:/etc/caddy/Caddyfile \
  -v caddy_data:/data \
  caddy:2
```

Wait ~30 seconds, then from **your Mac**:

```bash
curl https://api.yourdomain.com/health
# {"status":"ok"}
```

Certificates renew themselves from here on.

---

# Part 4 — The web app

## 10. Publish the web app

The frontend is plain files. **S3** stores them, **CloudFront** serves them
worldwide over HTTPS.

### Build it — on your Mac

```bash
cd ~/Desktop/personal/crop-pulse/frontend
echo "VITE_API_BASE_URL=https://api.yourdomain.com" > .env.production
npm run build
```

The API address is **compiled into the build**, so if that address ever changes
you must rebuild.

### Create the bucket

1. Console → **S3** → **Create bucket**.
2. Name `crop-analytics-web` (globally unique — add digits if taken).
3. Region **ap-south-1**.
4. Leave **Block all public access ticked**. CloudFront reads it privately, which
   is safer and the modern default.

### Upload

```bash
aws s3 sync dist/ s3://crop-analytics-web/ --delete
```

No `aws` command? Install the AWS CLI and run `aws configure` with a key from
**IAM → Users → Security credentials**. Or drag the *contents* of `dist/` into
the bucket in the console.

### Put CloudFront in front

1. Console → **CloudFront** → **Create distribution**.
2. **Origin domain**: your S3 bucket.
3. **Origin access**: **Origin access control settings (recommended)** →
   **Create new OAC** → Create. Then **Copy policy** and paste it into the
   bucket's **Permissions → Bucket policy**. This is what lets CloudFront read a
   private bucket.
4. **Viewer protocol policy**: **Redirect HTTP to HTTPS**.
5. **Default root object**: `index.html`.
6. **Custom SSL certificate** → **Request certificate** → `app.yourdomain.com`,
   DNS validation.
   *(This certificate must be created in **N. Virginia `us-east-1`** — CloudFront
   only accepts certificates from there. An AWS quirk, not a mistake.)*
7. **Alternate domain name (CNAME)**: `app.yourdomain.com`.
8. Create, wait ~15 minutes.
9. Change the `app` DNS record to point at the CloudFront domain
   (`d111111abcdef8.cloudfront.net`). In Route 53 use an **Alias** record.

Open `https://app.yourdomain.com` — you should see the login screen.

## 11. Load your data

Sign in with an `ADMIN_PHONES` number, then:

1. Pick a unit and rename it to the real name.
2. Upload that unit's plot register.
3. Upload the survey GeoJSON with its date.
4. Wait for the row to read **ready** — a few minutes for a large file.
5. Set login numbers for a couple of farmers, and use **View as farmer** to check
   what they see.

## 12. Back-ups — do not skip this

The server can fail. Without back-ups you lose everything.

```bash
mkdir -p ~/backups
nano ~/backup.sh
```

```bash
#!/bin/bash
set -e
STAMP=$(date +%Y%m%d-%H%M)
docker exec crop-prod-db pg_dump -U croppulse croppulse | gzip > ~/backups/db-$STAMP.sql.gz
# keep two weeks locally
find ~/backups -name 'db-*.sql.gz' -mtime +14 -delete
# and copy off the server, so a dead server is not a dead business
aws s3 cp ~/backups/db-$STAMP.sql.gz s3://crop-analytics-backups/
```

```bash
chmod +x ~/backup.sh
crontab -e
```

Add, for 2am daily:

```
0 2 * * * /home/ec2-user/backup.sh >> /home/ec2-user/backup.log 2>&1
```

Create the `crop-analytics-backups` bucket and give the instance an IAM role that
can write to it. **Then test a restore** — an untested back-up is not a back-up:

```bash
gunzip -c ~/backups/db-XXXX.sql.gz | docker exec -i crop-prod-db psql -U croppulse -d croppulse
```

---

# Part 5 — Automatic deploys and staging

Everything so far was manual on purpose: you now know what a deploy *is*. This
part replaces it with `git push`, and adds a staging environment.

| Branch | Environment | API | Web app |
|---|---|---|---|
| `develop` | **Staging** — break things here | `api-staging.yourdomain.com` | `app-staging.yourdomain.com` |
| `main` | **Production** — farmers | `api.yourdomain.com` | `app.yourdomain.com` |

Separate databases, so staging cannot touch real data. Both share one EC2
instance, because the server is idle almost all the time and a second one would
be money for nothing.

```
  you: git push origin develop
        │
        ▼
  GitHub Actions
        ├── backend changed?  ──► ssh to EC2 ──► git pull ──► rebuild ──► health check
        └── frontend changed? ──► npm build ──► upload to S3 ──► clear CloudFront cache
```

The two workflow files are already in the repo, under `.github/workflows/`. They
only run when files that matter changed — editing a README deploys nothing.

## 13. Add a staging stack

```bash
mkdir -p ~/apps/staging
cd ~/apps/staging
git clone https://github.com/dev-kv113/crop-pulse.git
cd crop-pulse
git checkout develop
```

Its Compose settings — different names and ports so nothing collides:

```bash
nano ~/apps/staging/crop-pulse/.env
```

```ini
STACK=crop-staging
API_PORT=8020
DB_PORT=5434
POSTGRES_PASSWORD=A_DIFFERENT_PASSWORD
```

Its application settings:

```bash
cp ~/apps/prod/crop-pulse/backend/.env ~/apps/staging/crop-pulse/backend/.env
nano ~/apps/staging/crop-pulse/backend/.env
```

Change:

```ini
DATABASE_URL=postgresql://croppulse:A_DIFFERENT_PASSWORD@db:5432/croppulse
CORS_ORIGINS=https://app-staging.yourdomain.com
SMS_PROVIDER=console
```

> Keep staging on `console` even after DLT approval. It costs nothing to test
> with, and stops test runs texting real farmers.

Because container names come from `STACK`, production is `crop-prod-*` and
staging is `crop-staging-*` — separate containers, separate data.

```bash
cd ~/apps/staging/crop-pulse
docker compose up -d --build
curl http://localhost:8020/health
```

## 14. Give staging its own addresses

**DNS** — two more records pointing at the same Elastic IP:

| Name | Type | Value |
|---|---|---|
| `api-staging.yourdomain.com` | A | your Elastic IP |
| `app-staging.yourdomain.com` | A | your Elastic IP (later, the CloudFront alias) |

**Caddy:**

```bash
nano ~/apps/prod/Caddyfile
```

```
api.yourdomain.com {
    reverse_proxy localhost:8010
}

api-staging.yourdomain.com {
    reverse_proxy localhost:8020
}
```

```bash
docker restart caddy
```

**S3 + CloudFront** — repeat step 10 with staging names: bucket
`crop-analytics-web-staging`, certificate and alias for
`app-staging.yourdomain.com`.

## 15. Let GitHub into the server

GitHub needs an SSH key to log in and deploy. **Do not reuse your personal
`.pem`** — a separate key can be revoked on its own.

On your Mac:

```bash
# Press Enter at the passphrase prompt: an automated job cannot type one.
ssh-keygen -t ed25519 -C "github-actions" -f ~/.ssh/crop_deploy_key

# Put the PUBLIC half on the server
ssh-copy-id -i ~/.ssh/crop_deploy_key.pub \
  -o IdentityFile=~/Downloads/crop-analytics-key.pem ec2-user@YOUR_ELASTIC_IP

ssh -i ~/.ssh/crop_deploy_key ec2-user@YOUR_ELASTIC_IP "echo connected"
```

The **private** half (`~/.ssh/crop_deploy_key`, no `.pub`) goes into GitHub next.
It is a password — never commit it, never paste it into a chat.

> GitHub's runners use AWS IPs that change, so a security group restricted to
> *My IP* will block them. Allow port 22 from anywhere — safe here because
> Amazon Linux disables password login, so only keys work — or use a self-hosted
> runner.

## 16. Configure GitHub

Repository → **Settings → Environments → New environment**. Create
**`production`** and **`staging`**. Environments let each hold *different values
under the same name*, so one workflow file serves both.

For **each** environment:

**Secrets** (hidden):

| Name | Value |
|---|---|
| `SSH_HOST` | Your Elastic IP |
| `SSH_PRIVATE_KEY` | The whole of `~/.ssh/crop_deploy_key`, including the `BEGIN`/`END` lines |
| `AWS_ACCESS_KEY_ID` | From IAM, below |
| `AWS_SECRET_ACCESS_KEY` | From IAM, below |
| `VITE_MAPTILER_KEY` | Optional — only if you use MapTiler imagery |

**Variables** (visible):

| Name | production | staging |
|---|---|---|
| `VITE_API_BASE_URL` | `https://api.yourdomain.com` | `https://api-staging.yourdomain.com` |
| `S3_BUCKET` | `crop-analytics-web` | `crop-analytics-web-staging` |
| `CLOUDFRONT_DISTRIBUTION_ID` | the production one | the staging one |

**The AWS key for GitHub:** IAM → **Users → Create user** →
`github-actions-deploy`. No console access. Attach an inline policy, with your
bucket names:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:DeleteObject", "s3:ListBucket"],
      "Resource": [
        "arn:aws:s3:::crop-analytics-web",
        "arn:aws:s3:::crop-analytics-web/*",
        "arn:aws:s3:::crop-analytics-web-staging",
        "arn:aws:s3:::crop-analytics-web-staging/*"
      ]
    },
    { "Effect": "Allow", "Action": "cloudfront:CreateInvalidation", "Resource": "*" }
  ]
}
```

Then **Security credentials → Create access key → Application running outside
AWS**. Copy both values into the secrets above — **the secret is shown once.**

That policy is deliberately narrow: it can publish the web app and nothing else,
so a leaked key is a bounded problem.

## 17. Create `develop` and try it

```bash
cd ~/Desktop/personal/crop-pulse
git checkout -b develop
git push -u origin develop
```

Watch the **Actions** tab; both workflows should go green. Then change something
visible, commit, push, and within a couple of minutes it is live on
`https://app-staging.yourdomain.com`.

## 18. The everyday routine

```bash
# 1. Work on develop
git checkout develop
git add -A && git commit -m "what changed" && git push
#    -> deploys to staging automatically

# 2. Check app-staging.yourdomain.com

# 3. Happy? Ship it
git checkout main && git merge develop && git push
#    -> deploys to production automatically
```

For anything substantial, open a **Pull Request** from `develop` to `main`
instead of merging locally: you get a diff to review before it reaches farmers.

**Protect `main`:** Settings → Branches → Add rule, name `main`, tick **Require a
pull request before merging**. That one tick makes it impossible to push straight
to production by accident.

### What the backend deploy actually does

1. Works out staging or production from the branch.
2. `git reset --hard` to that branch, so the server matches the repo exactly.
3. **Backs up the database** before anything changes.
4. Rebuilds and restarts the API. Migrations apply themselves on startup.
5. **Polls `/health` for 30 seconds.** If it never answers, it prints the last 60
   log lines and **fails loudly** rather than leaving you thinking it worked.
6. Prunes old Docker images, which otherwise fill the disk.

Your data is never touched — it lives in Docker volumes, not in the container.

## 19. Rolling back

```bash
git checkout main
git revert HEAD    # undoes the last commit, as a new commit
git push
```

Deployed within a couple of minutes. Reverting beats resetting because the
history stays honest about what happened.

If the *database* is wrong, restore the backup the workflow took just before:

```bash
ssh -i ~/Downloads/crop-analytics-key.pem ec2-user@YOUR_ELASTIC_IP
ls -lt ~/backups | head
cd ~/apps/prod/crop-pulse
docker compose stop api
gunzip -c ~/backups/predeploy-crop-prod-XXXX.sql.gz \
  | docker exec -i crop-prod-db psql -U croppulse -d croppulse
docker compose start api
```

---

# When something breaks

```bash
docker compose ps                    # is everything running?
docker compose logs --tail 100 api   # what did it say?
docker compose restart api           # turn it off and on again
df -h                                # disk full?
free -m                              # out of memory?
```

| Symptom | Likely cause |
|---|---|
| Site does not load | DNS not spread yet, or Caddy not running (`docker logs caddy`) |
| "Failed to fetch" in the browser | `CORS_ORIGINS` does not list your app domain |
| Certificate errors | Port 80 blocked in the security group — Caddy needs it to renew |
| Upload fails | Disk full. `docker system prune -a` clears old images |
| Everything slow | Check `docker stats`; if RAM is the limit, resize the instance |
| `Permission denied (publickey)` in Actions | `SSH_PRIVATE_KEY` wrong or missing its `BEGIN`/`END` lines |
| `did not become healthy` in Actions | API crashed on startup — the log tail is printed just below |
| `AccessDenied` on S3 in Actions | IAM policy missing that bucket, or variables set on the wrong environment |

Nothing is published unless every step before it passed, so a failed deploy
leaves the previous version running.

## When to outgrow one server

- **The database competes with the API for memory** → move it to **RDS
  PostgreSQL** (enable PostGIS once with `CREATE EXTENSION postgis;`). Usually
  the first thing to split out.
- **You need more than one API instance** → analysis processing currently runs as
  a background task *inside* the API process. With several instances behind a
  load balancer, the job runs on whichever one received the upload and is lost if
  that container restarts mid-job. Move it to a queue and worker (SQS plus a
  small worker service) before scaling out. Nothing else changes —
  `import_analysis_layer` is already a plain function taking a layer id, a unit
  id and a file path.
- **You want zero-downtime deploys** → ECS or Kubernetes.

None of that is needed on day one, and doing it early costs money and clarity you
do not get back.
