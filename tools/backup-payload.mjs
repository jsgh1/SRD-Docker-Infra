import fs from 'node:fs';
import { createHash } from 'node:crypto';

export const payloadMagic = Buffer.from('SRDP02\r\n');
export function lengthPrefix(length) { const b=Buffer.alloc(4); b.writeUInt32BE(length); return b; }

// Called only after the outer AEAD envelope has authenticated the entire payload.
export async function inspectPayload(file) {
  const fd=fs.openSync(file,'r'), total=fs.fstatSync(fd).size;
  let offset=0;
  const read=n=>{if(!Number.isSafeInteger(n)||n<0||offset+n>total)throw new Error('Contenido de copia truncado.');const b=Buffer.alloc(n);if(fs.readSync(fd,b,0,n,offset)!==n)throw new Error('Lectura de copia incompleta.');offset+=n;return b;};
  try {
    const first=read(8);const modern=first.equals(payloadMagic);offset=modern?8:0;
    const length=read(4).readUInt32BE();if(!length||length>65536)throw new Error('Configuración de copia inválida.');
    const environment=read(length);const objects=[];const names=new Set();
    if(modern) while(true) {
      const length=read(4).readUInt32BE();if(!length)break;
      if(length>1024||objects.length>=100000)throw new Error('Índice de imágenes demasiado grande.');
      const entry=JSON.parse(read(length).toString('utf8'));
      if(!/^[a-f0-9]{48}\.(png|bin)$/.test(entry.name)||names.has(entry.name)||!Number.isInteger(entry.size)||entry.size<1||entry.size>(entry.name.endsWith('.bin')?20:5)*1024*1024||!/^[a-f0-9]{64}$/.test(entry.sha256))throw new Error('Entrada de archivo inválida.');
      names.add(entry.name);
      const start=offset;if(offset+entry.size>total)throw new Error('Imagen truncada.');
      const hash=createHash('sha256');
      for await(const chunk of fs.createReadStream(file,{start,end:start+entry.size-1}))hash.update(chunk);
      if(hash.digest('hex')!==entry.sha256)throw new Error('Imagen alterada dentro de la copia.');
      offset+=entry.size;objects.push({name:entry.name,size:entry.size,sha256:entry.sha256,offset:start});
    }
    if(offset>=total)throw new Error('Falta el volcado SQL.');
    return {format:modern?2:1,sqlOffset:offset,includesFiles:/^APP_KEY_FILES=/m.test(environment.toString('utf8')),includesCalendar:/^APP_KEY_CALENDAR=/m.test(environment.toString('utf8')),includesNotifications:/^APP_KEY_NOTIFICATIONS=/m.test(environment.toString('utf8')),includesTreasury:/^APP_KEY_TREASURY=/m.test(environment.toString('utf8')),includesInventory:/^APP_KEY_INVENTORY=/m.test(environment.toString('utf8')),includesChat:/^APP_KEY_CHAT=/m.test(environment.toString('utf8')),objects};
  } finally {fs.closeSync(fd);}
}
