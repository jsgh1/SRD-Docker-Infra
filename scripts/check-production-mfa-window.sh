#!/usr/bin/env bash
set -euo pipefail
if [ "$(id -u)" -ne 0 ]; then exit 1; fi
docker exec -i srd-production-mysql-1 bash -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql -uroot --protocol=socket --skip-column-names srd_identity' <<'SQL'
SELECT NOW(), COUNT(*), MIN(created_at), MAX(created_at)
FROM auth_challenges
WHERE purpose = 'login' AND created_at > NOW() - INTERVAL 1 HOUR;
SQL
