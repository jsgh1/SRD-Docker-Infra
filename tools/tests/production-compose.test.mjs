import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const config = JSON.parse(fs.readFileSync(path.join(root, 'compose.production.yaml'), 'utf8'));
const productionPhpDockerfile = fs.readFileSync(path.join(root, 'docker/php-production.Dockerfile'), 'utf8');
const productionWebDockerfile = fs.readFileSync(path.join(root, 'docker/web-production.Dockerfile'), 'utf8');
const caddyfile = fs.readFileSync(path.join(root, 'docker/Caddyfile.production'), 'utf8');

test('production PHP image builds dependencies separately and runs pinned Apache without Composer', () => {
  const runtimeStart = productionPhpDockerfile.indexOf(' AS runtime');
  assert.ok(runtimeStart > 0, 'runtime stage must be explicit');
  const builder = productionPhpDockerfile.slice(0, runtimeStart);
  const runtime = productionPhpDockerfile.slice(runtimeStart);
  assert.match(builder, /^FROM php:8\.4-cli-bookworm@sha256:[a-f0-9]{64} AS build/m);
  assert.match(productionPhpDockerfile, /^FROM php:8\.4-apache-bookworm@sha256:[a-f0-9]{64} AS runtime/m);
  assert.match(builder, /COPY --from=composer \/usr\/bin\/composer/);
  assert.match(builder, /composer install --no-dev/);
  assert.match(runtime, /COPY --from=build \/app \/app/);
  assert.doesNotMatch(runtime, /COPY --from=composer/);
  assert.match(runtime, /apt-get purge -y --auto-remove/);
  assert.doesNotMatch(runtime, /\\\\n/);
  assert.match(runtime, /expose_php=Off/);
  assert.match(runtime, /CMD \["apache2-foreground"\]/);
  assert.match(runtime, /org\.opencontainers\.image\.revision=/);
  assert.match(runtime, /io\.srd\.infra\.revision=/);
  assert.match(runtime, /io\.srd\.database\.revision=/);
  assert.equal((runtime.match(/io\.srd\.database\.revision=/g) ?? []).length, 1);
});

test('production exposes only the HTTPS edge and bounded TURN relay', () => {
  assert.deepEqual(config.services.caddy.ports, ['80:80', '443:443']);
  for (const [name, service] of Object.entries(config.services)) {
    if (name !== 'caddy') assert.equal(service.ports, undefined, `${name} is publicly exposed`);
    if (name !== 'turn') assert.equal(service.network_mode, undefined, `${name} bypasses Docker networks`);
  }
  assert.equal(config.services.turn.network_mode, 'host');
  assert.deepEqual(config.services.turn.volumes, ['./.turnserver.conf:/etc/coturn/turnserver.conf:ro']);
  assert.match(config.services.turn.image, /^coturn\/coturn:4\.18\.0-r0-alpine@sha256:[a-f0-9]{64}$/);
  assert.equal(config.services.gateway.environment.WEBRTC_TURN_SECRET, '${WEBRTC_TURN_SECRET:-}');
  assert.equal(config.services.mailpit, undefined);
  assert.equal(config.services['web-tls'], undefined);
  for (const name of ['mysql_data', 'gateway_sessions', 'files_objects', 'antivirus_signatures', 'caddy_data']) {
    assert.ok(config.volumes[name], `${name} is missing`);
  }
});

test('Laravel services use production runtime and secure external settings', () => {
  for (const [name, service] of Object.entries(config.services)) {
    if (!service.environment?.APP_URL) continue;
    if (name.endsWith('-scheduler')) {
      const parent = name.slice(0, -'-scheduler'.length);
      assert.equal(service.image, config.services[parent].image, name);
      assert.equal(service.user, 'www-data', name);
    } else {
      assert.equal(service.build?.dockerfile, 'docker/php-production.Dockerfile', name);
    }
    assert.equal(service.environment.APP_ENV, 'production', name);
    assert.equal(service.environment.APP_DEBUG, 'false', name);
    assert.equal(service.environment.SESSION_SECURE_COOKIE, 'true', name);
    assert.match(service.environment.APP_URL, /^https:\/\//, name);
    assert.match(service.environment.MAIL_HOST, /^\$\{SMTP_HOST:\?/, name);
  }
  for (const name of ['gateway', 'chat', 'chat-reverb']) {
    assert.equal(config.services[name].environment.REVERB_APP_KEY, '${REVERB_APP_KEY:?Define REVERB_APP_KEY}', name);
    assert.equal(config.services[name].environment.REVERB_APP_SECRET, '${REVERB_APP_SECRET:?Ejecuta scripts/Initialize.ps1}', name);
  }
  assert.equal(config.services.chat.image, config.services['chat-reverb'].image);
  assert.equal(config.services['chat-reverb'].environment.REVERB_ALLOWED_ORIGIN, '${SRD_DOMAIN:?Define SRD_DOMAIN}');
  assert.ok(config.services.identity.networks.includes('smtp_egress'));
  assert.ok(config.services['identity-scheduler'].networks.includes('smtp_egress'));
});

test('TLS edge defers HSTS to the response write and production Nginx replaces the client proto header', () => {
  assert.match(caddyfile, /header >Strict-Transport-Security "max-age=31536000"/);
  assert.doesNotMatch(caddyfile, /header Strict-Transport-Security "max-age=31536000"/);
  assert.match(productionWebDockerfile, /sed -i 's\/X-Forwarded-Proto \\\$scheme\/X-Forwarded-Proto https\/g'/);
  const baseNginxLocations = fs.readFileSync(path.join(root, 'docker/nginx-locations.conf'), 'utf8');
  assert.match(baseNginxLocations, /proxy_set_header X-Forwarded-Proto \$scheme/);
});

test('release overlay includes no secrets and uses a manifest renderer tested separately', () => {
  const renderer = fs.readFileSync(path.join(root, 'scripts/render-release-compose.mjs'), 'utf8');
  assert.match(renderer, /sha256:\[a-f0-9\]\{64\}/);
  assert.match(renderer, /compose\.production\.yaml and --no-build/);
});
