(function () {
  "use strict";

  var APP_ROOT_SELECTOR = '[data-demo-escalation-owned="root"]';
  var APP_ROOT_MARKER = "root";
  var BUNDLE_ID = "demo-escalation-bundle";
  var STATUS_KEY = "DEMO_ESCALATION_LAUNCHER_STATUS";
  var RUNTIME_KEY = "DEMO_ESCALATION_LAUNCHER_RUNTIME";
  var DEFAULT_TITLE = "Demo Escalation Workbench";
  var BASE_URL = "https://example.invalid/sites/DemoPortal/fixtures/escalation/frontend/";
  var SITE_URL = "https://example.invalid/sites/DemoPortal";

  function errorMessage(error) {
    return error && error.message ? error.message : String(error);
  }

  function setStage(stage, message, error) {
    var previous = window[STATUS_KEY];
    var history = previous && Array.isArray(previous.history) ? previous.history.slice() : [];
    var timestamp = new Date().toISOString();
    history.push({ stage: stage, message: message, at: timestamp });
    window[STATUS_KEY] = {
      stage: stage,
      message: message,
      error: error || null,
      updatedAt: timestamp,
      history: history
    };
  }

  function ensureRequestedStage() {
    var current = window[STATUS_KEY];
    var history = current && Array.isArray(current.history) ? current.history : [];
    var hasRequested = history.some(function (entry) { return entry && entry.stage === "requested"; });
    if (!hasRequested) {
      setStage("requested", "Demo Escalation launcher requested.");
    }
  }

  function showFailure(error) {
    var message = errorMessage(error);
    setStage("error", message, message);
    if (window.console && typeof window.console.error === "function") {
      window.console.error("Demo Escalation launcher failed:", message);
    }
  }

  function resolveRuntime() {
    var injectedScript = /** @type {HTMLScriptElement | null} */ (document.currentScript);
    if (!window.location || window.location.protocol !== "https:") {
      throw new Error("Escalation launcher requires an HTTPS host page.");
    }

    if (injectedScript && typeof injectedScript.src !== "string") {
      throw new Error("Escalation launcher requires a script URL context.");
    }
    var hasScriptUrl = injectedScript && typeof injectedScript.src === "string" && injectedScript.src.trim();
    if (injectedScript && !hasScriptUrl) {
      throw new Error("Escalation launcher requires a script URL context.");
    }
    var baseUrl = hasScriptUrl ? new URL(".", injectedScript.src) : new URL(BASE_URL);
    if (baseUrl.protocol !== "https:" || baseUrl.origin !== window.location.origin) {
      throw new Error("Escalation launcher requires a same-origin HTTPS frontend URL.");
    }

    var decodedBasePath = decodeURIComponent(baseUrl.pathname);
    if (!/\/Escalation\/frontend\/$/i.test(decodedBasePath)) {
      throw new Error("Escalation launcher base URL must target the Escalation frontend folder.");
    }

    if (hasScriptUrl) {
      var scriptUrl = new URL(injectedScript.src, window.location.href);
      var decodedScriptPath = decodeURIComponent(scriptUrl.pathname);
      if (scriptUrl.protocol !== "https:" || scriptUrl.origin !== window.location.origin || !/\/Escalation\/frontend\/escalation-launcher\.js$/i.test(decodedScriptPath)) {
        throw new Error("Escalation launcher URL must target the same-origin HTTPS Escalation frontend folder.");
      }
    }

    return {
      baseUrl: baseUrl.href,
      siteUrl: SITE_URL
    };
  }

  function findOwnedRoot() {
    return document.querySelector(APP_ROOT_SELECTOR);
  }

  function isCurrentRun(token) {
    return window[RUNTIME_KEY] && window[RUNTIME_KEY].token === token;
  }

  function beginRun() {
    var previous = window[RUNTIME_KEY];
    var existingRoot = findOwnedRoot();
    var existingBundle = document.getElementById(BUNDLE_ID);
    if (previous && (previous.phase === "loading" || previous.phase === "active") && existingRoot && existingBundle) {
      previous.reentryCount = (previous.reentryCount || 0) + 1;
      setStage("launcher-reused", "Demo Escalation launcher is already active.");
      return null;
    }
    var token = String(Date.now()) + ":" + String(Math.random());
    window[RUNTIME_KEY] = { token: token, phase: "loading", reentryCount: 0 };
    return token;
  }

  function createOwnedRoot(documentShell) {
    var shellRoot = documentShell.getElementById("main-content");
    if (!shellRoot || !document.body || typeof document.importNode !== "function") {
      throw new Error("Escalation shell is missing its app-owned main root.");
    }
    var ownedRoot = document.importNode(shellRoot, true);
    ownedRoot.dataset.demoEscalationOwned = APP_ROOT_MARKER;
    return ownedRoot;
  }

  function bodyNodes() {
    return Array.prototype.slice.call(document.body.childNodes || document.body.children || []);
  }

  function replaceBody(nodes) {
    var first;
    while ((first = document.body.firstChild || (document.body.children && document.body.children[0]))) {
      document.body.removeChild(first);
    }
    nodes.forEach(function (node) { document.body.appendChild(node); });
  }

  function restoreNode(node, parent, nextSibling) {
    if (!node || !parent) return;
    if (nextSibling && nextSibling.parentNode === parent) {
      parent.insertBefore(node, nextSibling);
    } else {
      parent.appendChild(node);
    }
  }

  function loadBundle(documentShell, runtimeConfig, baseUrl, token) {
    if (!isCurrentRun(token)) return;
    var ownedRoot = createOwnedRoot(documentShell);
    var previousBodyNodes = bodyNodes();
    var previousTitle = document.title;
    var hadPreviousConfig = Object.prototype.hasOwnProperty.call(window, "DEMO_ESCALATION_CONFIG");
    var previousConfig = window.DEMO_ESCALATION_CONFIG;
    var previousBundle = document.getElementById(BUNDLE_ID);
    var previousBundleParent = previousBundle && previousBundle.parentNode;
    var previousBundleNextSibling = previousBundle && previousBundle.nextSibling;
    var bundle;
    var committed = false;

    function rollback(error) {
      if (committed || !isCurrentRun(token)) return;
      if (bundle && bundle.parentNode) bundle.remove();
      replaceBody(previousBodyNodes);
      restoreNode(previousBundle, previousBundleParent, previousBundleNextSibling);
      document.title = previousTitle;
      if (hadPreviousConfig) {
        window.DEMO_ESCALATION_CONFIG = previousConfig;
      } else {
        delete window.DEMO_ESCALATION_CONFIG;
      }
      window[RUNTIME_KEY].phase = "error";
      showFailure(error);
    }

    function markBundleReady() {
      if (!isCurrentRun(token)) return;
      setStage("bundle-loaded", "Demo Escalation runtime bundle loaded.");
      var currentRoot = findOwnedRoot();
      if (!currentRoot || currentRoot !== ownedRoot) {
        rollback(new Error("Demo Escalation app root did not take exclusive ownership of the visible body."));
        return;
      }
      replaceBody([ownedRoot]);
      committed = true;
      window[RUNTIME_KEY].phase = "active";
      bundle.onload = null;
      bundle.onerror = null;
      setStage("app-root-present", "Demo Escalation app root is present and visible.");
    }

    try {
      if (previousBundle) previousBundle.remove();
      replaceBody([ownedRoot]);
      document.title = documentShell.title || DEFAULT_TITLE;
      window.DEMO_ESCALATION_CONFIG = runtimeConfig;

      bundle = document.createElement("script");
      bundle.id = BUNDLE_ID;
      bundle.src = baseUrl + "assets/app.js?v=" + String(Date.now());
      bundle.async = true;
      bundle.dataset.source = "demo-escalation-webview2";
      bundle.onload = markBundleReady;
      bundle.onerror = function () {
        if (!isCurrentRun(token)) return;
        rollback(new Error("Could not load assets/app.js from the same-origin HTTPS Escalation frontend folder."));
      };
      document.head.appendChild(bundle);
    } catch (error) {
      rollback(error);
    }
  }

  ensureRequestedStage();
  setStage("launcher-loaded", "Demo Escalation launcher loaded.");

  var runtime;
  try {
    runtime = resolveRuntime();
  } catch (error) {
    showFailure(error);
    return;
  }

  var runtimeConfig = {
    status: "LIVE_READY",
    mode: "sharepoint",
    verified: true,
    siteUrl: runtime.siteUrl,
    listTitle: "Demo Escalations",
    vendorReferenceListTitle: "Demo Vendor Reference",
    pageSize: 10,
    fieldMapping: {
      id: "Id",
      Title: "Title",
      UniqueKey: "UniqueKey",
      Status: "Status",
      Priority: "Priority",
      Vendor: "Vendor",
      VendorName: "Vendor_x0020_Name",
      Reference: "Reference",
      From: "From",
      ReceivedDateTime: "Received_x0020_Date_x0020_Time",
      DateResolved: "Date_x0020_Resolved",
      WorkingNotes: "Working_x0020_Notes",
      Mailbox: "Mailbox",
      SourceQueue: "Source_x0020_Queue",
      InternetMessageId: "Internet_x0020_Message_x0020_ID",
      OutlookMessageId: "Outlook_x0020_Message_x0020_ID",
      ConversationId: "Conversation_x0020_ID",
      SMarker: "SMarker",
      OriginalUniqueKey: "Original_x0020_UniqueKey",
      VendorCategory: "Vendor_x0020_Category",
      Entity: "Entity",
      DocDate: "Doc_x0020_Date",
      InvRef: "Inv_x0020_Ref",
      Value: "Value",
      ActionType: "Action_x0020_Type",
      APOwner: "AP_x0020_Owner",
      EscalationDate: "Escalation_x0020_Date",
      DaysToResolve: "Days_x0020_To_x0020_Resolve",
      IsClosed: "Is_x0020_Closed"
    }
  };

  var runToken = beginRun();
  if (!runToken) return;

  fetch(runtime.baseUrl + "index.html?v=" + String(Date.now()), { credentials: "include" })
    .then(function (response) {
      if (!response.ok) throw new Error("Could not load the Escalation shell: " + response.status);
      return response.text();
    })
    .then(function (html) {
      if (!isCurrentRun(runToken)) return;
      var parsed = new DOMParser().parseFromString(html, "text/html");
      setStage("shell-loaded", "Demo Escalation shell loaded.");
      loadBundle(parsed, runtimeConfig, runtime.baseUrl, runToken);
    })
    .catch(showFailure);
}());
