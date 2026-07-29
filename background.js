// Opens a background Smiles tab, lets the site run its own search, collects the
// flights, optionally verifies each one's real seats (boardingtax) in the same
// tab/session, then closes the tab.
const waiters = {}; // tabId -> resolver for the search flights
const sleep = ms => new Promise(r => setTimeout(r, ms));
const openTabs = new Set(); // Smiles search tabs currently open (for Stop)
let abortFlag = false;      // set by a Stop request; runSearch checks it and bails

// NOTE: we deliberately do NOT modify the User-Agent. Spoofing it made Smiles' bot
// shield (Akamai) reject the browser — that was breaking searches (and normal browsing)
// on both desktop and phone. The real browser identity + the phone's real IP is trusted.

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'search') { runSearch(msg.params, sender.tab && sender.tab.id).then(sendResponse); return true; }
  if (msg.type === 'flights' && sender.tab && waiters[sender.tab.id]) waiters[sender.tab.id](msg);
  if (msg.type === 'abort') { abortFlag = true; for (const t of openTabs) { chrome.tabs.remove(t).catch(() => {}); } openTabs.clear(); }
});

function emissionUrl(p) {
  const q = new URLSearchParams({
    originAirportCode: p.origin, destinationAirportCode: p.destination, departureDate: p.date,
    adults: String(p.adults || 1), children: '0', infants: '0',
    isFlexibleDateChecked: 'false', tripType: '2', cabinType: 'all', currencyCode: 'ARS'
  });
  return 'https://www.smiles.com.ar/emission?' + q.toString();
}

function verifyInTab(tabId, f, adults) {
  return new Promise(resolve => {
    try {
      chrome.tabs.sendMessage(tabId, { ymVerify: { uid: f.uid, fareUid: f.fareUid, type: f.type, adults: adults || 1 } }, resp => {
        if (chrome.runtime.lastError) { resolve({ ok: false }); return; }
        resolve(resp || { ok: false });
      });
    } catch (e) { resolve({ ok: false }); }
  });
}

async function runSearch(params, originTabId) {
  // On phones there's no hidden background tab, so bring the app tab back to the front when done.
  const backToApp = () => { if (originTabId != null) { try { chrome.tabs.update(originTabId, { active: true }); } catch (e) {} } };
  // Phones freeze background tabs, which stalls the search — so on mobile open the
  // Smiles tab in the FOREGROUND (kept awake), then return to the app when done.
  // Desktop keeps it hidden as before.
  const isMobile = /Android|Mobile/i.test((self.navigator && self.navigator.userAgent) || '');
  // One search attempt on a tab: wait for the (slower) award query, keep the cheapest of
  // duplicate fares. Resolves { flights, rawCount }.
  const collectSearch = (tabId) => new Promise(resolve => {
    let done = false, acc = [], rawTotal = 0, settle = null;
    const finish = () => {
      if (done) return; done = true; delete waiters[tabId];
      const best = {};
      acc.forEach(f => {
        const k = [f.origin, f.departure, f.destination, f.classType, f.stopover ? f.stopover.airport : ''].join('|');
        const mi = f.milesClub || f.miles || 1e9;
        const cur = best[k];
        if (!cur || mi < (cur.milesClub || cur.miles || 1e9)) best[k] = f;
      });
      resolve({ flights: Object.values(best), rawCount: rawTotal });
    };
    waiters[tabId] = m => {
      if (done) return;
      rawTotal += (m.rawCount || 0);
      if (m.flights && m.flights.length) { acc = acc.concat(m.flights); if (settle) clearTimeout(settle); settle = setTimeout(finish, 9000); }
    };
    setTimeout(() => { if (done) return; done = true; delete waiters[tabId]; resolve({ flights: [], rawCount: rawTotal }); }, 25000);
  });

  // Flaky browsers (esp. mobile) sometimes return an empty "no flights" — retry a few
  // times and use the first pass that actually comes back with flights.
  abortFlag = false; // fresh search
  let flights = [], rawCount = 0, sTab = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (abortFlag) { backToApp(); return { ok: false, aborted: true }; }
    let tab;
    try { tab = await chrome.tabs.create({ url: emissionUrl(params), active: isMobile }); }
    catch (e) { backToApp(); return { ok: false, error: 'Could not open Smiles tab: ' + e.message }; }
    openTabs.add(tab.id);
    const result = await collectSearch(tab.id);
    rawCount = result.rawCount || 0;
    if (result.flights.length) { flights = result.flights; sTab = tab; break; }
    chrome.tabs.remove(tab.id).catch(() => {}); openTabs.delete(tab.id);
    await sleep(900);
  }

  if (!flights.length) { backToApp(); return { ok: true, flights: [], rawCount }; }

  if (params.verify || params.price) {
    // Look up the shown flights via boardingtax. In PRICE mode (unpriced route) we check
    // EVERY shown flight (any airline) to grab its ARS boarding tax + seats. In verify-only
    // mode we check American only (AC is trusted). Either way we mirror the display filters.
    const nonstop = !!params.nonstop;
    const econMax = params.econMax || 999999;
    const bizMax = params.bizMax || 999999;
    const maxStop = params.maxStop != null ? params.maxStop : 99;
    const stopHrs = f => { if (!f.stopover) return 0; const d = f.stopover.duration || ''; const h = +((d.match(/(\d+)\s*h/) || [])[1] || 0); const m = +((d.match(/(\d+)\s*min/) || [])[1] || 0); return h + m / 60; };
    const cap = 40;
    let n = 0;
    let scanGrabbed = false; // TEMP: one business flight's money-field scan, to pin the tax field
    for (const f of flights) {
      if (abortFlag) break;                                      // Stop pressed
      if (!f.uid || !f.fareUid) continue;
      if (nonstop && f.stopover) continue;                       // won't be shown
      if (f.stopover && stopHrs(f) > maxStop) continue;          // won't be shown
      const capMi = /business/i.test(f.classType) ? bizMax : econMax;
      if ((f.milesClub || f.miles || 0) > capMi) continue;       // won't be shown
      // Verify-only mode skips non-American (AC trusted). Price mode checks everyone.
      if (!params.price && !/American/i.test(f.airline || '')) continue;
      if (n++ >= cap) break;
      let r = await verifyInTab(sTab.id, f, params.adults);
      // A 452 is either a transient rate-limit OR the fare is genuinely gone.
      if (r && r.status === 452) { await sleep(1600); r = await verifyInTab(sTab.id, f, params.adults); }
      else if (r && !r.ok) { await sleep(1200); r = await verifyInTab(sTab.id, f, params.adults); }
      f.confirmedSeats = (r && r.ok) ? r.seats : null;
      f.verifyStatus = r ? (r.status || null) : null;
      // Availability judgment ONLY for American (AC is trusted — never mark it gone, even
      // when we look it up just to price it).
      if (/American/i.test(f.airline || '')) f.available = r ? (r.ok ? true : (r.status === 452 ? false : null)) : null;
      if (r && r.ok && r.taxMoney != null) f.taxARS = r.taxMoney;  // ARS boarding tax, for pricing
      if (r && r.ok && r.taxScan && /business/i.test(f.classType) && !scanGrabbed) { f._taxscan = r.taxScan; scanGrabbed = true; } // TEMP debug
      await sleep(500);
    }
  }

  backToApp();
  if (sTab) { chrome.tabs.remove(sTab.id).catch(() => {}); openTabs.delete(sTab.id); }
  if (abortFlag) return { ok: false, aborted: true };
  return { ok: true, flights, rawCount };
}
