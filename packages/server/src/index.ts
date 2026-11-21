import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

export interface ServerOptions {
  host?: string;
  port?: number;
}

export interface ServerHandle {
  readonly url: string;
  close(): Promise<void>;
}

export async function startServer(options: ServerOptions = {}): Promise<ServerHandle> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 0;
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true }));
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      reject(error);
    };

    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    throw new Error('Server did not bind to a TCP address');
  }

  return {
    url: `http://${host}:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}

function isEntrypoint(): boolean {
  const entrypoint = process.argv[1];
  return entrypoint !== undefined && pathToFileURL(entrypoint).href === import.meta.url;
}

if (isEntrypoint()) {
  const server = await startServer();
  console.log(`T3-Tab server listening on ${server.url}`);

  const shutdown = async (): Promise<void> => {
    await server.close();
    process.exitCode = 0;
  };

  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}
