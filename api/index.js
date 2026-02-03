
const app = require('../server');

// Serverless function handler
module.exports = (req, res) => {
  // Pass the request to the Express app
  app(req, res);
};
