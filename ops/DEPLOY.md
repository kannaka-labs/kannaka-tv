# Deploying Kannaka TV

The channel runs beside Ghost Signals Records on O1 (`opc@170.9.238.136`, Oracle Linux 9, aarch64).
It stores no media, so it costs the box almost nothing: one node process, one SQLite file, and a
schedule held in memory.

⚠ O1 has **one core** and about 6.8 GB free on `/var/oled`, while already running some thirty
services. Nothing in this deployment may change that. If you find yourself wanting to write video
to disk, re-read ADR-0001 decision 2.

## Once

```bash
ssh -i ~/.ssh/ninja-portal-ed25519 opc@170.9.238.136

git clone https://github.com/kannaka-labs/kannaka-tv.git ~/kannaka-tv
cd ~/kannaka-tv && npm install --omit=dev

# The environment. 600, because it holds the operator token and the floor credential.
cat > ~/.kannaka-tv.env <<'EOF'
TV_PORT=8891
TV_BIND=127.0.0.1
TV_PUBLIC_URL=https://tv.ninja-portal.com
TV_DATA_DIR=/var/oled/kannaka-tv
TV_ADMIN_TOKEN=<generate: openssl rand -base64 24>
EOF
chmod 600 ~/.kannaka-tv.env
sudo mkdir -p /var/oled/kannaka-tv && sudo chown opc:opc /var/oled/kannaka-tv
```

`systemd` unit — `/etc/systemd/system/kannaka-tv.service`:

```ini
[Unit]
Description=Kannaka TV - the transmitter
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=opc
WorkingDirectory=/home/opc/kannaka-tv
EnvironmentFile=/home/opc/.kannaka-tv.env
ExecStart=/usr/bin/node server/index.js
Restart=always
RestartSec=5
StandardOutput=append:/var/log/kannaka-tv.log
StandardError=append:/var/log/kannaka-tv.log

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now kannaka-tv
curl -s localhost:8891/api/health | head -c 200
```

⚠ Never start it by hand alongside the unit. Two transmitters on one data directory is the
duplicate-radio mistake from 2026-08-19, and here it would also double every air report.

## nginx

`/etc/nginx/conf.d/tv.conf`:

```nginx
server {
    listen 80;
    server_name tv.ninja-portal.com;
    location / {
        proxy_pass http://127.0.0.1:8891;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 30s;
    }
}
```

```bash
sudo nginx -t && sudo systemctl reload nginx
```

Then DNS and the certificate:

1. GoDaddy (**not** Cloudflare — the constellation's DNS is at GoDaddy): A record
   `tv` → `170.9.238.136`.
2. ⚠ certbot on O1 is `/usr/bin/certbot`, not `/usr/local/bin` as on the other fleet hosts:
   ```bash
   sudo /usr/bin/certbot --nginx -d tv.ninja-portal.com --non-interactive --agree-tos --redirect
   ```

## The office on floor 11

The channel runs fine with no lease; the office is additive. When the tenancy PR is merged:

1. **A principal of its own.** The tower enforces one floor per tenant and Kannaka's bot already
   holds floor 2, Ghost Signal holds floor 3. Kannaka TV needs a third KAX agent.
2. **Grant the lease.** `requireAdmin`, so it needs Nick's admin browser session on
   `kax.ninja-portal.com` — the service token is refused:
   ```js
   fetch('/api/admin/tower/lease', {
     method: 'POST', credentials: 'include',
     headers: { 'content-type': 'application/json' },
     body: JSON.stringify({
       floorNo: 11, slug: 'kannaka-tv', label: 'Kannaka TV',
       repoUrl: 'https://github.com/kannaka-labs/kannaka-tv',
       tenantPrincipal: 'kax:agent:<the channel agent id>',
     }),
   })
   ```
   The console prints `Promise {<pending>}`; the result logs on the next line. Verify with
   `GET /api/tower/storey/11`.
3. **Mint a floor credential** (`POST /api/admin/tower/storey/11/credential`) — shown once — and
   put it in the env as `KAX_TOWER_CREDENTIAL`, with `KAX_TOWER_STOREY=11`.
4. **Register the webhook** as the acting agent:
   `POST /tower/storey/11/webhook {"url":"https://tv.ninja-portal.com/api/tower/events"}`.
   The signing secret comes back **once** → `TOWER_WEBHOOK_SECRET`. Do not print it; write it
   straight into the env file.
5. ⚠ A `twr_` credential **cannot speak**. For the programming director to answer anyone who walks
   in, the channel also needs `KAX_AGENT_TOKEN` — its own agent token, via the attach flow
   (`POST /auth/agent/challenge` + `/verify`), which needs Nick's session.

Then `sudo systemctl restart kannaka-tv` and check `/api/health` reports
`tower.leased: true`.

⚠ Keep panel copy ASCII. Non-ASCII through an ssh heredoc has been mangled into mojibake on this
tower before; `tower.js` strips it, but do not fight it.

## Checking on it

```bash
curl -s https://tv.ninja-portal.com/api/health   | jq          # on air? horizon? tower?
curl -s https://tv.ninja-portal.com/api/sources  | jq          # which sources can it see
curl -s https://tv.ninja-portal.com/api/now      | jq .now.title
curl -s -H "authorization: Bearer $TV_ADMIN_TOKEN" \
     https://tv.ninja-portal.com/api/admin/outbox | jq          # air reports waiting
sudo journalctl -u kannaka-tv -n 50
```

## Deciding carriage

```bash
OP="authorization: Bearer $TV_ADMIN_TOKEN"
B=https://tv.ninja-portal.com

curl -s -H "$OP" "$B/api/admin/carriage?status=pending" | jq
curl -sX POST -H "$OP" "$B/api/admin/carriage/<grantId>/approve" | jq
```

⚠ Approving returns the partner's webhook signing secret **once**. Send it to them and do not log
it. Approving also replans the tail, so they start airing within about fifteen minutes rather than
at the end of the current six-hour horizon.

`suspend` takes a partner off air without ending the agreement; `resume` puts them back; `end`
closes it. A feed that fails twelve times running suspends itself and says why.
