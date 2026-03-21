export const REPORTING_EXPORT_SCHEMA_VERSION = '1.0.0';

export const ALLOWED_EXPORT_TYPES = new Set(['driver-excel', 'driver-excel-incremental', 'driver-excel-full']);

export function validateReportingExportInput(input = {}) {
  const {
    exportType,
    triggeredBy,
    includeArchived = false,
    schemaVersion = REPORTING_EXPORT_SCHEMA_VERSION,
  } = input;

  if (!exportType || !ALLOWED_EXPORT_TYPES.has(exportType)) {
    throw new Error('reporting-export.contract: exportType is invalid');
  }

  if (!triggeredBy || typeof triggeredBy !== 'string') {
    throw new Error('reporting-export.contract: triggeredBy is required');
  }

  return {
    schemaVersion,
    exportType,
    triggeredBy,
    includeArchived: Boolean(includeArchived),
  };
}

export default {
  REPORTING_EXPORT_SCHEMA_VERSION,
  ALLOWED_EXPORT_TYPES,
  validateReportingExportInput,
};
