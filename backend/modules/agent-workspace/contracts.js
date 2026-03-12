const AGENT_WORKSPACE_SCHEMA_VERSION = '1.0.0';

function validateWorkspaceLeadDetailInput(input = {}) {
  const {
    leadId,
    includeMessages = true,
    includeTimeline = true,
    schemaVersion = AGENT_WORKSPACE_SCHEMA_VERSION,
  } = input;

  if (!leadId || typeof leadId !== 'string') {
    throw new Error('agent-workspace.contract: leadId is required');
  }

  return {
    schemaVersion,
    leadId,
    includeMessages: Boolean(includeMessages),
    includeTimeline: Boolean(includeTimeline),
  };
}

module.exports = {
  AGENT_WORKSPACE_SCHEMA_VERSION,
  validateWorkspaceLeadDetailInput,
};
