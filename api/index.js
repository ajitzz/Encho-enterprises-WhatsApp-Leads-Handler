const serverModule = require('../server');

const app =
  typeof serverModule === 'function'
    ? serverModule
    : serverModule?.app;

if (typeof app !== 'function') {
  throw new TypeError('Invalid server export: expected an Express app function.');
}

module.exports = (req, res) => app(req, res);
