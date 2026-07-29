const $ = id => document.getElementById(id);
const CAB = { economy: 'Economy', premium: 'Premium', business: 'Business' };
const ABBR = { 'American Airlines': 'AA', 'Air Canada': 'AC', 'United Airlines': 'UA', 'Delta': 'DL', 'Porter Airlines': 'PD' };

function ampm(hhmm) { let [h, m] = hhmm.split('h').map(Number); const ap = h < 12 ? 'am' : 'pm'; h = h % 12 || 12; return h + ':' + String(m).padStart(2, '0') + ' ' + ap; }
function render(flights) {
  if (!flights || !flights.length) return 'Search ran, but returned 0 award flights.';
  const rows = flights.slice().sort((a, b) => a.classType.localeCompare(b.classType) || a.departure.localeCompare(b.departure));
  return rows.map(f => {
    const stop = f.stopover ? `  (Stopover in ${f.stopover.airport} ${f.stopover.duration})` : '  direct';
    const miles = f.milesClub ? `${f.milesClub.toLocaleString()}-${(f.miles || f.milesClub).toLocaleString()}` : (f.miles ? f.miles.toLocaleString() : '');
    let seatTxt = `${f.seats} seat${f.seats === 1 ? '' : 's'}`;
    if (f.available === true) seatTxt = `${f.seats} listed -> AVAILABLE ✓${f.confirmedSeats != null ? ' (' + f.confirmedSeats + ' real)' : ''}`;
    else if (f.available === false) seatTxt = `${f.seats} listed -> GONE ✗ (452)`;
    else if (f.available === null) seatTxt = `${f.seats} listed -> unknown${f.verifyStatus ? ' (' + f.verifyStatus + ')' : ''}`;
    return `${f.origin} ${ampm(f.departure)} - ${f.destination} ${ampm(f.arrival)}${stop}\n  ${ABBR[f.airline] || f.airline} ${CAB[f.classType]}  |  ${seatTxt}  |  ${miles} miles`;
  }).join('\n');
}

$('go').onclick = () => {
  const params = { origin: $('origin').value.trim().toUpperCase(), destination: $('destination').value.trim().toUpperCase(), date: $('date').value.trim(), verify: $('verify').checked };
  if (!params.origin || !params.destination || !params.date) { $('out').textContent = 'Fill in From, To, and Date.'; return; }
  $('go').disabled = true; $('out').textContent = params.verify ? 'Searching + verifying real seats… (can take ~30–60s)' : 'Searching Smiles in a background tab… (up to ~30s)';
  chrome.runtime.sendMessage({ type: 'search', params }, resp => {
    $('go').disabled = false;
    if (chrome.runtime.lastError) { $('out').textContent = 'Extension error: ' + chrome.runtime.lastError.message; return; }
    if (!resp) { $('out').textContent = 'No response from background.'; return; }
    if (!resp.ok) { $('out').textContent = 'Failed: ' + resp.error; return; }
    const ver = chrome.runtime.getManifest().version;
    $('out').textContent = `v${ver} — kept ${resp.flights.length}, raw response had ${resp.rawCount || 0} flights:\n\n` + render(resp.flights);
  });
};
