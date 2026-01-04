import { GoogleGenAI, Type } from "@google/genai";
import { LeadStatus } from "../types";

// NOTE: In a real production app, this key should be in process.env and calls proxied through a backend.
// We are initializing it here for the demo context.
const apiKey = process.env.API_KEY || ''; 

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

export const analyzeMessage = async (text: string, imageUrl?: string): Promise<AIAnalysisResult> => {
  if (!apiKey) {
    console.warn("No API Key provided for Gemini. Returning mock AI response.");
    
    // Improved mock logic for extraction simulation
    const lowerText = text.toLowerCase();
    let vehicleReg = undefined;
    if (lowerText.match(/[a-z]{2}\s?\d{2}\s?[a-z]{1,2}\s?\d{4}/)) {
        vehicleReg = text.toUpperCase(); // Simple mock extraction
    }

    let availability = undefined;
    if (lowerText.includes('full time') || lowerText.includes('full-time')) availability = 'Full-time';
    if (lowerText.includes('part time') || lowerText.includes('part-time')) availability = 'Part-time';

    return {
      intent: "Inquiry about joining",
      isInterested: true,
      containsDocument: !!imageUrl,
      suggestedReply: "Thanks! We've received your info.",
      recommendedStatus: imageUrl ? LeadStatus.FLAGGED_FOR_REVIEW : LeadStatus.NEW,
      extractedData: {
        vehicleRegistration: vehicleReg,
        availability: availability,
        isLicenseValid: !!imageUrl // Mock assumption
      }
    };
  }

  try {
    const model = "gemini-3-flash-preview";
    
    let prompt = `You are an AI recruiter for Uber Fleet. Analyze the driver's message.
    
    Message: "${text}"
    Has Image Attachment: ${imageUrl ? 'Yes' : 'No'}

    Tasks:
    1. If an image is attached, determine if it looks like a valid Driving License (DL) or Aadhaar card.
    2. Extract Vehicle Registration Number (e.g., MH 02 AB 1234) if present in text.
    3. Extract Availability (Full-time, Part-time, Weekends) if mentioned.
    4. Determine the best next status.

    Return JSON with:
    - intent: summary
    - isInterested: boolean
    - containsDocument: boolean
    - suggestedReply: short text
    - recommendedStatus: "New", "Qualified", "Flagged", "Rejected"
    - extractedData: {
        vehicleRegistration: string (or null),
        availability: string (or null),
        isLicenseValid: boolean (true only if image is a valid license document)
    }
    `;

    const response = await ai.models.generateContent({
      model,
      contents: prompt,
      config: {
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

    return {
      ...result,
      recommendedStatus: status
    };

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