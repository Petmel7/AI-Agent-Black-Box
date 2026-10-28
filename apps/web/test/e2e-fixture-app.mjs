import { createServer } from 'node:http';

const [mode, rawPort] = process.argv.slice(2);
const port = Number(rawPort);
if (
  !['ready', 'stubborn-ready', 'stall', 'stubborn-stall', 'exit'].includes(
    mode,
  ) ||
  !Number.isSafeInteger(port) ||
  port < 1024 ||
  port > 65_535
)
  throw new Error('Invalid E2E fixture application arguments.');

if (mode === 'exit') process.exit(17);
if (mode === 'stall' || mode === 'stubborn-stall') {
  if (mode === 'stubborn-stall') process.on('SIGTERM', () => undefined);
  setInterval(() => undefined, 60_000);
} else {
  const server = createServer((request, response) => {
    response.writeHead(request.url === '/health' ? 200 : 404, {
      'content-type': 'text/plain; charset=utf-8',
    });
    response.end(request.url === '/health' ? 'ok' : 'not found');
  });
  server.listen(port, '127.0.0.1');
  const close = () => server.close(() => process.exit(0));
  process.once('SIGINT', close);
  if (mode === 'stubborn-ready') process.on('SIGTERM', () => undefined);
  else process.once('SIGTERM', close);
}
