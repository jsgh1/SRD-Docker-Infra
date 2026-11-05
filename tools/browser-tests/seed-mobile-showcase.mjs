import {request} from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

const root = path.resolve(import.meta.dirname, '../..');
const fixture = JSON.parse(fs.readFileSync(path.join(root, '.local/e2e-fixture.json'), 'utf8'));
const gateway = process.env.SRD_TEST_URL || 'http://localhost:8080';
const mailpit = process.env.SRD_MAILPIT_URL || 'http://localhost:8025';
const api = await request.newContext({baseURL: gateway});
const mail = await request.newContext();

async function data(response, label) {
  if (!response.ok()) {
    const detail = label === 'Creación de evento' ? ` ${await response.text()}` : '';
    throw new Error(`${label}: HTTP ${response.status()}${detail}`);
  }
  return (await response.json()).data;
}

try {
  const before = await (await mail.get(`${mailpit}/api/v1/messages`)).json();
  const previous = new Set((before.messages || []).map(message => message.ID));
  const organization = await data(await api.get('/api/v1/organizations/srd-e2e-a'), 'Junta');
  let csrf = (await data(await api.get('/api/v1/csrf'), 'CSRF')).token;
  const challenge = await data(await api.post('/api/v1/auth/login', {
    headers: {'X-CSRF-TOKEN': csrf},
    data: {email: fixture.users.admin.email, password: fixture.password, organization_code: organization.code,
      accepted: true, terms_version_id: organization.terms.id},
  }), 'Acceso');

  let message;
  for (let attempt = 0; attempt < 20; attempt++) {
    const inbox = await (await mail.get(`${mailpit}/api/v1/messages`)).json();
    message = (inbox.messages || []).find(item => !previous.has(item.ID)
      && item.To.some(recipient => recipient.Address === fixture.users.admin.email));
    if (message) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (!message) throw new Error('No llegó el código MFA al correo local.');
  const content = await (await mail.get(`${mailpit}/api/v1/message/${message.ID}`)).json();
  const code = content.Text.match(/\b\d{6}\b/)?.[0];
  if (!code) throw new Error('El correo local no contiene un código MFA.');
  await data(await api.post('/api/v1/auth/verify', {
    headers: {'X-CSRF-TOKEN': csrf}, data: {challenge_id: challenge.challenge_id, code},
  }), 'Verificación');
  csrf = (await data(await api.get('/api/v1/csrf'), 'CSRF autenticado')).token;

  const fields = await data(await api.get('/api/v1/person-fields'), 'Campos');
  const positions = await data(await api.get('/api/v1/person-positions'), 'Cargos');
  const people = [
    ['SRD-DEMO-001', 'Alba', 'Ejemplo'],
    ['SRD-DEMO-002', 'Bruno', 'Ejemplo'],
    ['SRD-DEMO-003', 'Celia', 'Ejemplo'],
    ['SRD-DEMO-004', 'Daniela', 'Muestra'],
    ['SRD-DEMO-005', 'Ernesto', 'Muestra'],
    ['SRD-DEMO-006', 'Fabiana', 'Muestra'],
    ['SRD-DEMO-007', 'Gustavo', 'Ejemplo'],
    ['SRD-DEMO-008', 'Helena', 'Ejemplo'],
  ];
  let createdPeople = 0;
  for (const [number, first, last] of people) {
    const existing = await data(await api.get(`/api/v1/persons/lookup?document_type=CC&document_number=${number}`), 'Consulta de persona');
    if (!Array.isArray(existing) || existing.length !== 0) continue;
    await data(await api.post('/api/v1/persons', {
      headers: {'X-CSRF-TOKEN': csrf},
      data: {document_type: 'CC', document_number: number, first_names: first, last_names: last,
        status: 'pending', authorization_basis: 'Demostración local con datos ficticios',
        authorization_purpose: 'Mostrar las pantallas de SRD durante la exposición',
        schema_version: fields.version, positions_version: positions.version, custom_values: {}},
    }), 'Creación de persona');
    createdPeople++;
  }

  const calendar = [
    {title: 'Reunión de coordinación · Demo SRD', titleEn: 'Coordination meeting · SRD demo', type: 'meeting', hours: 3,
      location: 'Salón comunal ficticio', locationEn: 'Fictional community hall',
      description: 'Organización de actividades de la junta de prueba.',
      descriptionEn: 'Organizing activities for the sample council.'},
    {title: 'Jornada de registro · Demo SRD', titleEn: 'Registration day · SRD demo', type: 'activity', hours: 28,
      location: 'Punto de atención ficticio', locationEn: 'Fictional service point',
      description: 'Presentación del flujo de registro digital.',
      descriptionEn: 'Demonstration of the digital registration flow.'},
    {title: 'Asamblea comunitaria · Demo SRD', titleEn: 'Community assembly · SRD demo', type: 'meeting', hours: 20,
      location: 'Auditorio de prueba', locationEn: 'Sample auditorium',
      description: 'Revisión de proyectos y participación comunitaria.',
      descriptionEn: 'Review of projects and community participation.'},
    {title: 'Capacitación digital · Demo SRD', titleEn: 'Digital training · SRD demo', type: 'activity', hours: 44,
      location: 'Aula de prueba', locationEn: 'Sample classroom',
      description: 'Introducción al uso del sistema de registro.',
      descriptionEn: 'Introduction to the registration system.'},
  ];
  let createdEvents = 0;
  for (const event of calendar) {
    const search = await data(await api.get(`/api/v1/calendar-events/search?q=${encodeURIComponent(event.title)}`), 'Búsqueda de evento');
    if ((search.items || []).some(item => item.title === event.title && item.state !== 'cancelled')) continue;
    const starts = new Date(Date.now() + event.hours * 3_600_000);
    const ends = new Date(starts.getTime() + 3_600_000);
    await data(await api.post('/api/v1/calendar-events', {
      headers: {'X-CSRF-TOKEN': csrf},
      data: {type: event.type, title: event.title, title_en: event.titleEn,
        location: event.location, location_en: event.locationEn,
        description: event.description, description_en: event.descriptionEn,
        starts_at: starts.toISOString().replace(/\.\d{3}Z$/, '+00:00'),
        ends_at: ends.toISOString().replace(/\.\d{3}Z$/, '+00:00'), participants: []},
    }), 'Creación de evento');
    createdEvents++;
  }

  const dashboard = await data(await api.get('/api/v1/dashboard'), 'Resumen');
  const today = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date()).map(part => [part.type, part.value]));
  const effectiveDate = `${today.year}-${today.month}-${today.day}`;
  let treasury = await data(await api.get('/api/v1/treasury'), 'Tesorería');
  if (!treasury.opened) {
    await data(await api.post('/api/v1/treasury/opening', {
      headers: {'X-CSRF-TOKEN': csrf},
      data: {amount: '0.00', effective_date: effectiveDate, concept: 'Apertura ficticia · Demo SRD',
        support_note: 'Datos de prueba para exposición local', idempotency_key: randomUUID()},
    }), 'Apertura de tesorería');
  }
  let createdMovements = 0;
  for (const movement of [
    {kind: 'income', amount: '1250000.00', concept: 'Aporte comunitario ficticio · Demo SRD'},
    {kind: 'expense', amount: '185000.00', concept: 'Materiales de jornada ficticia · Demo SRD'},
  ]) {
    const found = await data(await api.get(`/api/v1/treasury?q=${encodeURIComponent(movement.concept)}`), 'Consulta de tesorería');
    if (found.items.some(item => item.concept === movement.concept)) continue;
    await data(await api.post('/api/v1/treasury/movements', {
      headers: {'X-CSRF-TOKEN': csrf},
      data: {...movement, effective_date: effectiveDate,
        support_note: 'Registro de muestra; no representa dinero real', idempotency_key: randomUUID()},
    }), 'Movimiento de tesorería');
    createdMovements++;
  }
  treasury = await data(await api.get('/api/v1/treasury'), 'Resumen de tesorería');

  let createdAssets = 0;
  const assets = [
    {code: 'SRD-DEMO-SILLAS', name: 'Sillas para reuniones', name_en: 'Meeting chairs',
      category: 'Mobiliario', category_en: 'Furniture', quantity: 36,
      location: 'Salón comunal ficticio', location_en: 'Fictional community hall'},
    {code: 'SRD-DEMO-PROYECTOR', name: 'Proyector de actividades', name_en: 'Activity projector',
      category: 'Equipo', category_en: 'Equipment', quantity: 1,
      location: 'Bodega ficticia', location_en: 'Fictional storage room'},
    {code: 'SRD-DEMO-MESAS', name: 'Mesas de atención', name_en: 'Service tables',
      category: 'Mobiliario', category_en: 'Furniture', quantity: 6,
      location: 'Punto de atención ficticio', location_en: 'Fictional service point'},
  ];
  for (const asset of assets) {
    const existing = await data(await api.get(`/api/v1/assets?q=${asset.code}`), 'Consulta de inventario');
    if (existing.items.some(item => item.code === asset.code)) continue;
    await data(await api.post('/api/v1/assets', {
      headers: {'X-CSRF-TOKEN': csrf},
      data: {...asset, type: 'movable', condition: 'Bueno', condition_en: 'Good',
        unit: 'unidad', unit_en: 'unit', description: 'Bien ficticio para la exposición de SRD.',
        description_en: 'Fictional asset for the SRD presentation.', idempotency_key: randomUUID()},
    }), 'Alta de inventario');
    createdAssets++;
  }
  const inventory = await data(await api.get('/api/v1/assets'), 'Resumen de inventario');
  console.log(`Semilla lista: ${createdPeople} personas, ${createdEvents} eventos, ${createdMovements} movimientos y ${createdAssets} bienes nuevos.`);
  console.log(`Junta de prueba: ${dashboard.total} personas; tesorería ${treasury.total} movimientos; inventario ${inventory.total} bienes.`);
} finally {
  await api.dispose();
  await mail.dispose();
}
