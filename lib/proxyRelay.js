// Minimal HTTP CONNECT tunnel relay that forwards to an authenticated upstream proxy.
// proxy-chain was returning ERR_TUNNEL_CONNECTION_FAILED for our use case;
// this is a straight-line implementation that matches what curl does with -x.
//
// Chromium connects to localhost:PORT, sends CONNECT foo.com:443, we open a TCP
// connection to the upstream proxy, send CONNECT with Basic auth, and pipe.

const net = require('net');
const http = require('http');

function relay({ upstreamHost, upstreamPort, upstreamUser, upstreamPass, listenPort = 0 }) {
  const auth = 'Basic ' + Buffer.from(`${upstreamUser}:${upstreamPass}`).toString('base64');

  const server = http.createServer((req, res) => {
    // Non-CONNECT (plain HTTP) — forward through upstream proxy
    const opts = {
      host: upstreamHost,
      port: upstreamPort,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, 'Proxy-Authorization': auth },
    };
    const up = http.request(opts, (upRes) => {
      res.writeHead(upRes.statusCode, upRes.headers);
      upRes.pipe(res);
    });
    up.on('error', (e) => { try { res.writeHead(502); res.end(e.message); } catch {} });
    req.pipe(up);
  });

  // HTTPS CONNECT — open a TCP tunnel to upstream, send CONNECT with auth, pipe
  server.on('connect', (req, clientSocket, head) => {
    const upstream = net.connect(upstreamPort, upstreamHost, () => {
      const connectReq =
        `CONNECT ${req.url} HTTP/1.1\r\n` +
        `Host: ${req.url}\r\n` +
        `Proxy-Authorization: ${auth}\r\n` +
        `Connection: keep-alive\r\n\r\n`;
      upstream.write(connectReq);
    });

    let buf = Buffer.alloc(0);
    const onFirstData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx < 0) return;
      const header = buf.slice(0, idx).toString('utf8');
      const remainder = buf.slice(idx + 4);
      upstream.removeListener('data', onFirstData);

      if (!/^HTTP\/1\.[01] 2\d\d/.test(header)) {
        try { clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch {}
        clientSocket.end();
        upstream.end();
        return;
      }
      // 200 Connection Established — tell client, then pipe
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (remainder.length) clientSocket.write(remainder);
      if (head && head.length) upstream.write(head);
      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
    };

    upstream.on('data', onFirstData);
    upstream.on('error', (e) => { try { clientSocket.end(); } catch {} });
    clientSocket.on('error', () => { try { upstream.end(); } catch {} });
  });

  return new Promise((resolve, reject) => {
    server.listen(listenPort, '127.0.0.1', () => {
      const port = server.address().port;
      console.log(`[proxyRelay] listening on 127.0.0.1:${port} -> ${upstreamHost}:${upstreamPort}`);
      resolve({ url: `http://127.0.0.1:${port}`, server });
    });
    server.on('error', reject);
  });
}

module.exports = { relay };
