#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

: "${P47_FIXTURE_RUN:?P47 laboratory must be explicitly enabled by GitHub Actions}"
: "${P47_BACKEND_SHA:?pinned Backend SHA required}"
: "${P47_DATABASE_SHA:?pinned Database SHA required}"
: "${P47_INFRA_SHA:?Infra SHA required}"
: "${P47_MYSQL_IMAGE:?pinned MySQL image required}"
: "${P47_ASSEMBLED:?assembled isolated workspace required}"

work="$RUNNER_TEMP/p47-runtime-restore"
artifact_dir="$RUNNER_TEMP/p47-artifacts"
mkdir -p "$work" "$artifact_dir"
report="$artifact_dir/FASE-P47-RUNNER-EVIDENCE.md"
printf '# P47 ephemeral runtime and migrated restore evidence\n\nScope: synthetic GitHub-hosted runner only; no local Docker, production data, or production runtime.\n\n' > "$report"
started=$SECONDS
services=(gateway identity configuration records audit files calendar notifications treasury inventory chat)
schedulers=(identity configuration records files calendar notifications treasury inventory chat)
databases=(srd_gateway srd_identity srd_configuration srd_records srd_audit srd_files srd_calendar srd_notifications srd_treasury srd_inventory srd_chat)
containers=()
networks=()
source_name=p47-source-mysql
restore_name=p47-restore-mysql
source_password="$(openssl rand -hex 24)"
restore_password="$(openssl rand -hex 24)"

log() {
    printf '%s\n' "$1"
    printf '%s\n' "$1" >> "$report"
}
cleanup() {
    local name
    for name in "${containers[@]}"; do docker rm -f "$name" >/dev/null 2>&1 || true; done
    for name in "${networks[@]}"; do docker network rm "$name" >/dev/null 2>&1 || true; done
    unset source_password restore_password
}
trap cleanup EXIT
check_resources() {
    local memory_kb disk_kb
    memory_kb="$(awk '/MemAvailable:/ {print $2}' /proc/meminfo)"
    disk_kb="$(df -Pk "$RUNNER_TEMP" | awk 'NR==2 {print $4}')"
    log "Resource guard: MemAvailable=$((memory_kb / 1024)) MiB; runner-temp-free=$((disk_kb / 1024)) MiB."
    if (( memory_kb < 2 * 1024 * 1024 )); then log 'NO-GO: available memory fell below 2 GiB.'; return 1; fi
    if (( disk_kb < 2 * 1024 * 1024 )); then log 'NO-GO: runner temporary storage fell below 2 GiB.'; return 1; fi
}
mysql_ready() {
    local container="$1" password="$2" attempt
    for attempt in $(seq 1 90); do
        if docker exec -e MYSQL_PWD="$password" "$container" mysqladmin ping -h 127.0.0.1 -uroot --silent >/dev/null 2>&1; then return 0; fi
        sleep 2
    done
    echo 'MySQL did not become ready in the isolated P47 fixture.' >&2
    return 1
}
mysql_exec() {
    local container="$1" password="$2"
    shift 2
    docker exec -e MYSQL_PWD="$password" "$container" mysql --protocol=socket -uroot --default-character-set=utf8mb4 "$@"
}
fpm_image() { printf 'srd-p47-%s-fpm:ci' "$1"; }
nginx_image() { printf 'srd-p47-%s-nginx:ci' "$1"; }
remove_container() { docker rm -f "$1" >/dev/null 2>&1 || true; }

app_env=(
    -e APP_ENV=production -e APP_DEBUG=false
    -e APP_KEY=base64:MTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTI=
    -e APP_URL=http://localhost -e LOG_CHANNEL=stderr
    -e CACHE_STORE=file -e SESSION_DRIVER=file -e QUEUE_CONNECTION=sync -e MAIL_MAILER=log
    -e DB_CONNECTION=mysql -e DB_HOST=p47-source-mysql -e DB_PORT=3306 -e DB_USERNAME=root
    -e REVERB_APP_ID=p47-fixture -e REVERB_APP_KEY=p47synthetickey20261104
    -e REVERB_APP_SECRET=p47syntheticsecret20261104 -e REVERB_HOST=chat-reverb
    -e REVERB_ALLOWED_ORIGIN=localhost
)

