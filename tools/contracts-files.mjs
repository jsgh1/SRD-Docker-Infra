import fs from 'node:fs';
const response = (description, schema) => ({ description, ...(schema ? { content: { 'application/json': { schema } } } : {}) });
const metadata = { type: 'object', required: ['slot','version','present','size','width','height'], properties: {
  slot: { type: 'string', enum: ['person','document','property'] }, version: { type: 'integer', minimum: 0 }, present: { type: 'boolean' }, size: { type: 'integer', minimum: 0 }, width: { type: ['integer','null'] }, height: { type: ['integer','null'] },
} };
const envelope = data => ({ type: 'object', required: ['data','meta'], properties: { data, meta: { type: 'object', properties: { correlation_id: { type: 'string', format: 'uuid' } }, required: ['correlation_id'] } } });
const parameters = [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }];
const slot = { name: 'slot', in: 'path', required: true, schema: metadata.properties.slot };
const operation = (summary, params, result, body) => ({ summary, parameters: params, security: [{ internal: [] }],
  ...(body ? { requestBody: { required: true, content: { 'application/json': { schema: body } } } } : {}),
  responses: { 200: response('Operación confirmada; Cache-Control: no-store', envelope(result)), 401: response('Firma inválida'), 403: response('Emisor, contexto o permiso inválido'), 404: response('Recurso no disponible'), 409: response('Versión en conflicto'), 413: response('Solicitud mayor de 7 MiB'), 422: response('Datos o imagen inválidos'), 503: response('Dependencia o antivirus no disponible'), 507: response('Cuota insuficiente') },
});
const doc = {
  openapi: '3.1.0', info: { title: 'SRD Archivos: API interna de fotografías', version: '0.1.0', description: 'Servicio incorporado a Compose y conectado a rutas autenticadas del gateway. Solo emisor gateway con contexto de sesión previamente validada. El servicio consulta a Registros o Inventario y exige antivirus real y comprobación reciente de firmas. Este contrato describe su API interna.' },
  servers: [{ url: 'http://files:8000/internal/v1' }],
  components: { securitySchemes: { internal: { type: 'apiKey', in: 'header', name: 'X-SRD-Context', description: 'Contexto HMAC ligado a audiencia files, cuerpo, método, ruta, nonce y caducidad; incluye junta, usuario, rol y session_id.' } } },
  paths: {
    '/persons/{id}/photos': { get: operation('Consultar tres posiciones de fotografías', parameters, { type: 'object', properties: { items: { type: 'array', items: metadata } }, required: ['items'] }) },
    '/persons/{id}/photos/{slot}': {
      get: operation('Leer fotografía privada normalizada', [...parameters, slot], { type: 'object', required: ['content','mime','version'], properties: { content: { type: 'string', contentEncoding: 'base64' }, mime: { const: 'image/png' }, version: { type: 'integer' } } }),
      put: operation('Crear o reemplazar con versión esperada', [...parameters, slot], metadata, { type: 'object', required: ['name','content','version'], properties: { name: { type: 'string', maxLength: 255 }, content: { type: 'string', maxLength: 6990508, contentEncoding: 'base64', description: 'Base64 canónico sin espacios. JPEG, PNG o WebP; máximo 5 MiB y 20 millones de píxeles.' }, version: { type: 'integer', minimum: 0, maximum: 2147483647 } } }),
      delete: operation('Borrar foto con confirmación y versión', [...parameters, slot], metadata, { type: 'object', required: ['confirmed','version'], properties: { confirmed: { const: true }, version: { type: 'integer', minimum: 1, maximum: 2147483647 } } }),
    },
  },
};
doc.paths['/photo-deletions/{id}'] = { post: {
  summary: 'Orden interna de limpieza de una persona ya eliminada; solo emisor records', parameters,
  description: 'Contexto firmado con organization_id, user_id y correlation_id. Sin autoridad en el cuerpo. Idempotente: registra marca terminal y retira metadatos; la retirada física y la liberación de cuota son posteriores mediante el recolector. Sin ruta pública en el gateway.',
  security: [{ internal: [] }], responses: { 200: response('Orden persistida', envelope({ type: 'object', properties: { accepted: { const: true } }, required: ['accepted'] })), 401: response('Firma inválida'), 403: response('Emisor o contexto inválido'), 500: response('Operación no confirmada; reintentar la misma orden') },
} };
doc.paths['/outbox-status'] = { get: {
  summary: 'Estado de entrega de eventos de Archivos para la junta activa',
  description: 'Solo emisor gateway con contexto firmado y permiso audit.read. Totales de entregados, pendientes, listos, diferidos y agotados; como máximo veinte agotados, sin contenido de fotografías.',
  security: [{ internal: [] }],
  responses: { 200: response('Estado de la junta', envelope({ type: 'object', required: ['service','published','pending','due','deferred','exhausted','exhausted_events'], properties: {
    service: { const: 'files' }, published: { type:'integer', minimum:0 }, pending: { type:'integer', minimum:0 }, due: { type:'integer', minimum:0 }, deferred: { type:'integer', minimum:0 }, exhausted: { type:'integer', minimum:0 },
    exhausted_events: { type:'array', maxItems:20, items: { type:'object', required:['id','action','attempts','occurred_at'], properties: { id:{ type:'string', format:'uuid' }, action:{ type:'string' }, attempts:{ type:'integer' }, occurred_at:{ type:'string' } } } },
  } })), 401: response('Firma inválida'), 403: response('Emisor o permiso inválido') },
} };
doc.paths['/outbox-status/{id}/retry'] = { post: {
  summary: 'Reintentar la entrega de un evento de auditoría agotado en Archivos',
  description: 'Solo emisor gateway y permiso audit.retry para SA/AD de la junta activa. Rechaza eventos no agotados o ya entregados.',
  parameters,
  security: [{ internal: [] }],
  responses: {
    200: response('Reintento programado', envelope({ type: 'object', required: ['queued'], properties: { queued: { const: true } } })),
    401: response('Firma inválida'), 403: response('Emisor o permiso inválido'),
    404: response('Evento inexistente en la junta activa'), 409: response('El evento no está agotado'),
  },
} };
const assetMetadata = structuredClone(metadata);
assetMetadata.properties.slot.enum = ['front', 'side', 'detail'];
const assetSlot = { ...slot, schema: assetMetadata.properties.slot };
doc.paths['/assets/{id}/photos'] = { get: operation('Consultar tres posiciones del bien', parameters,
  { type: 'object', properties: { items: { type: 'array', items: assetMetadata } }, required: ['items'] }) };
