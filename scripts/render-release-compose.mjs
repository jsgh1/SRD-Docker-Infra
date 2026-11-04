import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const imageServices = {
  gateway: ['gateway'],
  identity: ['identity', 'identity-scheduler'],
  configuration: ['configuration', 'configuration-scheduler'],
  records: ['records', 'records-scheduler'],
  audit: ['audit'],
  files: ['files', 'files-scheduler'],
  calendar: ['calendar', 'calendar-scheduler'],
  notifications: ['notifications', 'notifications-scheduler'],
  treasury: ['treasury', 'treasury-scheduler'],
  inventory: ['inventory', 'inventory-scheduler'],
  chat: ['chat', 'chat-reverb', 'chat-scheduler'],
  web: ['web'],
};

const exactKeys = (value, expected, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
    throw new Error(`${label} must contain exactly: ${required.join(', ')}`);
  }
};

export function renderReleaseCompose(manifest) {
  exactKeys(manifest, ['schemaVersion', 'releaseId', 'sources', 'images'], 'manifest');
  if (manifest.schemaVersion !== 1) throw new Error('schemaVersion must be 1');
  if (typeof manifest.releaseId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(manifest.releaseId)) {
    throw new Error('releaseId must be a short, safe identifier');
  }

  exactKeys(manifest.sources, ['backend', 'database', 'docs', 'frontend', 'infra'], 'sources');
  for (const [name, sha] of Object.entries(manifest.sources)) {
    if (typeof sha !== 'string' || !/^[a-f0-9]{40}$/.test(sha)) {
      throw new Error(`sources.${name} must be a full lowercase Git SHA`);
    }
  }

  exactKeys(manifest.images, Object.keys(imageServices), 'images');
  for (const [name, reference] of Object.entries(manifest.images)) {
    if (typeof reference !== 'string' || !new RegExp('^(?:[a-z0-9.-]+(?::[0-9]+)?/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[a-f0-9]{64}$').test(reference)) {
      throw new Error(`images.${name} must use an immutable sha256 digest reference`);
    }
    const repository = reference.slice(0, reference.indexOf('@')).split('/').at(-1);
    if (repository !== `srd-${name}`) {
      throw new Error(`images.${name} must reference an image named srd-${name}`);
    }
  }

  const lines = [
    `# Generated from SRD release manifest ${manifest.releaseId}; do not edit by hand.`,
    '# Apply with compose.production.yaml and --no-build.',
    'services:',
  ];
  for (const [imageName, services] of Object.entries(imageServices)) {
    for (const service of services) {
      lines.push(`  ${service}:`, `    image: ${manifest.images[imageName]}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  try {
    const manifestPath = process.argv[2];
    if (!manifestPath || process.argv.length !== 3) {
      throw new Error('Usage: node scripts/render-release-compose.mjs <release-manifest.json>');
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    process.stdout.write(renderReleaseCompose(manifest));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
