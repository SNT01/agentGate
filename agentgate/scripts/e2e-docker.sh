#!/usr/bin/env bash
#
# Deploy AgentGate to local Docker and run an end-to-end test against it.
#
# This exercises the real production path: keypairs are generated on the
# client side, only public keys are registered (the server refuses to
# generate keys in production), and every authorization decision is made by
# the containerized broker over HTTP.
#
# Usage: ./scripts/e2e-docker.sh
set -euo pipefail

IMAGE=agentgate:1.0.0
CONTAINER=agentgate-e2e
VOLUME=agentgate-e2e-data
PORT=${PORT:-4790}
URL="http://127.0.0.1:${PORT}"

cd "$(dirname "$0")/.."

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  docker volume rm "$VOLUME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "==> Building image"
docker build -q -t "$IMAGE" . >/dev/null
echo "    built $IMAGE"

echo "==> Verifying it refuses an unsafe production configuration"
if docker run --rm "$IMAGE" >/dev/null 2>&1; then
  echo "    FAIL: container started without AGENTGATE_ADMIN_TOKEN"
  exit 1
fi
echo "    refused to start without an admin token, as expected"

echo "==> Starting the broker"
cleanup
ADMIN_TOKEN=$(openssl rand -hex 32)
docker run -d --name "$CONTAINER" \
  -p "${PORT}:4790" \
  -v "${VOLUME}:/data" \
  -e AGENTGATE_ADMIN_TOKEN="$ADMIN_TOKEN" \
  "$IMAGE" >/dev/null

echo "    waiting for health"
for i in $(seq 1 30); do
  status=$(docker inspect "$CONTAINER" --format '{{.State.Health.Status}}' 2>/dev/null || echo starting)
  [ "$status" = "healthy" ] && break
  sleep 1
done
[ "$status" = "healthy" ] || { echo "    FAIL: container never became healthy"; docker logs "$CONTAINER"; exit 1; }
echo "    healthy, listening on ${URL}"

echo "==> Enrolling a human (keypair generated client-side)"
HUMAN_KEYS=$(node src/cli/cli.js keygen --json)
HUMAN_PUB=$(echo "$HUMAN_KEYS" | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).publicKey))")
HUMAN_PRIV=$(echo "$HUMAN_KEYS" | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).privateKey))")

HUMAN_ID=$(docker exec "$CONTAINER" node src/cli/cli.js enroll \
  --name "Priya" --contexts office --admin --public-key "$HUMAN_PUB" \
  | awk '/id:/ {print $2; exit}')
echo "    enrolled $HUMAN_ID (server never saw the private key)"

echo "==> Issuing an agent identity card for claude-code"
AGENT_KEYS=$(node src/cli/cli.js keygen --json)
AGENT_PUB=$(echo "$AGENT_KEYS" | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).publicKey))")

AGENT_ID=$(docker exec "$CONTAINER" node src/cli/cli.js issue-agent \
  --sponsor "$HUMAN_ID" --tool claude-code --version 2.4.0 --context office \
  --branches "feature/*,agent/*" --actions "push,pr:open,pr:comment" \
  --public-key "$AGENT_PUB" \
  | awk '/agentCardId:/ {print $2; exit}')
echo "    issued $AGENT_ID"

echo "==> Running end-to-end tests against the deployed service"
echo ""
IDENTITIES=$(node -e "
console.log(JSON.stringify({
  humanId: process.argv[1],
  humanKey: process.argv[2],
  agentCardId: process.argv[3],
}));
" "$HUMAN_ID" "$HUMAN_PRIV" "$AGENT_ID")

AGENTGATE_URL="$URL" AGENTGATE_ADMIN_TOKEN="$ADMIN_TOKEN" \
  node demo/e2e-docker.js "$IDENTITIES"
RESULT=$?

echo ""
echo "==> Verifying state survives a container restart"
docker restart "$CONTAINER" >/dev/null
for i in $(seq 1 30); do
  status=$(docker inspect "$CONTAINER" --format '{{.State.Health.Status}}' 2>/dev/null || echo starting)
  [ "$status" = "healthy" ] && break
  sleep 1
done
AFTER=$(curl -s -H "Authorization: Bearer ${ADMIN_TOKEN}" "${URL}/audit/verify")
echo "    audit chain after restart: $AFTER"
echo "$AFTER" | grep -q '"valid": true' || { echo "    FAIL: chain did not survive restart"; exit 1; }

STILL_THERE=$(docker exec "$CONTAINER" node src/cli/cli.js status "$AGENT_ID" | grep -c '"valid": true' || true)
[ "$STILL_THERE" -ge 1 ] || { echo "    FAIL: agent card did not survive restart"; exit 1; }
echo "    identities and audit log persisted across restart"

exit $RESULT
