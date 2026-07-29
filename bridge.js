// Injected into flight-processor. Lets the page ask the extension to run a
// Smiles search and get the flights back. The page talks via window.postMessage;
// this relays to the background service worker and posts the answer back.
(function () {
  'use strict';
  const announce = () => window.postMessage({ __ymBridge: 'ready', version: '0.2' }, '*');

  window.addEventListener('message', e => {
    if (e.source !== window || !e.data) return;

    // Page asks "is the extension there?"
    if (e.data.__ymPing) { announce(); return; }

    // Page asks to STOP the current search.
    if (e.data.__ymReq === 'abort') {
      try { if (chrome.runtime && chrome.runtime.id) chrome.runtime.sendMessage({ type: 'abort' }); } catch (ex) {}
      return;
    }

    // Page requests a search: { __ymReq:'search', id, params:{origin,destination,date,adults?} }
    if (e.data.__ymReq === 'search') {
      const id = e.data.id;
      if (!chrome.runtime || !chrome.runtime.id) {
        window.postMessage({ __ymRes: 'search', id, ok: false, flights: [], error: 'Extension was reloaded — please refresh this page (Ctrl+Shift+R).' }, '*');
        return;
      }
      try {
        chrome.runtime.sendMessage({ type: 'search', params: e.data.params, verify: e.data.verify, verifyUids: e.data.verifyUids }, resp => {
          const err = chrome.runtime.lastError;
          window.postMessage({
            __ymRes: 'search', id,
            ok: !err && resp && resp.ok,
            flights: resp && resp.flights || [],
            error: err ? err.message : (resp && resp.error) || null
          }, '*');
        });
      } catch (ex) {
        window.postMessage({ __ymRes: 'search', id, ok: false, flights: [], error: String(ex) }, '*');
      }
    }
  });

  announce(); // tell the page we're here as soon as we load
})();
