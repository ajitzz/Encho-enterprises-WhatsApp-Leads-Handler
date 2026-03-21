export const ERROR_CATEGORIES = ['validation', 'dependency', 'timeout', 'conflict', 'not_found', 'internal'];

export const buildBoundaryError = ({
  code,
  message,
  retriable = false,
  category = 'internal',
  details = null,
  traceId = null,
} = {}) => {
  if (!code) throw new Error('code is required');
  if (!message) throw new Error('message is required');
  if (!ERROR_CATEGORIES.includes(category)) {
    throw new Error(`invalid error category: ${category}`);
  }

  return {
    code,
    message,
    retriable: Boolean(retriable),
    category,
    details,
    traceId,
  };
};

export default {
  ERROR_CATEGORIES,
  buildBoundaryError,
};
