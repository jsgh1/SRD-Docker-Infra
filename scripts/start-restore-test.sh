#!/usr/bin/env bash
set -euo pipefail
if [ "$(id -u)" -ne 0 ]; then exit 1; fi
if docker container inspect srd-restore-test >/dev/null 2>&1; then
    echo 'El contenedor aislado de restauración ya existe.' >&2
    exit 1
fi
umask 077
restore_env=/root/srd-restore-test.env
if [ -e "$restore_env" ]; then exit 1; fi
printf 'MYSQL_ROOT_PASSWORD=%s\n' "$(openssl rand -hex 24)" > "$restore_env"
docker run -d --name srd-restore-test --network none --env-file "$restore_env" \
    mysql:8.4@sha256:b3b90af2a6552ae30c266fdb7d5dd55f3afb72404bb78d37fe8a23eb857fd3fb >/dev/null
for attempt in $(seq 1 60); do
    if docker exec srd-restore-test bash -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysqladmin ping --protocol=socket -uroot' >/dev/null 2>&1; then
        echo 'MySQL aislado listo para verificar restauración.'
        exit 0
    fi
    sleep 2
done
echo 'MySQL aislado no inició.' >&2
exit 1
