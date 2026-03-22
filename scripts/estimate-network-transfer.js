#!/usr/bin/env node

/**
 * Quick Neon transfer estimator for WhatsApp webhook workloads.
 *
 * Usage:
 *   node scripts/estimate-network-transfer.js
 *   LEADS_PER_WEEK=300 MSGS_PER_LEAD=18 DOC_RATE=0.2 node scripts/estimate-network-transfer.js
 */

const leadsPerWeek = Number.parseFloat(process.env.LEADS_PER_WEEK || '300');
const weeksPerMonth = Number.parseFloat(process.env.WEEKS_PER_MONTH || '4.345');
const messagesPerLead = Number.parseFloat(process.env.MSGS_PER_LEAD || '18');
const docRate = Number.parseFloat(process.env.DOC_RATE || '0.2');

// Conservative per-message DB transfer envelope (request+response round-trips)
const kbPerMessage = Number.parseFloat(process.env.KB_PER_MESSAGE || '3.2');

// Extra transfer for media/document metadata row updates when only S3 URL is stored
const kbPerDocument = Number.parseFloat(process.env.KB_PER_DOCUMENT || '1.5');

const monthlyLeads = leadsPerWeek * weeksPerMonth;
const monthlyMessages = monthlyLeads * messagesPerLead;
const monthlyDocuments = monthlyLeads * docRate;

const estimatedMessageTransferKb = monthlyMessages * kbPerMessage;
const estimatedDocumentTransferKb = monthlyDocuments * kbPerDocument;
const totalKb = estimatedMessageTransferKb + estimatedDocumentTransferKb;
const totalGb = totalKb / (1024 * 1024);

const print = (label, value) => {
  console.log(`${label.padEnd(34)} ${value}`);
};

console.log('--- Neon DB Transfer Estimator (Webhook + Bot Flow) ---');
print('Leads per week:', leadsPerWeek.toFixed(0));
print('Messages per lead (in+out):', messagesPerLead.toFixed(1));
print('Document share rate:', `${(docRate * 100).toFixed(1)}%`);
print('Estimated monthly leads:', monthlyLeads.toFixed(0));
print('Estimated monthly messages:', monthlyMessages.toFixed(0));
print('Assumed KB per message:', kbPerMessage.toFixed(2));
print('Assumed KB per document:', kbPerDocument.toFixed(2));
print('Estimated monthly transfer (GB):', totalGb.toFixed(3));
print('Monthly budget (GB):', '5.000');
print('Headroom (GB):', (5 - totalGb).toFixed(3));

if (totalGb <= 5) {
  console.log('\nResult: Within 5GB budget under the current assumptions.');
} else {
  console.log('\nResult: Exceeds 5GB budget; reduce message volume/DB round-trips or increase plan.');
}
