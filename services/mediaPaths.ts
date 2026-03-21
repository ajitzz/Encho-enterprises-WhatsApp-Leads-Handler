const sanitizePathSegment = (value: string) =>
  String(value || '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9+_-]/g, '');

const fallbackLeadFolder = 'unknown-lead';

export const getLeadScreenshotUploadPath = (lead: any) => {
  const phoneValue =
    lead?.phone_number ||
    lead?.phoneNumber ||
    lead?.phone ||
    lead?.mobile ||
    lead?.whatsapp_number ||
    '';
  const leadFolder = sanitizePathSegment(phoneValue) || fallbackLeadFolder;
  return `lead/${leadFolder}/screenshots`;
};

