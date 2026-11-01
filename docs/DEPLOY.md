# Deploying Crop Analytics

Written for someone who has an AWS account and has not deployed a server before.
Every step says **what you are doing and why**, not just what to type.

Everything runs on **one EC2 instance**: the database, the API and the web app,
each in its own Docker container, with nginx in front for HTTPS. One script,
[`scripts/deploy.sh`](../scripts/deploy.sh), sets the server up once and then
ships every release:

```bash
ssh ec2-user@YOUR_ELASTIC_IP 'cd ~/crop-pulse && scripts/deploy.sh'
```

| | Time | Cost |
|---|---|---|
| First deploy (Parts 1–2) | ~1 hour | ~US$15–20/month (t4g.small, 30 GB disk, Elastic IP) |
| Every release after | ~3 minutes | — |

Getting the app onto farmers' phones needs no app store and no extra
infrastructure — see **[DEPLOY-ANDROID.md](DEPLOY-ANDROID.md)**. It works as soon
as Part 2 is done, because the only requirement is HTTPS.

---

## Contents

**Part 0 — [Before you start](#part-0--before-you-start)**

**Part 1 — The server**
1. [What we are building](#1-what-we-are-building-in-plain-terms)
2. [Create the server](#2-create-the-server-ec2)
3. [Connect to it](#3-connect-to-the-server)
4. [Point your domain at it](#4-point-your-domain-at-the-server)

**Part 2 — Install and deploy**
5. [Get the code](#5-get-the-code)
6. [Set up the server](#6-set-up-the-server)
7. [Production settings](#7-production-settings)
8. [First deploy](#8-first-deploy)

**Part 3 — Running it**
9. [Load your data](#9-load-your-data)
10. [Back-ups](#10-back-ups--do-not-skip-this)
11. [The everyday routine](#11-the-everyday-routine)
12. [Rolling back](#12-rolling-back)

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

**You do not need to make one by hand.** The server setup in step 6 generates
an unguessable secret and writes it into `backend/.env`, and the deploy script
refuses to run with the public placeholder. If you ever want to generate one
yourself:

```bash
python3 -c "import secrets; print(secrets.token_urlsafe(48))"
```

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
in step 4 instead.

## 0.5 Have your data ready

The plot register GeoJSON, ideally with phone numbers in it. See
**[DATA-FORMAT.md](DATA-FORMAT.md)** for exactly which column names the importer
reads.

> **Regions.** Pick **Asia Pacific (Mumbai) `ap-south-1`** in the top-right
> region selector and stay in it. Resources in different regions cannot see each
> other, and Mumbai is closest to your users.

---

# Part 1 — The server

## 1. What we are building, in plain terms

| Piece | Plain meaning |
|---|---|
| **EC2 instance** | A computer you rent from Amazon, always on |
| **Docker** | Runs the database, API and web app in sealed boxes, so the server needs almost nothing installed |
| **nginx + certbot** | Face the internet, provide HTTPS (the padlock), and hand every request to the web app container. certbot gets and renews the certificate |

```
  phone / browser
        │  https://app.yourdomain.com
        ▼
  nginx :443 on the server ─── HTTPS certificate (certbot)
        │
        ▼
  web container :8080  ──  the app's files
        │  /api/...
        ▼
  api container  ──►  db container (PostgreSQL + PostGIS)
```

One address, `https://app.yourdomain.com`, serves both the app and its API
(under `/api/`). Because they share an address, there is no cross-site (CORS)
setup to get wrong, and the installed phone app works the same way.

Only nginx is reachable from outside. The containers listen on the server's
loopback address only, and the deploy script refuses to run if that ever
changes.

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
server. **From here on, commands are typed there** unless a step says otherwise.

## 4. Point your domain at the server

Do this **before** step 6: the certificate can only be issued once the domain
points at this server.

Add one DNS record:

| Name | Type | Value |
|---|---|---|
| `app.yourdomain.com` | A | your Elastic IP |

**Route 53:** Hosted zones → your domain → **Create record** → name `app`, type
**A**, value your IP → **Create**.

**IPv6-only instance** (no public IPv4)? Use an **AAAA** record with the
instance's IPv6 address instead. Setup checks either kind. Bear in mind that
visitors on IPv4-only networks cannot reach an IPv6-only server, and that the
server itself cannot reach GitHub (which has no IPv6), so copy the code over
from your machine rather than `git clone`.

DNS takes 5–30 minutes to spread. From your Mac:

```bash
dig +short app.yourdomain.com
```

Move on once it prints your IP.

---

# Part 2 — Install and deploy

## 5. Get the code

```bash
sudo dnf install -y git
git clone https://github.com/dev-kv113/crop-pulse.git ~/crop-pulse
cd ~/crop-pulse
```

Private repo? Generate a GitHub personal access token and use
`https://YOUR_TOKEN@github.com/dev-kv113/crop-pulse.git`.

## 6. Set up the server

```bash
scripts/deploy.sh --setup app.yourdomain.com you@yourdomain.com
```

The email address is where Let's Encrypt sends certificate-expiry warnings. One
command, a few minutes, and it:

1. Adds a **2 GB swap file**. The app fits in the instance's 2 GB, but building a
   new version alongside it may not, and without swap Linux kills a process
   instead (often the database).
2. Installs **Docker** (with the compose and buildx plugins Amazon Linux leaves
   out), **nginx** and **certbot**.
3. Writes the nginx site from [`deploy/nginx-crop-pulse.conf`](../deploy/nginx-crop-pulse.conf),
   including a maintenance page shown whenever the app is restarting.
4. **Checks the domain points at this server**, and stops with a plain message if
   not, rather than burning Let's Encrypt's rate limit.
5. Gets the **HTTPS certificate** and turns on automatic renewal.
6. Writes two settings files, if they do not exist yet, with **generated
   secrets**:
   - `~/crop-pulse/.env` — Docker Compose settings: stack name, ports, a random
     database password, your domain, and
     `COMPOSE_FILE=docker-compose.yml:docker-compose.prod.yml`, which keeps every
     container off the public network.
   - `~/crop-pulse/backend/.env` — app settings, with a random `JWT_SECRET`.
7. Creates `~/crop-pulse-secrets/` for secrets that should not sit in a settings
   file.

It is safe to run again: it keeps the existing certificate and settings, and
fills in any setting that is missing (so you can start from a `.env` of your
own, e.g. one holding only `SECRETS_DIR`).

DNS not ready yet? Leave out the email (`--setup app.yourdomain.com`) to do
everything except the certificate, deploy, and re-run with the email later.

Then **log out and back in**, so your user can run Docker without `sudo`:

```bash
exit
ssh -i ~/Downloads/crop-analytics-key.pem ec2-user@YOUR_ELASTIC_IP
cd ~/crop-pulse
```

`https://app.yourdomain.com` should now show the maintenance page, with a
padlock. That proves DNS, nginx and the certificate all work before the app is
even running.

## 7. Production settings

Open the app settings:

```bash
nano backend/.env
```

Change these two:

```ini
ADMIN_PHONES=+919999999999,+918888888888

# console = the code is printed to the log and returned by the API. Never use
# it once farmers have the link. msg91 = real SMS.
SMS_PROVIDER=msg91
```

Save with `Ctrl+O`, `Enter`, `Ctrl+X`. Everything else was filled in by setup.

Then the MSG91 key, as a file holding only the key:

```bash
printf '%s' 'PASTE_YOUR_MSG91_AUTHKEY' > ~/crop-pulse-secrets/msg91_auth_key
chmod 600 ~/crop-pulse-secrets/msg91_auth_key
```

Keeping it in its own file, outside the repository, means it never appears in a
settings file you might copy, paste or show someone.

DLT not approved yet? Leave `SMS_PROVIDER=console` and deploy with
`--allow-console-sms` (next step) to test with your own team. **Give no farmer
the link until real SMS works**: with `console`, anyone can sign in as anyone,
including as an admin.

## 8. First deploy

```bash
scripts/deploy.sh
```

The first run builds everything and takes a few minutes. It:

1. **Refuses unsafe settings**, listing every problem at once: console OTPs
   (unless `--allow-console-sms`), a placeholder `JWT_SECRET`, the default
   database password, or any container reachable from outside the server.
2. Builds the API and web app images **before** stopping anything, so a broken
   build leaves the running version untouched.
3. **Backs up the database** to `~/backups` (from the second deploy on).
4. Starts the database, API and web app. Database tables are created
   automatically.
5. **Checks three hops**: the API answers, the web app answers, and the web app
   can reach the API. If the new version fails, it **puts the previous one
   back** automatically and tells you why.
6. Checks `https://app.yourdomain.com` from the server itself.

Open `https://app.yourdomain.com` — you should see the login screen.

---

# Part 3 — Running it

## 9. Load your data

Sign in with an `ADMIN_PHONES` number, then:

1. Pick a unit and rename it to the real name.
2. Upload that unit's plot register.
3. Upload the survey GeoJSON with its date.
4. Wait for the row to read **ready** — a few minutes for a large file.
5. Set login numbers for a couple of farmers, and use **View as farmer** to check
   what they see.

## 10. Back-ups — do not skip this

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


## 11. The everyday routine

On your Mac, commit and push to `main` as usual. Then:

```bash
ssh -i ~/Downloads/crop-analytics-key.pem ec2-user@YOUR_ELASTIC_IP \
  'cd ~/crop-pulse && scripts/deploy.sh'
```

That pulls `main`, deploys it, and prints a summary. It deploys the API and the
web app together, every time, so they can never be out of step.

| Option | When |
|---|---|
| `--no-pull` | Deploy exactly what is checked out on the server, e.g. a specific commit |
| `--allow-console-sms` | Before DLT approval only |

The script refuses to pull if someone has edited files on the server. Keep
server-specific settings in the two `.env` files and `~/crop-pulse-secrets/`,
which git never touches.

**Protect `main`:** on GitHub, Settings → Branches → Add rule, name `main`, tick
**Require a pull request before merging**. Whatever is on `main` is what the
next deploy ships.

## 12. Rolling back

**A deploy that fails rolls itself back.** If the new version does not come up
healthy, the script restarts the previous images and says so.

To undo a release that deployed fine but is wrong:

```bash
# on your Mac
git revert HEAD    # undoes the last commit, as a new commit
git push
# then deploy as usual
```

Reverting beats resetting because the history stays honest about what happened.

If the *database* is wrong, restore the backup the deploy took just before:

```bash
ls -lt ~/backups | head
cd ~/crop-pulse
docker compose stop api
gunzip -c ~/backups/predeploy-crop-prod-XXXX.sql.gz \
  | docker exec -i crop-prod-db psql -U croppulse -d croppulse
docker compose start api
```

---

# When something breaks

```bash
cd ~/crop-pulse
docker compose ps                         # is everything running?
docker compose logs --tail 100 api web    # what did they say?
docker compose restart api                # turn it off and on again
sudo nginx -t && sudo systemctl status nginx
df -h                                     # disk full?
free -m                                   # out of memory?
```

| Symptom | Likely cause |
|---|---|
| Site does not load at all | DNS not spread yet, security group missing 80/443, or nginx stopped (`sudo systemctl status nginx`) |
| Maintenance page | The web container is down or restarting: `docker compose ps`, then `docker compose logs web` |
| Certificate errors | Port 80 blocked in the security group; certbot needs it to renew (`sudo certbot renew --dry-run`) |
| `--setup` says the domain points elsewhere | The A record is wrong or has not spread; check with `dig +short` |
| `Not deploying - fix these first` | The deploy script found unsafe settings; it lists each one |
| `rolled back` | The new version crashed on startup; the log tail is printed above the message |
| `Cannot talk to Docker` | Log out and back in after `--setup`, so the docker group applies |
| Upload fails | Disk full. `docker system prune -a` clears old images |
| A container keeps restarting | It hit its memory limit. `docker inspect -f '{{.State.OOMKilled}}' crop-prod-db` says `true`; `docker stats` shows usage against the limits |
| Everything slow | Check `docker stats`; if RAM is the limit, resize the instance and raise the limits in `docker-compose.prod.yml` |

Nothing restarts until the new version has built, and a version that does not
come up healthy is replaced by the previous one, so a failed deploy leaves the
site running.

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
