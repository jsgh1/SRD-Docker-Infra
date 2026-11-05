#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

: "${P46_SOURCE_PASSWORD:?synthetic source password required}"
: "${P46_RESTORE_PASSWORD:?synthetic restore password required}"
: "${P46_SOURCE_PORT:?source port required}"
: "${P46_RESTORE_PORT:?restore port required}"
: "${P46_MYSQL_IMAGE:?pinned MySQL client image required}"

databases=(srd_gateway srd_identity srd_configuration srd_records srd_audit srd_files srd_calendar srd_notifications srd_treasury srd_inventory srd_chat)
database_list=$(printf "'%s'," "${databases[@]}")
database_list=${database_list%,}
work=$(mktemp -d "${RUNNER_TEMP:-/tmp}/srd-p46-restore.XXXXXX")
backup="$work/backup"
mkdir -p "$backup" "$work/private/documents"

cleanup() {
    rm -f "$work/age-identity.txt" "$work/wrong-identity.txt" "$work/recipient.txt"
    rm -rf "$work"
}
trap cleanup EXIT

mysql_with_password() {
    local password="$1" port="$2"
    shift 2
    docker run --rm -i --network host -e MYSQL_PWD="$password" "$P46_MYSQL_IMAGE" \
        mysql --protocol=TCP --host=127.0.0.1 --port="$port" --user=root --default-character-set=utf8mb4 "$@"
}
source_mysql() { mysql_with_password "$P46_SOURCE_PASSWORD" "$P46_SOURCE_PORT" "$@"; }
restore_mysql() { mysql_with_password "$P46_RESTORE_PASSWORD" "$P46_RESTORE_PORT" "$@"; }

wait_for_mysql() {
    local port="$1" password="$2"
    for attempt in $(seq 1 60); do
        if mysql_with_password "$password" "$port" --batch --skip-column-names --execute 'SELECT 1' >/dev/null 2>&1; then
            return 0
        fi
        sleep 2
    done
    echo "MySQL readiness failed on the synthetic QA port $port." >&2
    return 1
}
wait_for_mysql "$P46_SOURCE_PORT" "$P46_SOURCE_PASSWORD"
wait_for_mysql "$P46_RESTORE_PORT" "$P46_RESTORE_PASSWORD"

age-keygen -o "$work/age-identity.txt" 2>/dev/null
age-keygen -y "$work/age-identity.txt" > "$work/recipient.txt"
age-keygen -o "$work/wrong-identity.txt" 2>/dev/null

for database in "${databases[@]}"; do
    source_mysql --execute "CREATE DATABASE $database CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci"
    source_mysql --execute "CREATE TABLE $database.p46_fixture (fixture_id VARCHAR(64) PRIMARY KEY, marker VARCHAR(80) NOT NULL) ENGINE=InnoDB"
    source_mysql --execute "INSERT INTO $database.p46_fixture VALUES ('$database', 'p46-synthetic-20261104')"
done

printf 'SRD P46 synthetic private file\nfixture=2026-11-04\n' > "$work/private/documents/p46-synthetic-document.txt"
document_sha=$(sha256sum "$work/private/documents/p46-synthetic-document.txt" | awk '{print $1}')
source_mysql <<SQL
CREATE TABLE srd_records.persons (
  id CHAR(36) PRIMARY KEY,
  display_name VARCHAR(100) NOT NULL,
  synthetic BOOLEAN NOT NULL
) ENGINE=InnoDB;
CREATE TABLE srd_calendar.events (
  id CHAR(36) PRIMARY KEY,
  person_id CHAR(36) NOT NULL,
  title VARCHAR(120) NOT NULL
) ENGINE=InnoDB;
CREATE TABLE srd_inventory.assets (
  id CHAR(36) PRIMARY KEY,
  person_id CHAR(36) NOT NULL,
  label VARCHAR(100) NOT NULL
) ENGINE=InnoDB;
CREATE TABLE srd_files.documents (
  id CHAR(36) PRIMARY KEY,
  person_id CHAR(36) NOT NULL,
  object_key VARCHAR(180) NOT NULL,
  sha256 CHAR(64) NOT NULL
) ENGINE=InnoDB;
CREATE TABLE srd_treasury.accounts (
  id CHAR(36) PRIMARY KEY,
  label VARCHAR(80) NOT NULL
) ENGINE=InnoDB;
CREATE TABLE srd_treasury.entries (
  id CHAR(36) PRIMARY KEY,
  account_id CHAR(36) NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  CONSTRAINT p46_entry_account FOREIGN KEY (account_id) REFERENCES srd_treasury.accounts(id)
) ENGINE=InnoDB;
CREATE TABLE srd_chat.threads (
  id CHAR(36) PRIMARY KEY,
  person_id CHAR(36) NOT NULL
) ENGINE=InnoDB;
CREATE TABLE srd_chat.messages (
  id CHAR(36) PRIMARY KEY,
  thread_id CHAR(36) NOT NULL,
  body VARCHAR(120) NOT NULL,
  CONSTRAINT p46_message_thread FOREIGN KEY (thread_id) REFERENCES srd_chat.threads(id)
) ENGINE=InnoDB;

