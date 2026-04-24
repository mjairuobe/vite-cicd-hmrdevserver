# vite-dev-remote

Long-running Vite dev server on a remote host, fed by a Jenkins CI/CD pipeline. Pushes
take seconds to surface in the browser via HMR, instead of minutes for a Docker rebuild.

## Layout

```
supervisor/   Node + TypeScript daemon that owns the Vite process and exposes an HTTP API
deploy/       systemd unit + install / uninstall scripts
Jenkinsfile   ~50-line pipeline that POSTs /sync and streams /events until terminal state
```

## Quick start (dev host)

```bash
# 1. Install dependencies and build.
cd supervisor && npm install && npm run build

# 2. Configure: see deploy/vite-dev-remote-supervisor.service for env vars,
#    or set them inline:
export REPO_DIR=$HOME/work/repo
export REPO_URL=https://github.com/org/your-frontend.git
export TRACKED_REF=main

# 3. Run.
node dist/src/supervisor.js

# Or install as a long-running user service:
bash deploy/install.sh
```

## Quick start (developer laptop)

```bash
# Forward the dev server's port from the dev host to your laptop.
ssh -N -L 40889:127.0.0.1:40889 user@dev-host
# Open http://127.0.0.1:40889 in your browser.
```

Pin the forward to `127.0.0.1` (not `localhost`) — see plan for the IPv4/IPv6 gotcha.

## Triggering a sync

```bash
curl -X POST http://dev-host.internal:40890/sync \
     -H 'Content-Type: application/json' \
     -d '{"ref":"main"}'
```

Or wire your Jenkins job to the included `Jenkinsfile`.

## Useful operator commands

```bash
# Status / logs (requires systemd install)
systemctl --user status vite-dev-remote-supervisor
journalctl --user -u vite-dev-remote-supervisor -f

# Find any stray processes
pgrep -af vite-dev-remote
ss -tlnp 'sport = :40889'

# Hard restart
systemctl --user restart vite-dev-remote-supervisor

# Read structured logs over HTTP (no journald access needed)
curl -s http://dev-host.internal:40890/logs?limit=200 | jq
```

## Tests

```bash
cd supervisor
npm test          # unit + integration (vitest)
npm run typecheck # tsc --noEmit
```
