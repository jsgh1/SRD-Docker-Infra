import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const config = JSON.parse(fs.readFileSync(path.join(root, 'compose.production.yaml'), 'utf8'));
const productionPhpDockerfile = fs.readFileSync(path.join(root, 'docker/php-production.Dockerfile'), 'utf8');

test('production Apache PHP image does not disclose the PHP runtime version', () => {
  assert.match(productionPhpDockerfile, /^FROM php:8\.4-apache-bookworm/m);
  assert.match(productionPhpDockerfile, /expose_php=Off/);
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
  assert.equal(config.services.chat.image, config.services['chat-reverb'].image);
  assert.equal(config.services['chat-reverb'].environment.REVERB_ALLOWED_ORIGIN, '${SRD_DOMAIN:?Define SRD_DOMAIN}');
  assert.ok(config.services.identity.networks.includes('smtp_egress'));
  assert.ok(config.services['identity-scheduler'].networks.includes('smtp_egress'));
});
