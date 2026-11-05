#!/usr/bin/env bash
set -euo pipefail
export MYSQL_PWD="${MYSQL_ROOT_PASSWORD:?Missing MYSQL_ROOT_PASSWORD}"
databases=$(mysql --protocol=socket -uroot -Nse "SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name LIKE 'srd_%'")
users=$(mysql --protocol=socket -uroot -Nse "SELECT COUNT(*) FROM mysql.user WHERE User LIKE 'srd_%'")
unset MYSQL_PWD
printf 'SRD databases: %s/11; service users: %s/11\n' "$databases" "$users"
test "$databases" -eq 11
test "$users" -eq 11
