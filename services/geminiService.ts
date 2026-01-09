
import { GoogleGenAI, Type } from "@google/genai";
import { LeadStatus, AuditReport, AuditIssue } from "../types";

// Helper to clean JSON from AI responses
const cleanJSON = (text: string) => {
  if (!text) return "{}";
  return text.replace(/```json/g, '').replace(/```/g, '').trim();
};

// Helper to get AI instance with the latest API key
const getAI = () => {
  return new GoogleGenAI({ apiKey: process.env.API_KEY });
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
  modelUsed?: string;
}

const runLocalMessageHeuristic = (text: string, hasImage: boolean): AIAnalysisResult => {
  const lower = text.toLowerCase();
  let reply = "Thank you for reaching out. An executive will review your message shortly.";
  let status = LeadStatus.NEW;
  let intent = "General Inquiry";

  if (lower.includes("hi") || lower.includes("hello") || lower.includes("ഹലോ")) {
    reply = "Hello! Welcome to Encho Cabs. Are you interested in joining our Uber/Ola fleet?";
    intent = "Greeting";
  } else if (lower.includes("rent") || lower.includes("വാടക") || lower.includes("rate")) {
    reply = "Our vehicle rent is ₹600/day, which can be reduced to ₹450/day if you meet the targets. Would you like to know more?";
    intent = "Pricing Inquiry";
  } else if (lower.includes("join") || lower.includes("ജോലി") || lower.includes("work")) {
    reply = "We have WagonR CNG vehicles ready! Do you have a valid driving license?";
    intent = "Job Application";
    status = LeadStatus.QUALIFIED;
  } else if (hasImage) {
    reply = "I see you've sent a document. Our team will verify it and get back to you.";
    intent = "Document Submission";
  }

  return {
    intent,
    isInterested: true,
    containsDocument: hasImage,
    suggestedReply: `[Local Fallback] ${reply}`,
    recommendedStatus: status,
    modelUsed: 'local-heuristic'
  };
};

export const analyzeMessage = async (text: string, imageUrl?: string, systemInstruction?: string): Promise<AIAnalysisResult> => {
  const models = ["gemini-3-flash-preview", "gemini-flash-lite-latest"];
  const persona = systemInstruction || `You are an AI recruiter for Uber Fleet. Your goal is to be helpful, professional, and encourage drivers to apply.`;
  let prompt = `Analyze the driver's message.
    Message: "${text}"
    Has Image Attachment: ${imageUrl ? 'Yes' : 'No'}
    Tasks: 1. Reply to the user. 2. Extract data. 3. Determine status.`;

  for (const model of models) {
    try {
      const ai = getAI();
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
            },
            required: ["intent", "isInterested", "containsDocument", "suggestedReply", "recommendedStatus"],
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

      return { ...result, recommendedStatus: status, modelUsed: model };
    } catch (error: any) {
      if (error?.message?.includes("429") || error?.message?.includes("quota")) {
        console.warn(`Model ${model} quota exceeded, falling back...`);
        continue;
      }
      console.error(`AI Analysis failed for model ${model}`, error);
    }
  }

  return runLocalMessageHeuristic(text, !!imageUrl);
};

export const auditBotFlow = async (nodes: any[]): Promise<AuditReport> => {
    const models = ["gemini-3-flash-preview", "gemini-flash-lite-latest"];
    const prompt = `
        You are a Quality Assurance AI for a Chatbot Flow.
        Analyze this JSON flow configuration for logical errors and empty spaces.
        INPUT DATA: ${JSON.stringify(nodes.map(n => ({ id: n.id, type: n.data.label, message: n.data.message, options: n.data.options, mediaUrl: n.data.mediaUrl })))}
        OUTPUT FORMAT: JSON with 'isValid' (boolean) and 'issues' (array).`;

    for (const model of models) {
        try {
            const ai = getAI();
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

            return JSON.parse(cleanJSON(response.text || '{"isValid": true, "issues": []}'));
        } catch (e: any) {
            if (e?.message?.includes("429") || e?.message?.includes("quota")) {
                continue;
            }
        }
    }

    return { isValid: true, issues: [] }; // Basic fallback
};

export const analyzeSystemCode = async (files: Array<{path: string, content: string}>, issueDescription: string): Promise<{ diagnosis: string, changes: Array<{filePath: string, content: string, explanation: string}> }> => {
    const model = "gemini-3-pro-preview"; 
    const fileContext = files.map(f => `-- ${f.path} --\n${f.content}\n`).join("\n");
    const prompt = `Engineer AI. ISSUE: "${issueDescription}"\nCONTEXT:\n${fileContext}`;

    try {
        const ai = getAI();
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
    } catch (e) {
        return { diagnosis: "System analysis failed. Check API quota.", changes: [] };
    }
}