build_service() {
    local service="$1" fpm nginx
    fpm="$(fpm_image "$service")"; nginx="$(nginx_image "$service")"
    log "Build: $service PHP-FPM candidate."
    docker build --pull --build-arg SERVICE="$service" \
        --build-arg SRD_BACKEND_REVISION="$P47_BACKEND_SHA" \
        --build-arg SRD_DATABASE_REVISION="$P47_DATABASE_SHA" \
        --build-arg SRD_INFRA_REVISION="$P47_INFRA_SHA" \
        -f "$P47_ASSEMBLED/docker/php-production-fpm.Dockerfile" -t "$fpm" "$P47_ASSEMBLED"
    test "$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$fpm")" = "$P47_BACKEND_SHA"
    test "$(docker image inspect --format '{{ index .Config.Labels "io.srd.database.revision" }}' "$fpm")" = "$P47_DATABASE_SHA"
    test "$(docker image inspect --format '{{ index .Config.Labels "io.srd.infra.revision" }}' "$fpm")" = "$P47_INFRA_SHA"
    log "Build: $service candidate Nginx."
    docker build --pull --build-arg SERVICE="$service" \
        --build-arg SRD_BACKEND_REVISION="$P47_BACKEND_SHA" \
        --build-arg SRD_INFRA_REVISION="$P47_INFRA_SHA" \
        -f "$P47_ASSEMBLED/docker/nginx-service-fpm.Dockerfile" -t "$nginx" "$P47_ASSEMBLED"
    log "PASS: $service FPM and Nginx images built from pinned sources with verified provenance labels."
}
migrate_service() {
    local service="$1" database="srd_$1" log_file="$work/migrate-$1.log" count
    if [[ "$service" == gateway ]]; then log 'INFO: Gateway has no migrations; its synthetic schema remains empty.'; return 0; fi
    if ! docker run --rm --network p47-source --name "p47-migrate-$service" \
        "${app_env[@]}" -e DB_DATABASE="$database" -e DB_PASSWORD="$source_password" \
        "$(fpm_image "$service")" php artisan migrate --force --no-interaction --no-ansi >"$log_file" 2>&1; then
        sed "s/$source_password/[REDACTED]/g" "$log_file" | tail -n 60 >&2
        return 1
    fi
    count="$(mysql_exec "$source_name" "$source_password" --batch --skip-column-names --execute "SELECT COUNT(*) FROM $database.migrations")"
    log "PASS: $service applied $count migration rows to synthetic database $database."
}
start_fpm() {
    local service="$1" name="p47-$1-fpm"
    docker run -d --name "$name" --network p47-source --network-alias "$service-fpm" \
        "${app_env[@]}" -e DB_DATABASE="srd_$service" -e DB_PASSWORD="$source_password" \
        "$(fpm_image "$service")" >/dev/null
    containers+=("$name")
}
check_extension() { docker exec "$1" php -m | grep -Fx "$2" >/dev/null; }
http_status_from_nginx() {
    local container="$1" path="$2" output
    output="$(docker exec "$container" sh -c 'wget -S -O /dev/null "http://127.0.0.1:8000$1" 2>&1' sh "$path" 2>&1 || true)"
    printf '%s\n' "$output" | sed -nE 's/.*HTTP\/1\.[01] ([0-9]{3})( .*)?$/\1/p' | tail -n 1
}
test_reverb() {
    local name=p47-chat-reverb
    docker run -d --name "$name" --network p47-source --publish 127.0.0.1:18082:8080 \
        "${app_env[@]}" -e DB_DATABASE=srd_chat -e DB_PASSWORD="$source_password" \
        "$(fpm_image chat)" php artisan reverb:start --host=0.0.0.0 --port=8080 >/dev/null
    containers+=("$name")
    local ready=false attempt
    for attempt in $(seq 1 30); do
        if docker exec "$name" php -r '$s=@fsockopen("127.0.0.1",8080,$e,$m,1); if(!$s){exit(1);} fclose($s);' >/dev/null 2>&1; then ready=true; break; fi
        sleep 1
    done
    test "$ready" = true
    node <<'NODE'
const net = require('node:net');
const crypto = require('node:crypto');
const key = crypto.randomBytes(16).toString('base64');
const socket = net.createConnection({ host: '127.0.0.1', port: 18082 });
let data = Buffer.alloc(0), upgraded = false, pingSent = false, done = false;
const timeout = setTimeout(() => fail('WebSocket Pusher ping/pong timed out'), 20000);
function fail(message) { if (done) return; done = true; clearTimeout(timeout); socket.destroy(); console.error(message); process.exitCode = 1; }
function frame(text) {
  const payload = Buffer.from(text), mask = crypto.randomBytes(4);
  const head = payload.length < 126 ? Buffer.from([0x81, 0x80 | payload.length]) : Buffer.from([0x81, 0xfe, payload.length >> 8, payload.length & 255]);
  const body = Buffer.from(payload); for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4];
  return Buffer.concat([head, mask, body]);
}
socket.on('connect', () => {
  socket.write('GET /app/p47synthetickey20261104?protocol=7&client=js&version=8.4.0&flash=false HTTP/1.1\r\nHost: 127.0.0.1:18082\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ' + key + '\r\nSec-WebSocket-Version: 13\r\nOrigin: http://localhost\r\n\r\n');
});
socket.on('error', error => fail('WebSocket connection failed: ' + error.message));
socket.on('data', chunk => {
  if (done) return;
  data = Buffer.concat([data, chunk]);
  if (!upgraded) {
    const end = data.indexOf('\r\n\r\n'); if (end < 0) return;
    const header = data.subarray(0, end).toString('latin1');
    const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    const acceptHeader = header.match(/^sec-websocket-accept:\s*(.+)$/im);
    if (!/^HTTP\/1\.1 101\b/m.test(header) || !acceptHeader || acceptHeader[1].trim() !== accept) return fail('Invalid WebSocket upgrade response');
    data = data.subarray(end + 4); upgraded = true;
  }
  while (data.length >= 2) {
    const opcode = data[0] & 0x0f, masked = (data[1] & 0x80) !== 0;
    let length = data[1] & 0x7f, offset = 2;
    if (length === 126) { if (data.length < 4) return; length = data.readUInt16BE(2); offset = 4; }
    else if (length === 127) { if (data.length < 10) return; const big = data.readBigUInt64BE(2); if (big > 65536n) return fail('Unexpected oversized WebSocket frame'); length = Number(big); offset = 10; }
    let mask; if (masked) { if (data.length < offset + 4) return; mask = data.subarray(offset, offset + 4); offset += 4; }
    if (data.length < offset + length) return;
    const payload = Buffer.from(data.subarray(offset, offset + length)); data = data.subarray(offset + length);
    if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    if (opcode === 8) return fail('WebSocket closed before Pusher pong');
    if (opcode === 9) { socket.write(Buffer.from([0x8a, 0x80, 1, 2, 3, 4])); continue; }
    if (opcode !== 1) continue;
    let event; try { event = JSON.parse(payload.toString('utf8')).event; } catch { continue; }
    if (event === 'pusher:connection_established' && !pingSent) { pingSent = true; socket.write(frame(JSON.stringify({ event: 'pusher:ping', data: {} }))); }
    if (event === 'pusher:pong') { done = true; clearTimeout(timeout); socket.end(); console.log('PASS: Pusher WebSocket upgrade and application ping/pong.'); return; }
  }
});
NODE
    log 'PASS: Reverb completed a Pusher WebSocket upgrade, established event, and application ping/pong; acceptance was not based on TCP alone.'
    remove_container "$name"
}
runtime_service() {
    local service="$1" fpm_name="p47-$1-fpm" nginx_name="p47-$1-nginx" status module
    start_fpm "$service"
    docker exec "$fpm_name" php-fpm -t >/dev/null
    for module in pdo_mysql mbstring zip bcmath pcntl; do check_extension "$fpm_name" "$module"; done
    case "$service" in gateway) check_extension "$fpm_name" curl ;; records|files) check_extension "$fpm_name" gd ;; esac
    if [[ "$service" == files ]]; then check_extension "$fpm_name" exif; fi
    test -z "$(docker port "$fpm_name" 9000/tcp || true)"
    docker run -d --name "$nginx_name" --network p47-source \
        "$(nginx_image "$service")" >/dev/null
    containers+=("$nginx_name")
    docker exec "$nginx_name" nginx -t >/dev/null
    docker exec "$fpm_name" php artisan --version --no-ansi >/dev/null
    status=''
    for attempt in $(seq 1 45); do
        status="$(http_status_from_nginx "$nginx_name" /up)"
        [[ "$status" == 200 ]] && break
        sleep 2
    done
    if [[ "$status" != 200 ]]; then
        echo "HTTP /up did not return 200 for $service through candidate Nginx/FPM." >&2
        docker logs "$fpm_name" 2>&1 | sed "s/$source_password/[REDACTED]/g" | tail -n 30 >&2 || true
        docker logs "$nginx_name" 2>&1 | tail -n 30 >&2 || true
        return 1
    fi
    test "$(http_status_from_nginx "$nginx_name" /.env)" = 403
    test "$(http_status_from_nginx "$nginx_name" /index.php/secret)" = 404
    if [[ -s "$P47_ASSEMBLED/services/$service/public/robots.txt" ]]; then
        test "$(http_status_from_nginx "$nginx_name" /robots.txt)" = 200
    fi
    log "PASS: $service PHP-FPM/Nginx: FPM config, extensions, Nginx config, /up HTTP 200, path guards, static robots where present, host FastCGI unpublished."
    remove_container "$nginx_name"
    remove_container "$fpm_name"
}
run_scheduler_cycle() {
    local service="$1" log_file="$work/scheduler-$1.log"
    if ! docker run --rm --network p47-source --name "p47-scheduler-$service" \
        "${app_env[@]}" -e DB_DATABASE="srd_$service" -e DB_PASSWORD="$source_password" \
        "$(fpm_image "$service")" php artisan schedule:run -v --no-ansi >"$log_file" 2>&1; then
        sed "s/$source_password/[REDACTED]/g" "$log_file" | tail -n 60 >&2
        return 1
    fi
    log "PASS: $service scheduler completed one schedule:run cycle against its empty synthetic database."
}

