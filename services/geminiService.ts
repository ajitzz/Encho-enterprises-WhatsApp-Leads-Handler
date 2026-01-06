import { GoogleGenAI, Type } from "@google/genai";
import { LeadStatus, AuditReport, AuditIssue } from "../types";

// NOTE: In a real production app, this key should be in process.env and calls proxied through a backend.
const apiKey = process.env.API_KEY || process.env.GEMINI_API_KEY || "AIzaSyDujw0ovB1bLtQJK8DKy1b__LT5aqGurz0"; 

const ai = new GoogleGenAI({ apiKey });

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
    const persona = systemInstruction || `You are an AI recruiter for Uber Fleet. Your goal is to be helpful, professional, and encourage drivers to apply.`;

    let prompt = `Analyze the driver's message.
    Message: "${text}"
    Has Image Attachment: ${imageUrl ? 'Yes' : 'No'}
    Tasks: 1. Reply to the user. 2. Extract data. 3. Determine status.`;

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

    const result = JSON.parse(response.text || '{}');
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

// --- NEW: AI SYSTEM AUDITOR ---
export const auditBotFlow = async (nodes: any[]): Promise<AuditReport> => {
    if (!apiKey) return { isValid: true, issues: [] };

    try {
        const model = "gemini-3-flash-preview";
        
        const prompt = `
        You are a Root Cause Analysis AI for a WhatsApp Bot.
        
        Analyze this JSON flow configuration for errors.
        
        SPECIFIC RULES TO CATCH:
        1. "Placeholder Text": Any message containing "replace this", "sample message", "type here".
        2. "Empty Options": An Options/List node that has no items in the 'options' array.
        3. "Empty Text": A text node with an empty string message.
        4. "Missing Media": A Media node (Image/Video) with no URL.

        INPUT DATA:
        ${JSON.stringify(nodes.map(n => ({ id: n.id, type: n.data.label, message: n.data.message, options: n.data.options, mediaUrl: n.data.mediaUrl })))}

        Return a JSON report.
        For "autoFixValue", provide the corrected string (e.g. remove placeholder, add default option).
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

        const report = JSON.parse(response.text || '{"isValid": true, "issues": []}');
        return report;

    } catch (e) {
        console.error("Audit failed", e);
        return { isValid: true, issues: [] };
    }
};
