# Deploy Taskpath on an Ubuntu VPS

This guide deploys one private Taskpath workspace on Ubuntu 24.04 or 22.04. Docker Compose runs Taskpath and SQLite. Nginx runs on the VPS host, terminates HTTPS, and proxies to Taskpath on `127.0.0.1:3000`. The database is kept in a Docker named volume.

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

The exclusions prevent local credentials, development data, and generated files from being copied. To migrate existing tasks, use the separate migration procedure near the end of this guide.

Reconnect and verify the files:

```sh
ssh ubuntu@203.0.113.10
cd /opt/taskpath
ls
```

You should see `Dockerfile`, `compose.yaml`, `package.json`, `public`, `src`, and `deploy`.

## 5. Configure Taskpath

Create the production environment file:

```sh
cd /opt/taskpath
cp .env.example .env
sudo docker compose build
sudo docker compose run --rm --no-deps taskpath bun run hash-password
```

Enter and confirm a long password at the prompts. The command prints an Argon2id hash; the password itself is not stored. Open `.env` with `sudoedit .env` and copy the complete hash into `TASKPATH_PASSWORD_HASH`. Keep the single quotes because the hash contains dollar signs.

Use this shape, with your own domain, username, hash, and IANA timezone:

```dotenv
PORT=3000
TASKPATH_TIMEZONE=Europe/Moscow
TASKPATH_ORIGIN=https://tasks.example.com
TASKPATH_USERNAME=taskpath
TASKPATH_PASSWORD_HASH='$argon2id$v=19$m=65536,t=2,p=1$paste-the-rest-of-the-generated-hash-here'
TASKPATH_SESSION_DAYS=30
```

Do not put the plain password in `.env`. Do not set `HOST` or `DATABASE_PATH` for the Compose deployment. The container already uses `0.0.0.0` internally and stores SQLite at `/app/data/taskpath.sqlite`. Protect the file:

```sh
chmod 600 .env
```

Start Taskpath:

```sh
sudo docker compose up -d --build
sudo docker compose ps
sudo docker compose logs --tail=50 taskpath
```

The service should report that authentication is enabled. Confirm that it is reachable only on the VPS loopback interface and that the login page is active:

```sh
curl -I http://127.0.0.1:3000/
curl -i http://127.0.0.1:3000/api/auth/status
```

The first command should redirect to `/login`. The second should report `"enabled":true` and `"authenticated":false`.

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
- limits each client IP to two requests per second with a burst of 20;
- keeps ordinary request bodies at 32 KB and permits up to 2 MB for the bounded Markdown import endpoints;
- proxies only to the host's loopback port.

Open `https://tasks.example.com` in a private browser window. The browser should show a valid certificate and Taskpath's sign-in page. Sign in with the username from `.env` and the original password you entered when generating the hash. The workspace menu includes **Sign out**.

## 8. Verify the public deployment

Run these checks from your computer:

```sh
curl -I http://tasks.example.com/
curl -I https://tasks.example.com/
curl -I https://tasks.example.com/login
curl -i https://tasks.example.com/api/board
```

Expected results:

1. HTTP returns a `308` redirect to the HTTPS URL.
2. HTTPS redirects an unsigned-in browser to `/login`.
3. The login page returns `200 OK`.
4. The unsigned-in board API returns `401 Unauthorized` without a browser credential prompt.

In the browser, create a temporary task, move it between columns, refresh the page, and confirm it remains. Test Markdown export and import from the workspace menu. Desktop reminders require browser notification permission and an open Taskpath tab.

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
  -v taskpath_taskpath-data:/data:ro \
  -v /var/backups/taskpath:/backup \
  alpine tar -czf /backup/taskpath-data.tgz -C /data .
sudo docker compose start taskpath
sudo chmod 600 /var/backups/taskpath/taskpath-data.tgz
```

The default volume name is `taskpath_taskpath-data` because the project directory is `/opt/taskpath`. Confirm the actual name with `sudo docker volume ls` if the backup command reports that it cannot find the volume. Copy the resulting archive off the VPS and test restoration periodically.

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

### Upgrade from the old Basic Auth release

The first release accepted a plain `TASKPATH_PASSWORD`. The current release deliberately refuses that setting. After copying the new files, build the image and generate a hash before restarting:

```sh
cd /opt/taskpath
sudo docker compose build
sudo docker compose run --rm --no-deps taskpath bun run hash-password
sudoedit .env
```

Remove `TASKPATH_PASSWORD`. Add the generated value as `TASKPATH_PASSWORD_HASH='...'`, keeping the single quotes, and optionally add `TASKPATH_SESSION_DAYS=30`. Then recreate the app and install the current Nginx template:

```sh
sudo docker compose up -d --force-recreate
sudo nginx -t
sudo systemctl reload nginx
```

Opening the site now shows Taskpath's own sign-in page instead of the browser credential dialog. Your existing SQLite tasks are unchanged.

## Migrate an existing local workspace

Markdown export/import is the simplest cross-platform migration and preserves task content, columns, notes, categories, dates, reminders, and dismissal state. It creates new task IDs and does not preserve original creation/completion timestamps.

For an exact SQLite migration, stop both local and VPS instances before copying. Copy the entire local `data` directory, including SQLite WAL sidecar files if present, into the Docker volume rather than copying only the main `.sqlite` file. Back up the destination first. This operation replaces the VPS workspace, so use it only when you intend a full replacement.

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

Generate a new hash with `sudo docker compose run --rm --no-deps taskpath bun run hash-password`, replace `TASKPATH_PASSWORD_HASH` in `.env`, and recreate the container with `sudo docker compose up -d --force-recreate`. Existing tasks remain in the named volume, and all existing sessions are invalidated.

## References

- [Install Docker Engine on Ubuntu](https://docs.docker.com/engine/install/ubuntu/)
- [Install the Docker Compose plugin](https://docs.docker.com/compose/install/linux/)
- [Certbot webroot documentation](https://eff-certbot.readthedocs.io/en/stable/using.html#webroot)
- [Nginx proxy module](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)
- [Nginx request limiting module](https://nginx.org/en/docs/http/ngx_http_limit_req_module.html)
