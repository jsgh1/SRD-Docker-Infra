import assert from 'node:assert/strict';
import test from 'node:test';
import { renderReleaseCompose } from '../../scripts/render-release-compose.mjs';

const services = ['gateway', 'identity', 'configuration', 'records', 'audit', 'files', 'calendar', 'notifications', 'treasury', 'inventory', 'chat', 'web'];
const manifest = () => ({
  schemaVersion: 1,
  releaseId: '2026-11-04-a1b2c3d',
  sources: {
    backend: 'a'.repeat(40),
    database: 'd'.repeat(40),
    docs: 'e'.repeat(40),
    frontend: 'b'.repeat(40),
    infra: 'c'.repeat(40),
  },
  images: Object.fromEntries(services.map((name, index) => [
    name,
    `ghcr.io/jsgh1/srd-${name}@sha256:${'0123456789ab'[index].repeat(64)}`,
  ])),
});

test('release overlay is deterministic and pins all first-party production images by digest', () => {
  const input = manifest();
  const output = renderReleaseCompose(input);
  assert.equal(output, renderReleaseCompose(input));
  for (const name of services) assert.ok(output.includes(`srd-${name}@sha256:`), name);
  for (const scheduler of ['identity-scheduler', 'configuration-scheduler', 'records-scheduler', 'files-scheduler', 'calendar-scheduler', 'notifications-scheduler', 'treasury-scheduler', 'inventory-scheduler', 'chat-scheduler', 'chat-reverb']) {
    assert.match(output, new RegExp(`^  ${scheduler}:\\n    image: .*srd-`, 'm'));
  }
});

test('release overlay rejects mutable tags and malformed source identifiers', () => {
  const mutable = manifest();
  mutable.images.gateway = 'ghcr.io/jsgh1/srd-gateway:production';
  assert.throws(() => renderReleaseCompose(mutable), /immutable sha256 digest/);

  const badSource = manifest();
  badSource.sources.backend = 'deadbeef';
  assert.throws(() => renderReleaseCompose(badSource), /full lowercase Git SHA/);
});

test('release overlay rejects missing images and unexpected fields that could carry secrets', () => {
  const missing = manifest();
  delete missing.images.chat;
  assert.throws(() => renderReleaseCompose(missing), /must contain exactly/);

  const withSecret = manifest();
  withSecret.smtpPassword = 'must-not-be-in-a-manifest';
  assert.throws(() => renderReleaseCompose(withSecret), /must contain exactly/);
});

test('release overlay prevents image/service-name confusion', () => {
  const wrongImage = manifest();
  wrongImage.images.gateway = `ghcr.io/jsgh1/srd-identity@sha256:${'d'.repeat(64)}`;
  assert.throws(() => renderReleaseCompose(wrongImage), /must reference an image named srd-gateway/);
});
