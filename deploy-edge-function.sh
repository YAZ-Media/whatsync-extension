#!/bin/bash
set -euo pipefail

# Deploy the `hubspot` edge function to Supabase and smoke-test the live endpoint.
#
# Requirements:
#   SUPABASE_ACCESS_TOKEN  personal access token (Supabase Dashboard → Account → Access Tokens)
#
# Optional (for the authenticated smoke test):
#   SUPABASE_JWT           access token of a logged-in WhatSync user
#
# Usage:
#   SUPABASE_ACCESS_TOKEN=sbp_... ./deploy-edge-function.sh

PROJECT_REF="ogsvchujqpayuckxuwdf"
FUNCTION_NAME="hubspot"
FUNCTION_URL="https://${PROJECT_REF}.supabase.co/functions/v1/${FUNCTION_NAME}"
ANON_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9nc3ZjaHVqcXBheXVja3h1d2RmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAzNzU3MzIsImV4cCI6MjA5NTk1MTczMn0.naUOzsjvZk5BT6kUM-eV1g4JxPhBogkBu8gb1Rg0Z8M"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'

if [ -z "${SUPABASE_ACCESS_TOKEN:-}" ]; then
  echo -e "${RED}SUPABASE_ACCESS_TOKEN is not set.${NC}"
  echo "Create one at https://supabase.com/dashboard/account/tokens and run:"
  echo "  SUPABASE_ACCESS_TOKEN=sbp_... ./deploy-edge-function.sh"
  exit 1
fi

echo -e "${YELLOW}Deploying ${FUNCTION_NAME} to project ${PROJECT_REF}...${NC}"
npx --yes supabase functions deploy "$FUNCTION_NAME" --project-ref "$PROJECT_REF"

echo -e "${YELLOW}Smoke-testing the live endpoint...${NC}"

# 1. CORS preflight must answer 204.
status=$(curl -s -o /dev/null -w "%{http_code}" -X OPTIONS "$FUNCTION_URL" -H "apikey: $ANON_KEY")
if [ "$status" != "204" ]; then
  echo -e "${RED}FAIL: OPTIONS returned $status (expected 204)${NC}"; exit 1
fi
echo -e "${GREEN}OK: CORS preflight (204)${NC}"

# 2. Unauthenticated requests must be rejected by the function's auth gate.
# The function wraps errors as HTTP 200 with { error, status } in the body
# (so supabase-js clients see the detail), so check the body, not the code.
body=$(curl -s -X POST "$FUNCTION_URL" \
  -H "Content-Type: application/json" -H "apikey: $ANON_KEY" \
  -d '{"action":"getTemplates"}')
if echo "$body" | grep -q '"status":401'; then
  echo -e "${GREEN}OK: auth gate (401 error body without user session)${NC}"
else
  echo -e "${RED}FAIL: unauthenticated POST response: $body${NC}"; exit 1
fi

# 3. Authenticated round-trip (only when a user JWT is provided).
if [ -n "${SUPABASE_JWT:-}" ]; then
  body=$(curl -s -X POST "$FUNCTION_URL" \
    -H "Content-Type: application/json" -H "apikey: $ANON_KEY" \
    -H "Authorization: Bearer $SUPABASE_JWT" \
    -d '{"action":"getTemplates"}')
  if echo "$body" | grep -q '"templates"'; then
    echo -e "${GREEN}OK: authenticated getTemplates round-trip${NC}"
  else
    echo -e "${RED}FAIL: authenticated getTemplates response: $body${NC}"; exit 1
  fi
else
  echo -e "${YELLOW}SKIP: authenticated round-trip (set SUPABASE_JWT to enable)${NC}"
fi

echo -e "${GREEN}Deploy verified — the hubspot edge function is live.${NC}"
