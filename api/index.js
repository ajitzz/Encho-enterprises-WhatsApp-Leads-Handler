const { Readable } = require('stream');
const serverModule = require('../server');

const app =
  typeof serverModule === 'function'
    ? serverModule
    : serverModule?.app;

if (typeof app !== 'function') {
  throw new TypeError('Invalid server export: expected an Express app function.');
}

const ensureReqStreamShape = (req) => {
  if (!req || typeof req !== 'object') return req;
  if (typeof req.pipe === 'function' && typeof req.unpipe === 'function') return req;

  const streamReq = Object.create(Readable.prototype);
  Readable.call(streamReq, { read() {} });
  Object.assign(streamReq, req);
  streamReq._read = () => {};
  process.nextTick(() => streamReq.push(null));
  return streamReq;
};

const ensureResShape = (res) => {
  if (!res || typeof res !== 'object') return res;
  if (!res._headers || typeof res._headers !== 'object') res._headers = {};

  if (typeof res.setHeader !== 'function') {
    res.setHeader = (name, value) => {
      res._headers[String(name).toLowerCase()] = value;
      return res;
    };
  }

  if (typeof res.getHeader !== 'function') {
    res.getHeader = (name) => res._headers[String(name).toLowerCase()];
  }

  if (typeof res.removeHeader !== 'function') {
    res.removeHeader = (name) => {
      delete res._headers[String(name).toLowerCase()];
      return res;
    };
  }

  if (typeof res.writeHead !== 'function') {
    res.writeHead = (statusCode, headers = {}) => {
      res.statusCode = statusCode;
      Object.entries(headers || {}).forEach(([k, v]) => res.setHeader(k, v));
      return res;
    };
  }

  if (typeof res.end !== 'function') {
    res.end = () => res;
  }

  if (typeof res.write !== 'function') {
    res.write = () => true;
  }

  return res;
};

module.exports = (req, res) => {
  const safeReq = ensureReqStreamShape(req);
  const safeRes = ensureResShape(res);
  return app(safeReq, safeRes);
};
