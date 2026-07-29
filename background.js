// Opens a background Smiles tab, lets the site run its own search, collects the
// flights, optionally verifies each one's real seats (boardingtax) in the same
// tab/session, then closes the tab.
const waiters = {}; // tabId -> resolver for the search flights
const sleep = ms => new Promise(r => setTimeout(r, ms));

// NOTE: we deliberately do NOT modify the User-Agent. Spoofing it made Smiles' bot
// shield (Akamai) reject the browser — that was breaking searches (and normal browsing)
// on both desktop and phone. The real browser identity + the phone's real IP is trusted.

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'search') { runSearch(msg.params, sender.tab && sender.tab.id).then(sendResponse); return true; }
  if (msg.type === 'flights' && sender.tab && waiters[sender.tab.id]) waiters[sender.tab.id](msg);
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
  let flights = [], rawCount = 0, sTab = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    let tab;
    try { tab = await chrome.tabs.create({ url: emissionUrl(params), active: isMobile }); }
    catch (e) { backToApp(); return { ok: false, error: 'Could not open Smiles tab: ' + e.message }; }
    const result = await collectSearch(tab.id);
    rawCount = result.rawCount || 0;
    if (result.flights.length) { flights = result.flights; sTab = tab; break; }
    chrome.tabs.remove(tab.id).catch(() => {});
    await sleep(900);
  }

  if (!flights.length) { backToApp(); return { ok: true, flights: [], rawCount }; }

  if (params.verify) {
    // Verify exactly the flights that will be SHOWN — mirror the app's display filters —
    // so "Verify seats" always checks whatever's in your list, nothing more.
    const nonstop = !!params.nonstop;
    const econMax = params.econMax || 999999;
    const bizMax = params.bizMax || 999999;
    const maxStop = params.maxStop != null ? params.maxStop : 99;
    const stopHrs = f => { if (!f.stopover) return 0; const d = f.stopover.duration || ''; const h = +((d.match(/(\d+)\s*h/) || [])[1] || 0); const m = +((d.match(/(\d+)\s*min/) || [])[1] || 0); return h + m / 60; };
    const cap = 40;
    let n = 0;
    let rawGrabbed = false; // TEMP: capture one raw boardingtax response to find the tax field
    for (const f of flights) {
      if (!f.uid || !f.fareUid) continue;
      // Air Canada is trusted (rarely has phantom seats) — never spend a check on it.
      if (!/American/i.test(f.airline || '')) continue;
      if (nonstop && f.stopover) continue;                       // won't be shown
      if (f.stopover && stopHrs(f) > maxStop) continue;          // won't be shown
      const capMi = /business/i.test(f.classType) ? bizMax : econMax;
      if ((f.milesClub || f.miles || 0) > capMi) continue;       // won't be shown
      if (n++ >= cap) break;
      let r = await verifyInTab(sTab.id, f, params.adults);
      // A 452 is either a transient rate-limit OR the fare is genuinely gone.
      // Retry once after a pause: a rate-limit clears -> 200; a truly-gone fare stays 452.
      if (r && r.status === 452) { await sleep(1600); r = await verifyInTab(sTab.id, f, params.adults); }
      else if (r && !r.ok) { await sleep(1200); r = await verifyInTab(sTab.id, f, params.adults); }
      f.confirmedSeats = (r && r.ok) ? r.seats : null;
      f.verifyStatus = r ? (r.status || null) : null;
      // 200 = real & available; persistent 452 = phantom/gone; anything else = unknown.
      f.available = r ? (r.ok ? true : (r.status === 452 ? false : null)) : null;
      if (r && r.ok && r.raw && !rawGrabbed) { f._taxraw = r.raw; rawGrabbed = true; } // TEMP debug: only a SUCCESSFUL (available) response carries the tax
      await sleep(500);
    }
  }

  backToApp();
  if (sTab) chrome.tabs.remove(sTab.id).catch(() => {});
  return { ok: true, flights, rawCount };
}
