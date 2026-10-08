'use strict';
/**
 * shippingService.js — destination-based transport pricing.
 *
 * The buyer picks a DESTINATION (county + town/area). The server then works out
 * which delivery options exist for that destination and what each costs. The
 * client never decides the fee: createOrder and /shipping/quote both call
 * quote() below, so what the buyer sees is what they are charged.
 *
 * To change prices, edit ONLY the RATES / TIERS tables below.
 */

const KENYA_COUNTIES = [
  'Baringo','Bomet','Bungoma','Busia','Elgeyo-Marakwet','Embu','Garissa','Homa Bay','Isiolo','Kajiado',
  'Kakamega','Kericho','Kiambu','Kilifi','Kirinyaga','Kisii','Kisumu','Kitui','Kwale','Laikipia','Lamu',
  'Machakos','Makueni','Mandera','Marsabit','Meru','Migori','Mombasa',"Murang'a",'Nairobi','Nakuru','Nandi',
  'Narok','Nyamira','Nyandarua','Nyeri','Samburu','Siaya','Taita-Taveta','Tana River','Tharaka-Nithi',
  'Trans Nzoia','Turkana','Uasin Gishu','Vihiga','Wajir','West Pokot',
];

// Tier of each county (anything not listed falls into 'rest').
const TIERS = {
  nairobi:  ['Nairobi'],
  metro:    ['Kiambu', 'Kajiado', 'Machakos'],                                   // Greater Nairobi
  hub:      ['Mombasa', 'Kisumu', 'Nakuru', 'Uasin Gishu', 'Nyeri', 'Meru', 'Kakamega', 'Kisii', 'Embu', 'Kirinyaga', "Murang'a", 'Nyandarua', 'Laikipia', 'Bungoma', 'Kericho', 'Kilifi'],
};

// KES. standard = normal courier, express = same-day (Nairobi only), pickup = collect at depot.
const RATES = {
  nairobi_cbd: { standard: 50,  eta: '1-2 hours',  label: 'Nairobi CBD' },
  nairobi:     { standard: 150, eta: '2-4 hours',  label: 'Nairobi & suburbs' },
  metro:       { standard: 200, eta: '1 day',      label: 'Greater Nairobi' },
  hub:         { standard: 300, eta: '1-2 days',   label: 'Major town' },
  rest:        { standard: 400, eta: '2-4 days',   label: 'Rest of Kenya' },
};
const EXPRESS = { fee: 250, eta: '30-60 min' };        // Nairobi county only
const PICKUP  = { fee: 0,   eta: 'Anytime' };

const CBD_WORDS = ['cbd', 'town centre', 'town center', 'city centre', 'city center', 'central business'];

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+county$/i, '').replace(/[’`]/g, "'");

function resolveCounty(input) {
  const n = norm(input);
  if (!n) return null;
  return KENYA_COUNTIES.find(c => norm(c) === n) || null;
}

function tierOf(county) {
  if (TIERS.nairobi.includes(county)) return 'nairobi';
  if (TIERS.metro.includes(county)) return 'metro';
  if (TIERS.hub.includes(county)) return 'hub';
  return 'rest';
}

/**
 * quote({ county, town, option? })
 *   -> { ok:true, county, town, zone, zoneLabel, options:[{id,name,fee,eta,available}], selected? }
 *   -> { ok:false, code, message }
 */
function quote({ county, town, option } = {}) {
  const c = resolveCounty(county);
  if (!c) return { ok: false, code: 'DESTINATION_REQUIRED', message: 'Select your delivery county to see the transport cost.' };

  let tier = tierOf(c);
  const t = norm(town);
  if (tier === 'nairobi' && CBD_WORDS.some(w => t.includes(w))) tier = 'nairobi_cbd';
  const rate = RATES[tier];

  const options = [
    { id: 'standard', name: 'Standard Delivery', fee: rate.standard, eta: rate.eta, available: true,  desc: `To ${town ? town + ', ' : ''}${c}` },
    { id: 'express',  name: 'Express Delivery',  fee: EXPRESS.fee,   eta: EXPRESS.eta, available: c === 'Nairobi', desc: 'Nairobi only' },
    { id: 'pickup',   name: 'Self Pickup',       fee: PICKUP.fee,    eta: PICKUP.eta,  available: true,  desc: 'Collect from our depot' },
  ].filter(o => o.available);

  const out = { ok: true, county: c, town: String(town || '').trim(), zone: tier, zoneLabel: rate.label, currency: 'KES', options };
  if (option !== undefined) {
    const sel = options.find(o => o.id === option);
    if (!sel) return { ok: false, code: 'OPTION_UNAVAILABLE', message: `${option} delivery is not available for ${c}.` };
    out.selected = sel;
  }
  return out;
}

module.exports = { KENYA_COUNTIES, quote, resolveCounty };
