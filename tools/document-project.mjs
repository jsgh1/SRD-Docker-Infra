import fs from "node:fs";
import path from "node:path";
const write = (p, s) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, s);
};
const sources = fs.readdirSync("docs/sources");
const srs = fs.readFileSync(
  "docs/sources/" + sources.find((n) => n.startsWith("01_")),
  "utf8",
);
const analysis = fs.readFileSync(
  "docs/sources/" + sources.find((n) => n.startsWith("02_")),
  "utf8",
);
const functional = [...srs.matchAll(/^RF-(\d{3})\. (.+)\r?$/gm)].map((m) => ({
  id: "RF-" + m[1],
  title: m[2].trim(),
  offset: m.index,
}));
const nonfunctional = [...srs.matchAll(/^RNF-(\d{3})\. (.+)\r?$/gm)].map(
  (m) => ({ id: "RNF-" + m[1], title: m[2].trim() }),
);
const usecases = [...analysis.matchAll(/^CU-(\d{2})\. (.+)\r?$/gm)].map(
  (m) => ({ id: "CU-" + m[1], title: m[2].trim() }),
);
if (
  functional.length !== 56 ||
  nonfunctional.length !== 18 ||
  usecases.length !== 20
)
  throw new Error("Unexpected requirement count");
const partial = {
  25: "API de eventos de junta con creación, edición versionada, cancelación y aislamiento; web con vistas de mes, semana y agenda. Participantes e invitaciones a eventos pendientes. Ver CALENDARIO.md.",
  26: "Estados calculados al consultar; recordatorios y notificaciones pendientes. Ver CALENDARIO.md.",
  20: "Fotos de persona, documento y predio desde el detalle o el paso opcional Guardar y añadir fotos del alta: carga, lectura privada, ampliación, reemplazo, borrado confirmado y versiones, con gateway autenticado y ClamAV. Nuevas eliminaciones con limpieza persistente. Orientación EXIF 1–8 en JPEG. La ficha se guarda antes de subir imágenes; otros formatos de orientación, dispositivos y validación integral pendientes.",
  39: "Fotos conectadas al gateway y al detalle de fichas, con MySQL y volumen privados, permisos, ClamAV, actualización de firmas, limpieza y outbox programados. Nuevos borrados de personas con orden durable, reintentos y protección contra cargas concurrentes. Copia local cifrada con fotos y verificación de metadatos. Otros tipos de archivo, conciliación histórica y operación integral pendientes.",
  56: "Copia manual local cifrada de las bases de servicio, .env y fotografías con pausa de escritores; autenticación y simulacro aislado de SQL y objetos con tablas, claves foráneas, hashes y cuotas. Compatibilidad con copias anteriores sin fotos ni Calendario. Programación diaria, retención, copia externa, recuperación operativa, permisos, supresiones posteriores y conciliación pendientes.",
  1: "Alta con términos, listado paginado, activación/suspensión e invitación de administrador por UI de plataforma. Acceso exclusivo SA, versiones y auditoría; validación integral pendiente.",
  2: "Bootstrap, invitación privada 24 h/uso único, vinculación de cuentas existentes, roles/activación por junta y revocación de sesiones. Pruebas backend; validación integral pendiente.",
  3: "Login con términos, cookie de sesión y CSRF; prueba SMTP/Chromium.",
  4: "Código HMAC de cinco minutos, cinco intentos, consumo único; probado con SQLite y SMTP.",
  5: "Espera de 60 s, cinco envíos/hora, invalida código previo; probado.",
  6: "Enlace de recuperación con fragmento efímero, 15 min, contraseña y revocación; pruebas backend.",
  7: "Contexto firmado, membresía vigente, junta y términos; pruebas cruzadas. Selector por código.",
  8: "Logout, revocar otras sesiones, 30 min inactividad/8 h; pruebas backend.",
  9: "Nombre/tema/preferencia persistentes y copia de correo. Fotografías pendientes.",
  10: "Cambio con contraseña y código al nuevo correo, revocación de otras sesiones y aviso durable al correo anterior; pruebas backend. Validación multidispositivo pendiente.",
  11: "Preferencia persistente, latidos cada 30 segundos sin renovar inactividad, agregación de sesiones válidas y vencimiento a los 90 segundos; Invisible se representa como Desconectado. Indicador propio y contactos con actualización automática visible y manual sin prolongar sesión; chat y avisos No molestar pendientes.",
  40: "Directorio paginado de cuentas activas de la junta, búsqueda por nombre y presencia pública sin correos ni fechas de conexión. Inicio de conversaciones pendiente.",
  12: "Shell responsive y menú de módulos disponibles. Búsqueda global, campana y logo pendientes.",
  13: "Hasta tres accesos configurables por SA/AD con etiquetas, catálogo autorizado, herencia, persistencia y versiones. Solo SA cambia la política común/personal; AD conserva edición de accesos comunes. Delegación granular pendiente.",
  14: "Conteos, últimas fichas, barras y circulares con actualización manual y fecha del servidor. Probados medianoche colombiana, lunes, cambio de mes y borrado. Pendientes carga y concurrencia integral.",
  15: "Búsqueda conjunta de personas y contactos desde el encabezado, resultados separados, paginación y errores independientes; detalle autorizado y exclusión de notas. Otros dominios y recursos pendientes.",
  16: "Ficha base con junta, autor, documento único, nota y campos adicionales tipados. Opción Guardar y añadir fotos: ficha persistida antes de las cargas, sin repetir el alta si una foto falla. Validación integral pendiente.",
  17: "Validación Pendiente/Completado de campos base y obligatoriedad de campos adicionales activos.",
  18: "Validaciones y ubicación condicional. Cargo validado contra catálogo versionado por junta; otros catálogos configurables pendientes.",
  19: "Campos adicionales tipados, versiones e historia; edición delegable por SA/AD a roles de la junta, con revocación bajo bloqueo. Catálogo de cargos configurable por SA/AD y etiquetas históricas. Otros catálogos base y validación integral pendientes.",
  21: "Filtros base, intervalos inclusivos de nacimiento y de registro (días de Colombia) y hasta tres criterios adicionales exactos o por intervalo para fechas; paginación 10/25/50 y limpieza. Selección visible común por junta con versiones y delegación por rol. No altera permisos de lectura. Otros rangos, consultas guardadas y validación integral pendientes.",
  22: "Consulta exacta y detalle sin nota para roles excluidos. Fotografías privadas y ampliación desde el detalle, con permisos por junta. Validación integral pendiente.",
  23: "Edición con versión y conflicto 409; probado.",
  24: "Confirmación y borrado de persona/notas con evento mínimo; nuevas eliminaciones generan limpieza durable de fotografías. Conciliación histórica, otros adjuntos y supresión de copias pendientes.",
  47: "Perfil, nombre/color, términos y delegación independiente de campos adicionales, filtros y edición del calendario. Política común/personal de accesos rápidos reservada a SA; AD edita accesos comunes. Resto de configuración/delegaciones pendiente.",
  48: "Términos inmutables por versión, aceptación por usuario/junta. Autorización de captura básica.",
  49: "Outbox, confirmación positiva, reintentos bajo bloqueo y consumidor idempotente; tres escenarios de concurrencia MySQL probados. Cobertura integral pendiente.",
  50: "Bitácora de solo lectura con filtros combinables por fecha UTC, actor, módulo (incluidos Archivos y Calendario), acción y resultado, paginación y detalle. Estado de entregas por junta en cinco servicios. Exportación XLSX de hasta 2000 eventos filtrados por SA/AD/AU; PDF, lotes extensos y supervisión global pendientes.",
  51: "Estado vacío honesto, sin binarios publicados.",
  55: "Salud /up y reintentos outbox; panel operativo y supervisión integral pendientes.",
};
const records = functional.map((r, i) => {
  const block = srs.slice(
    r.offset,
    functional[i + 1]?.offset ?? srs.indexOf("3.3 Requisitos"),
  );
  return {
    id: r.id,
    title: r.title,
    case: block.match(/Trazabilidad: (CU-\d+)/)?.[1] ?? null,
    interface: block.match(/· (UI-\d+)/)?.[1] ?? null,
    acceptance: "CA-" + r.id,
    state: partial[+r.id.slice(3)] ? "Parcial" : "Pendiente",
    detail:
      partial[+r.id.slice(3)] ?? "Conservado en alcance; no implementado.",
    evidence: partial[+r.id.slice(3)]
      ? "Ver docs/VALIDACION.md; no equivale a aceptación final."
      : "Sin evidencia de ejecución.",
  };
});
write(
  "docs/requirements.json",
  JSON.stringify(
    {
      source: "SRS SRD versión 1.0, 05/09/2026",
      counts: { functional: 56, nonfunctional: 18, usecases: 20 },
      functional: records,
      nonfunctional: nonfunctional.map((r) => ({
        ...r,
        state: "Pendiente de validación integral",
      })),
      usecases: usecases.map((r) => ({
        ...r,
        state: "Pendiente de aceptación integral",
      })),
    },
    null,
    2,
  ) + "\n",
);
write(
  "docs/TRAZABILIDAD.md",
  "# Trazabilidad de SRD\n\nSe verificaron 56 RF (RF-001–056), 18 RNF (RNF-001–018) y 20 CU (CU-01–20). Ningún RF se declara terminado mientras falten sus criterios completos y la integración MySQL.\n\n| Requisito | Caso / interfaz | Estado | Implementación y pendientes |\n|---|---|---|---|\n" +
    records
      .map(
        (r) =>
          `| ${r.id} · ${r.title} | ${r.case} / ${r.interface} | ${r.state} | ${r.detail} |`,
      )
      .join("\n") +
    "\n\n## Requisitos no funcionales\n\n" +
    nonfunctional
      .map(
        (r) =>
          `- ${r.id}: ${r.title}. Pendiente de validación integral; evidencia parcial en VALIDACION.md.`,
      )
      .join("\n") +
    "\n\n## Casos de uso\n\n" +
    usecases
      .map(
        (r) =>
          `- ${r.id}: ${r.title}. La aceptación requiere todos sus RF relacionados.`,
      )
      .join("\n") +
    "\n",
);
const groups = {
  "01_ddl": [
    "00_extensions",
    "01_schemas",
    "02_types",
    "03_tables",
    "04_alter",
    "05_views",
    "06_materialized_views",
    "07_functions",
    "08_procedures",
    "09_triggers",
    "10_indexes",
  ],
  "02_dml": [
    "00_inserts",
    "01_updates",
    "02_deletes",
    "03_upserts",
    "04_patches",
  ],
  "03_dcl": ["00_roles", "01_grants", "02_policies"],
  "04_tcl": ["00_transaction_blocks", "01_manual_recoveries"],
};
for (const [group, subdirs] of Object.entries(groups))
  for (const sub of subdirs) {
    const p = `database/${group}/${sub}`;
    fs.mkdirSync(p, { recursive: true });
    write(
      `${p}/README.md`,
      `# ${group}/${sub}\n\nOrganización inspirada exclusivamente en los nombres de carpetas del ZIP de referencia. No contiene datos ni scripts del sistema escolar.\n\n${sub === "03_tables" ? "Las tablas se crean con las migraciones propias de cada servicio en services/*/database/migrations. Son la única fuente ejecutable de DDL." : sub === "01_grants" ? "initialize-services.sh crea bases y usuarios separados; MySQL recibe secretos generados localmente." : sub === "06_materialized_views" ? "MySQL no ofrece vistas materializadas nativas. No aplicable en este incremento; proyecciones futuras mediante eventos." : "Reservado para cambios revisados de esta categoría; no implica funcionalidad implementada."}\n`,
    );
  }
for (const group of Object.keys(groups))
  write(
    `database/05_rollbacks/${group}/README.md`,
    "# Recuperación revisada\n\nNo se proporcionan reversos destructivos automáticos. Los cambios futuros incluirán procedimiento de recuperación y comprobación de integridad antes de ejecutarse.\n",
  );
write(
  "database/changelog/changelog-master.yaml",
  "format: srd-laravel-migrations-v1\nauthority: services/*/database/migrations\nservices:\n  - gateway\n  - identity\n  - configuration\n  - records\n  - audit\n  - files\n  - calendar\n# Índice documental. No ejecutarlo con Liquibase.\n",
);
console.log(
  "56 RF, 18 RNF, 20 CU verified. Traceability and database layout written.",
);
