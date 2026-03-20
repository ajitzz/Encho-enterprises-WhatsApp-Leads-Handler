const serverModule = require('../server');

const resolveExpressApp = () => {
  const moduleCandidate = serverModule;
  const appCandidate =
    moduleCandidate?.app ??
    moduleCandidate?.default?.app ??
    moduleCandidate?.default;

  if (typeof appCandidate !== 'function') {
    const exportedKeys = Object.keys(moduleCandidate || {});
    throw new TypeError(
      `Invalid server export: expected an Express app function, received keys [${exportedKeys.join(', ')}]`
    );
  }

  return appCandidate;
};

module.exports = (req, res) => resolveExpressApp()(req, res);
