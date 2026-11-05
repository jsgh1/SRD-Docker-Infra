#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

: "${P47_APP_ROLLBACK_SMOKE:?This is an isolated GitHub Actions fixture only}"
: "${P47_BACKEND_SHA:?current Backend SHA required}"
: "${P47_BACKEND_BASE_SHA:?earlier Backend SHA required}"
: "${P47_INFRA_SHA:?Infra SHA required}"
: "${P47_CURRENT_ASSEMBLED:?current assembled workspace required}"
: "${P47_BASE_ASSEMBLED:?earlier assembled workspace required}"

artifact_dir="$RUNNER_TEMP/p47-artifacts"
report="$artifact_dir/FASE-P47-APP-ROLLBACK-SMOKE.md"
mkdir -p "$artifact_dir"
printf '# P47 isolated SRD application rollback smoke evidence\n\n' > "$report"
containers=(p47-rollback-fpm p47-rollback-nginx)
network=p47-rollback
cleanup() {
    docker rm -f "${containers[@]}" >/dev/null 2>&1 || true
    docker network rm "$network" >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker network create --internal "$network" >/dev/null

build_candidate() {
    local revision="$1" workspace="$2" tag="$3"
    docker build --pull --build-arg SERVICE=gateway \
        --build-arg SRD_BACKEND_REVISION="$revision" \
        --build-arg SRD_DATABASE_REVISION=a96fc6e40e18c19adb6588362f53fb0c8bce5e33 \
        --build-arg SRD_INFRA_REVISION="$P47_INFRA_SHA" \
        -f "$workspace/docker/php-production-fpm.Dockerfile" \
        -t "srd-p47-gateway-fpm:$tag" "$workspace"
    test "$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "srd-p47-gateway-fpm:$tag")" = "$revision"
    test "$(docker image inspect --format '{{ index .Config.Labels "io.srd.database.revision" }}' "srd-p47-gateway-fpm:$tag")" = a96fc6e40e18c19adb6588362f53fb0c8bce5e33
    test "$(docker image inspect --format '{{ index .Config.Labels "io.srd.infra.revision" }}' "srd-p47-gateway-fpm:$tag")" = "$P47_INFRA_SHA"
    docker build --pull --build-arg SERVICE=gateway \
        --build-arg SRD_BACKEND_REVISION="$revision" \
        --build-arg SRD_INFRA_REVISION="$P47_INFRA_SHA" \
        -f "$workspace/docker/nginx-service-fpm.Dockerfile" \
        -t "srd-p47-gateway-nginx:$tag" "$workspace"
}
build_candidate "$P47_BACKEND_BASE_SHA" "$P47_BASE_ASSEMBLED" earlier
base_fpm=srd-p47-gateway-fpm:earlier
base_nginx=srd-p47-gateway-nginx:earlier
current_fpm=srd-p47-gateway-fpm:ci
current_nginx=srd-p47-gateway-nginx:ci
base_id="$(docker image inspect --format '{{.Id}}' "$base_fpm")"
current_id="$(docker image inspect --format '{{.Id}}' "$current_fpm")"
test "$base_id" != "$current_id"
test "$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$current_fpm")" = "$P47_BACKEND_SHA"
test "$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$current_nginx")" = "$P47_INFRA_SHA"

run_candidate() {
    local label="$1" fpm="$2" nginx="$3" expected="$4" status='' attempt
    docker rm -f "${containers[@]}" >/dev/null 2>&1 || true
    docker run -d --name p47-rollback-fpm --network "$network" --network-alias gateway-fpm \
        -e APP_ENV=production -e APP_DEBUG=false \
        -e APP_KEY=base64:MTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTI= \
        -e APP_URL=http://localhost -e LOG_CHANNEL=stderr \
        -e CACHE_STORE=file -e SESSION_DRIVER=file -e QUEUE_CONNECTION=sync \
        -e DB_CONNECTION=mysql -e DB_HOST=127.0.0.1 -e DB_DATABASE=srd_gateway \
        -e DB_USERNAME=synthetic -e DB_PASSWORD=synthetic \
        "$fpm" >/dev/null
    docker run -d --name p47-rollback-nginx --network "$network" \
        --publish 127.0.0.1:18083:8000 "$nginx" >/dev/null
    test -z "$(docker port p47-rollback-fpm 9000/tcp || true)"
    for attempt in $(seq 1 45); do
        status="$(curl --silent --show-error --max-time 3 --output "$RUNNER_TEMP/p47-rollback-$label.json" \
            --write-out '%{http_code}' http://127.0.0.1:18083/up 2>/dev/null || true)"
        [[ "$status" == 200 ]] && break
        sleep 2
    done
    if [[ "$status" != 200 ]]; then
        echo "Gateway /up failed during the isolated $label application selection." >&2
        docker logs p47-rollback-fpm 2>&1 | tail -n 30 >&2 || true
        docker logs p47-rollback-nginx 2>&1 | tail -n 30 >&2 || true
        return 1
    fi
    test -s "$RUNNER_TEMP/p47-rollback-$label.json"
    printf '%s\n' "$expected" > "$RUNNER_TEMP/p47-rollback-$label.sha256"
    sha256sum "$RUNNER_TEMP/p47-rollback-$label.json" | awk '{print $1}' >> "$RUNNER_TEMP/p47-rollback-$label.sha256"
}
run_candidate A "$current_fpm" "$current_nginx" "$current_id"
run_candidate B "$base_fpm" "$base_nginx" "$base_id"
run_candidate A-return "$current_fpm" "$current_nginx" "$current_id"
test "$(cat "$RUNNER_TEMP/p47-rollback-A.sha256")" = "$(cat "$RUNNER_TEMP/p47-rollback-A-return.sha256")"
test "$(head -n 1 "$RUNNER_TEMP/p47-rollback-B.sha256")" = "$base_id"
test "$(head -n 1 "$RUNNER_TEMP/p47-rollback-A.sha256")" = "$current_id"
{
    echo "- PASS: real Gateway application images built from Backend $P47_BACKEND_SHA and earlier code revision $P47_BACKEND_BASE_SHA."
    echo '- PASS: selected current image A, earlier image B, then reselected A; FastCGI stayed unpublished and /up returned HTTP 200 each time.'
    echo "- A image ID: $current_id"
    echo "- B image ID: $base_id"
    echo '- Scope limit: health-only Gateway smoke; no writes, migration rollback, user flow, or production deployment. Not full rollback acceptance.'
} >> "$report"
sha256sum "$artifact_dir"/*.md > "$artifact_dir/SHA256SUMS-P47-RUNNER.txt"
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    {
        echo '## P47 application-image rollback smoke'
        echo '- Real Gateway application code was selected A/B/A using two immutable Backend revisions and the same isolated runtime.'
        echo '- HTTP /up returned 200 for each selection and the final A image/body matched the initial A.'
        echo '- No database write or migration rollback was performed; full rollback compatibility remains partial.'
    } >> "$GITHUB_STEP_SUMMARY"
fi
