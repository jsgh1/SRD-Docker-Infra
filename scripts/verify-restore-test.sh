#!/usr/bin/env bash
set -euo pipefail
if [ "$(id -u)" -ne 0 ]; then exit 1; fi
query() {
    docker exec "$1" bash -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot --protocol=socket -Nse "SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name LIKE '\''srd_%'\''; SELECT COUNT(*) FROM information_schema.tables WHERE table_schema LIKE '\''srd_%'\''"'
}
original=$(query srd-production-mysql-1)
restored=$(query srd-restore-test)
printf 'Original: %s\nRestored: %s\n' "$(echo "$original" | tr '\n' '/')" "$(echo "$restored" | tr '\n' '/')"
test "$original" = "$restored"