doc.paths['/assets/{id}/photos/{slot}'] = {
  get: operation('Leer fotografía privada de bien', [...parameters, assetSlot],
    { type: 'object', required: ['content','mime','version'], properties: { content: { type: 'string', contentEncoding: 'base64' }, mime: { const: 'image/png' }, version: { type: 'integer' } } }),
  put: operation('Crear o reemplazar foto de bien activo', [...parameters, assetSlot], assetMetadata,
    { type: 'object', required: ['name','content','version'], properties: { name: { type: 'string', maxLength: 255 }, content: { type: 'string', maxLength: 6990508, contentEncoding: 'base64' }, version: { type: 'integer', minimum: 0, maximum: 2147483647 } } }),
  delete: operation('Borrar foto de bien activo con confirmación', [...parameters, assetSlot], assetMetadata,
    { type: 'object', required: ['confirmed','version'], properties: { confirmed: { const: true }, version: { type: 'integer', minimum: 1, maximum: 2147483647 } } }),
};
doc.paths['/folder-documents'] = { post: {
  summary: 'Cargar un archivo privado en Carpeta',
  description: 'Solo SA/AD de la junta activa. Hasta 20 MiB decodificados. ClamAV analiza el original y, para MP3 MPEG-1 Layer III, el flujo sin etiquetas ID3. FFmpeg local debe decodificar todo el MP3 en 15 segundos antes de reservar cuota. Un fallo rechaza el archivo y libera cuarentena.',
  security: [{ internal: [] }],
  requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['id','folder_id','name','content'], properties: {
    id: { type: 'string', format: 'uuid' }, folder_id: { type: ['string','null'], format: 'uuid' },
    name: { type: 'string', maxLength: 255 }, content: { type: 'string', contentEncoding: 'base64', maxLength: 27962028 },
  } } } } },
  responses: { 200: response('Documento guardado y cuota reservada'), 401: response('Firma inválida'),
    403: response('Permiso insuficiente'), 413: response('Solicitud mayor de 28 MiB'),
    422: response('Tipo o contenido rechazado'), 503: response('Antivirus o decodificador no disponible'),
    507: response('Cuota insuficiente') },
} };
doc.info.description += ' Las rutas de bienes verifican la junta y el estado activo en Inventario; la lectura se conserva tras la baja. La ruta photo-deletions admite exclusivamente al emisor records para órdenes persistentes de limpieza.';
doc.paths['/scheduler-status'] = { get: operation('Marcadores recientes del planificador; solo gateway firmado', [], {
  type: 'object', required: ['available', 'cycle_recent', 'outbox_recent'], properties: {
    available: { type: 'boolean' }, cycle_recent: { type: 'boolean' }, outbox_recent: { type: 'boolean' },
  },
}) };
fs.writeFileSync('contracts/files.openapi.json', JSON.stringify(doc, null, 2) + '\n');
const gateway = JSON.parse(fs.readFileSync('contracts/gateway.openapi.json', 'utf8'));
for (const [path, operations] of Object.entries(doc.paths)) {
  if (!path.startsWith('/persons/') && !path.startsWith('/assets/')) continue;
  gateway.paths[path] = structuredClone(operations);
  for (const operation of Object.values(gateway.paths[path])) operation.security = structuredClone(gateway.paths['/persons'].get.security);
}
gateway.paths['/folder-documents'] ??= {};
gateway.paths['/folder-documents'].post = structuredClone(doc.paths['/folder-documents'].post);
gateway.paths['/folder-documents'].post.security = structuredClone(gateway.paths['/persons'].get.security);
fs.writeFileSync('contracts/gateway.openapi.json', JSON.stringify(gateway, null, 2) + '\n');
