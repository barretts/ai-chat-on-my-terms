import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Dialog, Portal, Button } from "react-native-paper";
import { openMobileDatabase } from "../../platform/database-open";
import { DiagnosticsContext } from "./context";
import { DiagnosticsScreen } from "./screen";
import { traceLog } from "./trace-log";
import { describeError } from "./errors";

export function DiagnosticsProvider({ children }: { children: ReactNode }) {
  const [visible, setVisible] = useState(false);
  const [storageError, setStorageError] = useState("");
  const retryStorage = useCallback(async () => {
    try {
      await traceLog.initialize(await openMobileDatabase());
      setStorageError("");
    } catch (cause) {
      setStorageError(
        describeError(cause, {
          operation: "Open diagnostic storage",
          recovery:
            "Retry diagnostic storage. Check available storage space if it keeps failing.",
        }),
      );
      throw cause;
    }
  }, []);
  useEffect(() => {
    void retryStorage().catch(() => undefined);
  }, [retryStorage]);
  return (
    <DiagnosticsContext.Provider
      value={{ openTrace: () => setVisible(true), retryStorage, storageError }}
    >
      {children}
      <Portal>
        <Dialog
          visible={visible}
          onDismiss={() => setVisible(false)}
          style={{ maxHeight: "85%" }}
        >
          <Dialog.Title>Trace log</Dialog.Title>
          <Dialog.ScrollArea
            role="dialog"
            accessibilityLabel="Trace log"
            style={{ flexShrink: 1, paddingHorizontal: 0 }}
          >
            <DiagnosticsScreen />
          </Dialog.ScrollArea>
          <Dialog.Actions>
            <Button onPress={() => setVisible(false)}>Done</Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
    </DiagnosticsContext.Provider>
  );
}
