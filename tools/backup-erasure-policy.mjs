function count(value) {
  const text = String(value).trim();
  if (!/^(0|[1-9][0-9]*)$/.test(text)) throw new Error('La comprobacion de supresiones devolvio un conteo invalido.');
  return BigInt(text);
}

export function compareErasureRows(erased, tables, query, hasColumn) {
  for (const pair of erased) {
    if (pair.length !== 2 || pair.some(id => !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id))) {
      throw new Error('Identificador de supresion inesperado.');
    }
  }
  const available = (db, table) => tables.some(row => row[0] === db && row[1] === table);
  for (let start = 0; start < erased.length; start += 100) {
    const batch = erased.slice(start, start + 100);
    const tuples = batch.map(([org, person]) => `('${org}','${person}')`).join(',');
    const organizations = [...new Set(batch.map(([org]) => `'${org}'`))].join(',');
    const checks = [
      available('srd_records', 'persons') && `SELECT COUNT(*) FROM srd_records.persons WHERE (organization_id,id) IN (${tuples});`,
      available('srd_files', 'person_photos') && `SELECT COUNT(*) FROM srd_files.person_photos WHERE (organization_id,person_id) IN (${tuples});`,
      available('srd_identity', 'memberships') && hasColumn('srd_identity', 'memberships', 'person_id') && `SELECT COUNT(*) FROM srd_identity.memberships WHERE (organization_id,person_id) IN (${tuples});`,
      available('srd_identity', 'invitations') && hasColumn('srd_identity', 'invitations', 'person_id') && `SELECT COUNT(*) FROM srd_identity.invitations WHERE (organization_id,person_id) IN (${tuples});`,
      // Ready export files cannot be attributed reliably; reject all stored exports in the affected junta.
      available('srd_records', 'person_export_jobs') && `SELECT COUNT(*) FROM srd_records.person_export_jobs WHERE organization_id IN (${organizations});`,
    ].filter(Boolean);
    if (checks.some(sql => count(query(sql)) > 0n)) throw new Error('La copia recuperaria datos de una supresion posterior. No es apta para restauracion sin conciliacion.');
  }
  return { status: 'compared', current_erasures: erased.length, conflicts: 0 };
}
