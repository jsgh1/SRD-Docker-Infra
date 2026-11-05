# Versionado de releases y rollback de aplicación

Este procedimiento es optativo. El Compose de producción existente conserva sus etiquetas `*:production`; no se cambian automáticamente ni se despliega nada al ejecutar el generador. El objetivo es seleccionar una release con referencias inmutables por digest y poder volver a seleccionar una release previa.

## Manifiesto

El generador `scripts/render-release-compose.mjs` recibe un JSON con este esquema estricto:

```json
{
  "schemaVersion": 1,
  "releaseId": "2026-11-04-a1b2c3d",
  "sources": {
    "backend": "<40 caracteres hex>",
    "database": "<40 caracteres hex>",
    "docs": "<40 caracteres hex>",
    "frontend": "<40 caracteres hex>",
    "infra": "<40 caracteres hex>"
  },
  "images": {
    "gateway": "<registry>/srd-gateway@sha256:<64 caracteres hex>",
    "identity": "<registry>/srd-identity@sha256:<64 caracteres hex>",
    "configuration": "<registry>/srd-configuration@sha256:<64 caracteres hex>",
    "records": "<registry>/srd-records@sha256:<64 caracteres hex>",
    "audit": "<registry>/srd-audit@sha256:<64 caracteres hex>",
    "files": "<registry>/srd-files@sha256:<64 caracteres hex>",
    "calendar": "<registry>/srd-calendar@sha256:<64 caracteres hex>",
    "notifications": "<registry>/srd-notifications@sha256:<64 caracteres hex>",
    "treasury": "<registry>/srd-treasury@sha256:<64 caracteres hex>",
    "inventory": "<registry>/srd-inventory@sha256:<64 caracteres hex>",
    "chat": "<registry>/srd-chat@sha256:<64 caracteres hex>",
    "web": "<registry>/srd-web@sha256:<64 caracteres hex>"
  }
}
```

Los valores entre ángulos son marcadores y deben reemplazarse por revisiones y digests reales. El formato no admite etiquetas mutables ni campos adicionales que puedan transportar secretos. La referencia digest identifica exactamente el contenido de la imagen; las etiquetas de Docker pueden reasignarse. No guardar credenciales del registro en este JSON.

El manifiesto se genera después de construir y publicar las imágenes en un registro accesible al servidor. La imagen Docker PHP de producción guarda los SHA de Backend, Database e Infra en etiquetas OCI; la imagen web guarda los SHA de Frontend e Infra. El pipeline de publicación debe aportar esos argumentos y conservar el digest emitido por el registro. El manifiesto registra además los cinco SHA de origen, incluido Docs. Este PR no publica imágenes ni modifica el proceso actual de despliegue.

## Preflight sin reiniciar servicios

En la máquina operadora con Node.js:

```sh
node scripts/render-release-compose.mjs /ruta-protegida/release.json > /ruta-protegida/release.compose.yaml
```

En el servidor, con los archivos de producción protegidos y sin mostrar `.env.production`:

```sh
docker compose --env-file .env.production -f compose.production.yaml -f /ruta-protegida/release.compose.yaml config -q
docker compose --env-file .env.production -f compose.production.yaml -f /ruta-protegida/release.compose.yaml pull gateway identity configuration records audit files calendar notifications treasury inventory chat chat-reverb web
```

El primer comando valida la composición sin imprimir valores; el segundo verifica que cada digest sea recuperable. Si una imagen o digest no existe, el preflight falla antes de ejecutar `up`, por lo que no sustituye ni reinicia los contenedores actuales. No continuar con despliegue si falla.

## Release y rollback de aplicación

Antes de migrar, ejecutar el respaldo operativo desde `/opt/srd/scripts/backup-production.sh` como root y comprobar los archivos cifrados con:

```sh
cd /var/backups/srd/<directorio-de-la-release>
sha256sum --check SHA256SUMS
```

Ese chequeo confirma integridad por hash del respaldo cifrado; por sí solo **no demuestra que el respaldo pueda descifrarse o restaurarse**. La restauración de aceptación debe realizarse en un MySQL aislado y verificarse antes de depender del respaldo para recuperación. Los scripts actuales no automatizan esa restauración integral.

Con una ventana de despliegue aprobada, un manifiesto anterior preservado y preflight exitoso, seleccionar el overlay de la nueva release y ejecutar `up -d --no-build` para los servicios previstos por el plan de despliegue. No usar `--remove-orphans` ni eliminar volúmenes. La operación recrea contenedores de aplicación si cambia el digest; no borra los volúmenes Compose.

Para rollback de aplicación, volver a seleccionar el manifiesto y overlay previos, verificar que sus digests estén disponibles con `pull`, y luego recrear los servicios de aplicación con `up -d --no-build`. Mantener el overlay y JSON de cada release bajo un directorio operativo con permisos restringidos y respaldo, fuera de `/srv/downloads`.

## Base de datos y límites

`scripts/migrate-production.sh` ejecuta migraciones Laravel secuenciales y un backfill; no crea ni verifica automáticamente el respaldo previo. El sistema no ofrece rollback universal para migraciones destructivas o backfills.

- Para cambios compatibles, preferir migraciones expand/contract: desplegar primero esquema aditivo y código compatible, y retirar columnas/formatos antiguos en una release posterior.
- Ante una migración reversible, usar únicamente el rollback específico y probado en un entorno aislado, con revisión del estado de las demás migraciones.
- Ante un cambio destructivo o backfill que no tenga reversión demostrada, no ejecutar `migrate:rollback` a ciegas. Seguir un plan de recuperación basado en un respaldo cifrado cuya restauración se haya ensayado, con aprobación operativa y verificación posterior.
- No considerar `scripts/verify-restore-test.sh` una restauración autónoma: compara la prueba con el MySQL de producción. No ejecutarlo como parte de un preflight aislado.
- `scripts/verify-demo-restore-test.sh` valida conteos de una restauración demo, no garantiza por sí solo recuperación completa de producción.

P44 no ejecuta migraciones, respalda producción, despliega ni usa datos reales. El runtime y la aceptación del procedimiento de restauración siguen pendientes en un QA independiente.
