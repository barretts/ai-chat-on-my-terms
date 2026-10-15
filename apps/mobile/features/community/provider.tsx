import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { createCommunityClient } from "./client";
import type {
  CommunityClient,
  ThemeDetail,
  ThemeListing,
  VoicePackInfo,
} from "./client";
import { secureStoreTokenPort } from "../account/adapters";

export interface CommunityValue {
  available: boolean;
  themes: ThemeListing[];
  voices: VoicePackInfo[];
  busy: boolean;
  error: string | null;
  refresh(): Promise<void>;
  download(slugOrId: string): Promise<ThemeDetail | null>;
  publishTheme(slug: string, doc: unknown): Promise<boolean>;
}

const CommunityContext = createContext<CommunityValue | null>(null);

export function CommunityProvider(options: {
  baseUrl?: string;
  client?: CommunityClient;
  children: ReactNode;
}) {
  const client = useMemo(
    () =>
      options.client ??
      (options.baseUrl === undefined
        ? null
        : createCommunityClient({
            baseUrl: options.baseUrl,
            tokens: secureStoreTokenPort(),
          })),
    [options.client, options.baseUrl],
  );
  // Rebuilt in the render body, this factory produced a fresh client (and a
  // fresh token adapter) on every render: each refresh state update changed
  // the client identity, reran the refresh effect, and looped requests until
  // restart. The client is now owned here and rebuilt only for a real
  // configuration change (injected client or baseUrl).
  const activeClient = useRef(client);
  const [themes, setThemes] = useState<ThemeListing[]>([]);
  const [voices, setVoices] = useState<VoicePackInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    // A closure captured before a client switch must not fetch through the
    // abandoned client nor overwrite state from its responses.
    if (client === null || client !== activeClient.current) return;
    try {
      const [themeList, voiceList] = await Promise.all([
        client.listThemes(),
        client.listVoices(),
      ]);
      if (client !== activeClient.current) return;
      setThemes(themeList);
      setVoices(voiceList);
      setError(null);
    } catch {
      setError("catalog unreachable");
    }
  }, [client]);

  useEffect(() => {
    // Commit the new client as active before refreshing it; refreshes still
    // in flight on the previous client are dropped by the identity check.
    activeClient.current = client;
    void refresh();
  }, [client, refresh]);

  const download = useCallback(
    async (slugOrId: string) => {
      if (client === null) return null;
      return await client.getTheme(slugOrId).catch(() => null);
    },
    [client],
  );

  const publishTheme = useCallback(
    async (slug: string, doc: unknown) => {
      if (client === null) return false;
      setBusy(true);
      setError(null);
      try {
        await client.publishTheme(slug, doc);
        await refresh();
        return true;
      } catch {
        setError("publish failed: sign in first or fix the theme");
        return false;
      } finally {
        setBusy(false);
      }
    },
    [client, refresh],
  );

  const value: CommunityValue = {
    available: client !== null,
    themes,
    voices,
    busy,
    error,
    refresh,
    download,
    publishTheme,
  };
  return (
    <CommunityContext.Provider value={value}>
      {options.children}
    </CommunityContext.Provider>
  );
}

export function useCommunity(): CommunityValue {
  const value = useContext(CommunityContext);
  if (value === null)
    throw new Error("useCommunity must be used inside CommunityProvider");
  return value;
}
