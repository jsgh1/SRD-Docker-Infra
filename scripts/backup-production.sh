#!/usr/bin/env bash
set -euo pipefail
if [ "$(id -u)" -ne 0 ]; then
    echo 'Ejecuta este respaldo como root.' >&2
    exit 1
fi
umask 077
cd /opt/srd
test -s .backup-recipient
test -s .env.production
compose=(docker compose --env-file .env.production -f compose.production.yaml)
"${compose[@]}" config -q
install -d -m 700 /var/backups/srd
backup_dir=$(mktemp -d "/var/backups/srd/srd-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX")
complete=false
cleanup() {
    if [ "$complete" != true ]; then
        echo "Respaldo incompleto conservado para diagnóstico: $backup_dir" >&2
    fi
}
trap cleanup EXIT

"${compose[@]}" exec -T mysql sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysqldump -uroot --protocol=socket --single-transaction --quick --routines --events --triggers --databases srd_gateway srd_identity srd_configuration srd_records srd_audit srd_files srd_calendar srd_notifications srd_treasury srd_inventory srd_chat' \
    | age -R .backup-recipient -o "$backup_dir/mysql.sql.age"
"${compose[@]}" exec -T files tar -C /app/services/files/storage/app/private -cf - . \
    | age -R .backup-recipient -o "$backup_dir/files.tar.age"
age -R .backup-recipient -o "$backup_dir/env.production.age" .env.production
(
    cd "$backup_dir"
    sha256sum mysql.sql.age files.tar.age env.production.age > SHA256SUMS
)
complete=true
printf 'Respaldo cifrado: %s\n' "$backup_dir"
