#!/usr/bin/env bash
# So where? · Atlas Stream Processing for live TfL line status, via the Atlas Admin API (no CLI, no mongosh).
#   scripts/asp-setup.sh up      # workspace (SP2, London) + 2 connections + processor, then start it
#   scripts/asp-setup.sh status  # processor state + stats
#   scripts/asp-setup.sh stop    # STOP the processor after the finale (stops processor billing)
#   scripts/asp-setup.sh down    # stop + delete processor and workspace (nothing left to bill)
# Env: ATLAS_PUBLIC_KEY, ATLAS_PRIVATE_KEY (project API key, role Project Stream Processing Manager or Owner),
#      ATLAS_PROJECT_ID; optional ATLAS_CLUSTER (default so-where), ATLAS_SP_WORKSPACE (default sowhere-streams),
#      ATLAS_SP_REGION (default LONDON_GBR). Secrets are never echoed.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${ATLAS_PUBLIC_KEY:?set ATLAS_PUBLIC_KEY}" "${ATLAS_PRIVATE_KEY:?set ATLAS_PRIVATE_KEY}" "${ATLAS_PROJECT_ID:?set ATLAS_PROJECT_ID}"
WS="${ATLAS_SP_WORKSPACE:-sowhere-streams}"; CLUSTER="${ATLAS_CLUSTER:-so-where}"; REGION="${ATLAS_SP_REGION:-LONDON_GBR}"; SP="tfl_line_status"
API="https://cloud.mongodb.com/api/atlas/v2/groups/$ATLAS_PROJECT_ID/streams"
call() { # method path [json] [api-version]
  local v="${4:-2023-02-01}"
  curl -sS --digest -u "$ATLAS_PUBLIC_KEY:$ATLAS_PRIVATE_KEY" -X "$1" "$API$2" \
    -H "Accept: application/vnd.atlas.$v+json" -H "Content-Type: application/json" ${3:+--data "$3"} -w '\n[HTTP %{http_code}]\n'
}
case "${1:-status}" in
  up)
    echo "1/5 workspace $WS (AWS $REGION, tier SP2, max SP2)"
    call POST "" "{\"name\":\"$WS\",\"dataProcessRegion\":{\"cloudProvider\":\"AWS\",\"region\":\"$REGION\"},\"streamConfig\":{\"tier\":\"SP2\",\"maxTierSize\":\"SP2\"}}"
    echo "2/5 connection sowhere_cluster → cluster $CLUSTER"
    call POST "/$WS/connections" "{\"name\":\"sowhere_cluster\",\"type\":\"Cluster\",\"clusterName\":\"$CLUSTER\",\"dbRoleToExecute\":{\"role\":\"readWriteAnyDatabase\",\"type\":\"BUILT_IN\"}}"
    echo "3/5 connection tfl_api → https://api.tfl.gov.uk/"
    call POST "/$WS/connections" '{"name":"tfl_api","type":"Https","url":"https://api.tfl.gov.uk/"}'
    echo "4/5 processor $SP"
    call POST "/$WS/processor" "$(node -e 'const p=require("./scripts/stream-tfl-pipeline.cjs");process.stdout.write(JSON.stringify({name:"tfl_line_status",pipeline:p.streamPipeline(),options:{dlq:{connectionName:"sowhere_cluster",db:p.DB,coll:"line_status_dlq"}}}))')" 2024-05-30
    echo "5/5 start"
    call POST "/$WS/processor/$SP:start" "" 2024-05-30
    echo "Started. Rows land in sowhere.line_status within ~60 s. Remember: scripts/asp-setup.sh stop after the finale." ;;
  status) call GET "/$WS/processor/$SP" "" 2024-05-30 ;;
  stop) call POST "/$WS/processor/$SP:stop" "" 2024-05-30 ;;
  down)
    call POST "/$WS/processor/$SP:stop" "" 2024-05-30 || true
    call DELETE "/$WS/processor/$SP" "" 2024-05-30 || true
    call DELETE "/$WS" ;;
  *) echo "usage: $0 up|status|stop|down"; exit 2 ;;
esac
