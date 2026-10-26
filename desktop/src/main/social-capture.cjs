// Records the JSON the platform page itself fetches, so lead data comes from the
// page's own responses instead of scraping text. Nothing is requested on our
// own; responses over the size cap or that are not JSON are ignored.
const MAX_BYTES = 6 * 1024 * 1024;

function captureResponses(browser, sessionId, { match, onJson }) {
  const operations = new Map(), wanted = new Map();
  const stop = browser.onEvent(async (message) => {
    if (message.sessionId !== sessionId) return;
    const { method, params } = message;
    if (method === "Network.requestWillBeSent") {
      let operation = "";
      if (/\/graphql/.test(params.request.url)) { try { operation = JSON.parse(params.request.postData || "{}").operationName || ""; } catch { /* Not JSON. */ } }
      operations.set(params.requestId, operation);
    } else if (method === "Network.responseReceived") {
      const url = params.response.url;
      if (params.response.status === 200 && match(url, operations.get(params.requestId) || "")) wanted.set(params.requestId, url);
    } else if (method === "Network.loadingFinished" && wanted.has(params.requestId)) {
      const url = wanted.get(params.requestId); wanted.delete(params.requestId);
      const operation = operations.get(params.requestId) || ""; operations.delete(params.requestId);
      if (params.encodedDataLength > MAX_BYTES) return;
      try {
        const result = await browser.send("Network.getResponseBody", { requestId: params.requestId }, sessionId);
        const text = result.base64Encoded ? Buffer.from(result.body, "base64").toString("utf8") : result.body;
        if (text.length > MAX_BYTES) return;
        onJson({ url, operation, json: JSON.parse(text) });
      } catch { /* The page went away or the body was not JSON. */ }
    } else if (method === "Network.loadingFailed") { wanted.delete(params.requestId); operations.delete(params.requestId); }
  });
  return {
    start: () => browser.send("Network.enable", { maxResourceBufferSize: 8 * 1024 * 1024, maxTotalBufferSize: 32 * 1024 * 1024 }, sessionId),
    stop
  };
}

module.exports = { captureResponses };
