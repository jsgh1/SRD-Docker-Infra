#!/usr/bin/env bash
set -euo pipefail
if [ "$(id -u)" -ne 0 ]; then exit 1; fi
docker exec -i srd-restore-test bash -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql -uroot --protocol=socket'
