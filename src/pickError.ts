const FOLDER_TOO_BROAD =
  "The browser will not open that folder because it is too broad. Choose the Luci home, not your user folder.";

export function explainPickError(error: unknown): string {
  if (error instanceof DOMException && error.name === "SecurityError") {
    return FOLDER_TOO_BROAD;
  }
  if (error instanceof Error && /system files/i.test(error.message)) {
    return FOLDER_TOO_BROAD;
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "Could not open that folder.";
}