check_resources
docker info >/dev/null
test -s "$P47_ASSEMBLED/compose.production.yaml"
test -s "$P47_ASSEMBLED/docker/php-production-fpm.Dockerfile"
test -s "$P47_ASSEMBLED/docker/nginx-service-fpm.Dockerfile"
grep -F 'fastcgi_param HTTP_AUTHORIZATION $http_authorization;' "$P47_ASSEMBLED/docker/nginx-service-fpm.conf.template" >/dev/null
for forwarded in HTTP_X_FORWARDED_FOR HTTP_X_FORWARDED_HOST HTTP_X_FORWARDED_PROTO HTTP_X_FORWARDED_PORT HTTP_X_REAL_IP; do
    grep -F "fastcgi_param $forwarded " "$P47_ASSEMBLED/docker/nginx-service-fpm.conf.template" >/dev/null
done
log 'PASS: candidate FastCGI configuration forwards authorization and the reviewed X-Forwarded/real-IP headers.'
source_network=p47-source
docker network create --internal "$source_network" >/dev/null
networks+=("$source_network")
docker run -d --name "$source_name" --network "$source_network" --network-alias p47-source-mysql \
    -e MYSQL_ROOT_PASSWORD="$source_password" "$P47_MYSQL_IMAGE" \
    --character-set-server=utf8mb4 --collation-server=utf8mb4_0900_ai_ci >/dev/null
