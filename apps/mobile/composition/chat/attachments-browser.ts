/** Open the browser's real file chooser and remove its transient input on every exit. */
export function pickBrowserFile(
  accept: string,
  signal?: AbortSignal,
  capture?: string,
): Promise<File | undefined> {
  signal?.throwIfAborted();
  if (typeof document === "undefined")
    throw new Error("File selection is unavailable outside the browser");
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.style.display = "none";
    if (capture) input.setAttribute("capture", capture);
    const cleanup = () => {
      input.remove();
      signal?.removeEventListener("abort", abort);
    };
    const abort = () => {
      cleanup();
      reject(signal?.reason ?? new DOMException("Canceled", "AbortError"));
    };
    input.addEventListener(
      "change",
      () => {
        const file = input.files?.[0];
        cleanup();
        resolve(file);
      },
      { once: true },
    );
    input.addEventListener(
      "cancel",
      () => {
        cleanup();
        resolve(undefined);
      },
      { once: true },
    );
    signal?.addEventListener("abort", abort, { once: true });
    document.body.appendChild(input);
    input.click();
  });
}

export function browserFileMime(name: string): string {
  return (
    (
      {
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        png: "image/png",
        webp: "image/webp",
        gif: "image/gif",
        heic: "image/heic",
        heif: "image/heif",
        md: "text/markdown",
        txt: "text/plain",
        pdf: "application/pdf",
        xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      } as Record<string, string>
    )[name.toLowerCase().split(".").at(-1) ?? ""] ?? "application/octet-stream"
  );
}
