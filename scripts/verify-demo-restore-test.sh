#!/usr/bin/env bash
set -euo pipefail
if [ "$(id -u)" -ne 0 ] || [ "$#" -ne 4 ]; then
    echo 'Uso: root verify-demo-restore-test.sh PERSON_ID CALENDAR_ID ASSET_ID DOCUMENT_ID' >&2
    exit 1
fi
for id in "$@"; do
    if ! [[ "$id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
        echo 'Identificador inválido.' >&2
        exit 1
    fi
done
result=$(docker exec -i srd-restore-test bash -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql -uroot --protocol=socket --skip-column-names' <<SQL
SELECT 'person', COUNT(*) FROM srd_records.persons WHERE id = '$1';
SELECT 'calendar', COUNT(*) FROM srd_calendar.calendar_events WHERE id = '$2';
SELECT 'asset', COUNT(*) FROM srd_inventory.assets WHERE id = '$3';
SELECT 'document', COUNT(*) FROM srd_files.folder_documents WHERE id = '$4' AND ready = 1;
SELECT 'treasury', COUNT(*) FROM srd_treasury.treasury_accounts;
SQL
)
for entity in person calendar asset document treasury; do
    count=$(printf '%s\n' "$result" | awk -v entity="$entity" '$1 == entity {print $2}')
    if [ "$count" != 1 ]; then
        printf '%s: expected 1, got %s\n' "$entity" "${count:-missing}" >&2
        exit 1
    fi
    printf 'RESTORED_%s_OK\n' "${entity^^}"
done
