const { getDefaultConfig } = require("expo/metro-config");
const { localProviderProxy } = require("../../tools/local-provider-proxy.cjs");
const { webResearchProxy } = require("../../tools/web-research-proxy.cjs");
const { braveSearchProxy } = require("../../tools/brave-search-proxy.cjs");

const config = getDefaultConfig(__dirname);
if (!config.resolver.assetExts.includes("wasm")) {
  config.resolver.assetExts.push("wasm");
}
const previousEnhanceMiddleware = config.server.enhanceMiddleware;
config.server.enhanceMiddleware = (middleware, server) => {
  const next = previousEnhanceMiddleware
    ? previousEnhanceMiddleware(middleware, server)
    : middleware;
  return (request, response, nextHandler) => {
    response.setHeader("Cross-Origin-Embedder-Policy", "credentialless");
    response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    return braveSearchProxy(request, response, () =>
      webResearchProxy(request, response, () =>
        localProviderProxy(request, response, () =>
          next(request, response, nextHandler),
        ),
      ),
    );
  };
};

module.exports = config;
