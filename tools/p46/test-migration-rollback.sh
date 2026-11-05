#!/usr/bin/env bash
set -Eeuo pipefail

: "${P46_FILES_ROOT:?assembled Files service directory required}"
: "${DB_HOST:?}"
: "${DB_PORT:?}"
: "${DB_DATABASE:?}"
: "${DB_USERNAME:?}"
: "${DB_PASSWORD:?}"
cd "$P46_FILES_ROOT"

migration="database/migrations/2026_09_27_000002_create_folder_documents.php"
[[ -s "$migration" ]]
export APP_ENV=testing APP_DEBUG=false APP_KEY=base64:MTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTI=
export DB_CONNECTION=mysql DB_HOST DB_PORT DB_DATABASE DB_USERNAME DB_PASSWORD
export CACHE_STORE=file SESSION_DRIVER=file LOG_CHANNEL=stderr

php artisan migrate --path="$migration" --force --no-interaction
php -r '
$pdo = new PDO(
    "mysql:host=".getenv("DB_HOST").";port=".getenv("DB_PORT").";dbname=".getenv("DB_DATABASE").";charset=utf8mb4",
    getenv("DB_USERNAME"),
    getenv("DB_PASSWORD"),
    [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]
);
$pdo->exec("INSERT INTO folder_documents (id, organization_id, folder_id, parent_key, name, name_key, mime, blob_id, bytes, sha256, ready, created_by, created_at, updated_at) VALUES (\"04600000-0000-4000-8000-000000000001\", \"04600000-0000-4000-8000-000000000002\", NULL, \"04600000-0000-4000-8000-000000000003\", \"Synthetic rollback document\", SHA2(\"synthetic\", 256), \"text/plain\", \"p46syntheticblob00000000000000000000000000000000\", 9, SHA2(\"synthetic\", 256), 1, \"04600000-0000-4000-8000-000000000004\", NOW(), NOW())");
$count = $pdo->query("SELECT COUNT(*) FROM folder_documents WHERE name=\"Synthetic rollback document\"")->fetchColumn();
if ((int)$count !== 1) { throw new RuntimeException("Synthetic row was not inserted."); }
'
echo "PASS: selected migration applied and synthetic table/data verified."

php artisan migrate:rollback --path="$migration" --step=1 --force --no-interaction
php -r '
$pdo = new PDO(
    "mysql:host=".getenv("DB_HOST").";port=".getenv("DB_PORT").";dbname=".getenv("DB_DATABASE").";charset=utf8mb4",
    getenv("DB_USERNAME"),
    getenv("DB_PASSWORD"),
    [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]
);
$count = $pdo->query("SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name=\"folder_documents\"")->fetchColumn();
if ((int)$count !== 0) { throw new RuntimeException("Rollback did not remove only the selected synthetic table."); }
'
echo "PASS: specific rollback removed folder_documents in the disposable database; its synthetic row was discarded."

php artisan migrate --path="$migration" --force --no-interaction
php -r '
$pdo = new PDO(
    "mysql:host=".getenv("DB_HOST").";port=".getenv("DB_PORT").";dbname=".getenv("DB_DATABASE").";charset=utf8mb4",
    getenv("DB_USERNAME"),
    getenv("DB_PASSWORD"),
    [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]
);
$count = $pdo->query("SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name=\"folder_documents\"")->fetchColumn();
if ((int)$count !== 1) { throw new RuntimeException("Reapplying the selected migration failed."); }
'
echo "PASS: selected migration reapplied after rollback. This proves only this table migration in synthetic QA, not data-preserving or production rollback."
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    {
        echo "## P46 migration rollback"
        echo "- PASS: files/2026_09_27_000002_create_folder_documents.php applied, rolled back by exact path, and reapplied in the disposable MySQL service."
        echo "- Data effect: rollback drops the table and the synthetic row by design."
        echo "- Limit: no claim of reversibility for other migrations or production data."
    } >> "$GITHUB_STEP_SUMMARY"
fi
