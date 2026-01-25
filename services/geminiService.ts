
import { GoogleGenAI, Type } from "@google/genai";
import { LeadStatus, AuditReport, AuditIssue } from "../types";

// NOTE: In a real production app, this key should be in process.env and calls proxied through a backend.
// Fix: Use process.env.API_KEY exclusively
const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

// --- COST SAVING STRATEGY ---
// Automatic Downgrade: If Pro hits limits, switch to Flash instantly.
const MODELS = {
    BEST: "gemini-3-pro-preview",
    ECONOMY: "gemini-3-flash-preview"
};

let currentModel = MODELS.BEST;

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

// Wrapper to handle Rate Limits and Model Switching
const generateWithFallback = async (params: any) => {
    try {
        const response = await ai.models.generateContent({
            ...params,
            model: currentModel
        });
        
        // If successful and we are on economy, try to upgrade back after a success (or keep it simple and stay economy for session)
        // For now, we stick to the working model.
        return response;
    } catch (error: any) {
        // Check for Quota/Rate Limit Errors (429)
        if (error.message?.includes('429') || error.status === 429) {
            console.warn(`[AI] Rate Limit Hit on ${currentModel}. Switching to Economy Model.`);
            currentModel = MODELS.ECONOMY;
            
            // Retry immediately with cheaper model
            return await ai.models.generateContent({
                ...params,
                model: currentModel
            });
        }
        throw error;
    }
};

export const analyzeMessage = async (text: string, imageUrl?: string, systemInstruction?: string): Promise<AIAnalysisResult> => {
  if (!process.env.API_KEY) {
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
    const persona = systemInstruction || `You are an AI recruiter for Uber Fleet. Your goal is to be helpful, professional, and encourage drivers to apply.`;

    let prompt = `Analyze the driver's message.
    Message: "${text}"
    Has Image Attachment: ${imageUrl ? 'Yes' : 'No'}
    Tasks: 1. Reply to the user. 2. Extract data. 3. Determine status.`;

    const response = await generateWithFallback({
      contents: prompt,
      config: {
        systemInstruction: persona, // Updated to use systemInstruction config
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
      suggestedReply: "Could you please repeat that?",
      recommendedStatus: LeadStatus.NEW
    };
  }
};

// --- CLIENT-SIDE HEURISTIC FALLBACK ---
const runLocalAudit = (nodes: any[]): AuditReport => {
    console.warn("⚠️ API Quota Exceeded / Offline. Running Local Heuristic Audit.");
    const issues: AuditIssue[] = [];
    
    const BLOCKED_REGEX = /replace\s+this\s+sample\s+message|enter\s+your\s+message|type\s+your\s+message\s+here|replace\s+this\s+text/i;

    nodes.forEach(node => {
        if (node.id === 'start' || node.type === 'start' || node.data?.type === 'start') return;
        const data = node.data || {};

        if (data.message && BLOCKED_REGEX.test(data.message)) {
             issues.push({ 
                 nodeId: node.id, 
                 severity: 'CRITICAL', 
                 issue: 'Placeholder Text Detected', 
                 suggestion: 'You are using default text. Please write a real message.', 
                 autoFixValue: 'Please reply.' 
             });
        }
        else if ((data.label === 'Text' || data.inputType === 'text') && (!data.message || !data.message.trim())) {
            issues.push({ 
                nodeId: node.id, 
                severity: 'CRITICAL', 
                issue: 'Empty Message', 
                suggestion: 'This message bubble is empty.', 
                autoFixValue: 'Hello!' 
            });
        }
    });

    return { isValid: issues.length === 0, issues };
};

// --- SYSTEM AUDITOR (JSON CONFIG) ---
export const auditBotFlow = async (nodes: any[]): Promise<AuditReport> => {
    if (!process.env.API_KEY) return runLocalAudit(nodes);

    try {
        const prompt = `
        You are a Quality Assurance AI for a Chatbot Flow.
        Analyze this JSON flow configuration for logical errors and empty spaces.
        INPUT DATA: ${JSON.stringify(nodes.map(n => ({ id: n.id, type: n.data.label, message: n.data.message })))}
        `;

        const response = await generateWithFallback({
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
        return runLocalAudit(nodes);
    }
};

export const analyzeSystemCode = async (files: Array<{path: string, content: string}>, issueDescription: string): Promise<{ diagnosis: string, changes: Array<{filePath: string, content: string, explanation: string}> }> => {
    if (!process.env.API_KEY) throw new Error("No API Key");

    const fileContext = files.map(f => `--- START OF FILE ${f.path} ---\n${f.content}\n--- END OF FILE ${f.path} ---`).join("\n");

    const prompt = `
    You are a Principal Full-Stack Engineer.
    USER ISSUE: "${issueDescription}"
    PROJECT CONTEXT: ${fileContext}
    `;

    const response = await generateWithFallback({
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
