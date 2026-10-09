import { afterEach, expect, it, vi } from "vitest";
vi.mock("expo/fetch", () => ({ fetch: vi.fn(async () => new Response("{}")) }));
import { fetch as expoFetch } from "expo/fetch";
import { braveSearchFetch as nativeFetch } from "./brave-search-fetch";
import { braveSearchFetch as webFetch } from "./brave-search-fetch.web";

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
const endpoint =
  "https://api.search.brave.com/res/v1/web/search?q=Expo&count=5&extra_snippets=true";
const init: RequestInit = {
  credentials: "include",
  redirect: "follow",
  headers: {
    "x-subscription-token": "fixture-brave-key",
    authorization: "must-not-leak",
    cookie: "must-not-leak",
    "x-api-key": "must-not-leak",
  },
};

it("native Brave transport forwards only the selected search token and fixed Accept header", async () => {
  await nativeFetch(endpoint, init);
  expect(expoFetch).toHaveBeenCalledWith(endpoint, {
    method: "GET",
    credentials: "omit",
    redirect: "error",
    headers: {
      accept: "application/json",
      "x-subscription-token": "fixture-brave-key",
    },
  });
});
it("neither platform forwards a Brave token to a different host or endpoint", async () => {
  vi.stubGlobal("window", {
    location: { hostname: "localhost", origin: "http://localhost:8085" },
  });
  const request = vi.fn();
  vi.stubGlobal("fetch", request);
  for (const transport of [nativeFetch, webFetch]) {
    for (const url of [
      "https://example.com/",
      "https://api.search.brave.com/other",
      "https://user:password@api.search.brave.com/res/v1/web/search?q=Expo",
    ])
      await expect(transport(url, init)).rejects.toThrow(/Only the configured/);
  }
  expect(expoFetch).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
});
it("local preview carries a token in a header to its dedicated fixed-service relay, never in a URL", async () => {
  vi.stubGlobal("window", {
    location: { hostname: "localhost", origin: "http://localhost:8085" },
  });
  const request = vi.fn(async () => new Response("{}"));
  vi.stubGlobal("fetch", request);
  await webFetch(endpoint, init);
  const [url, options] = request.mock.calls[0] as unknown as [URL, RequestInit];
  expect(url.toString()).toBe(
    "http://localhost:8085/_locallab/search-api?q=Expo",
  );
  expect(options.headers).toEqual({
    accept: "application/json",
    "x-subscription-token": "fixture-brave-key",
    "x-locallab-preview": "1",
  });
  expect(options.credentials).toBe("omit");
  expect(options.redirect).toBe("error");
});
