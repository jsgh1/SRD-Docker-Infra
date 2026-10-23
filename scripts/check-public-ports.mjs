import net from 'node:net';

const host = '144.91.126.25';
const checks = await Promise.all([22, 80, 443, 3306, 8000, 8080, 3310, 1025].map(port => new Promise(resolve => {
  const socket = net.connect({ host, port });
  const timer = setTimeout(() => { socket.destroy(); resolve([port, 'closed-or-filtered']); }, 2500);
  socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve([port, 'open']); });
  socket.once('error', () => { clearTimeout(timer); resolve([port, 'closed-or-filtered']); });
})));
for (const [port, status] of checks) process.stdout.write(`${port}: ${status}\n`);
if (checks.some(([port, status]) => ![22, 80, 443].includes(port) && status === 'open')) process.exitCode = 1;
