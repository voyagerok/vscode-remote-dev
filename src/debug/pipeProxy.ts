// Standalone script launched by cppdbg as its pipeTransport program:
//   <electron> pipeProxy.js <socket> <folderUri> <command...>
// with ELECTRON_RUN_AS_NODE=1 and REMOTE_DEV_TOKEN in the environment. It forwards
// stdio to the extension, which runs the command on the remote over the already
// authenticated SSH connection.

import * as net from 'net';
import { FRAME_EXIT, FRAME_STDERR, FRAME_STDOUT, FrameDecoder } from './protocol';

function main(): void {
  const [socketPath, folder, ...rest] = process.argv.slice(2);
  const token = process.env.REMOTE_DEV_TOKEN ?? '';
  if (!socketPath || !folder || !rest.length) {
    process.stderr.write('usage: pipeProxy <socket> <folderUri> <command...>\n');
    process.exit(2);
  }
  const command = rest.join(' ');
  let exitCode = 255;

  const sock = net.connect({ path: socketPath, allowHalfOpen: true }, () => {
    sock.write(JSON.stringify({ token, folder, command }) + '\n');
    process.stdin.pipe(sock);
  });

  const decoder = new FrameDecoder((kind, payload) => {
    if (kind === FRAME_STDOUT) process.stdout.write(payload);
    else if (kind === FRAME_STDERR) process.stderr.write(payload);
    else if (kind === FRAME_EXIT) exitCode = Number(payload.toString('utf8')) || 0;
  });
  sock.on('data', (d: Buffer) => decoder.push(d));
  sock.on('end', () => {
    // Let stdout drain before exiting.
    process.stdout.write('', () => process.exit(exitCode));
  });
  sock.on('error', (e) => {
    process.stderr.write(`remote-dev pipe proxy: ${e.message}\n`);
    process.exit(255);
  });
}

main();
