import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { seal, unseal, digest } from './backup-codec.mjs';
import { payloadMagic, lengthPrefix, inspectPayload } from './backup-payload.mjs';
import { compareErasureRows } from './backup-erasure-policy.mjs';

const root = fs.realpathSync(path.resolve(import.meta.dirname, '..'));
process.chdir(root);
const directory = path.join(root, '.local', 'backups');
const projectName = JSON.parse(fs.readFileSync(path.join(root, 'compose.yaml'), 'utf8')).name;
const databases = ['gateway', 'identity', 'configuration', 'records', 'audit', 'files', 'calendar', 'notifications', 'treasury', 'inventory', 'chat'].map(name => 'srd_' + name);
const command = process.argv[2];
const id = randomUUID();
let container, temporary, activeChild, result;
let interrupted = false;
let secured = false;
let stoppedContainers = [], pauseManifest, backupLock, ownsBackupLock=false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { interrupted = true; activeChild?.kill(); });

function within(file) {
  const relative = path.relative(fs.realpathSync(directory), fs.realpathSync(file));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('La ruta debe estar dentro de .local/backups.');
  return file;
}
function run(args, options = {}) {
  try { return execFileSync('docker', args, { cwd: root, windowsHide: true, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 120000, maxBuffer: 16 * 1024 * 1024, ...options }).trim(); }
  catch (error) {
    const code = error.stderr?.toString().match(/\bERROR (\d{3,5})\b/)?.[1];
    throw new Error('Fallo de Docker en la operacion de respaldo' + (code ? ' (MySQL ' + code + ')' : '') + '; las salidas con datos no se muestran.');
  }
}
function launch(args, options = {}) {
  const child = spawn('docker', args, { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], ...options });
  activeChild = child;
  let mysqlCode;
  child.stderr.on('data', chunk => { mysqlCode ??= chunk.toString().match(/\bERROR (\d{3,5})\b/)?.[1]; });
  const done = new Promise((resolve, reject) => {
    child.on('error', () => reject(new Error('No se pudo iniciar Docker.')));
    child.on('close', code => code === 0 ? resolve() : reject(new Error('Docker no completo la copia o importacion' + (mysqlCode ? ' (MySQL ' + mysqlCode + ')' : '') + '.')));
  });
  return { child, done };
}
function audit(event, details = {}) {
  const log = path.join(directory, 'operations.jsonl');
  if (fs.existsSync(log)) within(log);
  fs.appendFileSync(log, JSON.stringify({ at: new Date().toISOString(), operation: command, run_id: id, event, ...details }) + '\n', { mode: 0o600 });
}
function secureDirectory() {
  const local = path.join(root, '.local');
  if (fs.existsSync(local) && fs.realpathSync(local).toLowerCase() !== local.toLowerCase()) throw new Error('No se permiten enlaces para .local.');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const expected = path.join(root, '.local', 'backups');
  if (fs.realpathSync(directory).toLowerCase() !== expected.toLowerCase()) throw new Error('No se permiten enlaces de directorio para los respaldos.');
  if (process.platform === 'win32') {
    const sid = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value'], { encoding: 'utf8', windowsHide: true }).trim();
    if (!/^S-1-[0-9-]+$/.test(sid)) throw new Error('No se pudo identificar al propietario local.');
    // Changes apply only to SRD's backup directory, not global Windows permissions.
    execFileSync('icacls.exe', [directory, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'], { windowsHide: true, stdio: 'pipe' });
    // Existing explicit grants are not removed by icacls /grant:r. Fail closed if any remain.
    const check = "$allowed=@([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18'); $items=@(Get-Item -LiteralPath '.local/backups')+@(Get-ChildItem -LiteralPath '.local/backups' -File); foreach($item in $items){$acl=Get-Acl -LiteralPath $item.FullName; foreach($rule in $acl.Access){if($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -notin $allowed){exit 1}}}";
    try { execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', check], { cwd: root, windowsHide: true, stdio: 'pipe' }); }
    catch { throw new Error('Hay permisos explicitos inesperados en el directorio de respaldos; no se crearan ni descifraran copias.'); }
  } else fs.chmodSync(directory, 0o700);
}
function key(create = false) {
  const file = path.join(directory, 'recovery-key.bin');
  if (!fs.existsSync(file) && create) fs.writeFileSync(file, randomBytes(32), { flag: 'wx', mode: 0o600 });
  within(file);
  const bytes = fs.readFileSync(file);
  if (bytes.length !== 32) throw new Error('Clave de recuperacion invalida.');
  return bytes;
}
function selectedBackup() {
  const name = process.argv[3] || fs.readdirSync(directory).filter(name => name.endsWith('.srdbackup')).sort().at(-1);
  if (!name) throw new Error('No hay copias disponibles.');
  const file = path.isAbsolute(name) ? name : path.join(directory, name);
  if (!file.endsWith('.srdbackup')) throw new Error('Selecciona un archivo .srdbackup.');
  return within(file);
}
async function backup() {
  if (fs.realpathSync(path.join(root, '.env')).toLowerCase() !== path.join(root, '.env').toLowerCase()) throw new Error('La configuracion debe ser un archivo local del proyecto.');
  const environment = fs.readFileSync(path.join(root, '.env'));
  if (!environment.length || environment.length > 65536) throw new Error('Configuracion local ausente o demasiado grande.');
  const file = path.join(directory, new Date().toISOString().replace(/[:.]/g, '-') + '-' + id + '.srdbackup');
  temporary = file + '.partial';
  const encryptionKey = key(true);
  backupLock=path.join(directory,'.backup.lock');
  // Prevent concurrent backups from resuming each other's stopped services.
  const lock=fs.openSync(backupLock,'wx',0o600);ownsBackupLock=true;fs.writeFileSync(lock,id);fs.closeSync(lock);
  const compose=JSON.parse(fs.readFileSync('compose.yaml','utf8'));
  const writers=new Set(['web','gateway','identity','configuration','records','audit','files','calendar','notifications','treasury','inventory','chat','identity-scheduler','configuration-scheduler','records-scheduler','files-scheduler','calendar-scheduler','notifications-scheduler','treasury-scheduler','inventory-scheduler','chat-scheduler']);
  const running=run(['compose','ps','--status','running','--format','json']);
  const rows=running.trim().startsWith('[')?JSON.parse(running):running.split('\n').filter(Boolean).map(line=>JSON.parse(line));
  const candidates=rows.filter(row=>writers.has(row.Service)).map(row=>row.ID);
  for(const cid of candidates) {
    if(!/^[a-f0-9]{12,64}$/.test(cid)||run(['inspect','--format','{{index .Config.Labels "com.docker.compose.project"}}',cid])!==compose.name)throw new Error('Contenedor ajeno al proyecto.');
  }
  stoppedContainers=candidates;
  pauseManifest=path.join(directory,'.paused-'+id+'.json');
  fs.writeFileSync(pauseManifest,JSON.stringify({run_id:id,containers:stoppedContainers}),{flag:'wx',mode:0o600});
  if(stoppedContainers.length)run(['stop','--time','30',...stoppedContainers]);
  audit('writers_stopped',{count:stoppedContainers.length});
  const photos=launch(['compose','run','--rm','--no-deps','-T','files','php']);
  photos.child.stdin.end(fs.readFileSync(path.join(root,'tools/export-photo-backup.php')));
  // Avoid unhandled rejection while the generator is exporting images.
  photos.done.catch(()=>{});
  const { child, done } = launch(['compose', 'exec', '-T', 'mysql', 'sh', '-c',
    'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysqldump --user=root --single-transaction --quick --hex-blob --routines --events --triggers --no-tablespaces --set-gtid-purged=OFF --databases ' + databases.join(' ')]);
  child.stdin.end();
  async function* payload() {
    yield payloadMagic;yield lengthPrefix(environment.length);yield environment;
    for await(const chunk of photos.child.stdout)yield chunk;
    await photos.done;
    for await (const chunk of child.stdout) yield chunk;
  }
  const writing = seal(Readable.from(payload()), temporary, encryptionKey);
  try { await Promise.all([writing, done, photos.done]); }
  catch (error) { child.kill(); child.stdout.destroy(); photos.child.kill(); photos.child.stdout.destroy(); await Promise.allSettled([writing, done, photos.done]); throw error; }
  if (interrupted) throw new Error('Operacion interrumpida.');
  fs.renameSync(temporary, file); temporary = undefined;
  const metadata = { format: 2, created_at: new Date().toISOString(), file: path.basename(file), bytes: fs.statSync(file).size, sha256: await digest(file), databases, environment_included: true, private_objects_included: true, consistency: 'SRD writers stopped during SQL and photo export' };
  fs.writeFileSync(file + '.json', JSON.stringify(metadata, null, 2), { flag: 'wx', mode: 0o600 });
  audit('backup_completed', metadata);
  return metadata;
}
async function authenticatedPayload() {
  const file = selectedBackup();
  temporary = path.join(directory, '.verified-' + id + '.payload');
  await unseal(file, temporary, key());
  return { file, ...await inspectPayload(temporary), sha256: await digest(file) };
}
function sql(query) {
  return run(['exec', container, 'sh', '-c', 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql --protocol=TCP --host=127.0.0.1 --user=root --batch --raw --skip-column-names --local-infile=0 --execute "$1"', 'srd-query', query]);
}
function liveSql(query) {
  return run(['compose', 'exec', '-T', 'mysql', 'sh', '-c', 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql --protocol=TCP --host=127.0.0.1 --user=root --batch --raw --skip-column-names --local-infile=0 --execute "$1"', 'srd-live-query', query]);
}
function erasureComparison(tables) {
  // The current operational database is a local reference, never a source of data to import.
  if (!run(['compose', 'ps', '-q', 'mysql'])) return { status: 'unavailable' };
  if (Number(liveSql("SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='srd_records' AND TABLE_NAME='privacy_requests';")) !== 1) return { status: 'unavailable' };
  const erased = liveSql("SELECT DISTINCT organization_id,person_id FROM srd_records.privacy_requests WHERE kind='erasure' AND status IN ('erasure_in_progress','erased');")
    .split('\n').filter(Boolean).map(line => line.split('\t'));
  const hasColumn = (db, table, column) => Number(sql(`SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='${db}' AND TABLE_NAME='${table}' AND COLUMN_NAME='${column}';`)) === 1;
  return compareErasureRows(erased, tables, sql, hasColumn);
}
function identifier(value) {
  if (!/^[a-zA-Z0-9_]+$/.test(value)) throw new Error('Identificador inesperado en la copia.');
  return '`' + value + '`';
}
async function restoreTest(payload) {
  const image = JSON.parse(fs.readFileSync('compose.yaml', 'utf8')).services.mysql.image;
  if (!/^mysql:8\.4@sha256:[a-f0-9]{64}$/.test(image)) throw new Error('Imagen MySQL no reconocida.');
  const name = 'srd-restore-' + id;
  container = run(['run', '--detach', '--rm', '--pull', 'never', '--network', 'none', '--memory', '768m', '--cpus', '1', '--label', 'srd.restore-probe=' + id,
    '--name', name, '-e', 'MYSQL_ROOT_PASSWORD', image], { env: { ...process.env, MYSQL_ROOT_PASSWORD: randomBytes(32).toString('hex') } });
  if (!/^[a-f0-9]{64}$/.test(container)) throw new Error('No se pudo identificar el contenedor temporal.');
  audit('isolated_container_started', { container });
  let ready = false;
  let lastReadinessError;
  // The image's bootstrap server uses only a socket. TCP selects the final server.
  // Docker Desktop may need several minutes for first-time InnoDB initialization.
  const deadline = Date.now() + 600000;
  while (Date.now() < deadline) {
    if (interrupted) throw new Error('Operacion interrumpida.');
    try { sql('SELECT 1;'); ready = true; break; } catch (error) { lastReadinessError = error.message; await new Promise(resolve => setTimeout(resolve, 1000)); }
  }
  if (!ready) throw new Error('MySQL temporal no estuvo disponible a tiempo. ' + lastReadinessError);
  audit('isolated_mysql_ready');
  const { child, done } = launch(['exec', '-i', container, 'sh', '-c', 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql --protocol=TCP --host=127.0.0.1 --user=root --local-infile=0']);
  child.stdout.resume();
  const importing = pipeline(fs.createReadStream(temporary, { start: payload.sqlOffset }), child.stdin);
  try { await Promise.all([importing, done]); }
  catch (error) { child.kill(); await Promise.allSettled([importing, done]); throw error; }
  audit('sql_imported');
  const tables = sql("SELECT TABLE_SCHEMA,TABLE_NAME FROM information_schema.TABLES WHERE TABLE_TYPE='BASE TABLE' AND TABLE_SCHEMA IN (" + databases.map(db => "'" + db + "'").join(',') + ') ORDER BY TABLE_SCHEMA,TABLE_NAME;').split('\n').filter(Boolean).map(line => line.split('\t'));
  const counts = {};
  for (const [db, table] of tables) {
    if (!databases.includes(db)) throw new Error('Base inesperada.');
    const target = identifier(db) + '.' + identifier(table);
    if (!sql('CHECK TABLE ' + target + ';').endsWith('\tstatus\tOK')) throw new Error('La comprobacion de tabla fallo.');
    counts[db] ??= { tables: 0, rows: 0 };
    counts[db].tables++; counts[db].rows += Number(sql('SELECT COUNT(*) FROM ' + target + ';'));
  }
  // Historical backups precede some services; require only databases present when created.
  for (const db of databases.filter(db => (db !== 'srd_files' || payload.includesFiles) && (db !== 'srd_calendar' || payload.includesCalendar) && (db !== 'srd_notifications' || payload.includesNotifications) && (db !== 'srd_treasury' || payload.includesTreasury) && (db !== 'srd_inventory' || payload.includesInventory) && (db !== 'srd_chat' || payload.includesChat))) if (!counts[db]?.tables) throw new Error('Falta una base del respaldo.');
  audit('tables_checked', { tables: tables.length });
  const erasure = erasureComparison(tables);
  audit('erasure_compared', erasure);
  // Verify every declared FK, including composite references, after import.
  const references = sql("SELECT TABLE_SCHEMA,TABLE_NAME,CONSTRAINT_NAME,COLUMN_NAME,REFERENCED_TABLE_SCHEMA,REFERENCED_TABLE_NAME,REFERENCED_COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE REFERENCED_TABLE_NAME IS NOT NULL AND TABLE_SCHEMA IN (" + databases.map(db => "'" + db + "'").join(',') + ') ORDER BY TABLE_SCHEMA,TABLE_NAME,CONSTRAINT_NAME,ORDINAL_POSITION;');
  const groups = new Map();
  for (const line of references.split('\n').filter(Boolean)) { const row = line.split('\t'); const k = row.slice(0, 3).join('.'); groups.set(k, [...(groups.get(k) || []), row]); }
  for (const rows of groups.values()) {
    const [db, table, , , parentDb, parentTable] = rows[0];
    if (!databases.includes(parentDb)) throw new Error('Referencia fuera de las bases esperadas.');
    const childTable = identifier(db) + '.' + identifier(table), parent = identifier(parentDb) + '.' + identifier(parentTable);
    const join = rows.map(r => 'c.' + identifier(r[3]) + '=p.' + identifier(r[6])).join(' AND ');
    const nonnull = rows.map(r => 'c.' + identifier(r[3]) + ' IS NOT NULL').join(' AND ');
    if (Number(sql(`SELECT COUNT(*) FROM ${childTable} c LEFT JOIN ${parent} p ON ${join} WHERE ${nonnull} AND p.${identifier(rows[0][6])} IS NULL;`)) !== 0) throw new Error('La copia contiene referencias huerfanas.');
  }
  if (payload.includesTreasury) {
    const difference = sql('SELECT COUNT(*) FROM srd_treasury.treasury_accounts a WHERE a.balance_cents <> (SELECT COALESCE(SUM(m.sign * CAST(m.amount_cents AS SIGNED)),0) FROM srd_treasury.treasury_movements m WHERE m.organization_id=a.organization_id) OR a.next_number <> 1 + (SELECT COUNT(*) FROM srd_treasury.treasury_movements m WHERE m.organization_id=a.organization_id);');
    if (Number(difference) !== 0) throw new Error('La cuenta de tesoreria no concilia con sus asientos.');
    const history = sql('SELECT COUNT(*) FROM (SELECT balance_after_cents, SUM(sign * CAST(amount_cents AS SIGNED)) OVER (PARTITION BY organization_id ORDER BY number) AS expected FROM srd_treasury.treasury_movements) x WHERE balance_after_cents <> expected;');
    if (Number(history) !== 0) throw new Error('Un comprobante de tesoreria no concilia con el historial.');
    audit('treasury_reconciled');
  }
  if (payload.includesInventory) {
    const mismatch = sql("SELECT COUNT(*) FROM srd_inventory.assets a WHERE a.quantity <> (SELECT COALESCE(SUM(m.delta),0) FROM srd_inventory.asset_movements m WHERE m.asset_id=a.id) OR a.version < 1;");
    if (Number(mismatch) !== 0) throw new Error('El inventario no concilia con sus movimientos.');
    const history = sql('SELECT COUNT(*) FROM (SELECT quantity_before,quantity_after,delta,LAG(quantity_after) OVER (PARTITION BY asset_id ORDER BY sequence) AS previous FROM srd_inventory.asset_movements) x WHERE quantity_after <> quantity_before + delta OR (previous IS NOT NULL AND quantity_before <> previous);');
    if (Number(history) !== 0) throw new Error('El historial de inventario no concilia.');
    audit('inventory_reconciled');
  }
  let photoReport={included:false};
  if(payload.format===2){
    const objects=new Map(payload.objects.map(object=>[object.name,object]));
    run(['exec',container,'mkdir','-m','700','/tmp/srd-photo-restore']);
    for(const object of objects.values()){
      const target='/tmp/srd-photo-restore/'+object.name;
      const stream=launch(['exec','-i',container,'sh','-c','umask 077; cat > "$1"','srd-photo',target]);
      stream.child.stdout.resume();
      const copying=pipeline(fs.createReadStream(temporary,{start:object.offset,end:object.offset+object.size-1}),stream.child.stdin);
      try{await Promise.all([copying,stream.done]);}catch(error){stream.child.kill();await Promise.allSettled([copying,stream.done]);throw error;}
      if(run(['exec',container,'sha256sum',target]).split(/\s+/)[0]!==object.sha256)throw new Error('La imagen restaurada no coincide.');
    }
    const assetPhotos=tables.some(([db,table])=>db==='srd_files'&&table==='asset_photos');
    const documents=tables.some(([db,table])=>db==='srd_files'&&table==='folder_documents');
    const references=sql('SELECT blob_id,bytes,sha256 FROM srd_files.person_photos WHERE blob_id IS NOT NULL' + (assetPhotos ? ' UNION ALL SELECT blob_id,bytes,sha256 FROM srd_files.asset_photos WHERE blob_id IS NOT NULL' : '') + ';').split('\n').filter(Boolean).map(line=>line.split('\t'));
    const garbage=sql('SELECT blob_id,bytes FROM srd_files.file_garbage;').split('\n').filter(Boolean).map(line=>line.split('\t'));
    const used=new Set();
    for(const [blob,size,hash] of [...references,...garbage]){
      const object=objects.get(blob+'.png');
      if(!object||object.size!==Number(size)||(hash&&object.sha256!==hash)||used.has(blob))throw new Error('Metadatos de fotografía incompatibles con los objetos restaurados.');
      used.add(blob);
    }
    const documentRows=documents?sql('SELECT blob_id,bytes,sha256,ready FROM srd_files.folder_documents;').split('\n').filter(Boolean).map(line=>line.split('\t')):[];
    for(const [blob,size,hash,ready] of documentRows){
      if(!/^[a-f0-9]{48}$/.test(blob)||used.has(blob))throw new Error('Referencia de documento inválida.');
      const object=objects.get(blob+'.bin');
      if(ready==='1'&&(!object||object.size!==Number(size)||object.sha256!==hash))throw new Error('Documento restaurado incompleto.');
      if(object)used.add(blob);
    }
    if(Number(sql('SELECT COUNT(*) FROM srd_files.file_quotas q WHERE q.reserved_bytes <> (SELECT COALESCE(SUM(p.bytes),0) FROM srd_files.person_photos p WHERE p.organization_id=q.organization_id)' + (assetPhotos ? ' + (SELECT COALESCE(SUM(a.bytes),0) FROM srd_files.asset_photos a WHERE a.organization_id=q.organization_id)' : '') + (documents?' + (SELECT COALESCE(SUM(d.bytes),0) FROM srd_files.folder_documents d WHERE d.organization_id=q.organization_id)':'') + ' + (SELECT COALESCE(SUM(g.bytes),0) FROM srd_files.file_garbage g WHERE g.organization_id=q.organization_id);'))!==0)throw new Error('Cuotas de archivos inconsistentes.');
    if(tables.some(([db,table])=>db==='srd_files'&&table==='file_deleted_persons')&&Number(sql('SELECT COUNT(*) FROM srd_files.person_photos p JOIN srd_files.file_deleted_persons d ON p.organization_id=d.organization_id AND p.person_id=d.person_id;'))!==0)throw new Error('Hay fotos de una persona marcada como eliminada.');
    photoReport={included:true,restored:objects.size,active:references.length,documents:documentRows.filter(r=>r[3]==='1').length,pending_documents:documentRows.filter(r=>r[3]!=='1').length,pending_removal:garbage.length,unreferenced:objects.size-used.size,hashes_verified:true,quotas_verified:true};
    audit('photos_restored',photoReport);
  }
  return { file: path.basename(payload.file), sha256: payload.sha256, databases: counts, foreign_keys_checked: groups.size, photos:photoReport, erasure_comparison: erasure, isolated: true };
}

try {
  if (!['create', 'verify', 'restore-test'].includes(command)) throw new Error('Usa create, verify o restore-test.');
  secureDirectory(); secured = true; audit('started');
  if (command === 'create') result = await backup();
  else {
    const payload = await authenticatedPayload();
    if (interrupted) throw new Error('Operacion interrumpida.');
    result = command === 'verify' ? { file: path.basename(payload.file), sha256: payload.sha256, authenticated: true, format:payload.format, private_objects_included:payload.format===2, objects:payload.objects.length } : await restoreTest(payload);
    audit('completed', result);
  }
  if (interrupted) throw new Error('Operacion interrumpida.');
} catch (error) {
  if (secured) { try { audit('failed'); } catch {} }
  process.stderr.write('Respaldo no completado: ' + error.message + '\n'); process.exitCode = 1;
} finally {
  if(stoppedContainers.length){
    let pending=stoppedContainers;
    for(let attempt=0;attempt<2&&pending.length;attempt++){
      const retry=[];
      for(const cid of pending){
        try{
          if(run(['inspect','--format','{{index .Config.Labels "com.docker.compose.project"}}',cid])!==projectName)throw new Error('Contenedor ajeno');
          if(run(['inspect','--format','{{.State.Running}}',cid])!=='true')run(['start',cid]);
        }catch{retry.push(cid);}
      }
      pending=retry;
    }
    if(!pending.length){audit('writers_resumed',{count:stoppedContainers.length});stoppedContainers=[];}
    else{process.stderr.write('No se pudieron reanudar todos los servicios de SRD; revisa el manifiesto privado de pausa y ejecuta scripts/Up.ps1 -SkipBuild.\n');process.exitCode=1;}
  }
  if(pauseManifest&&stoppedContainers.length===0&&fs.existsSync(pauseManifest)){within(pauseManifest);fs.unlinkSync(pauseManifest);}
  if(ownsBackupLock&&backupLock&&fs.existsSync(backupLock)){within(backupLock);fs.unlinkSync(backupLock);}
  if (temporary && fs.existsSync(temporary)) {
    try { within(temporary); fs.rmSync(temporary); }
    catch { process.stderr.write('No se pudo retirar el temporal privado del respaldo.\n'); process.exitCode = 1; }
  }
  if (container && /^[a-f0-9]{64}$/.test(container)) {
    try {
      const label = run(['inspect', '--format', '{{index .Config.Labels "srd.restore-probe"}}', container]);
      if (label !== id) throw new Error('No se elimina un contenedor ajeno.');
      run(['rm', '--force', container]);
    } catch { process.stderr.write('No se pudo retirar el contenedor de prueba ' + container + '.\n'); process.exitCode = 1; }
  }
}
if (!process.exitCode && result) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
