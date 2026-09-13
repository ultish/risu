# hana-server

How this app is hosted on `jimmy@hana-server`, and the pattern to copy for the next one.

Box: Ubuntu, **rootless Podman 5**, user `jimmy`, linger on. LAN `192.168.50.92`, Tailscale `100.86.84.22`. The Mac is `192.168.50.160` (`ssh macbook` from hana).

## Shape

```
LAN:       Caddy :80  →  127.0.0.1:8787/8788/8789
Tailscale: MagicDNS :8787/:8788/:8789  (HOST=0.0.0.0)
```

| Public URL | Upstream |
| --- | --- |
| http://hana-server/ | `/var/www/hana` index |
| http://crypto.hana-server/ | Caddy → 8787 |
| http://risu.hana-server/ | Caddy → 8788 |
| http://kura.hana-server/ | Caddy → 8789 |
| http://hana-server.taile9bee4.ts.net:8787 | crypto-tax Tailscale |
| http://hana-server.taile9bee4.ts.net:8788 | risu Tailscale |
| http://hana-server.taile9bee4.ts.net:8789 | kura Tailscale |

UFW: **22 LAN**, **80 LAN + Tailscale**, **8787–8789 Tailscale only**. LAN uses Caddy names; Tailscale uses `hana-server.taile9bee4.ts.net:<port>`.

SPAs own `/` and `/api`. Do not put them under path prefixes (`/risu/…`). Use a **subdomain** per app.

## This app

| | |
| --- | --- |
| Deploy | `./scripts/deploy-hana.sh` |
| Port | `8788` (8787 is crypto-tax) |
| Quadlet | `~/.config/containers/systemd/risu.container` |
| Live sqlite | `~/risu-data/risu.db` |
| Env | `YIELDS_DB_PATH=/data/risu.db` `HOST=0.0.0.0` `PORT=8788` `SERVE_WEB=1` `Network=host` |
| Backup timer | `risu-backup.timer` (daily, ~00:30 UTC) |
| Hana spool | `~/risu-backups/` |
| Mac archive | `~/Documents/Finances/risu-backups/` |
| Aliases (Mac) | `risu-backup` `risu-backup-log` `risu-backup-run` |

The old Mac Docker volume (`~/Documents/Finances/risu/db`) is **not** live anymore. Stop `run.sh` there so the two copies do not diverge.

```bash
./scripts/deploy-hana.sh          # rsync, podman build on hana (amd64), restart Quadlet
./scripts/install-hana-backup.sh  # daily WAL snapshot → Mac (already installed)
```

Do **not** `systemctl --user enable risu.service` — Quadlet units are generated; `enable` fails. `[Install] WantedBy=default.target` plus linger is enough. `daemon-reload` then `restart`.

Build **on hana**. The Mac is ARM.

## Caddy

System unit (`User=caddy`), binds :80 via `CAP_NET_BIND_SERVICE`. jimmy cannot bind :80 (`ip_unprivileged_port_start=1024`).

`/etc/caddy/Caddyfile`:

```
{
    auto_https off
}

http://crypto.hana-server {
    reverse_proxy 127.0.0.1:8787
}

http://risu.hana-server {
    reverse_proxy 127.0.0.1:8788
}

http://kura.hana-server {
    reverse_proxy 127.0.0.1:8789
}

:80 {
    root * /var/www/hana
    file_server
}
```

```bash
sudo systemctl reload caddy
```

## DNS

MagicDNS only has **`hana-server`** → `100.86.84.22`. It does **not** invent `crypto.` / `risu.`.

On the Mac, `/etc/hosts`:

```
192.168.50.92	hana-server crypto.hana-server risu.hana-server kura.hana-server
```

```bash
dscacheutil -flushcache
sudo killall -HUP mDNSResponder
```

Chrome caches NXDOMAIN — use a new tab. For other devices, add the same names on the **router**.

## Firewall

```bash
sudo ufw status numbered
```

Wanted:

```
22/tcp     ALLOW IN    192.168.50.0/24
80/tcp     ALLOW IN    192.168.50.0/24
80/tcp     ALLOW IN    100.64.0.0/10
8787/tcp   ALLOW IN    100.64.0.0/10
8788/tcp   ALLOW IN    100.64.0.0/10
8789/tcp   ALLOW IN    100.64.0.0/10
```

If LAN HTTP times out, UFW is dropping it (`grep DPT=80 /var/log/ufw.log`). Bind the rule to the NIC:

```bash
sudo ufw allow in on enp0s31f6 from 192.168.50.0/24 to any port 80 proto tcp comment 'caddy LAN'
sudo ufw reload
```

Never `ufw allow 80/tcp` with no `from`. App ports: Tailscale only, not LAN.

## Backup

Daily oneshot: Python `sqlite3.Connection.backup()` (WAL-safe) → hash-named `risu-YYYYMMDD-*.db` + `latest.db` → `rsync` to the Mac as `jxhui@macbook`. Unchanged hash = no new file. Mac asleep = keep spool, retry next day. No `--delete` on the Mac dir.

SSH key: same as crypto-tax, `~/.ssh/id_ed25519_cryptotax` on hana, `Host macbook` → `192.168.50.160`.

## Next app on this box

1. Pick a **free localhost port** (8789, …) and a **subdomain** (`foo.hana-server`).
2. Copy `scripts/deploy-hana.sh`: Quadlet `Network=host`, `HOST=0.0.0.0`, `PORT=<that>`, volume `~/foo-data`.
3. Add to Caddyfile: `http://foo.hana-server { reverse_proxy 127.0.0.1:<port> }` and `sudo systemctl reload caddy`.
4. Append `foo.hana-server` on the Mac `/etc/hosts` line (and the router).
5. UFW: allow the app port from `100.64.0.0/10` only.
6. Copy `scripts/install-hana-backup.sh` / `hana-backup.sh` / `backup-sqlite.py` with a new prefix, `~/foo-data/*.db`, Mac dir `~/Documents/Finances/foo-backups`, timer staggered off crypto-tax (midnight) and risu (00:30).
7. `HOST=0.0.0.0`. Tailscale URL: `http://hana-server.taile9bee4.ts.net:<port>/`. Keep `/api` at origin root.
