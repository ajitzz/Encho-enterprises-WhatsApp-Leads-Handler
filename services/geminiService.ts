
import { GoogleGenAI, Type } from "@google/genai";
import { LeadStatus, AuditReport, AuditIssue } from "../types";

// NOTE: In a real production app, this key should be in process.env and calls proxied through a backend.
const apiKey = process.env.API_KEY || process.env.GEMINI_API_KEY || "AIzaSyDujw0ovB1bLtQJK8DKy1b__LT5aqGurz0"; 

const ai = new GoogleGenAI({ apiKey });

const cleanJSON = (text: string) => {
  if (!text) return "{}";
  // Remove markdown code blocks like ```json ... ```
  return text.replace(/```json/g, '').replace(/```/g, '').trim();
};

export interface AIAnalysisResult {
  intent: string;
  isInterested: boolean;
  containsDocument: boolean;
  suggestedReply: string;
  recommendedStatus: LeadStatus;
  extractedData?: {
    vehicleRegistration?: string;
    availability?: string;
    isLicenseValid?: boolean;
  };
}

export const analyzeMessage = async (text: string, imageUrl?: string, systemInstruction?: string): Promise<AIAnalysisResult> => {
  if (!apiKey) {
    console.warn("No API Key provided for Gemini. Returning mock AI response.");
    return {
      intent: "Inquiry about joining",
      isInterested: true,
      containsDocument: !!imageUrl,
      suggestedReply: "Thanks! We've received your info.",
      recommendedStatus: LeadStatus.NEW,
      extractedData: {}
    };
  }

  try {
    const model = "gemini-3-flash-preview";
    
    // ENCHO CABS SPECIFIC FALLBACK PERSONA
    const defaultPersona = `
    Role: WhatsApp Executive for **Encho Cabs** (Uber/Ola fleet).
    Language: **Malayalam + Simple English (Manglish)**. 
    Tone: Friendly, human-like, short (2-4 lines).

    KEY FACTS:
    - Vehicle: WagonR CNG (Manual).
    - Accommodation: ₹5000 deposit (refundable), full facilities (AC/Fridge/Kitchen).
    - Rent: ₹600/day (10 trips target). Performance bonus available (Rent reduces to ₹450).
    - Earnings: ₹18k - ₹23k/week. NO COMMISSION from us.
    - **Software:** We provide a Company App for 100% transparency. Drivers can see calculations & download weekly bills.
    
    GOAL: Answer questions & get them to visit.
    `;

    const persona = systemInstruction || defaultPersona;

    let prompt = `Analyze the driver's message.
    Message: "${text}"
    Has Image Attachment: ${imageUrl ? 'Yes' : 'No'}
    Tasks: 1. Reply to the user (in Manglish/Malayalam unless they used English). 2. Extract data. 3. Determine status.`;

    const response = await ai.models.generateContent({
      model,
      contents: prompt,
      config: {
        systemInstruction: persona,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            intent: { type: Type.STRING },
            isInterested: { type: Type.BOOLEAN },
            containsDocument: { type: Type.BOOLEAN },
            suggestedReply: { type: Type.STRING },
            recommendedStatus: { type: Type.STRING },
            extractedData: {
              type: Type.OBJECT,
              properties: {
                 vehicleRegistration: { type: Type.STRING, nullable: true },
                 availability: { type: Type.STRING, nullable: true },
                 isLicenseValid: { type: Type.BOOLEAN }
              }
            }
          }
        }
      }
    });

    const result = JSON.parse(cleanJSON(response.text || '{}'));
    let status = LeadStatus.NEW;
    switch(result.recommendedStatus) {
      case 'Qualified': status = LeadStatus.QUALIFIED; break;
      case 'Flagged': status = LeadStatus.FLAGGED_FOR_REVIEW; break;
      case 'Rejected': status = LeadStatus.REJECTED; break;
      case 'Onboarded': status = LeadStatus.ONBOARDED; break;
      default: status = LeadStatus.NEW;
    }

    return { ...result, recommendedStatus: status };

  } catch (error) {
    console.error("AI Analysis failed", error);
    return {
      intent: "Analysis Failed",
      isInterested: false,
      containsDocument: !!imageUrl,
      suggestedReply: "ക്ഷമിക്കണം, എനിക്ക് മനസ്സിലായില്ല. ഒന്ന് കൂടി പറയാമോ?",
      recommendedStatus: LeadStatus.NEW
    };
  }
};

