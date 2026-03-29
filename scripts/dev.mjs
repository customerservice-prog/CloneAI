import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

function findFreePort(preferred, maxAttempts = 50) {
  return new Promise((resolve, reject) => {
    const tryListen = (p) => {
      if (p >= preferred + maxAttempts) {
        reject(
          new Error(`No free port found starting at ${preferred} (tried ${maxAttempts} ports).`)
        );
        return;
      }
      const probe = net.createServer();
      probe.unref();
      probe.once('error', () => tryListen(p + 1));
      probe.listen(p, () => {
        probe.close(() => resolve(p));
      });
    };
    tryListen(preferred);
  });
}

const apiPort = await findFreePort(3001);
const webPort = await findFreePort(5173);

console.log(`CloneAI dev — picking free ports (avoiding anything already in use).`);
console.log(`  API → http://127.0.0.1:${apiPort}`);
console.log(`  App → http://127.0.0.1:${webPort}\n`);

const backend = spawn(process.execPath, ['server.js'], {
  cwd: path.join(root, 'backend'),
  env: { ...process.env, PORT: String(apiPort) },
  stdio: 'inherit',
});

const viteCli = path.join(root, 'frontend', 'node_modules', 'vite', 'bin', 'vite.js');
const frontend = spawn(
  process.execPath,
  [viteCli, 'dev', '--port', String(webPort)],
  {
    cwd: path.join(root, 'frontend'),
    env: { ...process.env, VITE_API_URL: `http://127.0.0.1:${apiPort}` },
    stdio: 'inherit',
  }
);

function shutdown() {
  backend.kill('SIGTERM');
  frontend.kill('SIGTERM');
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

backend.on('exit', (code, signal) => {
  if (signal !== 'SIGTERM' && code !== 0) {
    frontend.kill('SIGTERM');
    process.exit(code ?? 1);
  }
});

frontend.on('exit', (code, signal) => {
  if (signal !== 'SIGTERM' && code !== 0) {
    backend.kill('SIGTERM');
    process.exit(code ?? 1);
  }
});
