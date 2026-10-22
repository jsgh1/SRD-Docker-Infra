import fs from 'node:fs';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { pipeline } from 'node:stream/promises';

const magic = Buffer.from('SRDBK01\n');
export async function seal(input, destination, key) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(magic);
  fs.writeFileSync(destination, Buffer.concat([magic, nonce]), { flag: 'wx', mode: 0o600 });
  await pipeline(input, cipher, fs.createWriteStream(destination, { flags: 'a' }));
  fs.appendFileSync(destination, cipher.getAuthTag());
}

// The caller must never use the output before this promise authenticates the entire file.
export async function unseal(source, destination, key) {
  const size = fs.statSync(source).size;
  if (size < 40) throw new Error('Copia truncada.');
  const fd = fs.openSync(source, 'r');
  const header = Buffer.alloc(20), tag = Buffer.alloc(16);
  try { fs.readSync(fd, header, 0, 20, 0); fs.readSync(fd, tag, 0, 16, size - 16); }
  finally { fs.closeSync(fd); }
  if (!header.subarray(0, 8).equals(magic)) throw new Error('Formato de copia desconocido.');
  const decipher = createDecipheriv('aes-256-gcm', key, header.subarray(8));
  decipher.setAAD(magic); decipher.setAuthTag(tag);
  const output = fs.openSync(destination, 'wx', 0o600);
  try {
    await pipeline(fs.createReadStream(source, { start: 20, end: size - 17 }), decipher,
      fs.createWriteStream(destination, { fd: output, autoClose: true }));
  } catch (error) {
    // Only our newly-created temporary is removed; never replace an existing file.
    fs.rmSync(destination, { force: true });
    throw new Error('No se pudo autenticar la copia; clave incorrecta, archivo alterado o error de lectura.');
  }
}

export async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