containers+=("$source_name")
mysql_ready "$source_name" "$source_password"
for database in "${databases[@]}"; do
    mysql_exec "$source_name" "$source_password" --execute "CREATE DATABASE $database CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci"
done
log 'PASS: isolated non-persistent MySQL 8.4 fixture started with 11 empty synthetic SRD schemas.'

for service in "${services[@]}"; do
    check_resources
    build_service "$service"
    migrate_service "$service"
    runtime_service "$service"
    if [[ " ${schedulers[*]} " == *" $service "* ]]; then
        docker run --rm --network p47-source --name "p47-schedule-list-$service" \
            "${app_env[@]}" -e DB_DATABASE="srd_$service" -e DB_PASSWORD="$source_password" \
            "$(fpm_image "$service")" php artisan schedule:list --no-ansi >/dev/null
        run_scheduler_cycle "$service"
    fi
    if [[ "$service" == chat ]]; then test_reverb; fi
    if [[ "$service" != gateway && "$service" != records && "$service" != chat ]]; then
        docker image rm "$(nginx_image "$service")" "$(fpm_image "$service")" >/dev/null
    elif [[ "$service" != gateway ]]; then
        docker image rm "$(nginx_image "$service")" >/dev/null
    fi
    check_resources
done

log 'Evaluating FastCGI east-west reachability on an isolated simulation of the shared production Compose internal network.'
shared_network=p47-shared-simulation
docker network create --internal "$shared_network" >/dev/null
networks+=("$shared_network")
for service in gateway records; do
    name="p47-shared-$service"
    docker run -d --name "$name" --network "$shared_network" --network-alias "$service-fpm" \
        "${app_env[@]}" "$(fpm_image "$service")" >/dev/null
    containers+=("$name")
    test -z "$(docker port "$name" 9000/tcp || true)"
