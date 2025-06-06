const RNInternals = require("./rn-internals/rn-internals");
const { AppExtensionProxy } = require("./plugins/AppExtensionProxy");

function mimeTypeFromResponseType(responseType) {
  switch (responseType) {
    case "arraybuffer":
    case "blob":
    case "base64":
      return "application/octet-stream";
    case "text":
    case "":
      return "text/plain";
    case "json":
      return "application/json";
    case "document":
      return "text/html";
  }
  return undefined;
}

function readResponseBodyContent(xhr) {
  if (!xhr && !xhr._cachedResponse) {
    // if response was accessed it is cached and we can use it
    // otherwise we don't want to read it here to avoid potential side effects
    return Promise.resolve(undefined);
  }
  const responseType = xhr.responseType;
  if (responseType === "" || responseType === "text") {
    return Promise.resolve(xhr.responseText);
  }
  if (responseType === "blob") {
    const contentType = xhr.getResponseHeader("Content-Type") || "";
    if (contentType.startsWith("text/") || contentType.startsWith("application/json")) {
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => {
          resolve(reader.result);
        };
        reader.readAsText(xhr.response);
      });
    }
  }
  // don't want to read binary data here
  return Promise.resolve(undefined);
}

// WeakRef support is only available on the new architecture. We keep XHR objects
// as WeakRefs to avoid leaking potentially large response data objects. We need
// to keep them around in case the network inspector wants to acess this data.
// By using WeakRefs we give a way to access that within a sensible time period
// which seems like a better tradeof than keeping all request data around forever.
// When WeakRef isn't supported, unless the response data is accessed, we will never
// cleanup the reference. The below fake implementation of weak reference drops
// the ref after specified timeout.
const XHR_REF_TIMEOUT_MS = 3 * 60 * 1000; // 3 mins
class FakeWeakRef {
  constructor(obj) {
    this.obj = obj;
    this.timeout = setTimeout(() => (this.obj = undefined), XHR_REF_TIMEOUT_MS);
  }
  deref() {
    // timeout captures this and hence may extend the time the reference is kept.
    // we clear it here as in the code below we drop the weak ref immediately after dereferencing.
    clearTimeout(this.timeout);
    return this.obj;
  }
}

const WeakRefImpl = typeof WeakRef !== "undefined" ? WeakRef : FakeWeakRef;

let setupCompleted = false;

export function setup() {
  if (setupCompleted) {
    return;
  }
  setupCompleted = true;

  const networkProxy = new AppExtensionProxy("network");

  let enabled = false;
  networkProxy.addMessageListener("cdp-message", (message) => {
    if (message.method === "Network.enable" && !enabled) {
      enabled = true;
      enableNetworkInspect(networkProxy);
    } else if (message.method === "Network.disable" && enabled) {
      enabled = false;
      disableNetworkInspect();
    }
  });
}

function disableNetworkInspect() {
  RNInternals.XHRInterceptor.disableInterception();
}

function enableNetworkInspect(networkProxy) {
  const XHRInterceptor = RNInternals.XHRInterceptor;

  const loaderId = "xhr-interceptor";
  const xhrsMap = new Map();

  const requestIdPrefix = Math.random().toString(36).slice(2);
  let requestIdCounter = 0;

  function listener(message) {
    if (message.method === "Network.disable") {
      networkProxy.removeMessageListener("cdp-message", listener);
    } else if (
      message.method === "Network.getResponseBody" &&
      message.params.requestId.startsWith(requestIdPrefix)
    ) {
      const requestId = message.params.requestId;
      const xhr = xhrsMap.get(requestId)?.deref();
      // typically with devtools UI, each request details will be fetched at most once.
      // we can safely delete the record once the request data is retrieved.
      xhrsMap.delete(requestId);

      readResponseBodyContent(xhr).then((body) => {
        networkProxy.sendMessage(
          "cdp-message",
          JSON.stringify({
            id: message.id,
            result: { body },
          })
        );
      });
    }
  }
  networkProxy.addMessageListener("cdp-message", listener);

  const HEADERS_RECEIVED = 2; // readyState value when headers are received

  function sendCallback(data, xhr) {
    const requestId = `${requestIdPrefix}-${requestIdCounter++}`;
    const sendTime = Date.now();
    let ttfb;

    xhrsMap.set(requestId, new WeakRefImpl(xhr));

    function sendCDPMessage(method, params) {
      networkProxy.sendMessage("cdp-message", JSON.stringify({ method, params }));
    }

    sendCDPMessage("Network.requestWillBeSent", {
      requestId: requestId,
      loaderId,
      timestamp: sendTime / 1000,
      wallTime: Math.floor(Date.now() / 1000),
      request: {
        url: xhr._url,
        method: xhr._method,
        headers: xhr._headers,
        postData: data,
      },
      type: "XHR",
      initiator: {
        type: "script",
      },
    });

    xhr.addEventListener("abort", (event) => {
      sendCDPMessage("Network.loadingFailed", {
        requestId: requestId,
        timestamp: Date.now() / 1000,
        type: "XHR",
        errorText: "Aborted",
        canceled: true,
      });
    });

    xhr.addEventListener("error", (event) => {
      sendCDPMessage("Network.loadingFailed", {
        requestId: requestId,
        timestamp: Date.now() / 1000,
        type: "XHR",
        errorText: "Failed",
        cancelled: false,
      });
    });

    xhr.addEventListener("readystatechange", (event) => {
      if (xhr.readyState === HEADERS_RECEIVED) {
        ttfb = Date.now() - sendTime;
      }
    });

    xhr.addEventListener("load", (event) => {
      sendCDPMessage("Network.responseReceived", {
        requestId: requestId,
        loaderId,
        timestamp: Date.now() / 1000,
        ttfb,
        type: "XHR",
        response: {
          type: xhr.responseType,
          url: xhr._url,
          status: xhr.status,
          statusText: xhr.statusText,
          headers: xhr.responseHeaders,
          mimeType: mimeTypeFromResponseType(xhr.responseType),
          data: xhr._response,
        },
      });
    });

    xhr.addEventListener("loadend", (event) => {
      sendCDPMessage("Network.loadingFinished", {
        requestId: requestId,
        timestamp: Date.now() / 1000,
        duration: Date.now() - sendTime,
        encodedDataLength: xhr._response.size || xhr._response.length, // when response is blob, we use size, and length otherwise
      });
    });
  }

  XHRInterceptor.disableInterception();
  XHRInterceptor.setSendCallback(sendCallback);
  XHRInterceptor.enableInterception();
}
