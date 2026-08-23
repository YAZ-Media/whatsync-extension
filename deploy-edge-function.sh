#!/bin/bash
set -euo pipefail

# Deploy the WhatSync edge functions to Supabase and smoke-test the live endpoints.
#
# Deploys all six functions (hubspot, hubspot-oauth, settings, external-auth,
# billing, save-activity-config) with JWT verification disabled — they
# authenticate against the EXTERNAL auth project's JWTs themselves, so platform
# verification (against this project's secret) must stay off.
#
# Requirements (deploy only — `smoke` needs no token):
#   SUPABASE_ACCESS_TOKEN  personal access token (Supabase Dashboard → Account → Access Tokens)
#
# Optional (for the authenticated smoke test):
#   SUPABASE_JWT           access token of a logged-in WhatSync user
#
# Usage:
#   SUPABASE_ACCESS_TOKEN=sbp_... ./deploy-edge-function.sh            # deploy all + smoke test
#   SUPABASE_ACCESS_TOKEN=sbp_... ./deploy-edge-function.sh hubspot    # deploy one + smoke test
#   ./deploy-edge-function.sh smoke                                    # smoke-test only (no deploy)

PROJECT_REF="ogsvchujqpayuckxuwdf"
ALL_FUNCTIONS=(hubspot hubspot-oauth settings external-auth billing save-activity-config)
BASE_URL="https://${PROJECT_REF}.supabase.co/functions/v1"
ANON_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9nc3ZjaHVqcXBheXVja3h1d2RmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAzNzU3MzIsImV4cCI6MjA5NTk1MTczMn0.naUOzsjvZk5BT6kUM-eV1g4JxPhBogkBu8gb1Rg0Z8M"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
FAILURES=0

# Shared curl options: retry transient failures (connection resets are normal
# for a second or two right after a redeploy, while the gateway cold-starts)
# and never let a curl exit code kill the script — every check reports into
# FAILURES instead.
CURL_OPTS=(-s --retry 5 --retry-all-errors --retry-delay 2 --max-time 20)

# CORS preflight. hubspot answers 204 explicitly; the others return 200 with
# CORS headers — both mean the function booted and is routable.
check_options() {
  local fn="$1"
  local status
  status=$(curl "${CURL_OPTS[@]}" -o /dev/null -w "%{http_code}" -X OPTIONS "${BASE_URL}/${fn}" -H "apikey: $ANON_KEY" || echo "000")
  if [ "$status" = "200" ] || [ "$status" = "204" ]; then
    echo -e "${GREEN}OK: ${fn} CORS preflight (${status})${NC}"
  else
    echo -e "${RED}FAIL: ${fn} OPTIONS returned ${status} (expected 200/204)${NC}"; FAILURES=$((FAILURES+1))
  fi
}

# POST a payload without a user session and assert the HTTP status plus a
# marker string in the body. This proves each function boots, parses JSON,
# and its auth gate (or dispatcher) behaves — without needing a real session.
check_post() {
  local fn="$1" payload="$2" want_status="$3" want_marker="$4" label="$5"
  local tmp status body
  tmp=$(mktemp)
  status=$(curl "${CURL_OPTS[@]}" -o "$tmp" -w "%{http_code}" -X POST "${BASE_URL}/${fn}" \
    -H "Content-Type: application/json" -H "apikey: $ANON_KEY" -d "$payload" || echo "000")
  body=$(cat "$tmp"); rm -f "$tmp"
  if [ "$status" = "$want_status" ] && echo "$body" | grep -q "$want_marker"; then
    echo -e "${GREEN}OK: ${fn} ${label}${NC}"
  else
    echo -e "${RED}FAIL: ${fn} ${label} — HTTP ${status} (expected ${want_status}), body: ${body}${NC}"
    FAILURES=$((FAILURES+1))
  fi
}

smoke() {
  echo -e "${YELLOW}Smoke-testing all live endpoints...${NC}"

  for fn in "${ALL_FUNCTIONS[@]}"; do
    check_options "$fn"
  done

  # hubspot wraps errors as HTTP 200 with { error, status } in the body
  # (so supabase-js clients see the detail) — check the body, not the code.
  check_post hubspot '{"action":"getTemplates"}' 200 '"status":401' \
    'auth gate (401 error body without user session)'

  # The hardened functions return a real HTTP 401 when no session is presented.
  check_post hubspot-oauth '{"action":"getConnectionStatus"}' 401 'Authorization' \
    'auth gate (HTTP 401 without user session)'
  check_post settings '{"action":"getSettings","data":{"userId":"smoke-test"}}' 401 'Authorization' \
    'auth gate (HTTP 401 without user session)'
  check_post billing '{"action":"getBillingData","data":{"userId":"smoke-test"}}' 401 'Authorization' \
    'auth gate (HTTP 401 without user session)'
  check_post save-activity-config '{"action":"save","data":{}}' 401 'Authorization' \
    'save is auth-gated (HTTP 401 without user session)'

  # Public-by-design endpoints must still answer correctly.
  check_post save-activity-config '{"action":"get"}' 200 'tableName' \
    'config read returns the activity table config'
  check_post external-auth '{"action":"__smoke__"}' 200 'Invalid action' \
    'dispatcher answers (auth actions are public by design)'

  # Authenticated round-trip (only when a user JWT is provided).
  if [ -n "${SUPABASE_JWT:-}" ]; then
    local body
    body=$(curl "${CURL_OPTS[@]}" -X POST "${BASE_URL}/hubspot" \
      -H "Content-Type: application/json" -H "apikey: $ANON_KEY" \
      -H "Authorization: Bearer $SUPABASE_JWT" \
      -d '{"action":"getTemplates"}' || echo "")
    if echo "$body" | grep -q '"templates"'; then
      echo -e "${GREEN}OK: hubspot authenticated getTemplates round-trip${NC}"
    else
      echo -e "${RED}FAIL: hubspot authenticated getTemplates response: $body${NC}"; FAILURES=$((FAILURES+1))
    fi
  else
    echo -e "${YELLOW}SKIP: authenticated round-trip (set SUPABASE_JWT to enable)${NC}"
  fi

  if [ "$FAILURES" -gt 0 ]; then
    echo -e "${RED}${FAILURES} smoke check(s) failed.${NC}"
    exit 1
  fi
  echo -e "${GREEN}Smoke tests passed — the WhatSync edge functions are live.${NC}"
}

if [ "${1:-}" = "smoke" ]; then
  smoke
  exit 0
fi

if [ -z "${SUPABASE_ACCESS_TOKEN:-}" ]; then
  echo -e "${RED}SUPABASE_ACCESS_TOKEN is not set.${NC}"
  echo "Create one at https://supabase.com/dashboard/account/tokens and run:"
  echo "  SUPABASE_ACCESS_TOKEN=sbp_... ./deploy-edge-function.sh"
  echo "Or run the smoke tests alone (no token needed):"
  echo "  ./deploy-edge-function.sh smoke"
  exit 1
fi

if [ "$#" -gt 0 ]; then
  FUNCTIONS=("$@")
else
  FUNCTIONS=("${ALL_FUNCTIONS[@]}")
fi

for fn in "${FUNCTIONS[@]}"; do
  echo -e "${YELLOW}Deploying ${fn} to project ${PROJECT_REF}...${NC}"
  # --no-verify-jwt is belt-and-braces on top of supabase/config.toml.
  npx --yes supabase functions deploy "$fn" --project-ref "$PROJECT_REF" --no-verify-jwt
done

smoke
