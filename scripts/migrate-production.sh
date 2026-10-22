#!/usr/bin/env bash
set -euo pipefail
cd /opt/srd
compose=(docker compose --env-file .env.production -f compose.production.yaml)
for service in gateway identity configuration records audit files calendar notifications treasury inventory chat; do
    echo "Migrating $service"
    "${compose[@]}" exec -T "$service" php artisan migrate --force
done
"${compose[@]}" exec -T calendar php artisan srd:calendar-backfill-reminders
echo 'Production migrations completed.'
