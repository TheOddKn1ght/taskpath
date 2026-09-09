# Deploy Taskpath on an Ubuntu VPS

This guide deploys an invite-only Taskpath installation with private per-user vaults on Ubuntu 24.04 or 22.04. Docker Compose runs Taskpath and SQLite. Nginx runs on the VPS host, terminates HTTPS, and proxies to Taskpath on `127.0.0.1:3000`. The database is kept in a Docker named volume.

You need:

- a VPS with a public IP and a sudo-capable SSH account;
- a domain or subdomain, such as `tasks.example.com`;
- the Taskpath project on your computer;
- outbound internet access from the VPS.

Commands below use `tasks.example.com`, `203.0.113.10`, and the SSH user `ubuntu` as examples. Replace them with your values. Keep the application port bound to loopback; only ports 80 and 443 should be public.

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
  ./ ubuntu@203.0.113.10:/opt/taskpath/
```

The exclusions prevent local credentials, development data, and generated files from being copied. For existing plaintext tasks, use the manual export/import upgrade procedure below. Do not copy a plaintext database into this release.

Reconnect and verify the files:

```sh
ssh ubuntu@203.0.113.10
cd /opt/taskpath
ls
```

You should see `Dockerfile`, `compose.yaml`, `package.json`, `public`, `src`, and `deploy`.

## 5. Configure fresh account storage

This release requires a fresh database and refuses both plaintext and single-owner encrypted databases without modifying them. Compose uses a new `taskpath-accounts-data` named volume. Existing volumes remain untouched. No account migration is provided. Never run `docker compose down -v` during an upgrade.
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
```

Remove legacy `TASKPATH_USERNAME`, `TASKPATH_PASSWORD`, and `TASKPATH_PASSWORD_HASH` values. Passwords are chosen only in the browser; there is no password-hash command. Optional `TASKPATH_START_SCRIPT=start:smol` enables Bun's lower-memory mode. Leave `HOST` and `DATABASE_PATH` at the container defaults.

```sh
chmod 600 .env
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
```

Expected results:

1. HTTP returns a `308` redirect to the HTTPS URL.
2. HTTPS returns the public, data-free unlock shell with `200 OK`.
3. The login page returns `200 OK`.
4. The unsigned-in sync API returns `401 Unauthorized` without a browser credential prompt.

In the browser, create a temporary task, move it between columns, refresh the page, unlock again, and confirm it remains. Test Markdown export and import from the workspace menu. Desktop reminders require notification permission, an open unlocked page, and a connection for deduplication claims.

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
cd /opt/taskpath
sudo docker compose stop taskpath
sudo docker run --rm \
  -v taskpath_taskpath-accounts-data:/data:ro \
  -v /var/backups/taskpath:/backup \
  alpine tar -czf /backup/taskpath-data.tgz -C /data .
sudo docker compose start taskpath
sudo chmod 600 /var/backups/taskpath/taskpath-data.tgz
```

The default volume name is `taskpath_taskpath-accounts-data` because the project directory is `/opt/taskpath`. Confirm the actual name with `sudo docker volume ls` if the backup command reports that it cannot find the volume. Copy the resulting archive off the VPS and test restoration periodically. This encrypted archive includes wrapped-key metadata: keep the whole volume, not just task rows. Restore into a separate empty volume with the app stopped. The backup contains all accounts. Each vault still needs its own password used by that backup; changing the password does not update old backups. Never overwrite the only copy. Existing plaintext backups remain plaintext.

## 10. Update Taskpath

Back up first. Then repeat the `rsync` command from your computer and run on the VPS:

```sh
cd /opt/taskpath
sudo docker compose build --pull
sudo docker compose up -d
sudo docker compose ps
sudo docker compose logs --tail=50 taskpath
```

The named volume survives image replacement. Review changes to `.env.example`, `compose.yaml`, and the Nginx template during upgrades; merge required configuration changes into the live files before restarting.

### Start fresh from a single-owner release

This change deliberately does not migrate existing accounts or vaults. Use the new Compose volume `taskpath-accounts-data` (or a fresh `DATABASE_PATH` for local runs), start the release, and run `bun run admin invite` inside the container for each person, including yourself. Existing volumes and browser storage remain untouched.

After updating, open the site online, close every Taskpath tab and installed-app window, then reopen to activate the new PWA. Application URLs and caches use a new account-specific version; old pending operations are never imported automatically.

## Offline and phone use

Unlock online and let the board download. On iPhone, use Safari's **Share → Add to Home Screen**; on Android, use **Install app**. Open the installed app online once. Disconnect, add a task, close and reopen, unlock using the same password, then reconnect and check for **All changes synced**. Keep clocks accurate: the latest whole-task edit wins, with operation IDs breaking timestamp ties.

Lock clears remembered decryption keys across this browser's tabs but keeps the encrypted queue. Expired authentication also keeps pending work; enter the password again to sync. Browser storage eviction or clearing site data can destroy unsynced changes. Markdown previews/imports and exports work offline. Reminder claims require a connection; reminder scheduling requires an unlocked page. Phones may suspend background work: reopen online to finish syncing.

Existing Nginx `/api/sync` (2 MB limit) and `/api/events` WebSocket settings still apply. No new proxy directives are needed for encryption. Keep the full cookie/Origin headers in the events location and its 90-second read timeout. If instant updates fail, inspect `/api/events` for a `101` upgrade; polling remains a fallback.

## Change password and key limitations

Use **Workspace options → Change password** while online and enter the current password. Existing sessions are revoked; other devices enter the new password to resume syncing. The underlying data key stays the same, so already copied or remembered decryption keys cannot be revoked. An offline device with older wrapping metadata may still unlock locally using the previous password until it signs in with the new password.

Server backups contain ciphertext and wrapped-key metadata, plus observable task IDs, edit times, sizes, timezone, and opaque reminder claims. Traffic patterns remain visible. A compromised server that supplies malicious JavaScript can capture an entered password or unlocked data. Encryption does not repair older plaintext backups.

## Troubleshooting

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
