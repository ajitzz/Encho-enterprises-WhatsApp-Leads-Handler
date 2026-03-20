const serverModule = require('../server');

const resolveExpressApp = () => {
  const moduleCandidate: any = serverModule as any;
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

module.exports = (req: any, res: any) => resolveExpressApp()(req, res);
