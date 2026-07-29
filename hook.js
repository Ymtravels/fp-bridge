// PAGE (MAIN world), document_start. Captures the site's own API auth headers +
// environment (green/blue), catches the /airlines/search response, and answers
// verify requests by calling boardingtax with those SAME headers, so Smiles
// treats it exactly like a real click instead of blocking it (452).
(function () {
  'use strict';
  const AIRLINE = { AA: 'American Airlines', AC: 'Air Canada', UA: 'United Airlines', DL: 'Delta', WN: 'Southwest', B6: 'JetBlue', PD: 'Porter Airlines' };
  const CABIN = { ECONOMIC: 'economy', BUSINESS: 'business', PREMIUM_ECONOMIC: 'premium', PREMIUM: 'premium' };
  const hm = iso => { const t = String(iso).split('T')[1] || '00:00:00'; return t.slice(0, 2) + 'h' + t.slice(3, 5); };
  const dur = ts => { if (!ts) return ''; const h = ts.hours || 0, m = ts.minutes || 0; return ((h ? h + 'h ' : '') + (m ? m + 'min' : '')).trim(); };
  const origFetch = window.fetch;

  let siteHeaders = null; // {Authorization, x-api-key, Region, Language, Channel} lifted from the site's own calls
  let apiEnv = 'blue';    // 'green' | 'blue' — read from the live API host

  function grabHeaders(url, h) {
    if (!h) return;
    if (h['x-api-key'] || h['X-Api-Key'] || h['Authorization'] || h['authorization']) siteHeaders = h;
    const m = /-(green|blue)\.smiles\.com\.ar/.exec(url);
    if (m) apiEnv = m[1];
  }

  function fareMiles(list, type) { const f = (list || []).find(x => x.type === type); return f ? f.miles : null; }
  function parseSmiles(json) {
    const out = [];
    (json.requestedFlightSegmentList || []).forEach(seg => {
      (seg.flightList || []).forEach(f => {
        const code = f.airline && f.airline.code;
        const fSmiles = (f.fareList || []).find(x => x.type === 'SMILES');
        const fClub = (f.fareList || []).find(x => x.type === 'SMILES_CLUB');
        // Keep anything bookable with miles — true award OR "comercial" fares paid in
        // miles (some routes, esp. Caribbean/long-haul, only have the latter).
        if (!fSmiles && !fClub) return;
        out.push({
          sourceFare: f.sourceFare || null,
          origin: f.departure.airport.code, departure: hm(f.departure.date),
          destination: f.arrival.airport.code, arrival: hm(f.arrival.date),
          airline: AIRLINE[code] || (f.airline && f.airline.name) || code || 'Unknown',
          classType: CABIN[f.cabin] || 'economy',
          stopover: (f.stops > 0 && f.airportMainStop && f.airportMainStop.code)
            ? { airport: f.airportMainStop.code, duration: dur(f.timeStop) } : null,
          seats: f.availableSeats,
          miles: fSmiles ? fSmiles.miles : null,
          milesClub: fClub ? fClub.miles : null,
          uid: f.uid,
          type: seg.type || 'SEGMENT_1',
          fareUid: fSmiles ? fSmiles.uid : null
        });
      });
    });
    return out;
  }

  function ingest(url, body) {
    if (!/\/airlines\/search/.test(url)) return;
    try {
      const json = JSON.parse(body);
      let raw = 0;
      (json.requestedFlightSegmentList || []).forEach(s => raw += (s.flightList || []).length);
      window.postMessage({ __ym: 'flights', url: String(url), flights: parseSmiles(json), rawCount: raw }, '*');
    } catch (e) {}
  }

  const oo = XMLHttpRequest.prototype.open, os = XMLHttpRequest.prototype.send, oh = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (m, u) { this.__u = u; this.__h = {}; return oo.apply(this, arguments); };
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) { if (this.__h) this.__h[k] = v; return oh.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function () {
    const u = this.__u;
    if (typeof u === 'string' && /api-[\w-]*\.smiles\.com\.ar/.test(u)) grabHeaders(u, this.__h);
    if (typeof u === 'string' && /\/airlines\/search/.test(u)) this.addEventListener('load', () => ingest(u, this.responseText));
    return os.apply(this, arguments);
  };

  window.fetch = function (...a) {
    const url = (a[0] && a[0].url) || a[0];
    return origFetch.apply(this, a).then(res => {
      if (typeof url === 'string' && /\/airlines\/search/.test(url)) res.clone().text().then(b => ingest(url, b)).catch(() => {});
      return res;
    });
  };

  // Verify a flight the way a real click does: boardingtax on the correct env host,
  // carrying the site's own auth headers.
  window.addEventListener('message', function (e) {
    if (e.source !== window || !e.data || !e.data.__ymVerify) return;
    const v = e.data.__ymVerify;
    const host = 'api-airlines-boarding-tax-' + apiEnv + '.smiles.com.ar';
    const url = 'https://' + host + '/v1/airlines/flight/boardingtax?adults=' + (v.adults || 1) + '&children=0&infants=0'
      + '&fareuid=' + encodeURIComponent(v.fareUid)
      + '&uid=' + encodeURIComponent(v.uid)
      + '&type=' + encodeURIComponent(v.type || 'SEGMENT_1')
      + '&highlightText=SMILES&currency=ARS';
    const headers = Object.assign({ 'Accept': 'application/json, text/plain, */*' }, siteHeaders || {});
    origFetch(url, { credentials: 'include', headers: headers })
      .then(r => r.text().then(t => ({ status: r.status, ok: r.ok, t: t })))
      .then(o => {
        let seats = null, gotFl = false, taxMoney = null, taxScan = {};
        if (o.ok) { try {
          const j = JSON.parse(o.t);
          const fl = j.flightList && j.flightList[0];
          if (fl) {
            seats = fl.availableSeats; gotFl = true;
            const totals = j.totals || {};
            const bt = fl.boardingTax || {};
            // Best guess for "tasas e impuestos (dinero)": totals.total.money.
            taxMoney = (totals.total && totals.total.money != null) ? totals.total.money
              : (bt.boardingTaxMoney != null ? bt.boardingTaxMoney : (bt.money != null ? bt.money : null));
            // TEMP: full money-field scan so we can confirm the right one on a business flight.
            const scan = (obj, path, depth) => { if (!obj || typeof obj !== 'object' || depth > 4) return; for (const k in obj) { const val = obj[k]; if (typeof val === 'number' && /tax|money|boarding|total|fee|amount/i.test(k)) taxScan[path + k] = val; else if (val && typeof val === 'object') scan(val, path + k + '.', depth + 1); } };
            scan(j, '', 0);
          }
        } catch (e) {} }
        window.postMessage({ __ymVerifyRes: { id: v.id, ok: gotFl, seats: seats, status: o.status, hadHeaders: !!siteHeaders, taxMoney: taxMoney, taxScan: JSON.stringify(taxScan) } }, '*');
      })
      .catch(err => window.postMessage({ __ymVerifyRes: { id: v.id, ok: false, status: 'neterr' } }, '*'));
  });
})();
