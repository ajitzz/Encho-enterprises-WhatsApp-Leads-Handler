# Rollback Playbook by Extracted Module

## lead-ingestion
- Toggle: `FF_LEAD_INGESTION_MODULE=off`
- Verification: webhook smoke + critical flow tests

## reminders-escalations
- Toggle: `FF_REMINDERS_MODULE=off`
- Verification: queue processing smoke + reminder critical tests

## auth-config
- Toggle: `FF_AUTH_CONFIG_MODULE=off`
- Verification: auth/settings smoke checks

## system-health
- Toggle: `FF_SYSTEM_HEALTH_MODULE=off`
- Verification: `/api/health`, `/api/ping`, `/api/debug/status`

## Recovery SLO
- Target normalization window: <=15 minutes
- If not normalized: redeploy previous release artifact and initiate incident review
