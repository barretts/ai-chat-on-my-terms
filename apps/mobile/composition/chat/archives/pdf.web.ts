import type { ArchiveConversation } from "@locallab/archives";
import type { ArchivePdfPort } from "./types";

const WIDTH = 1224;
const HEIGHT = 1584;
const MARGIN = 72;
const LINE_HEIGHT = 32;
const MAX_PAGES = 250;

/** Browser fonts preserve Unicode; each wrapped canvas page becomes a real PDF image page. */
export const browserArchivePdf: ArchivePdfPort = {
  async render(conversation) {
    const canvas = document.createElement("canvas");
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    const context = canvas.getContext("2d");
    if (!context)
      throw new Error("PDF rendering is unavailable in this browser");
    const pages: Uint8Array[] = [];
    let y = MARGIN;
    const reset = () => {
      context.fillStyle = "white";
      context.fillRect(0, 0, WIDTH, HEIGHT);
      context.fillStyle = "#181818";
      context.textBaseline = "top";
      context.font = "22px sans-serif";
      y = MARGIN;
    };
    const finish = () => {
      if (pages.length >= MAX_PAGES)
        throw new Error(
          "PDF exceeds 250 pages. Export the complete chat as TXT or ZIP instead.",
        );
      const encoded = canvas.toDataURL("image/jpeg", 0.9).split(",")[1]!;
      pages.push(
        Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0)),
      );
    };
    reset();
    const line = (text: string) => {
      if (y + LINE_HEIGHT > HEIGHT - MARGIN) {
        finish();
        reset();
      }
      context.fillText(text, MARGIN, y);
      y += LINE_HEIGHT;
    };
    const paragraph = (text: string) => {
      for (const source of text.split(/\r\n|\r|\n/)) {
        let pending = "";
        for (const character of source) {
          if (
            pending &&
            context.measureText(pending + character).width > WIDTH - 2 * MARGIN
          ) {
            line(pending);
            pending = "";
          }
          pending += character;
        }
        line(pending);
      }
    };
    paragraph(conversation.title);
    line("");
    for (const message of conversation.messages) {
      paragraph(message.role);
      paragraph(partsText(message.parts));
      for (const [index, variant] of (message.variants ?? []).entries()) {
        paragraph(
          `Variant ${index + 1}${variant.selected ? " (selected)" : ""}`,
        );
        paragraph(partsText(variant.parts));
      }
      line("");
    }
    finish();
    return encodeImagePdf(pages);
  },
};

function partsText(parts: readonly unknown[]): string {
  return parts
    .map((part) => {
      if (typeof part !== "object" || part === null) return "";
      const value = part as { type?: unknown; text?: unknown };
      return typeof value.text === "string"
        ? value.text
        : typeof value.type === "string"
          ? `[${value.type}]`
          : "";
    })
    .join("");
}

function encodeImagePdf(pages: readonly Uint8Array[]): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const offsets = [0];
  let length = 0;
  const append = (data: string | Uint8Array) => {
    const bytes = typeof data === "string" ? encoder.encode(data) : data;
    chunks.push(bytes);
    length += bytes.length;
  };
  const object = (id: number, body: string, stream?: Uint8Array) => {
    offsets[id] = length;
    append(`${id} 0 obj\n${body}`);
    if (stream) {
      append("\nstream\n");
      append(stream);
      append("\nendstream");
    }
    append("\nendobj\n");
  };
  append("%PDF-1.4\n");
  object(1, "<< /Type /Catalog /Pages 2 0 R >>");
  object(
    2,
    `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, index) => `${3 + index * 3} 0 R`).join(" ")}] >>`,
  );
  pages.forEach((image, index) => {
    const id = 3 + index * 3;
    object(
      id,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Image ${id + 1} 0 R >> >> /Contents ${id + 2} 0 R >>`,
    );
    object(
      id + 1,
      `<< /Type /XObject /Subtype /Image /Width ${WIDTH} /Height ${HEIGHT} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.length} >>`,
      image,
    );
    const drawing = encoder.encode("q 612 0 0 792 0 0 cm /Image Do Q");
    object(id + 2, `<< /Length ${drawing.length} >>`, drawing);
  });
  const xref = length;
  append(`xref\n0 ${offsets.length}\n0000000000 65535 f \n`);
  for (const offset of offsets.slice(1))
    append(`${String(offset).padStart(10, "0")} 00000 n \n`);
  append(
    `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`,
  );
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