INSERT INTO srd_records.persons VALUES ('10000000-0000-4000-8000-000000000001', 'Synthetic P46 Person', TRUE);
INSERT INTO srd_calendar.events VALUES ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'Synthetic P46 event');
INSERT INTO srd_inventory.assets VALUES ('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'Synthetic asset');
INSERT INTO srd_files.documents VALUES ('40000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'documents/p46-synthetic-document.txt', '$document_sha');
INSERT INTO srd_treasury.accounts VALUES ('50000000-0000-4000-8000-000000000001', 'Synthetic account');
INSERT INTO srd_treasury.entries VALUES ('60000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001', 12.34);
INSERT INTO srd_chat.threads VALUES ('70000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001');
INSERT INTO srd_chat.messages VALUES ('80000000-0000-4000-8000-000000000001', '70000000-0000-4000-8000-000000000001', 'Synthetic P46 message');
SQL

docker run --rm --network host -e MYSQL_PWD="$P46_SOURCE_PASSWORD" "$P46_MYSQL_IMAGE" \
    mysqldump --protocol=TCP --host=127.0.0.1 --port="$P46_SOURCE_PORT" --user=root \
    --single-transaction --quick --routines --events --triggers --databases "${databases[@]}" \
    | age -R "$work/recipient.txt" -o "$backup/mysql.sql.age"
tar -C "$work/private" -cf - . | age -R "$work/recipient.txt" -o "$backup/files.tar.age"
printf 'APP_ENV=synthetic\nDB_DATABASE=not-production\nSRD_BACKUP_FIXTURE=true\n' > "$work/synthetic.env"
age -R "$work/recipient.txt" -o "$backup/env.production.age" "$work/synthetic.env"
(
    cd "$backup"
    sha256sum mysql.sql.age files.tar.age env.production.age > SHA256SUMS
    sha256sum --check SHA256SUMS
)
echo "PASS: synthetic backup created with mysqldump, tar, age and SHA-256."

is_clean_target() {
    local count
    count=$(restore_mysql --batch --skip-column-names --execute "SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name IN ($database_list)")
    [[ "$count" == "0" ]]
}

drop_synthetic_databases() {
    local statement="SET FOREIGN_KEY_CHECKS=0;"
    local database
    for database in "${databases[@]}"; do statement+=" DROP DATABASE IF EXISTS $database;"; done
    restore_mysql --execute "$statement"
}

verify_restored() {
    local restored_private="$1" count tables relations expected_sha actual_sha
    count=$(restore_mysql --batch --skip-column-names --execute "SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name IN ($database_list)") || return 1
    [[ "$count" == "11" ]] || return 1
    tables=$(restore_mysql --batch --skip-column-names --execute "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema IN ($database_list) AND table_name='p46_fixture'") || return 1
    [[ "$tables" == "11" ]] || return 1
    for database in "${databases[@]}"; do
        count=$(restore_mysql --batch --skip-column-names --execute "SELECT COUNT(*) FROM $database.p46_fixture WHERE fixture_id='$database' AND marker='p46-synthetic-20261104'") || return 1
        [[ "$count" == "1" ]] || return 1
    done
    relations=$(restore_mysql --batch --skip-column-names --execute "SELECT COUNT(*) FROM srd_records.persons p JOIN srd_calendar.events e ON e.person_id=p.id JOIN srd_inventory.assets a ON a.person_id=p.id JOIN srd_files.documents d ON d.person_id=p.id WHERE p.synthetic=TRUE AND d.sha256='$document_sha'") || return 1
    [[ "$relations" == "1" ]] || return 1
    relations=$(restore_mysql --batch --skip-column-names --execute "SELECT COUNT(*) FROM srd_treasury.entries e JOIN srd_treasury.accounts a ON a.id=e.account_id WHERE e.amount=12.34") || return 1
    [[ "$relations" == "1" ]] || return 1
    relations=$(restore_mysql --batch --skip-column-names --execute "SELECT COUNT(*) FROM srd_chat.messages m JOIN srd_chat.threads t ON t.id=m.thread_id WHERE m.body='Synthetic P46 message'") || return 1
    [[ "$relations" == "1" ]] || return 1
    expected_sha=$(restore_mysql --batch --skip-column-names --execute "SELECT sha256 FROM srd_files.documents WHERE id='40000000-0000-4000-8000-000000000001'") || return 1
    actual_sha=$(sha256sum "$restored_private/documents/p46-synthetic-document.txt" | awk '{print $1}') || return 1
    [[ "$expected_sha" == "$actual_sha" ]] || return 1
    return 0
}

restore_backup() {
    local input="$1" identity="$2" label="$3"
    local stage="$work/restore-$label"
    mkdir -p "$stage/private"
    (
        cd "$input"
        sha256sum --check --status SHA256SUMS
    ) || return 41
    age -d -i "$identity" -o "$stage/mysql.sql" "$input/mysql.sql.age" || return 42
    age -d -i "$identity" -o "$stage/files.tar" "$input/files.tar.age" || return 43
    age -d -i "$identity" -o "$stage/env.production" "$input/env.production.age" || return 44
    grep -qx 'APP_ENV=synthetic' "$stage/env.production" || return 45
    tar -xf "$stage/files.tar" -C "$stage/private" || return 46
    [[ -s "$stage/mysql.sql" && -s "$stage/private/documents/p46-synthetic-document.txt" ]] || return 47
    if ! restore_mysql < "$stage/mysql.sql"; then
        drop_synthetic_databases >/dev/null 2>&1 || true
        return 48
    fi
    if ! verify_restored "$stage/private"; then
        drop_synthetic_databases >/dev/null 2>&1 || true
        return 49
    fi
    return 0
}

expect_rejected() {
    local label="$1" input="$2" identity="$3"
    if restore_backup "$input" "$identity" "$label"; then
        echo "FAIL: negative restore unexpectedly succeeded ($label)." >&2
        return 1
    fi
    is_clean_target || { echo "FAIL: rejected restore left synthetic schemas behind ($label)." >&2; return 1; }
    echo "PASS: $label rejected without importing or claiming a partial restore."
}

expect_rejected wrong-key "$backup" "$work/wrong-identity.txt"

truncated="$work/truncated"
cp -a "$backup" "$truncated"
truncate -s -16 "$truncated/mysql.sql.age"
expect_rejected truncated-ciphertext "$truncated" "$work/age-identity.txt"
if age -d -i "$work/age-identity.txt" -o "$work/truncated.sql" "$truncated/mysql.sql.age" >/dev/null 2>&1; then
    echo "FAIL: age accepted a truncated ciphertext." >&2
    exit 1
fi

modified="$work/modified"
cp -a "$backup" "$modified"
python3 - "$modified/mysql.sql.age" <<'PY'
import pathlib
import sys
path = pathlib.Path(sys.argv[1])
payload = bytearray(path.read_bytes())
if len(payload) < 32:
    raise SystemExit("ciphertext fixture is unexpectedly short")
payload[-1] ^= 1
path.write_bytes(payload)
PY
expect_rejected modified-ciphertext "$modified" "$work/age-identity.txt"
if age -d -i "$work/age-identity.txt" -o "$work/modified.sql" "$modified/mysql.sql.age" >/dev/null 2>&1; then
    echo "FAIL: age accepted modified ciphertext." >&2
    exit 1
fi

restore_backup "$backup" "$work/age-identity.txt" valid
echo "PASS: clean MySQL restored 11 schemas, 11 fixture rows, synthetic relations and private file hash."
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    {
        echo "## P46 synthetic encrypted restore"
        echo "- PASS: operational-format mysqldump/tar/age artifacts and SHA-256."
        echo "- PASS: wrong key, truncated ciphertext and modified ciphertext rejected before import."
        echo "- PASS: clean MySQL restored 11 canonical schemas, synthetic relations and private file hashes."
        echo "- Scope: ephemeral synthetic QA only; no production backup, secret, PII or key was used."
    } >> "$GITHUB_STEP_SUMMARY"
fi
