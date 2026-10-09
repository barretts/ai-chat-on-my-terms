import { createContext, useContext } from "react";
export const DiagnosticsContext = createContext<{
  openTrace(): void;
  retryStorage(): Promise<void>;
  storageError: string;
} | null>(null);
export function useDiagnostics() {
  return useContext(DiagnosticsContext);
}
