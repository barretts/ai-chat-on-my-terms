export interface DeviceCapacity {
  availableMemoryBytes: number | null;
  availableStorageBytes: number | null;
}

/** Browser quota and memory hints do not establish a native model fit. */
export function readDeviceCapacity(): DeviceCapacity {
  return { availableMemoryBytes: null, availableStorageBytes: null };
}
