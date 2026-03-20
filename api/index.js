let appPromise = null;

const extractExpressApp = (moduleCandidate) => {
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

const loadFromTypeScriptSource = () => {
  require('tsx/cjs');
  return extractExpressApp(require('../server.ts'));
};

const loadServerModule = async () => {
  if (!appPromise) {
    appPromise = (async () => {
      try {
        return extractExpressApp(await import('../server.js'));
      } catch (importError) {
        try {
          return extractExpressApp(require('../server'));
        } catch (requireError) {
          const moduleNotFoundCodes = new Set(['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND']);
          if (moduleNotFoundCodes.has(importError?.code) || moduleNotFoundCodes.has(requireError?.code)) {
            return loadFromTypeScriptSource();
          }

          throw importError;
        }
      }
    })();
  }

  return appPromise;
};

module.exports = async (req, res) => {
  const app = await loadServerModule();
  return app(req, res);
};
