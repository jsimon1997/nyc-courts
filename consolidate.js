#!/usr/bin/env node
/**
 * Consolidation Script
 *
 * Merges courts.json (OSM) + curated-courts.json into a single unified database.
 * Applies ALL current filters (blocked_ids, OVERRIDES remove, id_overrides),
 * runs clustering, and emits courts-db.json with one record per pin.
 *
 * Unified schema:
 *   { id, name, lat, lon, sport, surface, indoor, accessType, count,
 *     phone?, website?, hours?, address?, note?, photo?, bookingUrl?, bookingApp?,
 *     needsName?, source, osmIds? }
 */

const fs = require('fs');

const osm     = JSON.parse(fs.readFileSync('./courts.json',         'utf8'));
const curated = JSON.parse(fs.readFileSync('./curated-courts.json', 'utf8'));

const BLOCKED    = new Set(curated.blocked_ids || []);
const ID_OV      = curated.id_overrides || {};
const OVERRIDES  = curated.overrides    || [];
const GENERIC    = new Set(['tennis court','tennis courts','court','courts','pitch','padel court','padel courts']);

// ─── helpers ──────────────────────────────────────────────────────────────
function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000, d = x => x * Math.PI / 180;
  const dLat = d(lat2 - lat1), dLon = d(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(d(lat1))*Math.cos(d(lat2))*Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function findOverride(name) {
  if (!name) return null;
  const lower = name.toLowerCase();
  return OVERRIDES.find(o => lower.includes(o.match)) || null;
}
function classifyAccess(tags) {
  const access   = (tags.access     || '').toLowerCase();
  const fee      = (tags.fee        || '').toLowerCase();
  const member   = (tags.membership || '').toLowerCase();
  const operator = (tags.operator   || '').toLowerCase();
  if (operator.includes('nyc parks') || operator.includes('department of parks')) return 'permit';
  if (access === 'private' || access === 'members' || access === 'customers' ||
      member === 'required' || member === 'yes') return 'private';
  if (access === 'permit') return 'permit';
  if (tags.reservation || tags.booking || fee === 'yes' || fee === 'seasonal' || fee === 'interval') return 'reservable';
  if (access === 'yes' || access === 'public') return 'public';
  return 'unknown';
}
function normalizeSurface(tags) {
  const s = (tags.surface || '').toLowerCase();
  if (/clay|har.?tru/.test(s)) return 'clay';
  if (/grass/.test(s)) return 'grass';
  if (/hard|concrete|asphalt|acrylic|cushion/.test(s)) return 'hard';
  return 'other';
}
function mergeTags(into, from) {
  for (const k of Object.keys(from)) if (!into[k] && from[k]) into[k] = from[k];
}
const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
const slug = s => (s || 'unnamed').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

// ─── Step 1: parse OSM, apply blocked_ids + id_overrides + OVERRIDES.remove ──
const raw = [];
let skippedBlocked = 0, skippedRemoveOverride = 0, skippedWrongSport = 0;
for (const el of osm) {
  if (BLOCKED.has(el.id)) { skippedBlocked++; continue; }
  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;
  if (!lat || !lon) continue;
  const tags  = { ...(el.tags || {}), ...(ID_OV[el.id] || {}) };
  const sport = tags.sport;
  if (sport !== 'tennis' && sport !== 'padel') { skippedWrongSport++; continue; }
  if (findOverride(tags.name || '')?.remove) { skippedRemoveOverride++; continue; }
  raw.push({ id: el.id, lat, lon, tags, sport });
}
console.log(`Step 1 — OSM filter`);
console.log(`  Raw OSM elements:         ${osm.length}`);
console.log(`  Skipped (blocked_ids):    ${skippedBlocked}`);
console.log(`  Skipped (remove override):${skippedRemoveOverride}`);
console.log(`  Skipped (non-tennis/padel):${skippedWrongSport}`);
console.log(`  Kept:                     ${raw.length}`);

// ─── Step 2: cluster by name (2 km grid cell) ─────────────────────────────
const namedGroups = new Map();
const unnamed = [];
for (const pt of raw) {
  const name  = (pt.tags.name || '').trim();
  const lower = name.toLowerCase();
  if (name && name.length > 4 && !GENERIC.has(lower)) {
    const cell = `${pt.sport}:${lower}:${(pt.lat*50).toFixed(0)},${(pt.lon*50).toFixed(0)}`;
    if (namedGroups.has(cell)) {
      const g = namedGroups.get(cell);
      g.lats.push(pt.lat); g.lons.push(pt.lon); g.ids.push(pt.id);
      mergeTags(g.tags, pt.tags);
    } else {
      namedGroups.set(cell, { lats:[pt.lat], lons:[pt.lon], ids:[pt.id], tags:{...pt.tags}, sport:pt.sport });
    }
  } else {
    unnamed.push(pt);
  }
}

// Step 2b: merge same-name named groups within 1 km (grid boundary fix)
{
  const list = [...namedGroups.values()];
  const used = new Uint8Array(list.length);
  const merged = [];
  for (let i = 0; i < list.length; i++) {
    if (used[i]) continue;
    const g = list[i];
    used[i] = 1;
    const gn = (g.tags.name || '').toLowerCase();
    for (let j = i + 1; j < list.length; j++) {
      if (used[j] || list[j].sport !== g.sport) continue;
      if ((list[j].tags.name || '').toLowerCase() !== gn) continue;
      const gc = { lat: g.lats.reduce((a,b)=>a+b,0)/g.lats.length, lon: g.lons.reduce((a,b)=>a+b,0)/g.lons.length };
      const hc = { lat: list[j].lats.reduce((a,b)=>a+b,0)/list[j].lats.length, lon: list[j].lons.reduce((a,b)=>a+b,0)/list[j].lons.length };
      if (haversineMeters(gc.lat, gc.lon, hc.lat, hc.lon) < 1000) {
        g.lats.push(...list[j].lats); g.lons.push(...list[j].lons); g.ids.push(...list[j].ids);
        mergeTags(g.tags, list[j].tags);
        used[j] = 1;
      }
    }
    merged.push(g);
  }
  namedGroups.clear();
  merged.forEach((g, i) => namedGroups.set(i, g));
}

// ─── Step 3: greedy spatial cluster for unnamed (300 m) ──────────────────
const unnamedGroups = [];
{
  const used = new Uint8Array(unnamed.length);
  for (let i = 0; i < unnamed.length; i++) {
    if (used[i]) continue;
    const g = { lats:[unnamed[i].lat], lons:[unnamed[i].lon], ids:[unnamed[i].id], tags:{...unnamed[i].tags}, sport:unnamed[i].sport };
    used[i] = 1;
    for (let j = i + 1; j < unnamed.length; j++) {
      if (used[j] || unnamed[j].sport !== unnamed[i].sport) continue;
      if (haversineMeters(unnamed[i].lat, unnamed[i].lon, unnamed[j].lat, unnamed[j].lon) < 300) {
        g.lats.push(unnamed[j].lat); g.lons.push(unnamed[j].lon); g.ids.push(unnamed[j].id);
        mergeTags(g.tags, unnamed[j].tags);
        used[j] = 1;
      }
    }
    unnamedGroups.push(g);
  }
}
console.log(`\nStep 2/3 — Clustering`);
console.log(`  Named clusters:   ${namedGroups.size}`);
console.log(`  Unnamed clusters: ${unnamedGroups.length}`);

// ─── Step 4: build unified records from OSM clusters ─────────────────────
function makeRecord(g, { needsName }) {
  const tags = g.tags;
  const lat  = g.lats.reduce((a,b)=>a+b,0) / g.lats.length;
  const lon  = g.lons.reduce((a,b)=>a+b,0) / g.lons.length;
  const name = tags.name || null;
  const ov   = findOverride(name || '');
  const operator = (tags.operator || '').toLowerCase();
  const accessType = ov?.access || classifyAccess(tags);
  const note = ov?.note || (
    (operator.includes('nyc parks') || operator.includes('department of parks'))
      ? 'NYC Parks permit required Apr–Nov. $15/session or $100/season.' : null
  );

  return {
    id:       `osm-${g.ids[0]}`,
    name:     ov?.name || name || null,
    lat, lon,
    sport:    g.sport,
    surface:  ov?.surface || normalizeSurface(tags),
    indoor:   ov?.indoor ?? (tags.indoor === 'yes' || tags['location:indoor'] === 'yes'),
    accessType,
    count:    g.lats.length,
    phone:    ov?.phone      || tags.phone          || null,
    website:  ov?.website    || tags.website        || null,
    hours:    ov?.hours      || tags.opening_hours  || null,
    address:  ov?.address    || null,
    note,
    photo:    ov?.photo      || null,
    bookingUrl: ov?.bookingUrl || null,
    bookingApp: ov?.bookingApp || null,
    needsName: !!needsName,
    source:   'osm',
    osmIds:   g.ids,
  };
}

const records = [];
for (const g of namedGroups.values()) records.push(makeRecord(g, { needsName: false }));
for (const g of unnamedGroups)         records.push(makeRecord(g, { needsName: true  }));

// ─── Step 5: add curated entries, deduping against OSM by name proximity ──
const CURATED_CATS = [
  ['public_courts',       null],             // accessType from entry or fallback
  ['private_courts',      'private'],
  ['millennium_courts',   'private'],
  ['residential_courts',  'residential'],
];
let curatedAdded = 0, curatedSkippedAsDupe = 0;
for (const [cat, fallbackAccess] of CURATED_CATS) {
  for (const entry of (curated[cat] || [])) {
    const cn = norm(entry.name);
    // Is this already represented by an OSM named cluster nearby?
    const dupe = records.find(r => r.source === 'osm' && !r.needsName &&
      haversineMeters(entry.lat, entry.lon, r.lat, r.lon) < 500 &&
      (norm(r.name) === cn || (cn.length >= 8 && norm(r.name).includes(cn)) || (norm(r.name).length >= 8 && cn.includes(norm(r.name)))));
    if (dupe) {
      // Enrich the OSM record with curated fields it's missing (curated wins on conflict)
      const enriched = {
        ...dupe,
        name: entry.name,
        sport: entry.sport || dupe.sport,
        surface: entry.surface || dupe.surface,
        indoor: entry.indoor ?? dupe.indoor,
        accessType: entry.accessType || fallbackAccess || dupe.accessType,
        phone: entry.phone || dupe.phone,
        website: entry.website || dupe.website,
        hours: entry.hours || dupe.hours,
        address: entry.address || dupe.address,
        note: entry.note || dupe.note,
        photo: entry.photo || dupe.photo,
        bookingUrl: entry.bookingUrl || dupe.bookingUrl,
        bookingApp: entry.bookingApp || dupe.bookingApp,
        count: entry.courts || dupe.count,
        source: 'merged',
      };
      Object.assign(dupe, enriched);
      curatedSkippedAsDupe++;
      continue;
    }
    // Not a dupe — add as a new curated record
    records.push({
      id:       `curated-${slug(entry.name)}`,
      name:     entry.name,
      lat:      entry.lat,
      lon:      entry.lon,
      sport:    entry.sport || 'tennis',
      surface:  entry.surface || 'other',
      indoor:   entry.indoor ?? false,
      accessType: entry.accessType || fallbackAccess || 'unknown',
      count:    entry.courts || 1,
      phone:    entry.phone    || null,
      website:  entry.website  || null,
      hours:    entry.hours    || null,
      address:  entry.address  || null,
      note:     entry.note     || null,
      photo:    entry.photo    || null,
      bookingUrl: entry.bookingUrl || null,
      bookingApp: entry.bookingApp || null,
      needsName: false,
      source:   'curated',
      osmIds:   [],
    });
    curatedAdded++;
  }
}
console.log(`\nStep 5 — Curated merge`);
console.log(`  Curated added as new pins:       ${curatedAdded}`);
console.log(`  Curated merged into OSM cluster: ${curatedSkippedAsDupe}`);

// ─── Step 6: deterministic order, write file ─────────────────────────────
records.sort((a, b) => {
  if (a.needsName !== b.needsName) return a.needsName ? 1 : -1;
  return (a.name || 'zzz').localeCompare(b.name || 'zzz');
});

fs.writeFileSync('./courts-db.json', JSON.stringify(records, null, 2));

// ─── Final report ─────────────────────────────────────────────────────────
const stats = {
  total: records.length,
  bySource: {},
  bySport:  {},
  byAccess: {},
  needsName: records.filter(r => r.needsName).length,
  withName:  records.filter(r => !r.needsName).length,
  withPhone: records.filter(r => r.phone).length,
  withWebsite: records.filter(r => r.website).length,
  withAddress: records.filter(r => r.address).length,
};
records.forEach(r => {
  stats.bySource[r.source]     = (stats.bySource[r.source]     || 0) + 1;
  stats.bySport[r.sport]       = (stats.bySport[r.sport]       || 0) + 1;
  stats.byAccess[r.accessType] = (stats.byAccess[r.accessType] || 0) + 1;
});

console.log(`\n── Final: courts-db.json ──`);
console.log(`  Total pins: ${stats.total}`);
console.log(`  Named:      ${stats.withName}   |  Unnamed: ${stats.needsName}`);
console.log(`  Sources:    ${JSON.stringify(stats.bySource)}`);
console.log(`  Sport:      ${JSON.stringify(stats.bySport)}`);
console.log(`  Access:     ${JSON.stringify(stats.byAccess)}`);
console.log(`  Enrichment: ${stats.withPhone} phone, ${stats.withWebsite} web, ${stats.withAddress} addr`);

// Sanity: any dupes left?
const nameGroups = {};
records.filter(r => !r.needsName).forEach(r => (nameGroups[norm(r.name)] = nameGroups[norm(r.name)] || []).push(r));
const nameDupes = Object.entries(nameGroups).filter(([,a]) => a.length > 1);
console.log(`\n  Same-name duplicate pins remaining: ${nameDupes.length}`);
nameDupes.forEach(([,arr]) => console.log(`    "${arr[0].name}" ×${arr.length}`));
