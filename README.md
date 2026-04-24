# vite-cicd-hmrdevserver

Long-running Vite dev server on a remote host, fed by a Jenkins CI/CD pipeline. Pushes
take seconds to surface in the browser via HMR, instead of minutes for a Docker rebuild.

**Repository:** https://github.com/mjairuobe/vite-cicd-hmrdevserver

## Layout

```
mermaid-poc/  Vite + React Mermaid PoC (HMR-Ziel)
supervisor/   Node + TypeScript daemon that owns the Vite process and exposes an HTTP API
deploy/       systemd unit + install / uninstall scripts
Jenkinsfile   Pipeline that POSTs /sync and streams /events until terminal state
```

## Supervisor-Umgebung (neben `REPO_URL`)

| Variable | Bedeutung | Beispiel |
|----------|-----------|----------|
| `REPO_URL` | Git-Clone-URL | `https://github.com/mjairuobe/vite-cicd-hmrdevserver.git` |
| `REPO_DIR` | Arbeitskopie auf dem Host | `$HOME/vite-cicd-hmrdevserver` |
| `VITE_PROJECT_SUBDIR` | Unterordner mit `vite.config` / `index.html` | `mermaid-poc` |
| `VITE_BASE_PATH` | Öffentlicher URL-Pfad der App (Vite `base`) | `/mermaid-poc/` |

Die Datei `deploy/vite-dev-remote-supervisor.service` setzt diese Werte inklusive `REPO_URL`.

## Quick start (dev host)

```bash
cd supervisor && npm install && npm run build

export REPO_DIR=$HOME/vite-cicd-hmrdevserver
export REPO_URL=https://github.com/mjairuobe/vite-cicd-hmrdevserver.git
export VITE_PROJECT_SUBDIR=mermaid-poc
export VITE_BASE_PATH=/mermaid-poc/
export TRACKED_REF=main

node dist/src/supervisor.js
# oder: bash deploy/install.sh
```

## Quick start (Entwickler-Laptop)

```bash
ssh -N -L 40889:127.0.0.1:40889 user@dev-host
# App: http://127.0.0.1:40889/mermaid-poc/
```

## Monorepo (Frontend)

```bash
git clone https://github.com/mjairuobe/vite-cicd-hmrdevserver.git
cd vite-cicd-hmrdevserver
npm install
npm run dev
```

## Tests

```bash
cd supervisor
npm test
npm run typecheck
```
