/**
 * T117D (AU-06) — iOS Vision OCR bridge contract: screenshot and
 * camera text recognition runs ON DEVICE (the request never leaves the
 * phone; this contract only carries an opaque image reference and the
 * recognized text back). Plus the business-card field preview schema
 * and the user-confirmed Contacts write seam. The Swift Vision code is
 * compiled into the Apple build (T159E); both sides assert this
 * contract.
 */
import { z } from "zod";

export const OcrSourceSchema = z.enum([
  "screenshot",
  "camera",
  "share-sheet-image",
]);

export const OcrRequestSchema = z
  .object({
    /** Opaque reference to the local image (no filesystem paths). */
    imageRef: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    source: OcrSourceSchema,
    languages: z.array(z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/)).max(4).optional(),
  })
  .strict();
export type OcrRequest = z.infer<typeof OcrRequestSchema>;

/** Vision results are flagged on-device; anything claiming otherwise
 * fails this contract. */
export const OcrResultSchema = z
  .object({
    text: z.string().max(40000),
    languageCode: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/).nullable(),
    onDevice: z.literal(true),
  })
  .strict();
export type OcrResult = z.infer<typeof OcrResultSchema>;

/* ---------------- business-card fields (step 3) ---------------- */

export const CardFieldsSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    organization: z.string().min(1).max(100).optional(),
    phone: z.string().regex(/^[+][0-9 ()-]{6,19}$|^[0-9 ()-]{7,20}$/).optional(),
    email: z
      .string()
      .regex(/^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,64}(\.[A-Za-z]{2,})?$/)
      .optional(),
    website: z
      .string()
      .regex(/^https?:\/\/[A-Za-z0-9.-]{1,126}(:[0-9]{1,5})?(\/[^\s]{0,100})?$/)
      .optional(),
  })
  .strict();
export type CardFields = z.infer<typeof CardFieldsSchema>;

export function isCardFieldsEmpty(fields: CardFields): boolean {
  return Object.keys(fields).length === 0;
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+(\.[A-Za-z]{2,})?/;
const PHONE_RE = /(?:\+?[0-9][0-9 ()-]{6,19})/;
const URL_RE = /https?:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?(\/\S*)?/;

/** Field preview: best-effort extraction from OCR text; the preview
 * always goes through the strict schema before display. */
export function parseCardFields(ocrText: string): CardFields {
  const lines = ocrText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const joined = lines.join("\n");
  const fields: CardFields = {};
  const email = EMAIL_RE.exec(joined);
  if (email !== null) fields.email = email[0];
  const url = URL_RE.exec(joined);
  if (url !== null) fields.website = url[0];
  const phone = PHONE_RE.exec(
    lines.find((l) => PHONE_RE.test(l) && !EMAIL_RE.test(l)) ?? "",
  );
  if (phone !== null) fields.phone = phone[0].trim();
  const nameLine = lines.find(
    (l) =>
      !EMAIL_RE.test(l) &&
      !URL_RE.test(l) &&
      !PHONE_RE.test(l) &&
      /^[A-ZÀ-Þ][\p{L}' .-]{1,99}$/u.test(l),
  );
  if (nameLine !== undefined) fields.name = nameLine;
  const orgLine = lines.find(
    (l) =>
      l !== nameLine &&
      !EMAIL_RE.test(l) &&
      !URL_RE.test(l) &&
      !PHONE_RE.test(l) &&
      /\b(inc|llc|ltd|gmbh|co|company|labs?|studio|group)\b/i.test(l),
  );
  if (orgLine !== undefined) fields.organization = orgLine;
  const checked = CardFieldsSchema.safeParse(fields);
  return checked.success ? checked.data : {};
}

/* ---------------- confirmed Contacts write (step 3) ---------------- */

export interface ContactsPort {
  writeContact(fields: CardFields): Promise<void>;
}

/** No Contacts write ever occurs without the user's confirmed tap;
 * `userConfirmed` is that tap, plumbed from the UI. */
export async function confirmContactWrite(
  fields: CardFields,
  contacts: ContactsPort,
  userConfirmed: boolean,
): Promise<boolean> {
  if (!userConfirmed) return false;
  const parsed = CardFieldsSchema.safeParse(fields);
  if (!parsed.success || isCardFieldsEmpty(parsed.data)) return false;
  await contacts.writeContact(parsed.data);
  return true;
}
