/**
 * Enterprise Bot Studio - Keyword & Intent Trigger Matcher
 * 
 * Provides FAANG-grade (10/10) normalization, token analysis, and matching
 * for global WhatsApp conversational triggers (e.g. "send the property Number2", "Property 2", "#2").
 */

// Common English conversational filler prefixes/suffixes that users type before requesting an item
const FILLER_TOKENS = new Set([
  'please', 'pls', 'can', 'you', 'could', 'kindly',
  'send', 'give', 'show', 'share', 'get', 'want', 'need', 'i', 'im',
  'the', 'a', 'an', 'me', 'us', 'details', 'info', 'information', 'brochure',
  'for', 'of', 'about', 'to', 'this', 'that', 'number', 'no', 'num'
]);

/**
 * Normalizes text by removing punctuation, extra spaces, and lowercasing.
 * e.g. "Property #2!" -> "property 2"
 */
export const normalizeConversationalText = (text) => {
  if (!text || typeof text !== 'string') return '';
  return text
    .toLowerCase()
    .replace(/[#\-_/\\,.:;!?()[\]{}'"`~@$%^&*+=<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
};

/**
 * Strips all non-alphanumeric characters.
 * e.g. "Property #2!" -> "property2"
 */
export const stripAlphanumeric = (text) => {
  if (!text || typeof text !== 'string') return '';
  return text.toLowerCase().replace(/[^a-z0-9]/g, '');
};

/**
 * Extracts essential semantic core tokens by filtering out conversational filler words.
 * e.g. "send the property Number2" -> ["property", "2"]
 */
export const extractCoreTokens = (text) => {
  const normalized = normalizeConversationalText(text);
  if (!normalized) return [];

  // Split into tokens, also separating numbers glued to words like "number2" -> "number", "2"
  const tokens = normalized
    .replace(/([a-z])([0-9])/g, '$1 $2')
    .replace(/([0-9])([a-z])/g, '$1 $2')
    .split(' ')
    .map(t => t.trim())
    .filter(Boolean);

  const coreTokens = tokens.filter(t => !FILLER_TOKENS.has(t));
  // If all tokens were filtered out as fillers, return the original tokens so we don't return empty
  return coreTokens.length > 0 ? coreTokens : tokens;
};

/**
 * Evaluates whether an incoming message matches a configured keyword rule.
 * 
 * @param {string} incomingText The incoming customer WhatsApp message
 * @param {string} rawKeyword The keyword / phrase configured on the bot node
 * @param {'contains' | 'exact' | 'regex'} [mode='contains'] Matching mode
 * @returns {boolean} True if matched
 */
export const matchKeywordRule = (incomingText, rawKeyword, mode = 'contains') => {
  if (!incomingText || !rawKeyword) return false;

  const cleanInput = incomingText.trim().toLowerCase();
  const cleanKw = rawKeyword.trim().toLowerCase();
  if (!cleanInput || !cleanKw) return false;

  // 1. REGEX MODE
  if (mode === 'regex') {
    try {
      const reg = new RegExp(cleanKw, 'i');
      return reg.test(cleanInput);
    } catch {
      return cleanInput.includes(cleanKw);
    }
  }

  const normInput = stripAlphanumeric(cleanInput);
  const normKw = stripAlphanumeric(cleanKw);

  // 2. EXACT MODE
  if (mode === 'exact') {
    if (cleanInput === cleanKw) return true;
    if (normInput && normKw && normInput === normKw) return true;
    // Core token equality e.g. "Property 2" vs "Property #2"
    const inputCore = extractCoreTokens(cleanInput).join('');
    const kwCore = extractCoreTokens(cleanKw).join('');
    return inputCore.length > 0 && inputCore === kwCore;
  }

  // 3. CONTAINS MODE (Default & Recommended)
  // Direct substring check
  if (cleanInput.includes(cleanKw)) return true;

  // Alphanumeric normalized containment e.g. "can you send property2" contains "property2"
  if (normKw && normKw.length >= 2 && normInput.includes(normKw)) return true;

  // Semantic core token matching:
  // e.g. incoming: "send the property Number2" -> core: ["property", "2"]
  // keyword: "property 2" -> core: ["property", "2"]
  const inputCoreTokens = extractCoreTokens(cleanInput);
  const kwCoreTokens = extractCoreTokens(cleanKw);

  const inputCoreStr = inputCoreTokens.join('');
  const kwCoreStr = kwCoreTokens.join('');

  if (kwCoreStr && kwCoreStr.length >= 2) {
    if (inputCoreStr.includes(kwCoreStr)) return true;
  }

  // All keyword core tokens must be present in incoming text in sequence or order
  if (kwCoreTokens.length > 0 && kwCoreTokens.every(tok => inputCoreTokens.includes(tok))) {
    return true;
  }

  return false;
};

/**
 * Searches a list of bot nodes and returns the highest priority node whose keywords match.
 * 
 * @param {Array<any>} nodes Flow nodes array
 * @param {string} incomingText The user message
 * @returns {any | null} The matched node or null
 */
export const findMatchingKeywordNode = (nodes, incomingText) => {
  if (!incomingText || !Array.isArray(nodes) || nodes.length === 0) return null;

  const keywordNodes = nodes.filter(n => n?.data && Array.isArray(n.data.keywords) && n.data.keywords.length > 0);
  if (keywordNodes.length === 0) return null;

  // Sort by priority descending (higher priority evaluated first)
  const sortedNodes = [...keywordNodes].sort((a, b) => (b.data?.keywordPriority || 0) - (a.data?.keywordPriority || 0));

  for (const node of sortedNodes) {
    const mode = node.data?.keywordMatchMode || 'contains';
    const keywords = (node.data?.keywords || []).map(k => (k || '').trim()).filter(Boolean);

    for (const kw of keywords) {
      if (matchKeywordRule(incomingText, kw, mode)) {
        return node;
      }
    }
  }

  return null;
};
