// Idempotent local composition update for the Notifications service.
import fs from 'node:fs';

const file = 'compose.yaml';
const compose = JSON.parse(fs.readFileSync(file, 'utf8'));
const name = 'notifications';
const key = '${APP_KEY_NOTIFICATIONS:?Ejecuta scripts/Initialize.ps1}';
const password = '${DB_PASSWORD_NOTIFICATIONS:?Ejecuta scripts/Initialize.ps1}';

if (!compose.services[name]) {
  const service = structuredClone(compose.services.calendar);
  service.build.args.SERVICE = name;
  Object.assign(service.environment, {
    APP_NAME: 'SRD-notifications', APP_KEY: key, DB_DATABASE: 'srd_notifications',
    DB_USERNAME: 'srd_notifications', DB_PASSWORD: password,
  });
  delete service.environment.NOTIFICATIONS_URL;
  compose.services[name] = service;
}
if (!compose.services['notifications-scheduler']) {
  const scheduler = structuredClone(compose.services['calendar-scheduler']);
  scheduler.build.args.SERVICE = name;
  Object.assign(scheduler.environment, {
    APP_NAME: 'SRD-notifications', APP_KEY: key, DB_DATABASE: 'srd_notifications',
    DB_USERNAME: 'srd_notifications', DB_PASSWORD: password,
  });
  delete scheduler.environment.NOTIFICATIONS_URL;
  scheduler.depends_on = {
    notifications: { condition: 'service_healthy' },
    audit: { condition: 'service_healthy' },
  };
  compose.services['notifications-scheduler'] = scheduler;
}
compose.services.mysql.environment.DB_PASSWORD_NOTIFICATIONS = password;
compose.services.calendar.environment.NOTIFICATIONS_URL = 'http://notifications:8000';
compose.services['calendar-scheduler'].environment.NOTIFICATIONS_URL = 'http://notifications:8000';
compose.services.gateway.environment.NOTIFICATIONS_URL = 'http://notifications:8000';
fs.writeFileSync(file, JSON.stringify(compose, null, 2) + '\n');
console.log('Notifications services and local database declared.');