done
target_ready=false
for attempt in $(seq 1 30); do
    if docker exec p47-shared-records php -r '$s=@fsockopen("127.0.0.1",9000,$e,$m,2); if(!$s){exit(1);} fclose($s);' >/dev/null 2>&1; then
        target_ready=true
        break
    fi
    sleep 1
done
test "$target_ready" = true
reachable=false
for attempt in $(seq 1 30); do
    if docker exec p47-shared-gateway php -r '$s=@fsockopen("records-fpm",9000,$e,$m,2); if(!$s){exit(1);} fclose($s);' >/dev/null 2>&1; then
        reachable=true
        break
    fi
    sleep 1
done
if [[ "$reachable" == true ]]; then
    log 'RISK CONFIRMED: a sibling on the shared internal network can open Records FastCGI TCP/9000 while 9000 is unpublished to the host. Internal membership alone does not isolate the protocol.'
else
    log 'PASS: simulated shared internal network denied Gateway-to-Records FastCGI TCP/9000.'
fi
remove_container p47-shared-gateway
remove_container p47-shared-records

expected_migrations=72
actual_migrations="$(find "$P47_ASSEMBLED/services" -mindepth 5 -maxdepth 5 -type f -path '*/database/migrations/*.php' | wc -l | tr -d ' ')"
test "$actual_migrations" = "$expected_migrations"
test "$(mysql_exec "$source_name" "$source_password" --batch --skip-column-names --execute "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='srd_gateway'")" = 0
migrated_total=0
for database in "${databases[@]}"; do
    [[ "$database" == srd_gateway ]] && continue
    count="$(mysql_exec "$source_name" "$source_password" --batch --skip-column-names --execute "SELECT COUNT(*) FROM $database.migrations")"
    migrated_total=$((migrated_total + count))
done
test "$migrated_total" -eq "$expected_migrations"
log "PASS: all $expected_migrations canonical Database migrations applied across ten service schemas; Gateway is the empty eleventh schema."

organization=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa
person=11111111-1111-4111-8111-111111111111
user=22222222-2222-4222-8222-222222222222
mysql_exec "$source_name" "$source_password" --execute "
INSERT INTO srd_records.persons (id,organization_id,document_type,document_number,first_names,last_names,status,created_by,created_at,updated_at)
VALUES ('$person','$organization','CC','P47-SYNTHETIC-001','P47 Synthetic','Fixture','active','$user',UTC_TIMESTAMP(),UTC_TIMESTAMP());
INSERT INTO srd_records.person_notes (person_id,organization_id,body,updated_by,updated_at)
VALUES ('$person','$organization','Synthetic P47 note','$user',UTC_TIMESTAMP());
INSERT INTO srd_records.data_authorizations (person_id,organization_id,basis,purpose,captured_by,captured_at)
VALUES ('$person','$organization','P47 synthetic test','Restore integrity only','$user',UTC_TIMESTAMP());
"
blob=0123456789abcdef0123456789abcdef0123456789abcdef
private_root="$work/private"
mkdir -p "$private_root/photos"
printf 'SRD P47 private fixture only\n' > "$private_root/photos/$blob.bin"
file_bytes="$(wc -c < "$private_root/photos/$blob.bin" | tr -d ' ')"
file_sha="$(sha256sum "$private_root/photos/$blob.bin" | awk '{print $1}')"
name_sha="$(printf 'p47-fixture.txt' | sha256sum | awk '{print $1}')"
mysql_exec "$source_name" "$source_password" --execute "
INSERT INTO srd_files.folder_documents
(id,organization_id,folder_id,parent_key,name,name_key,mime,blob_id,bytes,sha256,ready,delete_pending,version,created_by,created_at,updated_at)
VALUES ('33333333-3333-4333-8333-333333333333','$organization',NULL,'00000000-0000-0000-0000-000000000000',
'p47-fixture.txt','$name_sha','text/plain','$blob',$file_bytes,'$file_sha',1,0,1,'$user',UTC_TIMESTAMP(),UTC_TIMESTAMP());
"
log 'PASS: synthetic Records person/note/authorization and Files document/private object inserted under the migrated application schemas.'

