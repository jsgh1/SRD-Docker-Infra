import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { payloadMagic, lengthPrefix, inspectPayload } from '../backup-payload.mjs';
import { seal, unseal } from '../backup-codec.mjs';

test('photo payload: authenticated roundtrip, legacy and hostile entries',async t=>{
  const base=path.resolve(import.meta.dirname,'../../.local');fs.mkdirSync(base,{recursive:true});
  const dir=fs.mkdtempSync(path.join(base,'backup-payload-test-'));
  const file=path.join(dir,'payload'),env=Buffer.from('APP_KEY_FILES=synthetic\n'),sql=Buffer.from('-- synthetic SQL\nSELECT 1;');
  const bytes=Buffer.from('synthetic image bytes');
  const entry={name:'a'.repeat(48)+'.png',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
  const object=(e=entry,b=bytes)=>{const header=Buffer.from(JSON.stringify(e));return Buffer.concat([lengthPrefix(header.length),header,b]);};
  const prefix=Buffer.concat([payloadMagic,lengthPrefix(env.length),env]);
  const payload=(objects=object())=>Buffer.concat([prefix,objects,lengthPrefix(0),sql]);
  try{
    await t.test('private documents preserve exact bytes and reject oversized objects',async()=>{
      const document={...entry,name:'b'.repeat(48)+'.bin'};
      fs.writeFileSync(file,payload(object(document)));
      const result=await inspectPayload(file);
      assert.equal(result.objects[0].name,document.name);
      assert.deepEqual(fs.readFileSync(file).subarray(result.objects[0].offset,result.objects[0].offset+document.size),bytes);
      fs.writeFileSync(file,payload(object({...document,size:20*1024*1024+1})));
      await assert.rejects(inspectPayload(file));
      fs.unlinkSync(file);
    });
    await t.test('encrypted images and SQL keep exact offsets',async()=>{
      const key=randomBytes(32),enc=path.join(dir,'sealed');
      await seal(Readable.from([payload()]),enc,key);await unseal(enc,file,key);
      const result=await inspectPayload(file);
      assert.equal(result.format,2);assert.equal(result.objects.length,1);assert.equal(result.includesFiles,true);
      assert.deepEqual(fs.readFileSync(file).subarray(result.sqlOffset),sql);
      const image=result.objects[0];assert.deepEqual(fs.readFileSync(file).subarray(image.offset,image.offset+image.size),bytes);
    });
    await t.test('old SQL-only backups remain readable',async()=>{
      fs.writeFileSync(file,Buffer.concat([lengthPrefix(env.length),env,sql]));
      const result=await inspectPayload(file);assert.equal(result.format,1);assert.deepEqual(result.objects,[]);
      assert.equal(result.includesCalendar,false);
      assert.equal(result.includesNotifications,false);
      assert.equal(result.includesTreasury,false);
      assert.equal(result.includesInventory,false);
      assert.equal(result.includesChat,false);
      assert.deepEqual(fs.readFileSync(file).subarray(result.sqlOffset),sql);
    });
    await t.test('calendar is required only for backups that include its key',async()=>{
      const current=Buffer.from('APP_KEY_FILES=synthetic\nAPP_KEY_CALENDAR=synthetic\n');
      fs.writeFileSync(file,Buffer.concat([payloadMagic,lengthPrefix(current.length),current,lengthPrefix(0),sql]));
      const result=await inspectPayload(file);
      assert.equal(result.includesFiles,true);assert.equal(result.includesCalendar,true);
      assert.equal(result.includesNotifications,false);
    });
    await t.test('notifications is required only for backups that include its key',async()=>{
      const current=Buffer.from('APP_KEY_NOTIFICATIONS=synthetic\n');
      fs.writeFileSync(file,Buffer.concat([payloadMagic,lengthPrefix(current.length),current,lengthPrefix(0),sql]));
      const result=await inspectPayload(file);
      assert.equal(result.includesNotifications,true);
    });
    await t.test('treasury is required only for backups that include its key',async()=>{
      const current=Buffer.from('APP_KEY_TREASURY=synthetic\n');
      fs.writeFileSync(file,Buffer.concat([payloadMagic,lengthPrefix(current.length),current,lengthPrefix(0),sql]));
      const result=await inspectPayload(file);
      assert.equal(result.includesTreasury,true);
    });
    await t.test('inventory is required only for backups that include its key',async()=>{
      const current=Buffer.from('APP_KEY_INVENTORY=synthetic\n');
      fs.writeFileSync(file,Buffer.concat([payloadMagic,lengthPrefix(current.length),current,lengthPrefix(0),sql]));
      const result=await inspectPayload(file);
      assert.equal(result.includesInventory,true);
    });
    await t.test('chat is required only for backups that include its key',async()=>{
      const current=Buffer.from('APP_KEY_CHAT=synthetic\n');
      fs.writeFileSync(file,Buffer.concat([payloadMagic,lengthPrefix(current.length),current,lengthPrefix(0),sql]));
      const result=await inspectPayload(file);
      assert.equal(result.includesChat,true);
    });
    for(const [name,data] of [
      ['traversal',payload(object({...entry,name:'../outside.png'}))],
      ['duplicate names',payload(Buffer.concat([object(),object()]))],
      ['incorrect hash',payload(object({...entry,sha256:'0'.repeat(64)}))],
      ['oversized image',payload(object({...entry,size:5*1024*1024+1}))],
      ['truncated object',Buffer.concat([prefix,object().subarray(0,-1)])],
      ['missing SQL',Buffer.concat([prefix,lengthPrefix(0)])],
      ['oversized metadata',Buffer.concat([prefix,lengthPrefix(1025)])],
    ])await t.test(name,async()=>{fs.writeFileSync(file,data);await assert.rejects(inspectPayload(file));});
  }finally{assert.ok(fs.realpathSync(dir).startsWith(fs.realpathSync(base)+path.sep));for(const name of fs.readdirSync(dir))fs.unlinkSync(path.join(dir,name));fs.rmdirSync(dir);}
});
