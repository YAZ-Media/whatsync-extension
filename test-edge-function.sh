#!/bin/bash
set -euo pipefail

# Smoke test for the `hubspot` Supabase edge function.
#
# The function requires an authenticated Supabase session, so all inputs come
# from environment variables — nothing is hardcoded:
#
#   EDGE_FUNCTION_URL   e.g. https://<project-ref>.supabase.co/functions/v1/hubspot
#   SUPABASE_ANON_KEY   anon key of the edge-function project (apikey header)
#   SUPABASE_JWT        access token of a logged-in test user
#   TEST_CONTACT_ID     HubSpot contact id in the test portal to attach the note to
#
# Usage:
#   EDGE_FUNCTION_URL=... SUPABASE_ANON_KEY=... SUPABASE_JWT=... TEST_CONTACT_ID=... ./test-edge-function.sh

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'

for var in EDGE_FUNCTION_URL SUPABASE_ANON_KEY SUPABASE_JWT TEST_CONTACT_ID; do
  if [ -z "${!var:-}" ]; then
    echo -e "${RED}Missing required environment variable: $var${NC}" >&2
    exit 1
  fi
done

TIMESTAMP=$(date +%s000)
TEST_PAYLOAD=$(cat <<EOF
{
  "action": "createNote",
  "data": {
    "contactId": "$TEST_CONTACT_ID",
    "note": "WhatSync edge-function smoke test - $(date)",
    "timestamp": $TIMESTAMP
  }
}
EOF
)

echo -e "${YELLOW}Testing edge function: $EDGE_FUNCTION_URL${NC}"

RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$EDGE_FUNCTION_URL" \
  -H "Content-Type: application/json" \
  -H "apikey: $SUPABASE_ANON_KEY" \
  -H "Authorization: Bearer $SUPABASE_JWT" \
  -d "$TEST_PAYLOAD")

HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
RESPONSE_BODY=$(echo "$RESPONSE" | sed '$d')

echo "HTTP Status: $HTTP_CODE"
echo "$RESPONSE_BODY" | jq '.' 2>/dev/null || echo "$RESPONSE_BODY"

if [ "$HTTP_CODE" -eq 200 ]; then
  echo -e "${GREEN}✅ Success${NC}"
else
  echo -e "${RED}❌ Failed (status $HTTP_CODE)${NC}"
  echo "Check: Supabase Dashboard → Edge Functions → hubspot → Logs"
  exit 1
fi
