# Deploy Taskpath on an Ubuntu VPS

This guide deploys an invite-only Taskpath installation with private per-user vaults on Ubuntu 24.04 or 22.04. Docker Compose runs Taskpath and SQLite. Nginx runs on the VPS host, terminates HTTPS, and proxies to Taskpath on `127.0.0.1:3000`. The database is kept in a Docker named volume.

**Already running the multi-user version?** Follow [Update Taskpath](#10-update-taskpath), then [Enable background reminders](#enable-background-reminders). Keep your existing `.env`, accounts, and volume. The picker update (`accounts-v16`) preserves the database and encrypted browser storage; it does not require a new vault, password, or migration command. Only older plaintext/single-owner installations need the separate fresh-start procedure.

The image uses Bun **1.4.2**. Docker installs the versions in `bun.lock`, including the server's Drizzle ORM and `web-push` dependencies, and minifies the client during the image build. You do not need Bun or `node_modules` on the VPS host. The Drizzle refactor uses the same multi-user SQLite database; no migration command, new volume, or account setup is needed.

You need:

- a VPS with a public IP and a sudo-capable SSH account;
- a domain or subdomain, such as `tasks.example.com`;
- the Taskpath project on your computer;
- outbound internet access from the VPS.

Commands below use `tasks.example.com`, `203.0.113.10`, and the SSH user `ubuntu` as examples. Replace them with your values. Keep the application port bound to loopback; the public application ports are 80 and 443, in addition to your SSH access.

## 1. Point the domain at the VPS

At your DNS provider, create an **A** record:

| Field | Value |
|---|---|
| Name | `tasks` (or the full hostname your provider expects) |
| Type | `A` |
| Value | your VPS IPv4 address |

Create an **AAAA** record only when the VPS has working public IPv6. Wait for DNS to resolve to the VPS before requesting a certificate. From your computer, check:

```sh
dig +short tasks.example.com A
dig +short tasks.example.com AAAA
```

An absent AAAA response is fine. A returned address must belong to this VPS.

## 2. Connect and prepare the server

```sh
ssh ubuntu@203.0.113.10
sudo apt update
sudo apt upgrade
sudo apt install ca-certificates curl nginx certbot ufw
```

Configure the firewall before enabling it. If your SSH service does not use the standard `OpenSSH` profile, allow its actual port first so you do not lock yourself out.

```sh
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
sudo ufw status verbose
```

Also configure the VPS provider's network firewall, if available: allow TCP 80/443 from anywhere and restrict SSH to your own IP where practical. Do not open port 3000.

## 3. Install Docker Engine and Compose

These commands use Docker's official Ubuntu package repository:

```sh
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
```

```sh
. /etc/os-release
DOCKER_ARCH="$(dpkg --print-architecture)"
DOCKER_CODENAME="${UBUNTU_CODENAME:-$VERSION_CODENAME}"
sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: ${DOCKER_CODENAME}
Components: stable
Architectures: ${DOCKER_ARCH}
Signed-By: /etc/apt/keyrings/docker.asc
EOF
sudo apt update
sudo apt install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo docker version
sudo docker compose version
```

Using `sudo docker` in this guide avoids adding your SSH account to the `docker` group; membership in that group effectively grants root-level control of the host.

## 4. Copy Taskpath to the VPS

On the VPS, create the application directory:

```sh
sudo install -d -m 0750 -o ubuntu -g ubuntu /opt/taskpath
exit
```

On your computer, run this command from the Taskpath project directory:

```sh
rsync -av \
  --exclude '.git/' \
  --exclude '.env' \
  --exclude 'data/' \
  --exclude 'node_modules/' \
  --exclude 'dist/' \
  --exclude 'coverage/' \
  ./ ubuntu@203.0.113.10:/opt/taskpath/
```

The exclusions prevent local credentials, development data, and generated files from being copied. For existing plaintext tasks, use the manual export/import upgrade procedure below. Do not copy a plaintext database into this release.

Reconnect and verify the files:

```sh
ssh ubuntu@203.0.113.10
cd /opt/taskpath
ls
```

You should see `Dockerfile`, `compose.yaml`, `package.json`, **`bun.lock`**, `scripts`, `public`, `src`, and `deploy`. Copy the lockfile: the Docker build requires it. The image builds `dist/public` itself, so do not upload your local build or dependencies.

## 5. Configure fresh account storage

For a first installation, Compose creates the `taskpath-accounts-data` named volume. Existing multi-user installations reuse it. Plaintext and single-owner encrypted databases are refused without modification; no account migration from those formats is provided. Never run `docker compose down -v` during an upgrade. Create `.env` only for a new installation; do not overwrite an existing one.
```sh
cd /opt/taskpath
cp .env.example .env
```

Edit `.env` with your domain and timezone:

```dotenv
PORT=3000
TASKPATH_TIMEZONE=Europe/Moscow
TASKPATH_ORIGIN=https://tasks.example.com
TASKPATH_SESSION_DAYS=30
# Optional; defaults to TASKPATH_ORIGIN for push delivery:
# TASKPATH_PUSH_SUBJECT=mailto:admin@example.com
```

Remove legacy `TASKPATH_USERNAME`, `TASKPATH_PASSWORD`, and `TASKPATH_PASSWORD_HASH` values. Passwords are chosen only in the browser; there is no password-hash command. Optional `TASKPATH_START_SCRIPT=start:smol` enables Bun's lower-memory mode. Leave `HOST` and `DATABASE_PATH` at the container defaults.

The HTTPS origin also enables server push delivery. Signing keys are generated once and stored in SQLite; do not generate or paste VAPID keys manually. `TASKPATH_PUSH_SUBJECT`, when supplied, must be an HTTPS contact URL or `mailto:` address. Allow outbound DNS and HTTPS from the container to browser push providers. No additional incoming port or Nginx configuration is needed for push.

```sh
chmod 600 .env
sudo docker compose config --quiet
sudo docker compose up -d --build
sudo docker compose ps
curl -i http://127.0.0.1:3000/healthz
```

The health check should return `200`. Complete HTTPS below before choosing your password. Startup does not print an invitation. Create accounts explicitly with the admin command once HTTPS is ready.

## 6. Obtain the first HTTPS certificate

The complete Nginx template references certificate files that do not exist yet. Start with the repository's temporary HTTP-only configuration:

```sh
cd /opt/taskpath
cp deploy/nginx/taskpath-bootstrap.conf.example /tmp/taskpath-bootstrap.conf
sed -i 's/tasks\.example\.com/YOUR_REAL_DOMAIN/g' /tmp/taskpath-bootstrap.conf
sudo install -d -m 0755 /var/www/letsencrypt
sudo install -m 0644 /tmp/taskpath-bootstrap.conf /etc/nginx/conf.d/taskpath-bootstrap.conf
sudo nginx -t
sudo systemctl reload nginx
```

Replace `YOUR_REAL_DOMAIN` in the command itself, for example `tasks.example.net`. Check the installed file if uncertain:

```sh
sudo nginx -T
```

Request the certificate. Certbot will ask for an email address and agreement to its terms:

```sh
sudo certbot certonly --webroot -w /var/www/letsencrypt -d tasks.example.com
```

Use your real domain in this command. Certificate issuance should finish before the next step.

## 7. Enable the full Nginx reverse proxy

Prepare the production template:

```sh
cd /opt/taskpath
cp deploy/nginx/taskpath.conf.example /tmp/taskpath.conf
sed -i 's/tasks\.example\.com/YOUR_REAL_DOMAIN/g' /tmp/taskpath.conf
sudo install -m 0644 /tmp/taskpath.conf /etc/nginx/conf.d/taskpath.conf
sudo unlink /etc/nginx/conf.d/taskpath-bootstrap.conf
sudo nginx -t
sudo systemctl reload nginx
```

Again, replace `YOUR_REAL_DOMAIN` in the command with the same domain used for Certbot. If you changed `PORT` from 3000, edit every `proxy_pass` target in the Nginx file to match it.

If this hostname was configured previously, replace its existing configuration instead of leaving duplicate `server_name` blocks. The port-80 block redirects to HTTPS; the port-443 block proxies to Taskpath. A redirect to the same HTTPS URL inside the port-443 block causes a redirect loop. With the webroot procedure above, Certbot obtains the certificate without rewriting Nginx routing.

The production template:

- redirects HTTP to HTTPS while preserving the ACME renewal path;
- supports TLS 1.2 and 1.3 and sends HSTS for this hostname;
- passes the browser's session cookie and Origin header to Taskpath;
- applies per-IP request limits and permits a burst for offline-shell downloads;
- keeps ordinary request bodies at 32 KB and permits up to 2 MB for encrypted sync batches;
- proxies only to the host's loopback port.

Confirm the HTTPS certificate is valid. Then create your own account or invite a friend:

```sh
sudo docker compose exec taskpath bun run admin invite
```

The command prints a **user ID** and **setup URL**. Send both privately to your friend. The URL already contains the user ID, so the recipient only needs to choose and confirm a vault password and optionally enter a nickname. The link expires after **24 hours** and is consumed once; restarting the server does not renew it.

Normal login requires **user ID + password**. The nickname is encrypted and only used for the greeting. **There is no password reset or recovery key**, including for the administrator. Leave **Remember this device** off on shared browser profiles. The workspace menu includes **Lock**, **Switch account**, **Nickname**, and **Change password**.

Account administration, while the app is running:

```sh
sudo docker compose exec taskpath bun run admin list
sudo docker compose exec taskpath bun run admin reinvite USER_ID
sudo docker compose exec taskpath bun run admin revoke USER_ID
sudo docker compose exec taskpath bun run admin disable USER_ID
```

Replace `USER_ID` with the generated ID. `reinvite` replaces an expired or unclaimed invitation; its old link stops working. `revoke` cancels a pending invitation. Active accounts cannot be reinvited. `disable` revokes the user's sessions and prevents server access while retaining their encrypted data. It does not revoke offline access to previously downloaded data. Other accounts are unaffected. There is no deletion or password-reset command.

Each command opens the configured database using SQLite transactions. Use `docker compose exec` so it receives the same volume, database path, and public origin as the server. Do not generate invitations in a separate container without the persistent volume.

## 8. Verify the public deployment

Run these checks from your computer:

```sh
curl -I http://tasks.example.com/
curl -I https://tasks.example.com/
curl -I https://tasks.example.com/login
curl -i https://tasks.example.com/api/sync
curl -i https://tasks.example.com/api/push
```

Expected results:

1. HTTP returns a `308` redirect to the HTTPS URL.
2. HTTPS returns the public, data-free unlock shell with `200 OK`.
3. The login page returns `200 OK`.
4. The unsigned-in sync API returns `401 Unauthorized` without a browser credential prompt.
5. The unsigned-in push API also returns `401 Unauthorized`.

In the browser, create a temporary task, move it between columns, refresh the page, unlock again, and confirm it remains. Test Markdown export and import from the workspace menu. Archive the task, refresh while on Archive, then restore it. Search and filters should remain after `#` in the URL and survive refresh; they are not sent to the server. Test background notifications separately using the steps below.

Verify automatic certificate renewal on the VPS:

```sh
sudo certbot renew --dry-run
systemctl list-timers --all | rg 'certbot|letsencrypt'
```

If `rg` is not installed on the VPS, inspect `systemctl list-timers --all` directly. The dry run is the decisive check.

## 9. Back up the database

Create a backup directory once:

```sh
sudo install -d -m 0700 /var/backups/taskpath
```

For a consistent backup, briefly stop Taskpath, archive the entire named volume, and restart it:

```sh
(
  set -eu
  cd /opt/taskpath
  TASKPATH_CONTAINER="$(sudo docker compose ps -a -q taskpath)"
  test -n "$TASKPATH_CONTAINER"
  TASKPATH_VOLUME="$(sudo docker inspect --format '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{.Name}}{{end}}{{end}}' "$TASKPATH_CONTAINER")"
  test -n "$TASKPATH_VOLUME"
  sudo docker volume inspect "$TASKPATH_VOLUME" >/dev/null
  TASKPATH_BACKUP="taskpath-$(date -u +%Y%m%dT%H%M%SZ)-$$.tgz"
  sudo docker pull alpine
  trap 'sudo docker compose start taskpath' EXIT
  sudo docker compose stop taskpath
  sudo docker run --rm \
    --mount "type=volume,src=$TASKPATH_VOLUME,dst=/data,readonly" \
    --mount "type=bind,src=/var/backups/taskpath,dst=/backup" \
    alpine tar -czf "/backup/$TASKPATH_BACKUP" -C /data .
  sudo chmod 600 "/var/backups/taskpath/$TASKPATH_BACKUP"
  printf 'Backup saved: /var/backups/taskpath/%s\n' "$TASKPATH_BACKUP"
)
```

This resolves the actual named volume mounted by the existing container, creates a timestamped archive, and restarts Taskpath even if archiving fails. It stops before touching the service if the container or named volume cannot be found. If you customized Compose to use a bind mount instead, back up that directory while the service is stopped. Check that the command reports a saved archive and the service restarts successfully.

Copy the resulting archive off the VPS and test restoration periodically. Keep the whole volume, not just task rows: it includes every account's ciphertext and wrapped-key metadata, sessions, push signing keys, device subscriptions, schedules and retry state. Push times and subscription metadata are readable in the database even though task contents remain encrypted. Treat the entire backup as private.

Restore into a separate empty volume with the app stopped. Each vault still needs its own password used by that backup; changing the password does not update old backups. Restoring an older backup can restore older schedules and authentication state. Never overwrite the only copy. Existing plaintext backups remain plaintext.

## 10. Update Taskpath

These steps are for an existing **multi-user** installation:

1. Open each device online and wait for **All changes synced**. Do not clear browser storage: it may contain unsynced edits.
2. [Back up the volume](#9-back-up-the-database).
3. Repeat the `rsync` command from step 4 on your computer. Keep the `.env`, `data/`, `node_modules/`, and `dist/` exclusions, and include `bun.lock` and `scripts/`.
4. On the VPS, review new settings in `.env.example` and merge them into your existing `.env`. Keep the same Compose project/volume name and `TASKPATH_ORIGIN`. Do not replace `.env` with the example.
5. Rebuild and recreate the service:

```sh
cd /opt/taskpath
sudo docker compose config --quiet
sudo docker compose build --pull
sudo docker compose up -d --no-build
sudo docker compose ps
sudo docker compose logs --tail=50 taskpath
curl -f http://127.0.0.1:3000/healthz
```

Continue only if the image build succeeds. The named volume survives image replacement, including accounts, task ciphertext and push signing keys. The picker update keeps the existing SQLite schema and encrypted browser queues unchanged. No account invitation or password change is needed for this update. Docker performs the frozen dependency install and client minification; a container restart alone will not pick up new source files or `.env` values.

6. Repeat the HTTPS checks in step 8. Existing Nginx `/api/sync` and `/api/events` configuration is sufficient for this update.
7. With changes synchronized on all devices before upgrading, on **every device**, open Taskpath online so it can download the new PWA shell, close all Taskpath tabs and installed-app windows, then reopen and unlock. Keep browser storage intact. The worker waits for old windows to close before activating; refreshing one tab may not be enough.
8. Enable background reminders on each desired device using the section below. Confirm a test notification arrives with the app closed.

For a local checkout with Bun 1.4.2, the same dependency/build/test sequence used by CI is:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run typecheck
bun run build
bun test
```

The build belongs in `dist/public`. `bun run start` and `bun run start:smol` serve it; `bun run dev` serves readable sources and is not the production command. If you already manage a non-Docker Bun service, run the sequence above in its release directory before restarting that service with the same database and environment.

### Start fresh from a plaintext or single-owner release

This change deliberately does not migrate existing accounts or vaults. Use the new Compose volume `taskpath-accounts-data` (or a fresh `DATABASE_PATH` for local runs), start the release, and run `bun run admin invite` inside the container for each person, including yourself. Existing volumes and browser storage remain untouched.

If you want to keep readable tasks from that older release, export Markdown while the old vault is unlocked, store the export privately, then import it into a newly created account. This is optional manual transfer; old pending operations, account credentials and browser storage are never imported automatically. Follow the PWA close/reopen step above after switching releases.

## Enable background reminders

1. Check that `TASKPATH_ORIGIN` is your public **HTTPS** origin and the app is running. `TASKPATH_PUSH_SUBJECT` is optional; the origin is the default contact. Changes to `.env` require recreating the container with `sudo docker compose up -d --force-recreate`.
2. On iPhone/iPad (iOS/iPadOS 16.4+), open the site in Safari, select **Share → Add to Home Screen**, then open that installed app. On Android, install the PWA from the browser. Unlock online once in the installation you intend to use.
3. Open **Workspace options → Background reminders → Enable on this device** and grant notification permission. This is separate from **Enable desktop notifications**, which applies to an open page.
4. Create a test task with a reminder a few minutes in the future. Wait for **All changes synced**. Then lock Taskpath and close its tabs/app windows; keep the phone connected to the internet.
5. Expect **“You have a reminder in Taskpath.”** The notification contains no title, notes, tags or account nickname. Tap it to open/focus Taskpath and unlock normally to read your tasks. Repeat on each device that should receive pushes; up to 10 devices are supported per account.

Enabling any device allows the server to store reminder times and random identifiers for that account, plus device push subscriptions. Titles, notes, passwords and vault decryption keys are never sent in pushes. The background worker does not load a vault key, including on remembered devices. Locking leaves background reminders enabled. **Turn off on this device** removes its subscription; turning off the last subscribed device removes server schedules. Account switching attempts to unsubscribe the browser. Disabling an account through the admin command stops future server sends.

The server checks schedules every 15 seconds and retains its queue across restarts. Completion, archive, deletion, dismissal and rescheduling cancel or replace the corresponding schedule **after sync**. Offline changes cannot retract a notification already queued by the server or accepted by a push provider. The page keeps in-app reminders but avoids a second desktop alert when account-level push is enabled.

Push delivery depends on the device and browser's push service; it is not an exact alarm. Focus modes, notification settings, internet loss or disabled browser background activity can delay or prevent an alert. Transient failures are retried, expired subscriptions are removed, and a stable notification tag replaces duplicates. Following downtime, reminders overdue by up to 24 hours are eligible; a provider can retain an accepted push for up to one hour. Older missed reminders remain visible in the app. A session expiry does not stop already scheduled pushes, but the user must sign in again before new edits can sync.

## Offline and phone use

Unlock online and let the board download. On iPhone, use Safari's **Share → Add to Home Screen**; on Android, use **Install app**. Open the installed app online once. Disconnect, add a task, close and reopen, unlock using the same password, then reconnect and check for **All changes synced**. Keep clocks accurate: the latest whole-task edit wins, with operation IDs breaking timestamp ties.

Lock clears remembered decryption keys across this browser's tabs but keeps the encrypted queue. Expired authentication also keeps pending work; enter the password again to sync. Browser storage eviction or clearing site data can destroy unsynced changes. Markdown previews/imports and exports work offline. Without background reminders enabled, reminders need an open unlocked page. Once enabled and synchronized, server schedules work while it is closed or locked. Phones may suspend background work: reopen online to finish syncing new edits.

Existing Nginx `/api/sync` (2 MB limit) and `/api/events` WebSocket settings still apply. No new proxy directives are needed for encryption. Keep the full cookie/Origin headers in the events location and its 90-second read timeout. If instant updates fail, inspect `/api/events` for a `101` upgrade; polling remains a fallback.

## Change password and key limitations

Use **Workspace options → Change password** while online and enter the current password. Existing sessions are revoked; other devices enter the new password to resume syncing. The underlying data key stays the same, so already copied or remembered decryption keys cannot be revoked. An offline device with older wrapping metadata may still unlock locally using the previous password until it signs in with the new password.

Server backups contain ciphertext and wrapped-key metadata, plus observable task IDs, edit times, sizes, timezone, and opaque reminder claims. Background reminders add readable scheduling times and push subscription/delivery metadata. VAPID signing keys in the backup authorize pushes but cannot decrypt a vault. Traffic patterns remain visible. A compromised server that supplies malicious JavaScript can capture an entered password or unlocked data. Encryption does not repair older plaintext backups.

## Troubleshooting

### Docker or Compose is unavailable

```sh
sudo systemctl status docker
sudo systemctl start docker
sudo docker version
sudo docker compose version
```

If `docker compose` is unrecognized, install `docker-compose-plugin` from the Docker repository configured in step 3. The legacy `docker-compose` command is not used by this guide. A valid YAML file alone does not verify that an image builds or a container runs.

### Build fails or the client is outdated

Confirm `bun.lock` and `scripts/build.ts` were uploaded, then rebuild the image. Do not copy host `node_modules` into the container. A frozen-lockfile failure means `package.json` and `bun.lock` do not match; upload both from the same project revision. Do not delete the lockfile to bypass the check.

For non-Docker production, **Client build missing or outdated** means you must run `bun run build` before starting the server. If the server is updated but the UI is still old, follow the close-all-windows PWA update procedure. Do not clear site storage as the first fix.

### Background notifications do not arrive

- Open **Background reminders** and check that this device is enabled. If it asks for the public origin, verify `.env` and recreate the container. On iPhone, open the Home Screen installation rather than a Safari tab.
- If permission was denied or revoked, enable it in browser/OS settings, then enable reminders again in Taskpath. Check Focus/Do Not Disturb settings. Subscription removal or expiry may require subscribing again.
- Create a fresh reminder a few minutes ahead, wait for **All changes synced**, and verify the server and device clocks. A completed, archived, deleted or dismissed task will not send. An already claimed reminder token will not send again; changing the reminder time creates a new one.
- Check `sudo docker compose ps` and `sudo docker compose logs --tail=100 taskpath`. The VPS/container needs outbound DNS and TCP 443 to the browser's provider: `web.push.apple.com`, `fcm.googleapis.com`, `updates.push.services.mozilla.com`, or the endpoint under `*.notify.windows.com`. Custom push-provider domains are not supported by the endpoint allowlist.
- If changes were made offline, reopen Taskpath online and unlock to finish syncing. A push already accepted by a provider cannot be recalled. Test actual delivery on the intended phone/browser; unit tests and a healthy `/healthz` response do not prove push delivery.

Do not paste passwords, invitation links, full subscription endpoints or signing keys into diagnostic logs or support messages.

### Nginx configuration fails

```sh
sudo nginx -t
sudo tail -n 100 /var/log/nginx/error.log
```

Certificate-path errors mean the full proxy configuration was enabled before Certbot successfully created the certificate, or the domain in the certificate path does not match the requested certificate name.

### Taskpath returns 502 Bad Gateway

```sh
cd /opt/taskpath
sudo docker compose ps
sudo docker compose logs --tail=100 taskpath
curl -i http://127.0.0.1:3000/healthz
```

Check that the Compose port and every Nginx `proxy_pass` port match.

### Browser changes fail with an Origin error

`TASKPATH_ORIGIN` must exactly equal the browser origin, including `https://` and any non-default port. Correct `.env`, then recreate the container so it loads the new value:

```sh
cd /opt/taskpath
sudo docker compose up -d --force-recreate
```

### Forgot the password

There is no reset or recovery mechanism. The server cannot decrypt your tasks. An already unlocked or remembered device may still export readable Markdown/JSON; keep that device intact while exporting. Otherwise the tasks are inaccessible. Restarting, changing environment variables, or issuing a setup link cannot recover an initialized vault.

## References

- [Install Docker Engine on Ubuntu](https://docs.docker.com/engine/install/ubuntu/)
- [Install the Docker Compose plugin](https://docs.docker.com/compose/install/linux/)
- [Certbot webroot documentation](https://eff-certbot.readthedocs.io/en/stable/using.html#webroot)
- [Nginx proxy module](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)
- [Nginx request limiting module](https://nginx.org/en/docs/http/ngx_http_limit_req_module.html)
- [Web Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API)
- [Web Push for Home Screen apps on iOS and iPadOS](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)