backup="$work/backup"
mkdir -p "$backup"
for database in "${databases[@]}"; do
    docker exec -e MYSQL_PWD="$source_password" "$source_name" \
        mysqldump --protocol=socket -uroot --single-transaction --quick --routines --events --triggers \
        --databases "$database" >> "$backup/mysql.sql"
done
age-keygen -o "$work/age-identity.txt" 2>/dev/null
age-keygen -y "$work/age-identity.txt" > "$work/recipient.txt"
printf 'APP_ENV=synthetic\nDB_DATABASE=fixture-only\nSRD_BACKUP_FIXTURE=true\n' > "$work/env.production"
age -R "$work/recipient.txt" -o "$backup/mysql.sql.age" "$backup/mysql.sql"
tar -C "$private_root" -cf - . | age -R "$work/recipient.txt" -o "$backup/files.tar.age"
age -R "$work/recipient.txt" -o "$backup/env.production.age" "$work/env.production"
(
    cd "$backup"
    sha256sum mysql.sql.age files.tar.age env.production.age > SHA256SUMS
    sha256sum --check SHA256SUMS
)
rm -f "$backup/mysql.sql"
log 'PASS: created encrypted mysqldump, private-files tar and synthetic environment using an ephemeral age identity and SHA-256 manifest.'

restore_network=p47-restore
docker network create --internal "$restore_network" >/dev/null
networks+=("$restore_network")
docker run -d --name "$restore_name" --network "$restore_network" --network-alias p47-restore-mysql \
    -e MYSQL_ROOT_PASSWORD="$restore_password" "$P47_MYSQL_IMAGE" \
    --character-set-server=utf8mb4 --collation-server=utf8mb4_0900_ai_ci >/dev/null
containers+=("$restore_name")
mysql_ready "$restore_name" "$restore_password"
restore_dir="$work/restore"
mkdir -p "$restore_dir/private"
(cd "$backup" && sha256sum --check SHA256SUMS)
age -d -i "$work/age-identity.txt" -o "$restore_dir/mysql.sql" "$backup/mysql.sql.age"
age -d -i "$work/age-identity.txt" -o "$restore_dir/files.tar" "$backup/files.tar.age"
age -d -i "$work/age-identity.txt" -o "$restore_dir/env.production" "$backup/env.production.age"
grep -qx 'APP_ENV=synthetic' "$restore_dir/env.production"
grep -qx 'SRD_BACKUP_FIXTURE=true' "$restore_dir/env.production"
tar -xf "$restore_dir/files.tar" -C "$restore_dir/private"
docker exec -i -e MYSQL_PWD="$restore_password" "$restore_name" mysql --protocol=socket -uroot --default-character-set=utf8mb4 < "$restore_dir/mysql.sql"
test "$(mysql_exec "$restore_name" "$restore_password" --batch --skip-column-names --execute "SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name LIKE 'srd!_%' ESCAPE '!'")" = 11

schema_inventory() {
    mysql_exec "$1" "$2" --batch --skip-column-names --execute \
      "SELECT CONCAT(table_schema,'.',table_name) FROM information_schema.tables WHERE table_schema LIKE 'srd!_%' ESCAPE '!' ORDER BY table_schema,table_name"
}
column_inventory() {
    mysql_exec "$1" "$2" --batch --skip-column-names --execute \
      "SELECT CONCAT(table_schema,'.',table_name,'.',column_name,'|',column_type,'|',is_nullable,'|',COALESCE(column_default,'<NULL>'),'|',extra) FROM information_schema.columns WHERE table_schema LIKE 'srd!_%' ESCAPE '!' ORDER BY table_schema,table_name,ordinal_position"
}
index_inventory() {
    mysql_exec "$1" "$2" --batch --skip-column-names --execute \
      "SELECT CONCAT(table_schema,'.',table_name,'.',index_name,'|',seq_in_index,'|',COALESCE(column_name,'<NULL>'),'|',non_unique,'|',index_type) FROM information_schema.statistics WHERE table_schema LIKE 'srd!_%' ESCAPE '!' ORDER BY table_schema,table_name,index_name,seq_in_index"
}
foreign_key_inventory() {
    mysql_exec "$1" "$2" --batch --skip-column-names --execute \
      "SELECT CONCAT(constraint_schema,'.',table_name,'.',constraint_name,'|',referenced_table_schema,'.',referenced_table_name) FROM information_schema.referential_constraints WHERE constraint_schema LIKE 'srd!_%' ESCAPE '!' ORDER BY constraint_schema,table_name,constraint_name"
}
for kind in schema column index foreign_key; do
    case "$kind" in schema) function=schema_inventory ;; column) function=column_inventory ;; index) function=index_inventory ;; foreign_key) function=foreign_key_inventory ;; esac
    "$function" "$source_name" "$source_password" > "$work/source-$kind.txt"
    "$function" "$restore_name" "$restore_password" > "$work/restore-$kind.txt"
    cmp "$work/source-$kind.txt" "$work/restore-$kind.txt"