// --- CLIENT-SIDE HEURISTIC FALLBACK ---
const runLocalAudit = (nodes: any[]): AuditReport => {
    console.warn("⚠️ API Quota Exceeded / Offline. Running Local Heuristic Audit.");
    const issues: AuditIssue[] = [];
    
    // Regex matches: "replace this sample message", "enter your message", etc.
    const BLOCKED_REGEX = /replace\s+this\s+sample\s+message|enter\s+your\s+message|type\s+your\s+message\s+here|replace\s+this\s+text/i;

    nodes.forEach(node => {
        if (node.id === 'start' || node.type === 'start' || node.data?.type === 'start') return;
        const data = node.data || {};

        // 1. Placeholder Text
        if (data.message && BLOCKED_REGEX.test(data.message)) {
             issues.push({ 
                 nodeId: node.id, 
                 severity: 'CRITICAL', 
                 issue: 'Placeholder Text Detected', 
                 suggestion: 'You are using default text. Please write a real message.', 
                 autoFixValue: 'Please reply.' 
             });
        }
        // 2. Empty Text
        else if ((data.label === 'Text' || data.inputType === 'text') && (!data.message || !data.message.trim())) {
            issues.push({ 
                nodeId: node.id, 
                severity: 'CRITICAL', 
                issue: 'Empty Message', 
                suggestion: 'This message bubble is empty.', 
                autoFixValue: 'Hello!' 
            });
        }
        // 3. Missing Media
        else if (['Image', 'Video'].includes(data.label)) {
            if (!data.mediaUrl || !data.mediaUrl.trim()) {
                 issues.push({ 
                     nodeId: node.id, 
                     severity: 'CRITICAL', 
                     issue: 'Missing Media URL', 
                     suggestion: 'This media node has no file link. Please add a URL.', 
                     autoFixValue: null 
                 });
            }
        }
        // 4. Empty Options
        else if (data.inputType === 'option') {
            if (!data.options || data.options.length === 0) {
                 issues.push({
                     nodeId: node.id,
                     severity: 'CRITICAL',
                     issue: 'No Options',
                     suggestion: 'Add at least one button option.',
                     autoFixValue: ['Yes', 'No']
                 });
            } else if (data.options.some((o: string) => !o || !o.trim())) {
                 issues.push({
                     nodeId: node.id,
                     severity: 'WARNING',
                     issue: 'Empty Option Label',
                     suggestion: 'One or more buttons have no text.',
                     autoFixValue: data.options.filter((o: string) => o && o.trim())
                 });
            }
        }
    });

    return { isValid: issues.length === 0, issues };
};

// --- SYSTEM AUDITOR (JSON CONFIG) ---
export const auditBotFlow = async (nodes: any[]): Promise<AuditReport> => {
    // If no key, fallback immediately
    if (!apiKey) return runLocalAudit(nodes);

    try {
        const model = "gemini-3-flash-preview";
        
        const prompt = `
        You are a Quality Assurance AI for a Chatbot Flow.
        
        Analyze this JSON flow configuration for logical errors and empty spaces.
        
        STRICT VALIDATION RULES:
        1. "Placeholder Text": Any message containing "replace this", "sample message", "type here".
        2. "Empty Options": An Options node where the 'options' array is empty OR contains empty strings.
        3. "Empty Text": A Text node with an empty or whitespace-only message.
        4. "Missing Media": A Media node (Image/Video) with no URL.

        INPUT DATA:
        ${JSON.stringify(nodes.map(n => ({ id: n.id, type: n.data.label, message: n.data.message, options: n.data.options, mediaUrl: n.data.mediaUrl })))}

        OUTPUT FORMAT:
        Return a JSON object with 'isValid' (boolean) and 'issues' (array).
        
        For 'autoFixValue':
        - If the node is redundant or hopelessly empty, set autoFixValue to "DELETE_NODE".
        - If it's a text node, provide a professional fallback message.
        - If it's an option node with empty options, suggest a fixed list like ["Yes", "No"].
        `;

        const response = await ai.models.generateContent({
            model,
            contents: prompt,
            config: {
                responseMimeType: "application/json",
                responseSchema: {
                    type: Type.OBJECT,
                    properties: {
                        isValid: { type: Type.BOOLEAN },
                        issues: {
                            type: Type.ARRAY,
                            items: {
                                type: Type.OBJECT,
                                properties: {
                                    nodeId: { type: Type.STRING },
                                    severity: { type: Type.STRING, enum: ["CRITICAL", "WARNING"] },
                                    issue: { type: Type.STRING },
                                    suggestion: { type: Type.STRING },
                                    autoFixValue: { type: Type.STRING, nullable: true } 
                                }
                            }
                        }
                    }
                }
            }
        });

        const report = JSON.parse(cleanJSON(response.text || '{"isValid": true, "issues": []}'));
        return report;

    } catch (e: any) {
        console.error("Gemini Audit failed", e);
        // Fallback to local heuristics on any AI error
        return runLocalAudit(nodes);
    }
};

// --- SYSTEM DOCTOR (FULL PROJECT ANALYSIS) ---
export const analyzeSystemCode = async (files: Array<{path: string, content: string}>, issueDescription: string): Promise<{ diagnosis: string, changes: Array<{filePath: string, content: string, explanation: string}> }> => {
    if (!apiKey) throw new Error("No API Key");

    const model = "gemini-3-pro-preview"; // Use PRO for complex code analysis

    // Create a compact representation of the files
    const fileContext = files.map(f => `
    --- START OF FILE ${f.path} ---
    ${f.content}
    --- END OF FILE ${f.path} ---
    `).join("\n");

    const prompt = `
    You are a Principal Full-Stack Engineer with read/write access to this entire project.
    
    USER ISSUE: "${issueDescription}"

    YOUR TASKS:
    1. Analyze the provided project files to understand the root cause.
    2. Check dependencies, imports, API logic, and Frontend components.
    3. Determine which files need to be modified to fix the issue.
    4. Provide the FULL content of the fixed files.

    CONSTRAINTS:
    - Do NOT remove existing valid logic. Only fix what is broken.
    - If you need to fix multiple files (e.g., update an Interface in types.ts AND the Component usage in App.tsx), return changes for ALL of them.
    - Return a valid JSON object.

    PROJECT CONTEXT:
    ${fileContext}
    `;

    const response = await ai.models.generateContent({
        model,
        contents: prompt,
        config: {
            responseMimeType: "application/json",
            responseSchema: {
                type: Type.OBJECT,
                properties: {
                    diagnosis: { type: Type.STRING },
                    changes: {
                        type: Type.ARRAY,
                        items: {
                            type: Type.OBJECT,
                            properties: {
                                filePath: { type: Type.STRING },
                                content: { type: Type.STRING },
                                explanation: { type: Type.STRING }
                            }
                        }
                    }
                }
            }
        }
    });

    return JSON.parse(cleanJSON(response.text || '{}'));
}
