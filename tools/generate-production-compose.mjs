import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = JSON.parse(fs.readFileSync(path.join(root, 'compose.yaml'), 'utf8'));
const production = structuredClone(source);
production.name = 'srd-production';

delete production.services.mailpit;
delete production.services['web-tls'];
delete production.networks.local_access;
production.networks.edge = {};
production.networks.smtp_egress = {};
production.volumes.caddy_data = {};
production.volumes.caddy_config = {};

for (const [name, service] of Object.entries(production.services)) {
  if (service.build?.dockerfile === 'docker/php.Dockerfile' || service.build?.dockerfile === 'docker/files.Dockerfile') {
    service.build.dockerfile = 'docker/php-production.Dockerfile';
    if (!name.endsWith('-scheduler')) service.image = `srd-${name}:production`;
  }
  if (service.environment?.APP_ENV) {
    service.environment.APP_ENV = 'production';
    service.environment.APP_DEBUG = 'false';
  }
  if (service.environment?.APP_URL) service.environment.APP_URL = 'https://${SRD_DOMAIN:?Define SRD_DOMAIN}';
  if (service.environment?.PUBLIC_URL) service.environment.PUBLIC_URL = 'https://${SRD_DOMAIN:?Define SRD_DOMAIN}';
  if (service.environment?.SESSION_SECURE_COOKIE) service.environment.SESSION_SECURE_COOKIE = 'true';
  if (service.environment?.MAIL_HOST) {
    service.environment.MAIL_HOST = '${SMTP_HOST:?Define SMTP_HOST}';
    service.environment.MAIL_PORT = '${SMTP_PORT:-587}';
    service.environment.MAIL_SCHEME = '${SMTP_SCHEME:-smtp}';
    service.environment.MAIL_USERNAME = '${SMTP_USERNAME:?Define SMTP_USERNAME}';
    service.environment.MAIL_PASSWORD = '${SMTP_PASSWORD:?Define SMTP_PASSWORD}';
    service.environment.MAIL_FROM_ADDRESS = '${SMTP_FROM_ADDRESS:?Define SMTP_FROM_ADDRESS}';
    service.environment.MAIL_FROM_NAME = 'SRD';
  }
  if (service.environment?.REVERB_APP_ID) service.environment.REVERB_APP_ID = '${REVERB_APP_ID:?Define REVERB_APP_ID}';
  if (service.environment?.REVERB_APP_KEY) service.environment.REVERB_APP_KEY = '${REVERB_APP_KEY:?Define REVERB_APP_KEY}';
  if (name.endsWith('-scheduler')) {
    const parent = name.slice(0, -'-scheduler'.length);
    service.image = `srd-${parent}:production`;
    delete service.build;
    service.user = 'www-data';
  }
}

production.services.web.build.dockerfile = 'docker/web-production.Dockerfile';
delete production.services.web.ports;
production.services.web.networks = ['internal'];
production.services['chat-reverb'].image = 'srd-chat:production';
production.services['chat-reverb'].depends_on = { chat: { condition: 'service_healthy' } };
production.services['chat-reverb'].environment.REVERB_ALLOWED_ORIGIN = '${SRD_DOMAIN:?Define SRD_DOMAIN}';
production.services.identity.networks.push('smtp_egress');
production.services['identity-scheduler'].networks.push('smtp_egress');

production.services.caddy = {
  image: 'caddy:2@sha256:685ae3d7c34d9b5f8caeddc5d14051db7bbd88ff1f5a2fa0c16bd8ca328fb7af',
  restart: 'unless-stopped',
  ports: ['80:80', '443:443'],
  environment: { SRD_DOMAIN: '${SRD_DOMAIN:?Define SRD_DOMAIN}' },
  volumes: [
    './docker/Caddyfile.production:/etc/caddy/Caddyfile:ro',
    'caddy_data:/data',
    'caddy_config:/config',
  ],
  networks: ['edge', 'internal'],
  depends_on: { web: { condition: 'service_started' } },
};

production.services.turn = {
  image: 'coturn/coturn:4.18.0-r0-alpine@sha256:c29135c08565810d37053f384584392b7c24b69570fc81a721b878d6fe63e04e',
  restart: 'unless-stopped',
  network_mode: 'host',
  volumes: ['./.turnserver.conf:/etc/coturn/turnserver.conf:ro'],
  healthcheck: {
    test: ['CMD', 'turnutils_stunclient', '-p', '3478', '144.91.126.25'],
    interval: '30s', timeout: '5s', retries: 3, start_period: '20s',
  },
};

for (const [name, service] of Object.entries(production.services)) {
  service.logging = { driver: 'local', options: { 'max-size': '10m', 'max-file': '3' } };
  if (name === 'caddy') continue;
  service.restart = 'unless-stopped';
  if (service.ports?.length) throw new Error(`Puerto público inesperado: ${name}`);
  if (service.network_mode && !(name === 'turn' && service.network_mode === 'host')) throw new Error(`Red host inesperada: ${name}`);
  if (service.environment?.APP_ENV === 'local') throw new Error(`Servicio local en producción: ${name}`);
}

fs.writeFileSync(path.join(root, 'compose.production.yaml'), JSON.stringify(production, null, 2) + '\n');
console.log(`Compose de producción generado: ${Object.keys(production.services).length} servicios`);
