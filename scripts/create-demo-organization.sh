#!/usr/bin/env bash
set -euo pipefail
cd /opt/srd
compose=(docker compose --env-file .env.production -f compose.production.yaml)
"${compose[@]}" cp deploy/demo-terms-es.txt configuration:/tmp/srd-demo-terms-es.txt
"${compose[@]}" cp deploy/demo-terms-en.txt configuration:/tmp/srd-demo-terms-en.txt
"${compose[@]}" exec -T configuration php artisan srd:organization srd-piloto 'SRD - Demostración' \
    --terms-file=/tmp/srd-demo-terms-es.txt --terms-file-en=/tmp/srd-demo-terms-en.txt
