const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const http2 = require('node:http2')
const net = require('node:net')

const hopByHop = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'])
const filterHeaders = headers => {
  const excluded = new Set([...hopByHop, ...(String(headers.connection || '').toLowerCase().split(',').map(value => value.trim()))])
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !key.startsWith(':') && !excluded.has(key.toLowerCase())))
}

const server = http2.createSecureServer({
  key: fs.readFileSync(path.join(process.env.RUNNER_TEMP, 'proxy-key.pem')),
  cert: fs.readFileSync(path.join(process.env.RUNNER_TEMP, 'proxy-cert.pem')),
  allowHTTP1: true,
}, (request, response) => {
  const headers = filterHeaders(request.headers)
  headers.host = request.headers[':authority'] || request.headers.host
  headers['x-forwarded-proto'] = 'https'
  const upstream = http.request({
    hostname: '127.0.0.1', port: 10000,
    method: request.method, path: request.url, headers,
  }, backend => {
    if (request.method === 'POST' && /\/rows(?:\?|$)/.test(request.url)) {
      console.log(JSON.stringify({ method: request.method, path: request.url, clientProtocol: request.httpVersion, backendStatus: backend.statusCode }))
    }
    response.writeHead(backend.statusCode, filterHeaders(backend.headers))
    backend.pipe(response)
    backend.on('error', () => response.destroy())
  })
  upstream.on('error', error => {
    console.error('Local backend proxy error:', error.code)
    if (!response.headersSent) response.writeHead(502)
    response.end()
  })
  request.on('error', () => upstream.destroy())
  response.on('close', () => upstream.destroy())
  request.pipe(upstream)
})

server.on('upgrade', (request, socket, head) => {
  const upstream = net.connect(10000, '127.0.0.1', () => {
    const lines = [`${request.method} ${request.url} HTTP/1.1`]
    for (let i = 0; i < request.rawHeaders.length; i += 2) {
      lines.push(`${request.rawHeaders[i]}: ${request.rawHeaders[i + 1]}`)
    }
    upstream.write(lines.join('\r\n') + '\r\n\r\n')
    if (head.length) upstream.write(head)
    socket.pipe(upstream).pipe(socket)
  })
  socket.on('error', () => upstream.destroy())
  upstream.on('error', () => socket.destroy())
})
server.on('sessionError', error => console.error('HTTP/2 session error:', error.code))
server.on('error', error => { console.error(error); process.exitCode = 1 })
server.listen(10443, '127.0.0.1', () => console.log('Local HTTP/2 proxy ready'))
process.on('SIGTERM', () => server.close(() => process.exit(0)))
