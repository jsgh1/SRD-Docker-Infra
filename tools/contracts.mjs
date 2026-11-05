import fs from "node:fs";
const str = (extra = {}) => ({ type: "string", ...extra }),
  uuid = () => str({ format: "uuid" }),
  obj = (properties, required = Object.keys(properties)) => ({
    type: "object",
    properties,
    required,
  });
const error = obj({
  error: obj({
    code: str(),
    message: str(),
    fields: {
      type: "object",
      additionalProperties: { type: "array", items: str() },
    },
  }),
  correlation_id: uuid(),
});
const envelope = {
  type: "object",
  required: ["data", "meta"],
  properties: { data: {}, meta: obj({ correlation_id: uuid() }) },
};
const response = {
  description: "Resultado confirmado",
  content: { "application/json": { schema: envelope } },
};
const schemas = {
  ChatStart: obj({ user_id: uuid() }),
  ChatMessage: obj({ client_id: uuid(), body: str({ minLength: 1, maxLength: 10000 }) }),
  ChatReceipt: obj({ kind: str({ enum: ['delivered', 'read'] }), message_ids: { type: 'array', minItems: 1, maxItems: 25, uniqueItems: true, items: uuid() } }),
  ChatBroadcastAuth: obj({ socket_id: str({ pattern: '^[0-9]+\\.[0-9]+$' }), channel_name: str({ maxLength: 128 }) }),
  TreasuryOpening: obj({ amount: str({ pattern: '^(0|[1-9][0-9]{0,11})(\\.[0-9]{1,2})?$' }), effective_date: str({ format: 'date' }), concept: str({ minLength: 3, maxLength: 500 }), support_note: str({ maxLength: 500 }), idempotency_key: uuid() }, ['amount','effective_date','concept','idempotency_key']),
  TreasuryMovement: obj({ kind: str({ enum: ['income','expense'] }), amount: str({ pattern: '^(0|[1-9][0-9]{0,11})(\\.[0-9]{1,2})?$', description: 'Mayor que cero; validación estricta en el servicio.' }), effective_date: str({ format: 'date' }), concept: str({ minLength: 3, maxLength: 500 }), support_note: str({ maxLength: 500 }), idempotency_key: uuid() }, ['kind','amount','effective_date','concept','idempotency_key']),
  TreasuryReversal: obj({ reason: str({ minLength: 10, maxLength: 500 }), idempotency_key: uuid() }),
  InventoryAsset: obj({ code: str({ minLength: 2, maxLength: 40, pattern: '^[A-Za-z0-9._-]+$' }), type: str({ enum: ['real_estate','movable'] }), name: str({ minLength: 2, maxLength: 160 }), category: str({ maxLength: 80 }), unit: str({ maxLength: 40 }), description: str({ maxLength: 5000 }), location: str({ minLength: 2, maxLength: 180 }), condition: str({ minLength: 2, maxLength: 80 }), responsible_name: str({ maxLength: 120 }), quantity: { type: 'integer', minimum: 0, maximum: 1000000000 }, idempotency_key: uuid() }, ['code','type','name','location','condition','quantity','idempotency_key']),
  InventoryAssetUpdate: obj({ version: { type: 'integer', minimum: 1 }, name: str({ minLength: 2, maxLength: 160 }), category: str({ maxLength: 80 }), unit: str({ maxLength: 40 }), description: str({ maxLength: 5000 }), location: str({ minLength: 2, maxLength: 180 }), condition: str({ minLength: 2, maxLength: 80 }), responsible_name: str({ maxLength: 120 }) }, ['version','name','location','condition']),
  InventoryMovement: obj({ type: str({ enum: ['in','out','adjust'] }), quantity: { type: 'integer', minimum: 0, maximum: 1000000000 }, reason: str({ minLength: 5, maxLength: 500 }), idempotency_key: uuid() }),
  InventoryRetire: obj({ version: { type: 'integer', minimum: 1 }, reason: str({ minLength: 5, maxLength: 500 }), idempotency_key: uuid() }),
  NotificationPreferences: obj({ event_changes: { type: 'boolean' }, reminders: { type: 'boolean' }, chat_messages: { type: 'boolean', description: 'Avisos opcionales de mensajes; omitir en clientes antiguos conserva la preferencia.' },
    quiet_start: { type: ['string','null'], pattern: '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$', description: 'Inicio incluido del silencio diario, hora de Colombia. Enviar con quiet_end; ambos null desactivan. Omitir ambos conserva el horario existente.' },
    quiet_end: { type: ['string','null'], pattern: '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$', description: 'Fin excluido; distinto del inicio. Puede cruzar medianoche. Solo oculta el distintivo web; no descarta avisos ni cambia presencia.' },
  }, ['event_changes','reminders']),
  CalendarSettings: obj({ version: { type: 'integer', minimum: 0 }, editor_roles: { type: 'array', maxItems: 4, uniqueItems: true, items: str({ enum: ['registrar','treasurer','auditor','viewer'] }) } }),
  CalendarEvent: obj({ type: str({ enum: ['meeting','appointment','activity','important_date'] }), title: str({ minLength: 2, maxLength: 160 }), description: str({ maxLength: 4000 }), location: str({ maxLength: 160 }), starts_at: str({ format: 'date-time' }), ends_at: str({ format: 'date-time' }), participants: { type: 'array', maxItems: 50, uniqueItems: true, items: uuid(), description: 'IDs de integrantes activos de la junta. Omitir en el alta equivale a lista vacía.' }, version: { type: 'integer', minimum: 1 } }, ['type','title','starts_at','ends_at']),
  CalendarEventUpdate: obj({ type: str({ enum: ['meeting','appointment','activity','important_date'] }), title: str({ minLength: 2, maxLength: 160 }), description: str({ maxLength: 4000 }), location: str({ maxLength: 160 }), starts_at: str({ format: 'date-time' }), ends_at: str({ format: 'date-time' }), participants: { type: 'array', maxItems: 50, uniqueItems: true, items: uuid(), description: 'Omitir conserva los participantes; [] elimina todas las asignaciones.' }, version: { type: 'integer', minimum: 1 } }, ['type','title','starts_at','ends_at','version']),
  CalendarCancel: obj({ version: { type: 'integer', minimum: 1 } }),
  CalendarInvitationResponse: obj({ response: str({ enum: ['accepted', 'declined'] }), version: { type: 'integer', minimum: 1 } }),
  PersonFilterSettings: obj({ version: { type: 'integer', minimum: 0 }, base: { type: 'array', maxItems: 9, uniqueItems: true, items: str({ enum: ['status','zone','affiliated','document_type','gender','descriptive_role','position_code','birth_date','registered_at'] }) }, custom: { type: 'array', maxItems: 20, uniqueItems: true, items: uuid() }, delegated_roles: { type: 'array', maxItems: 4, uniqueItems: true, items: str({ enum: ['registrar','treasurer','auditor','viewer'] }) } }, ['version','base','custom']),
  PlanillaSettings: obj({ version: { type: 'integer', minimum: 0 }, allowed_columns: { type: 'array', maxItems: 8, uniqueItems: true, items: str({ enum: ['email','phone','property_name','zone','position_label','descriptive_role','status','affiliated'] }) }, h1: str({ minLength: 1, maxLength: 120 }), h2: str({ minLength: 1, maxLength: 120 }), h3: str({ minLength: 1, maxLength: 120 }), h1_en: { type: ['string','null'], maxLength: 120, description: 'Encabezado inglés; null solo en configuraciones anteriores.' }, h2_en: { type: ['string','null'], maxLength: 120 }, h3_en: { type: ['string','null'], maxLength: 120 }, delegated_roles: { type: 'array', maxItems: 4, uniqueItems: true, items: str({ enum: ['registrar','treasurer','auditor','viewer'] }) } }, ['version','allowed_columns','h1','h2','h3']),
  PersonPositionCatalog: obj({ version: { type: 'integer', minimum: 0 }, items: { type: 'array', minItems: 1, maxItems: 50, items: { ...obj({ code: str({ maxLength: 60, pattern: '^[a-z0-9-]+$' }), label: str({ maxLength: 80 }), label_en: str({ maxLength: 80, description: 'Nombre en inglés; obligatorio al guardar, opcional en catálogos anteriores.' }), active: { type: 'boolean' } }, ['code','label','active']), additionalProperties: false } } }),
  PersonFieldOption: { ...obj({ id: uuid(), label: str({ minLength: 1, maxLength: 80 }), label_en: str({ minLength: 1, maxLength: 80, description: 'Versión inglesa, opcional para esquemas anteriores.' }), active: { type: 'boolean' } }, ['id','label','active']), additionalProperties: false },
  PersonField: { ...obj({ id: uuid(), label: str({ minLength: 1, maxLength: 80 }), label_en: str({ minLength: 1, maxLength: 80, description: 'Versión inglesa, opcional para esquemas anteriores.' }), type: str({ enum: ['text', 'date', 'number', 'select'] }), active: { type: 'boolean' }, required: { type: 'boolean' }, options: { type: 'array', maxItems: 50, items: { $ref: '#/components/schemas/PersonFieldOption' } } }, ['id','label','type','active','required','options']), additionalProperties: false },
  PersonFieldSchema: obj({ version: { type: 'integer', minimum: 0 }, fields: { type: 'array', maxItems: 20, items: { $ref: '#/components/schemas/PersonField' } }, delegated_roles: { type: 'array', maxItems: 4, uniqueItems: true, items: str({ enum: ['registrar','treasurer','auditor','viewer'] }), description: 'Opcional; solo SA/AD. Omitir conserva las delegaciones vigentes.' } }, ['version','fields']),
  QuickLink: { ...obj({ function: str({ enum: ['register', 'list', 'lookup', 'settings', 'audit', 'downloads'] }), label: str({ minLength: 1, maxLength: 40 }), label_en: str({ minLength: 1, maxLength: 40, description: 'Versión inglesa, opcional para accesos anteriores.' }) }, ['function','label']), additionalProperties: false },
  OrganizationQuickLinks: obj({ version: { type: 'integer', minimum: 0 }, mode: str({ enum: ['common', 'personal'], description: 'Opcional: omitir conserva la política vigente. Solo SA puede cambiarla; AD puede enviar el valor vigente.' }), items: { type: 'array', maxItems: 3, items: { $ref: '#/components/schemas/QuickLink' } } }, ['version','items']),
  PersonalQuickLinks: obj({ version: { type: 'integer', minimum: 0 }, common_version: { type: 'integer', minimum: 0 }, inherit: { type: 'boolean' }, items: { type: 'array', maxItems: 3, items: { $ref: '#/components/schemas/QuickLink' } } }),
  OrganizationCreate: obj({ code: str({ minLength: 3, maxLength: 40, pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$' }), name: str({ maxLength: 160 }), terms: str({ minLength: 20, maxLength: 50000 }), terms_en: str({ minLength: 20, maxLength: 50000 }) }),
  OrganizationStatus: obj({ active: { type: 'boolean' }, version: { type: 'integer', minimum: 1 } }),
  AdministratorInvitation: obj({ email: str({ format: 'email', maxLength: 254 }) }),
  Invitation: obj({ email: str({ format: 'email', maxLength: 254 }), role: str({ enum: ['admin', 'registrar', 'treasurer', 'auditor', 'viewer'] }) }),
  InvitationCredential: obj({ invitation_id: uuid(), secret: str({ pattern: '^[a-f0-9]{64}$', writeOnly: true }) }),
  InvitationAccept: obj({ invitation_id: uuid(), secret: str({ pattern: '^[a-f0-9]{64}$', writeOnly: true }), name: str({ minLength: 2, maxLength: 120 }), password: str({ minLength: 12, maxLength: 128, writeOnly: true }), password_confirmation: str({ writeOnly: true }), terms_version_id: uuid(), accepted: { type: 'boolean', const: true } }),
  Membership: obj({ role: str({ enum: ['admin', 'registrar', 'treasurer', 'auditor', 'viewer'] }), active: { type: 'boolean' }, version: { type: 'integer', minimum: 1 } }),
  PlatformAccountStatus: obj({ active: { type: 'boolean' }, expected_active: { type: 'boolean' } }),
  SessionToken: obj({ token: str({ pattern: "^[a-f0-9]{64}$", writeOnly: true }) }),
  Login: obj({
    email: str({ format: "email", maxLength: 254 }),
    password: str({ minLength: 1, maxLength: 1024 }),
    organization_code: str({ pattern: "^[a-z0-9-]{3,40}$" }),
    terms_version_id: uuid(),
    accepted: { type: "boolean", const: true },
  }),
  Verify: obj({ challenge_id: uuid(), code: str({ pattern: "^[0-9]{6}$" }) }),
  Challenge: obj({ challenge_id: uuid() }),
  EmailChange: obj({
    new_email: str({ format: "email", maxLength: 254 }),
    password: str({ maxLength: 1024 }),
  }),
  Recover: obj({ email: str({ format: "email" }), organization_code: str() }),
  Reset: obj({
    challenge_id: uuid(),
    secret: str({ minLength: 64, maxLength: 64 }),
    password: str({ minLength: 12, maxLength: 128 }),
    password_confirmation: str(),
  }),
  Switch: obj({
    organization_code: str(),
    terms_version_id: uuid(),
    accepted: { type: "boolean", const: true },
  }),
  Profile: obj({
    name: str({ maxLength: 120 }),
    theme: str({ enum: ["light", "dark"] }),
    presence: str({ enum: ["online", "away", "dnd", "invisible"] }),
    language: str({ enum: ["es", "en"] }),
  }, ['name', 'theme', 'presence']),
  Organization: obj({
    name: str({ maxLength: 160 }),
    accent: str({ pattern: "^#[0-9a-fA-F]{6}$" }),
    version: { type: "integer", minimum: 1 },
  }),
  Terms: obj({
    body: str({ minLength: 20, maxLength: 50000 }),
    body_en: str({ minLength: 20, maxLength: 50000 }),
    version: { type: "integer", minimum: 1 },
  }),
  Person: obj(
    {
      schema_version: { type: 'integer', minimum: 0, description: 'Versión vigente de /person-fields. Omitir equivale a 0; una versión antigua devuelve 409.' },
      positions_version: { type: 'integer', minimum: 0, description: 'Versión vigente de /person-positions. Omitir equivale a 0; una versión antigua devuelve 409.' },
      custom_values: { type: 'object', maxProperties: 20, propertyNames: { format: 'uuid' }, additionalProperties: { type: ['string', 'null'], maxLength: 500 }, description: 'UUID de campo a valor. Fechas YYYY-MM-DD, decimales en cadena (12 enteros y hasta 4 decimales), selecciones UUID de opción. Omitidos conservan su valor; null retira un valor activo.' },
      document_type: str({ enum: ["RC", "TI", "CC", "CE", "NIT"] }),
      document_number: str({ maxLength: 30 }),
      first_names: str({ maxLength: 120 }),
      last_names: str({ maxLength: 120 }),
      status: str({ enum: ["pending", "complete"] }),
      affiliated: { type: ["boolean", "null"] },
      zone: str({ enum: ["rural", "urban"] }),
      gender: str({ enum: ["male", "female", "other"] }),
      birth_date: str({ format: "date" }),
      phone: str({ maxLength: 20 }),
      email: str({ format: "email" }),
      position_code: { type: ['string', 'null'], maxLength: 60, pattern: '^[a-z0-9-]+$', description: 'Identificador del catálogo de la junta. Una opción inactiva solo puede conservarse en la ficha que ya la usaba.' },
      position_label: { type: ['string', 'null'], maxLength: 80, readOnly: true, description: 'Nombre capturado al asignar el cargo; conserva su historia aunque cambie el catálogo.' },
      position_label_en: { type: ['string', 'null'], maxLength: 80, readOnly: true, description: 'Nombre inglés capturado al asignar el cargo; los registros históricos sin traducción pueden conservar null.' },
      descriptive_role: str({
        enum: ["admin", "registrar", "treasurer", "auditor", "viewer"],
      }),
      property_name: str({ maxLength: 160 }),
      address: str({ maxLength: 180 }),
      neighborhood: str({ maxLength: 100 }),
      note: str({ maxLength: 4000 }),
      authorization_basis: str({ maxLength: 120 }),
      authorization_purpose: str({ maxLength: 1000 }),
      version: { type: "integer", minimum: 1 },
    },
    [
      "document_type",
      "document_number",
      "first_names",
      "status",
      "authorization_basis",
      "authorization_purpose",
    ],
  ),
  Delete: obj({
    confirmed: { type: "boolean", const: true },
    version: { type: "integer", minimum: 1 },
  }),
  Error: error,
};
// Historical GET payloads may lack English. New writes must include both languages.
schemas.PlanillaSettingsWrite = structuredClone(schemas.PlanillaSettings);
for (const name of ['h1_en', 'h2_en', 'h3_en']) {
  schemas.PlanillaSettingsWrite.properties[name] = str({ minLength: 1, maxLength: 120 });
  schemas.PlanillaSettingsWrite.required.push(name);
}
schemas.PersonPositionCatalogWrite = structuredClone(schemas.PersonPositionCatalog);
schemas.PersonPositionCatalogWrite.properties.items.items.required.push('label_en');
schemas.PersonFieldOptionWrite = structuredClone(schemas.PersonFieldOption);
schemas.PersonFieldOptionWrite.required.push('label_en');
schemas.PersonFieldWrite = structuredClone(schemas.PersonField);
schemas.PersonFieldWrite.required.push('label_en');
schemas.PersonFieldWrite.properties.options.items.$ref = '#/components/schemas/PersonFieldOptionWrite';
schemas.PersonFieldSchemaWrite = structuredClone(schemas.PersonFieldSchema);
schemas.PersonFieldSchemaWrite.properties.fields.items.$ref = '#/components/schemas/PersonFieldWrite';
schemas.QuickLinkWrite = structuredClone(schemas.QuickLink);
schemas.QuickLinkWrite.required.push('label_en');
for (const name of ['OrganizationQuickLinks', 'PersonalQuickLinks']) {
  schemas[`${name}Write`] = structuredClone(schemas[name]);
  schemas[`${name}Write`].properties.items.items.$ref = '#/components/schemas/QuickLinkWrite';
}
for (const name of ['CalendarEvent', 'CalendarEventUpdate']) {
  schemas[name].properties.title_en = { type: ['string', 'null'], minLength: 2, maxLength: 160, description: 'Versión inglesa redactada por la junta; opcional para clientes y eventos anteriores.' };
  schemas[name].properties.location_en = { type: ['string', 'null'], maxLength: 160 };
  schemas[name].properties.description_en = { type: ['string', 'null'], maxLength: 4000 };
  for (const field of ['remind_24h', 'remind_1h']) schemas[name].properties[field] = {
    type: 'boolean', ...(name === 'CalendarEvent' ? { default: true } : {}),
    description: name === 'CalendarEvent' ? 'Anticipación del evento; omitir activa esta anticipación. La preferencia personal puede suprimir la entrega.' : 'Anticipación del evento; omitir conserva su valor anterior. Requiere versión vigente y permiso de edición.',
  };
}
const routes = [
  ['get', '/person-fields', 'Configuración de campos de personas de la junta; todos los lectores'],
  ['get', '/person-filter-settings', 'Filtros visibles comunes, versión y permisos de edición. custom=null en la configuración inicial significa todos los campos.'],
  ['put', '/person-filter-settings', 'Guardar filtros comunes; SA/AD o rol delegado vigente. Solo SA/AD pueden enviar delegated_roles. Conflicto de versión: 409; no modifica permisos de lectura.', 'PersonFilterSettings'],
  ['get', '/planilla-settings', 'Configuración de encabezados y columnas de la planilla para la junta activa; todos los roles lectores'],
  ['put', '/planilla-settings', 'Guardar encabezados ES/EN, columnas disponibles y delegaciones con versión; SA/AD o rol delegado vigente. Solo SA/AD cambian delegaciones.', 'PlanillaSettingsWrite'],
  ['get', '/person-positions', 'Catálogo de cargos de personas de la junta; todos los lectores'],
  ['put', '/person-positions', 'Guardar cargos; SA/AD, versión, desactivación e historia', 'PersonPositionCatalogWrite'],
  ['get', '/contacts', 'Directorio de otras cuentas con membresía activa en la junta; nombre, rol y presencia pública. Valida la sesión sin renovar inactividad.'],
  ['put', '/person-fields', 'Guardar campos adicionales; SA/AD o delegado vigente. Solo SA/AD conceden delegaciones. Versión compartida y conservación histórica.', 'PersonFieldSchemaWrite'],
  ["get", "/csrf", "Inicializar CSRF", null, "public"],
  [
    "get",
    "/organizations/{code}",
    "Términos e identidad pública por código",
    null,
    "public",
  ],
  [
    "post",
    "/auth/login",
    "Validar credenciales sin emitir sesión",
    "Login",
    "public",
  ],
  [
    "post",
    "/auth/verify",
    "Consumir código y establecer sesión HttpOnly",
    "Verify",
    "public",
  ],
  [
    "post",
    "/auth/resend",
    "Reenviar sujeto a 60 segundos y cinco envíos por hora",
    "Challenge",
    "public",
  ],
  [
    "post",
    "/auth/cancel",
    "Cancelar desafío ligado a la sesión de navegador",
    "Challenge",
    "public",
  ],
  [
    "post",
    "/auth/recover",
    "Solicitar recuperación con respuesta genérica",
    "Recover",
    "public",
  ],
  [
    "post",
    "/auth/reset",
    "Consumir enlace y revocar sesiones",
    "Reset",
    "public",
  ],
  ["post", "/auth/logout", "Revocar sesión actual"],
  ["post", "/auth/revokeOthers", "Revocar otras sesiones"],
  [
    "post",
    "/auth/switchOrganization",
    "Validar membresía y aceptar términos de destino",
    "Switch",
  ],
  ["get", "/me", "Perfil de sesión y estado de aceptación"],
  ['get', '/members', 'Miembros de la junta; administradores; páginas de 25'],
  ['patch', '/members/{id}', 'Cambiar rol/estado con versión y revocar sesiones de la junta', 'Membership'],
  ['get', '/invitations', 'Invitaciones de la junta, sin credenciales; páginas de 25'],
  ['get', '/audit-delivery/{service}', 'Estado de entrega y hasta 20 eventos agotados de la junta; requiere permiso de auditoría'],
  ['get', '/system/schedulers', 'Estado de los nueve planificadores y sus publicadores de auditoría; solo SA/AD'],
  ['get', '/system/audit-deliveries', 'Conteo de eventos de auditoría agotados por emisor de la junta activa; solo SA/AD'],
  ['get', '/system/calendar-deliveries', 'Estado de entregas programadas de Calendario de la junta activa; solo SA/AD'],
  ['get', '/system/mail-deliveries', 'Conteos de invitaciones y avisos de seguridad pendientes de correo en la junta activa; solo SA/AD'],
  ['post', '/system/mail-deliveries/{type}/{id}/retry', 'Programar nuevo intento de correo agotado de la junta activa; invitación o aviso de seguridad; solo SA/AD'],
  ['post', '/system/calendar-deliveries/{id}/retry', 'Programar nuevo intento de un aviso de Calendario agotado de la junta activa; solo SA/AD'],
  ['post', '/audit-delivery/{service}/{id}/retry', 'Programar un nuevo intento de un evento de auditoría agotado de la junta; solo SA/AD'],
  ['get', '/treasury', 'Saldo COP y movimientos de la junta; SA/AD/TE'],
  ['get', '/treasury/export', 'Exportar hasta 2000 asientos filtrados como XLSX; SA/AD/TE'],
  ['get', '/treasury/export-pdf', 'Datos filtrados de hasta 2000 asientos para PDF A4 local; SA/AD/TE'],
  ['post', '/treasury/opening', 'Registrar apertura única con clave idempotente; SA/AD/TE', 'TreasuryOpening'],
  ['post', '/treasury/movements', 'Registrar ingreso o egreso sin saldo negativo; SA/AD/TE', 'TreasuryMovement'],
  ['get', '/treasury/movements/{id}', 'Comprobante interno de un asiento de la junta'],
  ['get', '/treasury/movements/{id}/pdf', 'Datos actualizados y nombre confirmado para el PDF individual; SA/AD/TE'],
  ['get', '/treasury/movements/{id}/xlsx', 'Comprobante individual XLSX con nombre confirmado; SA/AD/TE'],
  ['post', '/treasury/movements/{id}/reverse', 'Reversar una vez un ingreso o egreso; SA/AD/TE', 'TreasuryReversal'],
  ['get', '/assets', 'Bienes de la junta; filtros, paginación y permiso SA/AD/TE'],
  ['get', '/assets/export', 'Exportar hasta 2000 bienes filtrados como XLSX; SA/AD/TE'],
  ['get', '/assets/export-pdf', 'Datos filtrados de hasta 2000 bienes para PDF A4 local; SA/AD/TE'],
  ['post', '/assets', 'Registrar inmueble o mueble con cantidad inicial', 'InventoryAsset'],
  ['get', '/assets/{id}', 'Ficha e historial del bien de la junta'],
  ['get', '/assets/{id}/movements/export', 'XLSX del historial con filtros aplicados, hasta 2000 movimientos, todas las páginas, celdas de texto y fechas UTC; SA/AD/TE'],
  ['get', '/assets/{id}/movements/export-pdf', 'Datos del historial filtrado para PDF A4 local, hasta 2000 movimientos, todas las páginas; SA/AD/TE'],
  ['patch', '/assets/{id}', 'Actualizar ficha con versión, sin alterar existencia', 'InventoryAssetUpdate'],
  ['post', '/assets/{id}/movements', 'Entrada, salida o ajuste de mueble con motivo', 'InventoryMovement'],
  ['post', '/assets/{id}/retire', 'Baja histórica con motivo y versión', 'InventoryRetire'],
  ['get', '/calendar-settings', 'Consultar delegaciones de edición del calendario'],
  ['put', '/calendar-settings', 'Delegar edición; solo SA/AD, versión obligatoria', 'CalendarSettings'],
  ['get', '/calendar-events', 'Eventos solapados con días de America/Bogota; intervalo máximo de 62 días'],
  ['get', '/calendar-events/search', 'Buscar eventos de cualquier fecha por título o lugar; 25 por página y junta activa'],
  ['post', '/calendar-events', 'Crear evento de junta; SA/AD o rol delegado', 'CalendarEvent'],
  ['get', '/calendar-events/{id}', 'Detalle de evento de la junta activa'],
  ['patch', '/calendar-events/{id}', 'Editar evento activo con versión', 'CalendarEventUpdate'],
  ['post', '/calendar-events/{id}/cancel', 'Cancelar evento con versión', 'CalendarCancel'],
  ['get', '/calendar-invitations', 'Mis invitaciones a eventos futuros de la junta activa; páginas de 25'],
  ['post', '/calendar-invitations/{id}/respond', 'Aceptar o rechazar mi invitación con versión', 'CalendarInvitationResponse'],
  ['get', '/conversations', 'Conversaciones directas propias de la junta activa; páginas de 25'],
  ['post', '/conversations', 'Abrir o reutilizar conversación con integrante activo de la misma junta', 'ChatStart'],
  ['get', '/conversations/{id}', 'Consultar una conversación propia para abrirla desde un aviso de Chat'],
  ['get', '/conversations/{id}/messages', 'Últimos 25 mensajes; before consulta anteriores y after consulta posteriores en orden ascendente. receipt_ids consulta marcas de hasta 25 mensajes propios.'],
  ['post', '/conversations/{id}/messages', 'Guardar texto de hasta 10000 caracteres; reintento idempotente por client_id del remitente', 'ChatMessage'],
  ['post', '/conversations/{id}/receipts', 'Confirmar recepción o lectura de mensajes concretos por el destinatario; lectura exige visibilidad real en el cliente', 'ChatReceipt'],
  ['get', '/chat/broadcast-config', 'Obtener clave pública y canal privado de señales de Chat para la sesión y junta activas'],
  ['post', '/chat/broadcast-auth', 'Autorizar el socket sólo para el canal privado de la sesión y junta activas', 'ChatBroadcastAuth'],
  ['post', '/folder-documents', 'Cargar archivo privado en Carpeta con ClamAV y cuota compartida; MP3 MPEG-1 Layer III se decodifica completo con FFmpeg local y límite de 15 segundos antes de reservar cuota'],
  ['get', '/notifications', 'Bandeja personal de avisos; páginas de 25'],
  ['get', '/notification-preferences', 'Preferencias personales de avisos opcionales de Calendario'],
  ['put', '/notification-preferences', 'Activar o silenciar cambios y recordatorios propios', 'NotificationPreferences'],
  ['post', '/notifications/{id}/read', 'Marcar como leído un aviso propio'],
  ['delete', '/notifications/{id}', 'Descartar un aviso propio sin borrar auditoría'],
  ['get', '/quick-links', 'Accesos efectivos, catálogo autorizado y versiones de configuración'],
  ['patch', '/quick-links/organization', 'Guardar accesos comunes: SA/AD. Cambiar política común/personal: solo SA; AD recibe 403 si intenta cambiarla. Versión antigua: 409.', 'OrganizationQuickLinksWrite'],
  ['patch', '/quick-links/personal', 'Guardar accesos propios o volver a heredar; requiere modo personal y versiones vigentes', 'PersonalQuickLinksWrite'],
  ['get', '/platform/organizations', 'Listar juntas, solo superadministrador; páginas de 25'],
  ['post', '/platform/organizations', 'Crear junta con términos iniciales, solo superadministrador', 'OrganizationCreate'],
  ['patch', '/platform/organizations/{id}', 'Activar o suspender junta con versión; no suspender la junta actual', 'OrganizationStatus'],
  ['get', '/platform/accounts', 'Listar cuentas de la plataforma; solo superadministrador, filtro y páginas de 25'],
  ['patch', '/platform/accounts/{id}', 'Suspender o reactivar una cuenta en todas las juntas; revocar sesiones al suspender', 'PlatformAccountStatus'],
  ['post', '/platform/organizations/{id}/administrators', 'Invitar administrador de la junta indicada, solo superadministrador', 'AdministratorInvitation'],
  ['post', '/invitations', 'Crear invitación privada con envío pendiente y caducidad de 24 horas', 'Invitation'],
  ['delete', '/invitations/{id}', 'Revocar enlace de invitación no aceptado'],
  ['post', '/invitations/inspect', 'Consultar invitación únicamente presentando su secreto', 'InvitationCredential', 'public'],
  ['post', '/invitations/accept', 'Consumir invitación y vincular cuenta sin iniciar sesión', 'InvitationAccept', 'public'],
  ["get", "/dashboard", "Indicadores exclusivos de junta; date en America/Bogota, generated_at UTC y timezone. Semana desde lunes; períodos hasta antes de la siguiente medianoche colombiana."],
  ["get", "/persons", "Consulta paginada de personas"],
  ["get", "/persons/export", "Exportar hasta 2000 personas filtradas como XLSX, sin notas ni fotografías"],
  ["get", "/persons/export-pdf", "Datos filtrados de hasta 2000 personas para descargar un PDF real en el cliente, sin notas ni fotografías"],
  ["get", "/persons/planilla", "Planilla XLSX de firmas con cinco columnas fijas y hasta cinco opcionales"],
  ["get", "/persons/planilla-preview", "Datos mínimos de la planilla filtrada para imprimir o guardar PDF desde el navegador"],
  ["get", "/persons/planilla-pdf", "Datos mínimos de la planilla filtrada para descargar un PDF real en el cliente"],
  ["post", "/persons", "Crear persona y evento durable", "Person"],
  ["get", "/persons/lookup", "Consulta exacta por tipo y documento"],
  ["get", "/persons/{id}", "Detalle; nota solo para SA/AD/RE"],
  ["get", "/persons/{id}/xlsx", "Ficha individual XLSX con datos base y campos adicionales históricos, sin notas, autorizaciones ni fotografías"],
  ["get", "/persons/{id}/pdf", "Datos autorizados para la ficha individual PDF, sin notas, autorizaciones ni fotografías"],
  ["patch", "/persons/{id}", "Actualizar con versión requerida", "Person"],
  ["delete", "/persons/{id}", "Borrado confirmado con versión", "Delete"],
  ["patch", "/profile", "Editar perfil propio, sin rol ni correo", "Profile"],
  [
    "post",
    "/profile/email-change",
    "Reautenticar y enviar código al nuevo correo",
    "EmailChange",
  ],
  [
    "post",
    "/profile/email-change/resend",
    "Reenviar dentro del período de reautenticación",
    "Challenge",
  ],
  [
    "post",
    "/profile/email-change/confirm",
    "Verificar correo y revocar otras sesiones",
    "Verify",
  ],
  ["patch", "/organization", "Editar nombre/color con versión", "Organization"],
  [
    "post",
    "/organization/terms",
    "Publicar versión inmutable de términos",
    "Terms",
  ],
  ["get", "/audit-events", "Auditoría de junta; SA/AD/AU"],
  ["get", "/audit-events/export", "Exportar hasta 2000 eventos filtrados como XLSX; SA/AD/AU"],
  ["get", "/audit-events/export-pdf", "Datos filtrados de hasta 2000 eventos para PDF A3 horizontal local; SA/AD/AU"],
  ["get", "/releases", "Lista vacía hasta disponer de instaladores reales"],
];
const paths = {};
for (const [method, path, summary, input, scope] of routes) {
  const op = {
    summary,
    operationId: method + path.replace(/[^a-zA-Z]/g, "_"),
    security: scope === "public" ? [] : [{ session: [] }],
    responses: {
      200: response,
      ...Object.fromEntries(
        [401, 403, 404, 409, 419, 422, 429, 503].map((code) => [
          code,
          {
            description: "Error normalizado " + code,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Error" },
              },
            },
          },
        ]),
      ),
    },
  };
  if (input)
    op.requestBody = {
      required: true,
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/" + input },
        },
      },
    };
  op.parameters = [...path.matchAll(/\{(\w+)\}/g)].map((m) => ({
    name: m[1],
    in: "path",
    required: true,
    schema: m[1] === "id" ? uuid() : m[1] === 'service' ? str({ enum: ['identity', 'configuration', 'records', 'files', 'calendar', 'notifications', 'treasury', 'inventory', 'chat'] }) : str(),
  }));
  if (method !== "get")
    op.parameters.push({
      name: "X-CSRF-TOKEN",
      in: "header",
      required: true,
      schema: str(),
      description: "Obtener de /csrf; renovar tras /auth/verify y logout.",
    });
  if (["/persons", "/persons/export", "/persons/export-pdf", "/persons/planilla", "/persons/planilla-preview", "/persons/planilla-pdf"].includes(path) && method === "get")
    op.parameters.push(
      { name: 'document_type', in: 'query', schema: str({ enum: ['RC', 'TI', 'CC', 'CE', 'NIT'] }) },
      { name: 'gender', in: 'query', schema: str({ enum: ['male', 'female', 'other'] }) },
      { name: 'descriptive_role', in: 'query', schema: str({ enum: ['admin', 'registrar', 'treasurer', 'auditor', 'viewer'] }), description: 'Rol de la ficha; no representa permisos de cuenta.' },
      { name: 'position_code', in: 'query', schema: str({ maxLength: 60, pattern: '^[a-z0-9-]+$' }), description: 'Código del catálogo de la junta activa, incluidos cargos inactivos. Todos los filtros se combinan con AND.' },
      { name: 'birth_date_from', in: 'query', schema: str({ format: 'date' }), description: 'Fecha inicial de nacimiento YYYY-MM-DD; requiere birth_date_to. Extremos inclusivos.' },
      { name: 'birth_date_to', in: 'query', schema: str({ format: 'date' }), description: 'Fecha final de nacimiento YYYY-MM-DD; requiere birth_date_from y no puede ser anterior.' },
      { name: 'registered_from', in: 'query', schema: str({ format: 'date' }), description: 'Día inicial de registro en America/Bogota YYYY-MM-DD; requiere registered_to. Extremos inclusivos.' },
      { name: 'registered_to', in: 'query', schema: str({ format: 'date' }), description: 'Día final de registro en America/Bogota YYYY-MM-DD; requiere registered_from y no puede ser anterior. El servidor convierte el límite final a UTC del día siguiente.' },
    );
  if (["/persons", "/persons/export", "/persons/export-pdf", "/persons/planilla", "/persons/planilla-preview", "/persons/planilla-pdf"].includes(path) && method === "get")
    for (const name of [
      "q",
      "status",
      "zone",
      "affiliated",
      ...(path === '/persons' ? ["page", "page_size"] : []),
    ])
      op.parameters.push({
        name,
        in: "query",
        schema:
          name === "page"
            ? { type: "integer", minimum: 1 }
            : name === "page_size"
              ? { type: "integer", enum: [10, 25, 50] }
              : str(),
      });
  if (["/persons", "/persons/export", "/persons/export-pdf", "/persons/planilla", "/persons/planilla-preview", "/persons/planilla-pdf"].includes(path) && method === "get")
    op.parameters.push({ name: 'custom_filters', in: 'query', description: 'Hasta tres criterios combinados con AND. Codificar custom_filters[0][field_id] y [value] (índices 0..2). operator omitido o eq: coincidencia exacta, sin value_to. between: solo fechas ISO YYYY-MM-DD, value inicial y value_to final obligatorios, extremos inclusivos y ordenados. UUID de campo de la junta; campos y opciones inactivos admitidos. Números exactos comparados como cadenas, 1 difiere de 1.0.', schema: { type: 'array', maxItems: 3, items: { ...obj({ field_id: uuid(), value: str({ minLength: 1, maxLength: 120 }), operator: str({enum:['eq','between']}), value_to: str({format:'date'}) }, ['field_id','value']), additionalProperties: false } } });
  if (['/persons/export', '/persons/planilla', '/persons/{id}/xlsx'].includes(path) && method === 'get') {
    op.responses[200] = { description: 'Libro XLSX en base64 con personas filtradas de la junta, sin notas', content: { 'application/json': { schema: obj({
      data: obj({ filename: str({ pattern: '^[A-Za-z0-9][A-Za-z0-9._ -]{0,119}\\.xlsx$' }), mime: str({ const: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), content: str({ contentEncoding: 'base64' }), count: { type: 'integer', minimum: 0, maximum: 2000 } }),
      meta: obj({ correlation_id: uuid() }),
    }) } } };
    op.responses[422].description = 'Filtros o nombre inválidos, o más de 2000 personas';
    if (path === '/persons/{id}/xlsx') {
      op.responses[200].description = 'Ficha XLSX de una persona de la junta, sin notas, autorizaciones ni fotografías';
      op.responses[200].content['application/json'].schema.properties.data.properties.count = { type: 'integer', const: 1 };
      op.responses[422].description = 'Nombre inválido o sin confirmar';
    }
  }
  if (path === '/persons/{id}/pdf') {
    op.responses[200] = { description: 'Nombre confirmado y tabla de campos de una persona de la junta para PDF A4 local', content: { 'application/json': { schema: obj({
      data: obj({ filename: str({ pattern: '^[A-Za-z0-9][A-Za-z0-9._ -]{0,119}\\.pdf$' }), date: str({ format: 'date' }), count: { type: 'integer', const: 1 }, headers: { type: 'array', minItems: 2, maxItems: 2, items: str() }, rows: { type: 'array', minItems: 21, items: { type: 'array', minItems: 2, maxItems: 2, items: str() } } }),
      meta: obj({ correlation_id: uuid() }),
    }) } } };
    op.responses[422].description = 'Nombre inválido o sin confirmar';
  }
  if (path === '/persons/export-pdf') {
    op.responses[200] = { description: 'Nombre PDF confirmado y filas filtradas de la junta; sin notas ni fotografías', content: { 'application/json': { schema: obj({
      data: obj({ filename: str({ pattern: '^[A-Za-z0-9][A-Za-z0-9._ -]{0,119}\\.pdf$' }), date: str({ format: 'date' }), headers: { type: 'array', minItems: 12, maxItems: 12, items: str() }, rows: { type: 'array', maxItems: 2000, items: { type: 'array', minItems: 12, maxItems: 12, items: str() } }, count: { type: 'integer', minimum: 0, maximum: 2000 } }),
      meta: obj({ correlation_id: uuid() }),
    }) } } };
    op.responses[422].description = 'Filtros o nombre inválidos, o más de 2000 personas';
  }
  if (['/persons/planilla', '/persons/planilla-preview', '/persons/planilla-pdf'].includes(path)) {
    op.parameters.push({ name: 'columns', in: 'query', description: 'Codificar columns[0] hasta columns[4]. Sin repetidos. Firma es fija, vacía y última.', schema: { type: 'array', maxItems: 5, uniqueItems: true, items: str({ enum: ['email','phone','property_name','zone','position_label','descriptive_role','status','affiliated'] }) } });
    for (const name of ['h1', 'h2', 'h3']) op.parameters.push({ name, in: 'query', schema: str({ maxLength: 120 }), description: 'Encabezado para esta descarga; no se guarda como configuración.' });
  }
  if (path === '/persons/planilla-preview') {
    op.responses[200] = { description: 'Encabezados y filas filtradas para una vista local imprimible; sin notas ni fotos', content: { 'application/json': { schema: obj({
      data: obj({ title: str(), headings: obj({ h1: str(), h2: str(), h3: str() }), date: obj({ month: str(), day: str(), year: str() }), headers: { type: 'array', minItems: 5, maxItems: 10, items: str() }, rows: { type: 'array', maxItems: 2000, items: { type: 'array', minItems: 5, maxItems: 10, items: str() } }, count: { type: 'integer', minimum: 0, maximum: 2000 } }),
      meta: obj({ correlation_id: uuid() }),
    }) } } };
    op.responses[422].description = 'Filtros, columnas o nombre inválidos, o más de 2000 personas';
  }
  if (path === '/persons/planilla-pdf') {
    op.responses[200] = { description: 'Nombre PDF confirmado, encabezados y filas filtradas; sin notas ni fotos', content: { 'application/json': { schema: obj({
      data: obj({ filename: str({ pattern: '^[A-Za-z0-9][A-Za-z0-9._ -]{0,119}\\.pdf$' }), headings: obj({ h1: str(), h2: str(), h3: str() }), date: obj({ month: str(), day: str(), year: str() }), headers: { type: 'array', minItems: 5, maxItems: 10, items: str() }, rows: { type: 'array', maxItems: 2000, items: { type: 'array', minItems: 5, maxItems: 10, items: str() } }, count: { type: 'integer', minimum: 0, maximum: 2000 } }),
      meta: obj({ correlation_id: uuid() }),
    }) } } };
    op.responses[422].description = 'Filtros, columnas o nombre inválidos, o más de 2000 personas';
  }
  if (path === '/contacts') op.parameters.push(
    { name: 'q', in: 'query', schema: str({ maxLength: 120 }), description: 'Parte literal del nombre; no busca correos ni documentos.' },
    { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 }, description: '25 contactos por página, ordenados por nombre e identificador.' },
  );
  if (path === "/persons/lookup")
    op.parameters.push(
      ...["document_type", "document_number"].map((name) => ({
        name,
        in: "query",
        required: true,
        schema: str(),
      })),
    );
  if (path === '/audit-events' && method === 'get') {
    for (const [name, schema] of Object.entries({
      page: { type: 'integer', minimum: 1, maximum: 1000000 },
      page_size: { type: 'integer', enum: [10, 25, 50], default: 25 },
      date_from: { type: 'string', format: 'date', description: 'Primer día incluido, UTC.' },
      date_to: { type: 'string', format: 'date', description: 'Último día incluido, UTC; no anterior a date_from.' },
      actor_id: uuid(), service: str({ enum: ['identity', 'configuration', 'records', 'files', 'calendar', 'notifications', 'treasury', 'inventory', 'chat'] }),
      action: str({ maxLength: 100 }), result: str({ enum: ['success', 'rejected', 'failed'] }),
    })) op.parameters.push({ name, in: 'query', schema });
  }
  if (['/audit-events/export', '/audit-events/export-pdf'].includes(path) && method === 'get') {
    for (const [name, schema] of Object.entries({
      date_from: str({ format: 'date' }), date_to: str({ format: 'date' }), actor_id: uuid(),
      service: str({ enum: ['identity', 'configuration', 'records', 'files', 'calendar', 'notifications', 'treasury', 'inventory', 'chat'] }),
      action: str({ maxLength: 100 }), result: str({ enum: ['success', 'rejected', 'failed'] }),
    })) op.parameters.push({ name, in: 'query', schema });
    op.responses[200] = { description: 'Libro XLSX en base64, sin contenido de recursos', content: { 'application/json': { schema: obj({
      data: obj({ filename: str({ pattern: '^[A-Za-z0-9][A-Za-z0-9._ -]{0,119}\\.xlsx$' }), mime: str({ const: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), content: str({ contentEncoding: 'base64' }), count: { type: 'integer', minimum: 0, maximum: 2000 } }),
      meta: obj({ correlation_id: uuid() }),
    }) } } };
    op.responses[422].description = 'Filtros inválidos o más de 2000 eventos';
    if (path === '/audit-events/export-pdf') {
      op.responses[200] = { description: 'Ocho campos de los eventos autorizados, sin contenido del recurso asociado', content: { 'application/json': { schema: obj({
        data: obj({ filename: str({pattern:'^[A-Za-z0-9][A-Za-z0-9._ -]{0,119}\\.pdf$'}), date: str({format:'date'}),
          headers: {type:'array',minItems:8,maxItems:8,items:str()}, rows: {type:'array',maxItems:2000,items:{type:'array',minItems:8,maxItems:8,items:str()}}, count: {type:'integer',minimum:0,maximum:2000} }),
        meta: obj({correlation_id:uuid()}),
      }) } } };
    }
  }
  if (path === '/calendar-events' && method === 'get') for (const name of ['from','to']) op.parameters.push({ name, in: 'query', required: true, schema: str({ format: 'date' }) });
  if (method === 'get' && ['/calendar-events', '/calendar-events/search', '/calendar-events/{id}'].includes(path)) op.description = 'Estado calculado con el reloj UTC del servidor al consultar: Próximo en las 24 horas previas (umbral incluido); En curso desde el inicio incluido hasta el fin excluido; Finalizado desde el fin. Cancelado tiene prioridad. Consultar no cambia la versión ni registra un movimiento.';
  if (path === '/calendar-events/search' && method === 'get') {
    op.parameters.push({ name: 'q', in: 'query', required: true, schema: str({ minLength: 1, maxLength: 120 }), description: 'Título o lugar; %, _ y ! se interpretan literalmente.' });
    op.parameters.push({ name: 'page', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 100000 } });
  }
  if (path === '/calendar-invitations' && method === 'get') op.parameters.push({ name: 'page', in: 'query', required: false, schema: { type: 'integer', minimum: 1 } });
  if (path === '/conversations' && method === 'get') op.parameters.push({ name: 'page', in: 'query', required: false, schema: { type: 'integer', minimum: 1 } });
  if (path === '/conversations/{id}/messages' && method === 'get') {
    op.parameters.push({ name: 'before', in: 'query', required: false, schema: { type: 'integer', minimum: 1 }, description: 'Cursor exclusivo hacia mensajes anteriores; no combinar con after.' });
    op.parameters.push({ name: 'after', in: 'query', required: false, schema: { type: 'integer', minimum: 0 }, description: 'Cursor exclusivo hacia mensajes nuevos; devuelve hasta 25 en orden ascendente y next_after para continuar. No combinar con before.' });
    op.parameters.push({ name: 'receipt_ids', in: 'query', required: false, schema: { type: 'array', maxItems: 25, uniqueItems: true, items: uuid() }, description: 'IDs de mensajes enviados por el solicitante para consultar entregado/leído; la respuesta incluye receipts.' });
  }
  if (path === '/notifications' && method === 'get') op.parameters.push({ name: 'page', in: 'query', required: false, schema: { type: 'integer', minimum: 1 } });
  if (path === '/notification-preferences') {
    op.responses[200] = { description: 'Preferencias del usuario y junta firmados; horario diario de Colombia para el distintivo web', content: { 'application/json': { schema: obj({
      data: { ...schemas.NotificationPreferences, required: ['event_changes','reminders','chat_messages','quiet_start','quiet_end'] },
      meta: obj({correlation_id:uuid()}),
    }) } } };
  }
  if (path === '/treasury' && method === 'get') {
    op.parameters.push({ name: 'page', in: 'query', required: false, schema: { type: 'integer', minimum: 1 } });
    for (const name of ['from', 'to']) op.parameters.push({ name, in: 'query', required: false, schema: str({ format: 'date' }) });
    op.parameters.push({ name: 'q', in: 'query', required: false, schema: str({ maxLength: 120 }), description: 'Concepto con %, _ y ! literales, o comprobante TES-número exacto.' });
  }
  if (path === '/treasury/movements/{id}/pdf' && method === 'get') {
    op.parameters.push({ name: 'filename', in: 'query', schema: str({ maxLength: 100 }), description: 'Nombre opcional confirmado y saneado; elimina extensiones finales .xlsx/.pdf y añade .pdf. Por defecto: comprobante_TES-NNNNNN.pdf.' });
    op.parameters.push({ name: 'confirm_filename', in: 'query', schema: { type: 'boolean' }, description: 'Obligatorio true/1 cuando se escribe un nombre.' });
    op.responses[200] = { description: 'Comprobante de la junta y nombre PDF seguro; el cliente genera el archivo local', content: { 'application/json': { schema: obj({
      data: obj({ filename: str({ pattern: '^[A-Za-z0-9][A-Za-z0-9._ -]{0,119}\\.pdf$' }), receipt: obj({
        id: uuid(), number: { type: 'integer', minimum: 1 }, receipt: str(), kind: str({ enum: ['opening','income','expense','reversal'] }),
        sign: { type: 'integer', enum: [-1,1] }, amount: str({ pattern: '^\\d+\\.\\d{2}$' }), balance_after: str({ pattern: '^\\d+\\.\\d{2}$' }),
        effective_date: str({ format: 'date' }), concept: str(), support_note: { type: ['string','null'] }, actor_name: str(), actor_id: uuid(),
        reverses_id: { type: ['string','null'], format: 'uuid' }, reversed_by_id: { type: ['string','null'], format: 'uuid' }, created_at: str(),
      }) }), meta: obj({ correlation_id: uuid() }),
    }) } } };
    op.responses[422].description = 'Nombre inválido o sin confirmar';
  }
  if (['/treasury/export', '/treasury/export-pdf'].includes(path) && method === 'get') {
    for (const name of ['from', 'to']) op.parameters.push({ name, in: 'query', required: false, schema: str({ format: 'date' }) });
    op.parameters.push({ name: 'q', in: 'query', required: false, schema: str({ maxLength: 120 }), description: 'Concepto con %, _ y ! literales, o comprobante TES-número exacto.' });
    op.responses[200] = { description: 'Libro XLSX en base64 con los asientos filtrados de la junta', content: { 'application/json': { schema: obj({
      data: obj({ filename: str({ pattern: '^[A-Za-z0-9][A-Za-z0-9._ -]{0,119}\\.xlsx$' }), mime: str({ const: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), content: str({ contentEncoding: 'base64' }), count: { type: 'integer', minimum: 0, maximum: 2000 } }),
      meta: obj({ correlation_id: uuid() }),
    }) } } };
    op.responses[422].description = 'Filtros inválidos o más de 2000 asientos';
    if (path === '/treasury/export-pdf') {
      op.responses[200] = { description: 'Nombre PDF confirmado y doce campos de todos los asientos filtrados de la junta; saldo histórico al confirmar', content: { 'application/json': { schema: obj({
        data: obj({ filename: str({pattern:'^[A-Za-z0-9][A-Za-z0-9._ -]{0,119}\\.pdf$'}), date: str({format:'date'}),
          headers: {type:'array',minItems:12,maxItems:12,items:str()}, rows: {type:'array',maxItems:2000,items:{type:'array',minItems:12,maxItems:12,items:str()}}, count: {type:'integer',minimum:0,maximum:2000} }),
        meta: obj({correlation_id:uuid()}),
      }) } } };
    }
  }
  if (path === '/treasury/movements/{id}/xlsx' && method === 'get') {
    op.parameters.push({ name: 'filename', in: 'query', schema: str({ maxLength: 100 }), description: 'Nombre opcional confirmado y saneado; elimina extensiones finales .xlsx/.pdf repetidas. Por defecto: comprobante_TES-NNNNNN.xlsx.' });
    op.parameters.push({ name: 'confirm_filename', in: 'query', schema: { type: 'boolean' } });
    op.responses[200] = { description: 'Comprobante individual XLSX en base64; todas las celdas son texto', content: { 'application/json': { schema: obj({
      data: obj({ filename: str({ pattern: '^[A-Za-z0-9][A-Za-z0-9._ -]{0,119}\\.xlsx$' }), mime: str({ const: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), content: str({ contentEncoding: 'base64' }), count: { type: 'integer', const: 1 } }),
      meta: obj({ correlation_id: uuid() }),
    }) } } };
    op.responses[422].description = 'Nombre inválido o sin confirmar';
  }
  if (path === '/assets' && method === 'get') {
    op.parameters.push({ name: 'page', in: 'query', required: false, schema: { type: 'integer', minimum: 1 } });
    op.parameters.push({ name: 'type', in: 'query', required: false, schema: str({ enum: ['real_estate', 'movable'] }) });
    op.parameters.push({ name: 'status', in: 'query', required: false, schema: str({ enum: ['active', 'retired'] }) });
    op.parameters.push({ name: 'q', in: 'query', required: false, schema: str({ maxLength: 120 }), description: 'Código o nombre; %, _ y ! se interpretan literalmente.' });
  }
  if (['/assets/export', '/assets/export-pdf'].includes(path) && method === 'get') {
    op.parameters.push({ name: 'type', in: 'query', required: false, schema: str({ enum: ['real_estate', 'movable'] }) });
    op.parameters.push({ name: 'status', in: 'query', required: false, schema: str({ enum: ['active', 'retired'] }) });
    op.parameters.push({ name: 'q', in: 'query', required: false, schema: str({ maxLength: 120 }), description: 'Código o nombre; %, _ y ! se interpretan literalmente.' });
    op.responses[200] = { description: 'Libro XLSX en base64 con los bienes filtrados de la junta', content: { 'application/json': { schema: obj({
      data: obj({ filename: str({ pattern: '^[A-Za-z0-9][A-Za-z0-9._ -]{0,119}\\.xlsx$' }), mime: str({ const: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), content: str({ contentEncoding: 'base64' }), count: { type: 'integer', minimum: 0, maximum: 2000 } }),
      meta: obj({ correlation_id: uuid() }),
    }) } } };
    op.responses[422].description = 'Filtros inválidos o más de 2000 bienes';
    if (path === '/assets/export-pdf') {
      op.responses[200] = { description: 'Nombre PDF confirmado y catorce campos de todos los bienes filtrados de la junta', content: { 'application/json': { schema: obj({
        data: obj({ filename: str({pattern:'^[A-Za-z0-9][A-Za-z0-9._ -]{0,119}\\.pdf$'}), date: str({format:'date'}),
          headers: {type:'array',minItems:14,maxItems:14,items:str()}, rows: {type:'array',maxItems:2000,items:{type:'array',minItems:14,maxItems:14,items:str()}}, count: {type:'integer',minimum:0,maximum:2000} }),
        meta: obj({correlation_id:uuid()}),
      }) } } };
    }
  }
  if (path === '/assets/{id}/movements/export-pdf' && method === 'get') {
    op.responses[200] = { description: 'Nombre PDF confirmado y once columnas de todos los movimientos filtrados, orden descendente de secuencia', content: { 'application/json': { schema: obj({
      data: obj({ filename: str(), date: str({ format: 'date' }), count: { type: 'integer', minimum: 0, maximum: 2000 },
        headers: { type: 'array', minItems: 11, maxItems: 11, items: str() }, rows: { type: 'array', maxItems: 2000, items: { type: 'array', minItems: 11, maxItems: 11, items: str() } } }),
      meta: obj({ correlation_id: uuid() }),
    }) } } };
    op.responses[422].description = 'Filtros o nombre inválidos, o más de 2000 movimientos: no se trunca';
  }
  if (path === '/assets/{id}/movements/export' && method === 'get') {
    op.responses[200] = { description: 'XLSX en base64 del historial filtrado, orden descendente de secuencia, once columnas de texto, sin fotos', content: { 'application/json': { schema: obj({
      data: obj({ filename: str(), mime: str({ const: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), content: str({ contentEncoding: 'base64' }), count: { type: 'integer', minimum: 0, maximum: 2000 } }),
      meta: obj({ correlation_id: uuid() }),
    }) } } };
    op.responses[422].description = 'Filtros o nombre inválidos, o más de 2000 movimientos: no se trunca';
  }
  if (['/assets/{id}', '/assets/{id}/movements/export', '/assets/{id}/movements/export-pdf'].includes(path) && method === 'get') {
    if (path === '/assets/{id}') op.parameters.push({ name: 'movement_page', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 100000 }, description: 'Página de movimientos, 25 por página, orden descendente de secuencia.' });
    op.parameters.push({ name: 'movement_type', in: 'query', required: false, schema: str({ enum: ['opening', 'in', 'out', 'adjust', 'retire'] }), description: 'Operación del historial; no modifica la existencia actual del bien.' });
    op.parameters.push({ name: 'movement_q', in: 'query', required: false, schema: str({ maxLength: 120 }), description: 'Texto del motivo; %, _ y ! se interpretan literalmente.' });
    for (const name of ['movement_from', 'movement_to']) op.parameters.push({ name, in: 'query', required: false, schema: str({ format: 'date' }), description: 'Día inclusivo de Colombia según la fecha de registro del movimiento. El fin debe ser igual o posterior al inicio.' });
  }
  if (method === 'get' && ['/audit-events/export', '/audit-events/export-pdf', '/assets/export', '/assets/export-pdf', '/assets/{id}/movements/export', '/assets/{id}/movements/export-pdf', '/treasury/export', '/treasury/export-pdf', '/persons/export', '/persons/export-pdf', '/persons/planilla', '/persons/planilla-preview', '/persons/planilla-pdf', '/persons/{id}/xlsx', '/persons/{id}/pdf'].includes(path)) {
    op.parameters.push({ name: 'filename', in: 'query', required: false, schema: str({ maxLength: 100 }), description: ['/persons/export-pdf', '/persons/planilla-pdf', '/persons/{id}/pdf', '/assets/export-pdf', '/assets/{id}/movements/export-pdf', '/treasury/export-pdf', '/audit-events/export-pdf'].includes(path) ? 'Nombre opcional; el servidor sanea caracteres, elimina extensiones .xlsx/.pdf finales y añade .pdf. Si se omite, usa tipo_YYYY-MM-DD.pdf con fecha de Colombia.' : 'Nombre opcional; el servidor sanea caracteres, elimina extensión .xlsx repetida y añade .xlsx. Si se omite, usa tipo_YYYY-MM-DD con fecha de Colombia.' });
    op.parameters.push({ name: 'confirm_filename', in: 'query', required: false, schema: { type: 'boolean' }, description: 'Debe ser true/1 cuando filename contiene texto.' });
  }
  paths[path] ??= {};
  paths[path][method] = op;
}
const schedulerItem = obj({
  service: str({ enum: ['identity', 'configuration', 'records', 'files', 'calendar', 'notifications', 'treasury', 'inventory', 'chat'] }),
  available: { type: 'boolean' }, cycle_recent: { type: 'boolean' }, outbox_recent: { type: 'boolean' },
});
const schedulerResponse = structuredClone(response);
schedulerResponse.content['application/json'].schema.properties.data = obj({
  items: { type: 'array', minItems: 9, maxItems: 9, items: schedulerItem },
  checked_at: str({ format: 'date-time' }),
});
paths['/system/schedulers'].get.responses[200] = schedulerResponse;
const auditOverviewResponse = structuredClone(response);
auditOverviewResponse.content['application/json'].schema.properties.data = obj({
  items: { type: 'array', minItems: 9, maxItems: 9, items: obj({
    service: schedulerItem.properties.service,
    available: { type: 'boolean' },
    exhausted: { type: ['integer', 'null'], minimum: 0 },
  }) },
  checked_at: str({ format: 'date-time' }),
});
paths['/system/audit-deliveries'].get.responses[200] = auditOverviewResponse;
const calendarDeliveryData = obj({
  delivered: { type: 'integer', minimum: 0 }, pending: { type: 'integer', minimum: 0 },
  due: { type: 'integer', minimum: 0 }, deferred: { type: 'integer', minimum: 0 },
  exhausted: { type: 'integer', minimum: 0 },
  exhausted_jobs: { type: 'array', maxItems: 20, items: obj({
    id: uuid(), kind: str(), attempts: { type: 'integer', minimum: 8 }, due_at: str(),
  }) },
});
const calendarDeliveryResponse = structuredClone(response);
calendarDeliveryResponse.content['application/json'].schema.properties.data = calendarDeliveryData;
paths['/system/calendar-deliveries'].get.responses[200] = calendarDeliveryResponse;
const mailCounts = obj({
  pending: { type: 'integer', minimum: 0 }, due: { type: 'integer', minimum: 0 },
  deferred: { type: 'integer', minimum: 0 }, exhausted: { type: 'integer', minimum: 0 },
  exhausted_items: { type: 'array', maxItems: 20, items: obj({
    id: uuid(), attempts: { type: 'integer', minimum: 4 }, created_at: str(), retryable: { type: 'boolean' },
  }) },
});
const mailResponse = structuredClone(response);
mailResponse.content['application/json'].schema.properties.data = obj({
  invitations: obj({ ...mailCounts.properties, expired: { type: 'integer', minimum: 0 } }),
  security_notices: mailCounts,
});
paths['/system/mail-deliveries'].get.responses[200] = mailResponse;
const mailRetryResponse = structuredClone(response);
mailRetryResponse.content['application/json'].schema.properties.data = obj({ queued: { const: true } });
paths['/system/mail-deliveries/{type}/{id}/retry'].post.responses[200] = mailRetryResponse;
paths['/system/mail-deliveries/{type}/{id}/retry'].post.parameters.find(parameter => parameter.name === 'type').schema = str({ enum: ['invitations', 'security-notices'] });
const calendarRetryResponse = structuredClone(response);
calendarRetryResponse.content['application/json'].schema.properties.data = obj({ queued: { const: true } });
paths['/system/calendar-deliveries/{id}/retry'].post.responses[200] = calendarRetryResponse;
paths['/presence/heartbeat'] = { post: {
  summary: 'Confirmar conexión sin renovar inactividad',
  description: 'Cada 30 segundos. Señal válida durante 90 segundos. Usa únicamente la credencial del gateway. Respuesta propia: effective (online/away/dnd/offline), preference (incluye invisible), ttl_seconds=90. No permite consultar otras cuentas.',
  security: [{ session: [] }],
  parameters: [{ name: 'X-CSRF-TOKEN', in: 'header', required: true, schema: str() }],
  responses: { 200: response, 401: { description: 'Sesión inválida o vencida' }, 403: { description: 'Acceso o términos no vigentes' }, 419: { description: 'CSRF inválido' }, 429: { description: 'Límite de solicitudes' } },
} };
fs.mkdirSync("contracts", { recursive: true });
const doc = {
  openapi: "3.1.0",
  info: {
    title: "SRD Gateway API",
    version: "0.1.0",
    description:
      "Contrato del incremento implementado. Identidad nativa, archivos y otros dominios aún no expuestos. Cada éxito contiene data y meta. Listas contienen items/page/page_size/total dentro de data.",
  },
  servers: [
    { url: "http://localhost:8080/api/v1", description: "Compose local" },
  ],
  paths,
  components: {
    securitySchemes: {
      session: {
        type: "apiKey",
        in: "cookie",
        name: "srd_session",
        description:
          "Cookie cifrada HttpOnly Laravel; nunca contiene una credencial legible por JavaScript.",
      },
    },
    schemas,
  },
};
fs.writeFileSync(
  "contracts/gateway.openapi.json",
  JSON.stringify(doc, null, 2) + "\n",
);
for (const [service, filter] of Object.entries({
  identity: (p) => p === '/contacts' || p.startsWith("/auth/") || p.startsWith("/profile") || p.startsWith('/members') || p.startsWith('/invitations') || p.startsWith('/platform/accounts') || p.endsWith('/administrators'),
  configuration: (p) => p.startsWith("/organization") || p.startsWith('/quick-links') || (p.startsWith('/platform/organizations') && !p.endsWith('/administrators')),
  records: (p) => p.startsWith("/persons") || p === '/person-fields' || p === '/person-positions' || p === '/person-filter-settings' || p === '/planilla-settings' || p === "/dashboard",
  audit: (p) => p === "/audit-events" || p === "/audit-events/export" || p === "/audit-events/export-pdf",
  calendar: (p) => p.startsWith('/calendar-'),
  notifications: (p) => p.startsWith('/notifications') || p === '/notification-preferences',
  treasury: (p) => p.startsWith('/treasury'),
  inventory: (p) => p.startsWith('/assets'),
  chat: (p) => p.startsWith('/conversations'),
})) {
  const internalPaths = {};
  for (const [p, v] of Object.entries(paths))
    if (filter(p)) {
      let target =
        p === "/audit-events"
          ? "/events"
          : p.startsWith('/audit-events/export')
            ? p.replace('/audit-events/', '/events/')
          : p.startsWith('/calendar-')
            ? p.replace(/^\/calendar-/, '/')
          : p === "/organizations/{code}"
            ? "/organizations/code/{code}"
            : p;
      const ops = structuredClone(v);
      for (const op of Object.values(ops)) {
        op.security = [{ internal: [] }];
        op.parameters = op.parameters.filter((p) => p.name !== "X-CSRF-TOKEN");
        if (
          service === "identity" &&
          target.startsWith("/auth/") &&
          ![
            "/auth/login",
            "/auth/verify",
            "/auth/resend",
            "/auth/cancel",
            "/auth/recover",
            "/auth/reset",
          ].includes(target)
        ) {
          op.description =
            "Recibe token de sesión por POST desde el gateway; nunca del navegador directamente.";
          const tokenSchema = { $ref: "#/components/schemas/SessionToken" };
          const schema = op.requestBody?.content?.["application/json"]?.schema;
          op.requestBody = { required: true, content: { "application/json": { schema: schema ? { allOf: [schema, tokenSchema] } : tokenSchema } } };
        }
      }
      internalPaths[target] = ops;
    }
  if (service === "identity")
    internalPaths["/auth/me"] = {
      post: {
        summary: "Resolver credencial opaca y contexto; touch_activity=false valida sin renovar inactividad",
        requestBody: { required: true, content: { "application/json": { schema: { allOf: [{ $ref: "#/components/schemas/SessionToken" }, { type: 'object', properties: { touch_activity: { type: 'boolean', default: true } } }] } } } },
        security: [{ internal: [] }],
        responses: { 200: response },
      },
    };
  if (service === 'identity') internalPaths['/auth/presence'] = { post: {
    summary: 'Registrar latido sin tocar last_activity_at',
    security: [{ internal: [] }],
    requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/SessionToken' } } } },
    responses: { 200: response, 401: { description: 'Sesión vencida o revocada' }, 403: { description: 'Términos pendientes' } },
  } };
  if (service === 'identity') internalPaths['/calendar-participants/resolve'] = { post: {
    summary: 'Resolver integrantes activos de una junta; solo emisor calendar',
    description: 'Devuelve solo user_id y nombre para las cuentas activas con membresía activa en la junta del contexto firmado. Rechaza la lista completa si algún ID no cumple.',
    security: [{ internal: [] }],
    requestBody: { required: true, content: { 'application/json': { schema: obj({ user_ids: { type: 'array', maxItems: 50, uniqueItems: true, items: uuid() } }) } } },
    responses: { 200: response, 401: { description: 'Firma o emisor inválido' }, 422: { description: 'Integrante inválido o ajeno a la junta' } },
  } };
  if (service === 'identity') internalPaths['/chat-contacts/resolve'] = { post: {
    summary: 'Resolver otro integrante activo de la junta; solo emisor chat',
    description: 'Devuelve únicamente ID, nombre y rol; rechaza otra junta, cuenta inactiva y el propio usuario.',
    security: [{ internal: [] }],
    requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/ChatStart' } } } },
    responses: { 200: response, 401: { description: 'Firma o emisor inválido' }, 422: { description: 'Contacto inválido o ajeno a la junta' } },
  } };
  if (service === 'notifications') internalPaths['/deliveries'] = { post: {
    summary: 'Entrega idempotente de avisos de Calendario o Chat; emisor firmado correspondiente',
    security: [{ internal: [] }],
    requestBody: { required: true, content: { 'application/json': { schema: { oneOf: [
      obj({ organization_id: uuid(), user_id: uuid(), event_id: uuid(), title: str({ maxLength: 160 }), title_en: { type: ['string', 'null'], maxLength: 160 },
        kind: str({ enum: ['invitation', 'event_changed', 'event_cancelled', 'reminder_24h', 'reminder_1h'] }),
        delivery_key: str({ pattern: '^[a-f0-9]{64}$' }) }, ['organization_id', 'user_id', 'event_id', 'title', 'kind', 'delivery_key']),
      obj({ organization_id: uuid(), user_id: uuid(), conversation_id: uuid(), kind: str({ enum: ['chat_message'] }),
        delivery_key: str({ pattern: '^[a-f0-9]{64}$' }) }),
    ] } } } },
    responses: { 200: response, 401: { description: 'Firma o emisor inválido' }, 403: { description: 'Junta del contexto distinta' }, 422: { description: 'Datos inválidos' } },
  } };
  if (['identity', 'configuration', 'records', 'files', 'calendar', 'notifications', 'treasury', 'inventory', 'chat'].includes(service)) {
    const schedulerOperation = structuredClone(paths['/system/schedulers'].get);
    schedulerOperation.summary = 'Marcadores locales recientes del planificador; solo emisor gateway firmado';
    schedulerOperation.security = [{ internal: [] }];
    schedulerOperation.responses[200].content['application/json'].schema.properties.data = obj({
      available: { type: 'boolean' }, cycle_recent: { type: 'boolean' }, outbox_recent: { type: 'boolean' },
    });
    internalPaths['/scheduler-status'] = { get: schedulerOperation };
    const status = structuredClone(paths['/audit-delivery/{service}'].get);
    status.security = [{ internal: [] }];
    status.parameters = [];
    internalPaths['/outbox-status'] = { get: status };
    const retry = structuredClone(paths['/audit-delivery/{service}/{id}/retry'].post);
    retry.security = [{ internal: [] }];
    retry.parameters = retry.parameters.filter(parameter => parameter.name === 'id');
    internalPaths['/outbox-status/{id}/retry'] = { post: retry };
  }
  if (service === 'calendar') {
    const operation = structuredClone(paths['/system/calendar-deliveries'].get);
    operation.summary = 'Estado interno de entregas programadas de Calendario de la junta activa';
    operation.security = [{ internal: [] }];
    internalPaths['/delivery-status'] = { get: operation };
    const retry = structuredClone(paths['/system/calendar-deliveries/{id}/retry'].post);
    retry.summary = 'Reintentar un aviso agotado de Calendario de la junta activa';
    retry.security = [{ internal: [] }];
    retry.parameters = retry.parameters.filter(parameter => parameter.name === 'id');
    internalPaths['/delivery-status/{id}/retry'] = { post: retry };
  }
  if (service === 'identity') {
    const operation = structuredClone(paths['/system/mail-deliveries'].get);
    operation.summary = 'Conteos internos de correo pendiente de la junta activa';
    operation.security = [{ internal: [] }];
    internalPaths['/mail-delivery-status'] = { get: operation };
    const retry = structuredClone(paths['/system/mail-deliveries/{type}/{id}/retry'].post);
    retry.summary = 'Reintentar correo agotado de la junta activa';
    retry.security = [{ internal: [] }];
    retry.parameters = retry.parameters.filter(parameter => ['type', 'id'].includes(parameter.name));
    internalPaths['/mail-delivery-status/{type}/{id}/retry'] = { post: retry };
  }
  if (service === 'records') internalPaths['/persons/{id}/photo-access'] = { post: {
    summary: 'Decisión mínima de acceso a fotos; solo emisor files',
    description: 'Comprueba el rol del contexto firmado y la existencia de la persona en esa junta. No devuelve campos ni notas, no almacena concesiones y no valida por sí sola una sesión. No está publicada en el gateway.',
    parameters: [{ name: 'id', in: 'path', required: true, schema: uuid() }],
    security: [{ internal: [] }],
    requestBody: { required: true, content: { 'application/json': { schema: obj({ action: str({ enum: ['persons.read', 'persons.write'] }) }) } } },
    responses: {
      200: { description: 'Acceso permitido, sin datos de la persona', content: { 'application/json': { schema: obj({ data: obj({ authorized: { type: 'boolean', const: true } }), meta: obj({ correlation_id: uuid() }) }) } } },
      401: { description: 'Firma o emisor no admitido' },
      403: { description: 'Emisor distinto de files o permisos insuficientes' },
      404: { description: 'Persona inexistente o fuera de la junta' },
      422: { description: 'Acción no admitida' },
    },
  } };
  if (service === 'inventory') internalPaths['/assets/{id}/photo-access'] = { post: {
    summary: 'Decisión mínima de acceso a fotos de un bien; solo emisor files',
    description: 'Comprueba el rol y junta del contexto firmado y que el bien exista. La escritura exige un bien activo; la lectura admite dados de baja. No devuelve datos del bien ni está publicada en el gateway.',
    parameters: [{ name: 'id', in: 'path', required: true, schema: uuid() }],
    security: [{ internal: [] }],
    requestBody: { required: true, content: { 'application/json': { schema: obj({ action: str({ enum: ['inventory.read', 'inventory.write'] }) }) } } },
    responses: {
      200: { description: 'Acceso permitido', content: { 'application/json': { schema: obj({ data: obj({ authorized: { type: 'boolean', const: true } }), meta: obj({ correlation_id: uuid() }) }) } } },
      401: { description: 'Firma o emisor no admitido' },
      403: { description: 'Permiso insuficiente o bien dado de baja para escritura' },
      404: { description: 'Bien inexistente o fuera de la junta' },
      422: { description: 'Acción no admitida' },
    },
  } };
  if (service === "configuration")
    internalPaths["/organizations/{id}"] = {
      get: {
        summary: "Consulta para identidad; incluye términos y estado",
        parameters: [
          { name: "id", in: "path", required: true, schema: uuid() },
        ],
        security: [{ internal: [] }],
        responses: { 200: response },
      },
    };
  if (service === "audit")
    internalPaths["/events"].post = {
      summary: "Ingestión idempotente de evento mínimo; emisor igual a service",
      requestBody: { required: true, content: { "application/json": { schema: { $ref: "./audit-event.v1.schema.json" } } } },
      security: [{ internal: [] }],
      responses: { 200: response },
    };
  fs.writeFileSync(
    `contracts/${service}.openapi.json`,
    JSON.stringify(
      {
        ...doc,
        info: { title: `SRD ${service} API interna`, version: "0.1.0" },
        servers: [{ url: `http://${service}:8000/internal/v1` }],
        paths: internalPaths,
        components: {
          schemas,
          securitySchemes: {
            internal: {
              type: "apiKey",
              in: "header",
              name: "X-SRD-Context",
              description:
                "Base64(JSON claims).HMAC-SHA256; audiencia, método, ruta, hash del cuerpo, nonce y caducidad obligatorios.",
            },
          },
        },
      },
      null,
      2,
    ) + "\n",
  );
}
fs.writeFileSync(
  "contracts/audit-event.v1.schema.json",
  JSON.stringify(
    {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      title: "SRD audit event v1",
      ...obj({
        id: uuid(),
        organization_id: { type: ["string", "null"], format: "uuid" },
        actor_id: { type: ["string", "null"], format: "uuid" },
        service: str({ enum: ["identity", "configuration", "records", "files", "calendar", "notifications", "treasury", "inventory", "chat"] }),
        action: str({ maxLength: 100 }),
        resource_id: { type: ["string", "null"], format: "uuid" },
        result: str({ enum: ["success", "rejected", "failed"] }),
        correlation_id: uuid(),
        occurred_at: str(),
        event_version: { type: "integer", const: 1 },
      }),
    },
    null,
    2,
  ) + "\n",
);
await import('./contracts-files.mjs');
console.log("OpenAPI contracts written, including authenticated photo routes.");
