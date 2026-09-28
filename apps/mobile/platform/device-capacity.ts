import * as Device from "expo-device";
import { Paths } from "expo-file-system";

export interface DeviceCapacity {
  availableMemoryBytes: number | null;
  availableStorageBytes: number | null;
}

/** Preserve the native onboarding fit estimate and available storage reading. */
export function readDeviceCapacity(): DeviceCapacity {
  const totalMemory = Device.totalMemory;
  return {
    availableMemoryBytes: totalMemory ? Math.floor(totalMemory * 0.55) : null,
    availableStorageBytes:
      Paths.availableDiskSpace > 0 ? Paths.availableDiskSpace : null,
  };
}
