/**
 * T117D (AU-06) — screenshot / business-card workflows on top of the
 * OCR bridge contract: "Chat with Screenshot" routes to a vision model
 * when one is available, otherwise to the OCR text path; card scans
 * produce a field PREVIEW and the Contacts write is user-confirmed.
 */
import {
  confirmContactWrite,
  parseCardFields,
  type CardFields,
  type ContactsPort,
  type OcrResult,
} from "@locallab/ocr-ios";

export { parseCardFields, confirmContactWrite };
export type { CardFields, ContactsPort, OcrResult };

export type ScreenshotChatRoute =
  | {
      kind: "vision-model";
      modelClass: string;
      imageRef: string;
      prompt: string;
    }
  | {
      kind: "ocr-text";
      modelClass: string;
      prompt: string;
      ocrText: string;
    };

export function buildScreenshotPrompt(ocrText: string, question: string): string {
  return `Answer the question about the screenshot's recognized text. Use only the text; say so if it is not there.\n\nRecognized text:\n"""\n${ocrText}\n"""\n\nQuestion: ${question}`;
}

/** Step 2: vision model when capability says so, OCR text otherwise. */
export function routeScreenshotChat(options: {
  question: string;
  imageRef: string;
  ocr: OcrResult;
  visionModelClass: string | null;
  textModelClass: string;
}): ScreenshotChatRoute {
  if (options.visionModelClass !== null)
    return {
      kind: "vision-model",
      modelClass: options.visionModelClass,
      imageRef: options.imageRef,
      prompt: options.question,
    };
  return {
    kind: "ocr-text",
    modelClass: options.textModelClass,
    prompt: buildScreenshotPrompt(options.ocr.text, options.question),
    ocrText: options.ocr.text,
  };
}
