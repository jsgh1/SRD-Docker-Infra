import fs from 'node:fs';

const file = 'compose.yaml';
const compose = JSON.parse(fs.readFileSync(file, 'utf8'));
const password = '${DB_PASSWORD_TREASURY:?Ejecuta scripts/Initialize.ps1}';
const appKey = '${APP_KEY_TREASURY:?Ejecuta scripts/Initialize.ps1}';
compose.services.mysql.environment.DB_PASSWORD_TREASURY = password;
compose.services.gateway.environment.TREASURY_URL = 'http://treasury:8000';

if (!compose.services.treasury) {
  const service = structuredClone(compose.services.notifications);
  service.build.args.SERVICE = 'treasury';
  service.environment.APP_NAME = 'SRD-treasury';
  service.environment.APP_KEY = appKey;
  service.environment.DB_DATABASE = 'srd_treasury';
  service.environment.DB_USERNAME = 'srd_treasury';
  service.environment.DB_PASSWORD = password;
  compose.services.treasury = service;
}
if (!compose.services['treasury-scheduler']) {
  const scheduler = structuredClone(compose.services['notifications-scheduler']);
  scheduler.build.args.SERVICE = 'treasury';
  scheduler.environment.APP_NAME = 'SRD-treasury';
  scheduler.environment.APP_KEY = appKey;
  scheduler.environment.DB_DATABASE = 'srd_treasury';
  scheduler.environment.DB_USERNAME = 'srd_treasury';
  scheduler.environment.DB_PASSWORD = password;
  delete scheduler.depends_on.notifications;
  scheduler.depends_on.treasury = { condition: 'service_healthy' };
  compose.services['treasury-scheduler'] = scheduler;
}
fs.writeFileSync(file, JSON.stringify(compose, null, 2) + '\n');
