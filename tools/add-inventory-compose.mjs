import fs from 'node:fs';

const file = 'compose.yaml';
const compose = JSON.parse(fs.readFileSync(file, 'utf8'));
const password = '${DB_PASSWORD_INVENTORY:?Ejecuta scripts/Initialize.ps1}';
const appKey = '${APP_KEY_INVENTORY:?Ejecuta scripts/Initialize.ps1}';
compose.services.mysql.environment.DB_PASSWORD_INVENTORY = password;
compose.services.gateway.environment.INVENTORY_URL = 'http://inventory:8000';

if (!compose.services.inventory) {
  const service = structuredClone(compose.services.treasury);
  service.build.args.SERVICE = 'inventory';
  service.environment.APP_NAME = 'SRD-inventory';
  service.environment.APP_KEY = appKey;
  service.environment.DB_DATABASE = 'srd_inventory';
  service.environment.DB_USERNAME = 'srd_inventory';
  service.environment.DB_PASSWORD = password;
  compose.services.inventory = service;
}
if (!compose.services['inventory-scheduler']) {
  const scheduler = structuredClone(compose.services['treasury-scheduler']);
  scheduler.build.args.SERVICE = 'inventory';
  scheduler.environment.APP_NAME = 'SRD-inventory';
  scheduler.environment.APP_KEY = appKey;
  scheduler.environment.DB_DATABASE = 'srd_inventory';
  scheduler.environment.DB_USERNAME = 'srd_inventory';
  scheduler.environment.DB_PASSWORD = password;
  delete scheduler.depends_on.treasury;
  scheduler.depends_on.inventory = { condition: 'service_healthy' };
  compose.services['inventory-scheduler'] = scheduler;
}
fs.writeFileSync(file, JSON.stringify(compose, null, 2) + '\n');
