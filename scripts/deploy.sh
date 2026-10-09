#!/usr/bin/env bash
# Deploys the committed code (HEAD) to the server and restarts the stack.
#   scripts/deploy.sh            (run from Git Bash in the repo)
#
# Copies a clean `git archive` over SSH, so the server needs no GitHub
# access. The server's .env and backups/ are never touched. Migrations run
# automatically when the app starts.
set -euo pipefail

HOST="${DEPLOY_HOST:-production-hub}"   # ~/.ssh/config alias
DIR="/opt/production-hub"

cd "$(git rev-parse --show-toplevel)"
if [ -n "$(git status --porcelain)" ]; then
  echo "Note: uncommitted changes are NOT deployed — only the last commit ($(git rev-parse --short HEAD))."
fi
REV="$(git rev-parse --short HEAD)"

echo "Copying $REV to $HOST:$DIR ..."
git archive --format=tar HEAD | ssh "$HOST" "mkdir -p $DIR && cd $DIR \
  && find . -mindepth 1 -maxdepth 1 ! -name .env ! -name backups -exec rm -rf {} + \
  && tar -xf - && echo $REV > REVISION"

echo "Building and restarting ..."
ssh "$HOST" "cd $DIR && test -f .env || { echo 'Missing $DIR/.env — see README'; exit 1; }; \
  docker compose up -d --build --remove-orphans 2>&1 | tail -5 && docker image prune -f >/dev/null && docker compose ps"
echo "Deployed $REV."