done
source_migrations=0; restore_migrations=0
for database in "${databases[@]}"; do
    [[ "$database" == srd_gateway ]] && continue
    source_count="$(mysql_exec "$source_name" "$source_password" --batch --skip-column-names --execute "SELECT COUNT(*) FROM $database.migrations")"
    restored_count="$(mysql_exec "$restore_name" "$restore_password" --batch --skip-column-names --execute "SELECT COUNT(*) FROM $database.migrations")"
    test "$source_count" = "$restored_count"
    source_migrations=$((source_migrations + source_count))
    restore_migrations=$((restore_migrations + restored_count))
done
test "$source_migrations" -eq 72
test "$restore_migrations" -eq 72
record_fixtures="$(mysql_exec "$restore_name" "$restore_password" --batch --skip-column-names --execute \
    "SELECT COUNT(*) FROM srd_records.persons p JOIN srd_records.person_notes n ON n.organization_id=p.organization_id AND n.person_id=p.id JOIN srd_records.data_authorizations a ON a.organization_id=p.organization_id AND a.person_id=p.id WHERE p.id='$person' AND p.organization_id='$organization'")"
test "$record_fixtures" = 1
restore_file_sha="$(mysql_exec "$restore_name" "$restore_password" --batch --skip-column-names --execute \
    "SELECT sha256 FROM srd_files.folder_documents WHERE id='33333333-3333-4333-8333-333333333333' AND blob_id='$blob' AND ready=1")"
test "$restore_file_sha" = "$file_sha"
test "$(sha256sum "$restore_dir/private/photos/$blob.bin" | awk '{print $1}')" = "$restore_file_sha"
if mysql_exec "$restore_name" "$restore_password" --execute \
    "INSERT INTO srd_records.person_notes (person_id,organization_id,body,updated_by,updated_at) VALUES ('99999999-9999-4999-8999-999999999999','$organization','orphan','$user',UTC_TIMESTAMP())" >/dev/null 2>&1; then
    echo 'The restored composite Records foreign key accepted an orphan note.' >&2
    exit 1
fi
log 'PASS: fresh MySQL restore matched 11 schemas, table/column/index/FK inventories and all 72 migration rows.'
log 'PASS: Records synthetic person, note, authorization relation and orphan-FK rejection survived restore.'
log 'PASS: Files private object bytes, metadata SHA-256 and restored folder_documents row agree.'
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    {
        echo '## P47 runtime and migrated-schema restore'
        echo '- All 11 PHP-FPM/Nginx service images were built sequentially and probed over HTTP /up.'
        echo '- Nine schedulers were inventoried and one isolated synthetic scheduler cycle was executed per scheduler.'
        echo '- Chat Reverb was validated with a Pusher WebSocket upgrade and application ping/pong.'
        echo '- MySQL 8.4 applied all 72 canonical migrations; encrypted operational-format backup restored to clean MySQL 8.4.'
        echo '- Schema inventories, migration rows, Records relational fixtures, Files object SHA-256 and negative FK case matched.'
        echo '- Only synthetic QA data and an ephemeral age identity were used. Production Compose/runtime and VPS were not modified.'
    } >> "$GITHUB_STEP_SUMMARY"
fi
log "PASS: P47 ephemeral runtime and migrated-schema restore checks completed in $((SECONDS - started)) seconds."
printf '\nElapsed runner seconds: %s\n' "$((SECONDS - started))" >> "$report"
sha256sum "$report" > "$artifact_dir/SHA256SUMS-P47-RUNNER.txt"
