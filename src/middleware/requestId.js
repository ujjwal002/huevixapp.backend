import { randomUUID } from 'node:crypto';

// Attach a stable id to every request for log correlation. Honours an inbound
// X-Request-Id (from a proxy/load balancer) when present, otherwise generates
// one, and echoes it back on the response so clients/proxies can stitch traces.
export function requestId(req, res, next) {
  const incoming = req.headers['x-request-id'];
  const id = typeof incoming === 'string' && incoming.length <= 200 ? incoming : randomUUID();
  req.id = id;
  res.setHeader('X-Request-Id', id);
  next();
}