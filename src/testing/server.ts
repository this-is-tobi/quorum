/** A fake server for the few tests that read a streamed reply through the real `fetch`: the one module that uses `node:http`. */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createServer } from 'node:http'

/**
 * A server on 127.0.0.1, port 0, that hands every request to `handle` and writes with no delay. A handler that
 * throws destroys its connection. `close()` ends every connection, then the server.
 */
export async function fakeServer(
  handle: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
): Promise<{ readonly url: string, readonly close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    Promise.resolve()
      .then(async () => handle(request, response))
      .catch(() => response.destroy())
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => {
        server.close(error => error
          ? reject(error)
          : resolve())
      })
    },
  }
}
