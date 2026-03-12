const MEDIA_SCHEMA_VERSION = '1.0.0';

const ALLOWED_MEDIA_ACTIONS = new Set(['list', 'upload', 'copy', 'delete', 'tokenize-showcase']);

function validateMediaOperationInput(input = {}) {
  const {
    action,
    folder = null,
    key = null,
    schemaVersion = MEDIA_SCHEMA_VERSION,
  } = input;

  if (!action || !ALLOWED_MEDIA_ACTIONS.has(action)) {
    throw new Error('media.contract: action is invalid');
  }

  if (folder !== null && typeof folder !== 'string') {
    throw new Error('media.contract: folder must be a string when provided');
  }

  if (key !== null && typeof key !== 'string') {
    throw new Error('media.contract: key must be a string when provided');
  }

  return {
    schemaVersion,
    action,
    folder,
    key,
  };
}

module.exports = {
  MEDIA_SCHEMA_VERSION,
  ALLOWED_MEDIA_ACTIONS,
  validateMediaOperationInput,
};
