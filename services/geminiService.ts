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

// --- SYSTEM AUDITOR (JSON CONFIG) ---
export const auditBotFlow = async (nodes: any[]): Promise<AuditReport> => {
    if (!apiKey) return { isValid: true, issues: [] };

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
        5. "Redundant Node": A node with no connections and empty content.

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

    } catch (e) {
        console.error("Audit failed", e);
        return { isValid: true, issues: [] };
    }
};

// --- NEW: SYSTEM DOCTOR (SOURCE CODE ANALYSIS) ---
export const analyzeSystemCode = async (sourceCode: string, issueDescription: string): Promise<{ diagnosis: string, fixedCode: string }> => {
    if (!apiKey) throw new Error("No API Key");

    const model = "gemini-3-pro-preview"; // Use PRO for complex code analysis

    const prompt = `
    You are an Expert Node.js Backend Engineer.
    
    TASKS:
    1. Analyze the provided "server.js" source code.
    2. Identify the root cause of the user's issue: "${issueDescription}".
    3. Fix the code.
    4. Return the FULL fixed source code.

    CONSTRAINTS:
    - Do NOT remove existing endpoints or logic unless they are the bug.
    - Keep the code structure identical.
    - Return a JSON object with a diagnosis explanation and the full fixed code string.

    SOURCE CODE:
    \`\`\`javascript
    ${sourceCode}
    \`\`\`
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
                    fixedCode: { type: Type.STRING }
                }
            }
        }
    });

    return JSON.parse(cleanJSON(response.text || '{}'));
}
