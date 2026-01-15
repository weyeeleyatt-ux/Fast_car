/**
 * Fast Car MVP (Single File)
 * - Arabic RTL UI
 * - Green/White theme
 * - Dispatcher/Admin page: create trip (name/phone), pick pickup & dropoff on map, estimate price, send to captains
 * - Trips table with statuses: searching/accepted/rejected/started/completed/cancelled/no_driver
 * - Captain page: login by PIN, see new trips, accept/reject, start/complete
 * - Realtime updates via Socket.io
 *
 * Run:
 *   npm init -y
 *   npm i express socket.io
 *   node app.js
 * Open:
 *   http://localhost:8080  (Dispatcher)
 *   http://localhost:8080/captain (Captain)
 */

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
app.use(express.json({ limit: "1mb" }));

const server = http.createServer(app);
const io = new Server(server);

// ---------------- In-memory DB ----------------
let tripSeq = 1;
let driverSeq = 1;

// Default pricing (Old Ouguiya)
const pricing = {
  baseFareOld: 900,
  perKmOld: 120,
  perMinOld: 20
};

// Simple drivers (PIN login)
const drivers = [
  { id: driverSeq++, name: "كابتن 1", pin: "1111", isAvailable: true, lastLat: null, lastLng: null },
  { id: driverSeq++, name: "كابتن 2", pin: "2222", isAvailable: true, lastLat: null, lastLng: null }
];

// Zones (demo rectangle polygon around Nouakchott)
const zones = [
  {
    id: 1,
    name: "نواكشوط (تجريبي)",
    // Polygon ring: [lng, lat]
    ring: [
      [-15.999, 18.020],
      [-15.999, 18.200],
      [-15.700, 18.200],
      [-15.700, 18.020],
      [-15.999, 18.020]
    ],
    baseFareOld: 900,
    perKmOld: 120,
    perMinOld: 20
  }
];

// Trips
const trips = []; // {id, customerName, customerPhone, pickup{lat,lng,address}, dropoff{...}, distanceKm, durationMin, priceOld, zoneName, status, assignedDriverId, createdAt}

function nowISO() {
  return new Date().toISOString();
}

// ---------------- Geo helpers ----------------
function pointInPolygon(point, vs) {
  // point: [lng,lat], vs: [[lng,lat],...]
  const x = point[0], y = point[1];
  let inside = false;
  for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
    const xi = vs[i][0], yi = vs[i][1];
    const xj = vs[j][0], yj = vs[j][1];
    const intersect = ((yi > y) !== (yj > y)) &&
      (x < (xj - xi) * (y - yi) / (yj - yi + 0.0) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function pickZone(lat, lng) {
  for (const z of zones) {
    if (pointInPolygon([lng, lat], z.ring)) return z;
  }
  return null;
}

function calcPriceOld(distanceKm, durationMin, zoneOrNull) {
  const base = zoneOrNull ? zoneOrNull.baseFareOld : pricing.baseFareOld;
  const perKm = zoneOrNull ? zoneOrNull.perKmOld : pricing.perKmOld;
  const perMin = zoneOrNull ? zoneOrNull.perMinOld : pricing.perMinOld;
  const total = base + (perKm * distanceKm) + (perMin * durationMin);
  return Math.max(0, Math.round(total));
}

// Rough estimate: if you have distanceKm, durationMin already computed from frontend
// (Frontend calculates distance via haversine and estimates time)
function haversineKm(a, b) {
  const R = 6371;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLng / 2);
  const q = s1 * s1 + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * s2 * s2;
  const c = 2 * Math.atan2(Math.sqrt(q), Math.sqrt(1 - q));
  return R * c;
}

// ---------------- Socket ----------------
io.on("connection", (socket) => {
  socket.on("join", (role) => {
    if (role === "dispatcher") socket.join("dispatcher");
    if (role === "captain") socket.join("captains");
  });
});

// Broadcast helpers
function emitTrips() {
  io.to("dispatcher").emit("trips", trips);
  io.to("captains").emit("trips", trips);
}
function emitTripUpdated(trip) {
  io.to("dispatcher").emit("trip:update", trip);
  io.to("captains").emit("trip:update", trip);
}

// ---------------- API ----------------
app.get("/api/health", (_req, res) => res.json({ ok: true, t: nowISO() }));
app.get("/api/pricing", (_req, res) => res.json(pricing));
app.get("/api/zones", (_req, res) => res.json(zones.map(z => ({ id: z.id, name: z.name }))));

app.get("/api/trips", (_req, res) => res.json(trips));

app.post("/api/estimate", (req, res) => {
  const { pickupLat, pickupLng, distanceKm, durationMin } = req.body || {};
  if ([pickupLat, pickupLng, distanceKm, durationMin].some(v => typeof v !== "number")) {
    return res.status(400).json({ error: "بيانات التقدير غير صحيحة" });
  }
  const zone = pickZone(pickupLat, pickupLng);
  const priceOld = calcPriceOld(distanceKm, durationMin, zone);
  res.json({
    zone: zone ? { id: zone.id, name: zone.name } : null,
    baseFareOld: zone ? zone.baseFareOld : pricing.baseFareOld,
    perKmOld: zone ? zone.perKmOld : pricing.perKmOld,
    perMinOld: zone ? zone.perMinOld : pricing.perMinOld,
    priceOld
  });
});

app.post("/api/trips", (req, res) => {
  const {
    customerName, customerPhone,
    pickupLat, pickupLng, pickupAddress,
    dropoffLat, dropoffLng, dropoffAddress,
    distanceKm, durationMin
  } = req.body || {};

  const missing = [
    customerName, customerPhone,
    pickupLat, pickupLng, dropoffLat, dropoffLng,
    distanceKm, durationMin
  ].some(v => v === undefined || v === null || v === "");

  if (missing) return res.status(400).json({ error: "يرجى تعبئة جميع الحقول" });

  const zone = pickZone(pickupLat, pickupLng);
  const priceOld = calcPriceOld(distanceKm, durationMin, zone);

  const trip = {
    id: tripSeq++,
    customerName: String(customerName),
    customerPhone: String(customerPhone),
    pickup: { lat: pickupLat, lng: pickupLng, address: pickupAddress || "" },
    dropoff: { lat: dropoffLat, lng: dropoffLng, address: dropoffAddress || "" },
    distanceKm: Number(distanceKm),
    durationMin: Number(durationMin),
    priceOld,
    zoneName: zone ? zone.name : "تعرفة عامة",
    status: "searching",
    assignedDriverId: null,
    createdAt: nowISO()
  };

  trips.unshift(trip);
  io.to("dispatcher").emit("trip:created", trip);
  io.to("captains").emit("trip:created", trip);
  res.json(trip);
});

app.post("/api/driver/login", (req, res) => {
  const { pin } = req.body || {};
  const driver = drivers.find(d => d.pin === String(pin || ""));
  if (!driver) return res.status(401).json({ error: "PIN غير صحيح" });
  res.json({ ok: true, driver: { id: driver.id, name: driver.name, isAvailable: driver.isAvailable } });
});

app.patch("/api/trips/:id", (req, res) => {
  const id = Number(req.params.id);
  const { action, driverId } = req.body || {};
  const trip = trips.find(t => t.id === id);
  if (!trip) return res.status(404).json({ error: "الكورس غير موجود" });

  // actions: accept, reject, start, complete, cancel, no_driver
  if (action === "accept") {
    if (!driverId) return res.status(400).json({ error: "driverId مطلوب" });
    if (trip.status !== "searching") return res.status(400).json({ error: "لا يمكن قبول هذا الكورس الآن" });
    trip.status = "accepted";
    trip.assignedDriverId = Number(driverId);
  } else if (action === "reject") {
    // For MVP we mark as rejected if no one accepts (simple)
    trip.status = "rejected";
  } else if (action === "start") {
    if (trip.status !== "accepted") return res.status(400).json({ error: "لا يمكن بدء الكورس الآن" });
    trip.status = "started";
  } else if (action === "complete") {
    if (trip.status !== "started") return res.status(400).json({ error: "لا يمكن إنهاء الكورس الآن" });
    trip.status = "completed";
  } else if (action === "cancel") {
    trip.status = "cancelled";
  } else if (action === "no_driver") {
    trip.status = "no_driver";
  } else {
    return res.status(400).json({ error: "عملية غير صحيحة" });
  }

  emitTripUpdated(trip);
  res.json(trip);
});

// ---------------- Single-file Pages (HTML+CSS+JS embedded) ----------------
const PAGE_CSS = `
:root{
  --green:#0a8f3a;
  --green2:#0fb14d;
  --bg:#f6fff8;
  --text:#0b1b12;
  --card:#ffffff;
  --muted:#6b7a73;
  --border:#d7eadc;
}
*{box-sizing:border-box}
html,body{margin:0;padding:0;font-family:system-ui,-apple-system,"Segoe UI",Tahoma,Arial;background:var(--bg);color:var(--text)}
.rtl{direction:rtl}
.container{max-width:1100px;margin:0 auto;padding:20px}
.header{display:flex;gap:12px;align-items:center;justify-content:space-between;padding:14px 16px;border:1px solid var(--border);background:var(--card);border-radius:14px}
.brand{display:flex;align-items:center;gap:10px}
.logo{width:40px;height:40px;border-radius:12px;background:linear-gradient(135deg,var(--green),var(--green2))}
.title{font-weight:900}
.small{font-size:12px;color:var(--muted)}
.nav{display:flex;gap:10px}
.btn{border:1px solid var(--border);background:#fff;padding:10px 12px;border-radius:12px;cursor:pointer;font-weight:800}
.btnPrimary{border:none;background:linear-gradient(135deg,var(--green),var(--green2));color:#fff}
.grid{margin-top:16px;display:grid;grid-template-columns:1.1fr 0.9fr;gap:16px}
.card{border:1px solid var(--border);background:var(--card);border-radius:14px;padding:16px}
.label{font-size:13px;color:var(--muted);margin-bottom:6px}
.input{width:100%;padding:12px;border-radius:12px;border:1px solid var(--border);outline:none}
.row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.mapWrap{height:360px;border-radius:14px;overflow:hidden;border:1px solid var(--border)}
.kpi{display:flex;justify-content:space-between;align-items:center;border:1px dashed var(--border);padding:12px;border-radius:12px;background:#fbfffc;margin-top:12px}
.kpi strong{font-size:18px}
.note{margin-top:10px;color:var(--muted);font-size:12px}
.table{width:100%;border-collapse:collapse}
.table th,.table td{padding:10px;border-bottom:1px solid var(--border);text-align:right;vertical-align:top;font-size:14px}
.pill{display:inline-block;padding:6px 10px;border-radius:999px;font-size:12px;font-weight:900;border:1px solid var(--border)}
.pill.searching{background:#e8fff1;color:var(--green)}
.pill.accepted{background:#e8f3ff;color:#1357b8}
.pill.rejected{background:#ffecec;color:#b81212}
.pill.started{background:#fff7e3;color:#9a6a00}
.pill.completed{background:#eefcf7;color:#0b6b44}
.pill.cancelled{background:#f1f1f1;color:#444}
.pill.no_driver{background:#f7f0ff;color:#6b2bb8}
.actions{display:flex;gap:8px;flex-wrap:wrap}
hr{border:none;border-top:1px solid var(--border);margin:12px 0}
@media (max-width:980px){.grid{grid-template-columns:1fr}.row{grid-template-columns:1fr}}
`;

const LEAFLET_CDN = `
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
`;

const SOCKET_CDN = `<script src="/socket.io/socket.io.js"></script>`;

function dispatcherPage() {
  return `
<!doctype html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Fast Car - لوحة الكورسات</title>
  ${LEAFLET_CDN}
  ${SOCKET_CDN}
  <style>${PAGE_CSS}</style>
</head>
<body class="rtl">
  <div class="container">
    <div class="header">
      <div class="brand">
        <div class="logo"></div>
        <div>
          <div class="title">Fast Car</div>
          <div class="small">لوحة الكورسات (عربي RTL) — أخضر/أبيض</div>
        </div>
      </div>
      <div class="nav">
        <a class="btn btnPrimary" href="/">لوحة الكورسات</a>
        <a class="btn" href="/captain">لوحة الكابتن</a>
      </div>
    </div>

    <div class="grid">
      <div class="card">
        <h3 style="margin:0 0 10px 0">طلب كورس جديد</h3>

        <div class="row">
          <div>
            <div class="label">اسم الزبون</div>
            <input id="customerName" class="input" placeholder="مثال: محمد أحمد">
          </div>
          <div>
            <div class="label">رقم الهاتف</div>
            <input id="customerPhone" class="input" placeholder="مثال: 22xxxxxx">
          </div>
        </div>

        <hr>

        <div class="row">
          <div>
            <div class="label">بحث عن مكان (انطلاق أو وجهة)</div>
            <input id="searchBox" class="input" placeholder="اكتب اسم مكان بالعربي...">
            <div class="note">اكتب ثم Enter — النتائج تعتمد على OpenStreetMap (Nominatim).</div>
          </div>
          <div>
            <div class="label">اختيار نقطة البحث</div>
            <div class="actions">
              <button class="btn" id="setAsPickup">تعيين كنقطة انطلاق</button>
              <button class="btn" id="setAsDropoff">تعيين كوجهة</button>
            </div>
            <div class="note" id="searchStatus">—</div>
          </div>
        </div>

        <hr>

        <div class="row">
          <div>
            <div class="label">موقع الانطلاق (اضغط على الخريطة)</div>
            <input id="pickupAddress" class="input" placeholder="سيظهر العنوان هنا تلقائياً" readonly>
          </div>
          <div>
            <div class="label">الوجهة (اضغط على الخريطة)</div>
            <input id="dropoffAddress" class="input" placeholder="سيظهر العنوان هنا تلقائياً" readonly>
          </div>
        </div>

        <div class="mapWrap" id="map"></div>

        <div class="kpi">
          <div>
            <div class="small">المسافة / الوقت (تقديري)</div>
            <strong id="kpiDistance">—</strong>
          </div>
          <div>
            <div class="small">السعر قبل الإرسال (أوقية قديمة)</div>
            <strong id="kpiPrice">—</strong>
          </div>
        </div>

        <div class="actions" style="margin-top:12px">
          <button class="btn" id="btnPickup">أحدد الآن: الانطلاق</button>
          <button class="btn" id="btnDropoff">أحدد الآن: الوجهة</button>
          <button class="btn btnPrimary" id="btnSend">إرسال للكباتنة</button>
        </div>

        <div class="note">
          فتح العداد الافتراضي = <b>900 أوقية قديمة</b>.  
          التسعيرة تتحدد تلقائياً حسب <b>منطقة الانطلاق</b> إن وُجدت، وإلا تعرفة عامة.
        </div>
      </div>

      <div class="card">
        <h3 style="margin:0 0 10px 0">كورسات اليوم</h3>
        <div class="note">التحديث فوري (Realtime) — عند القبول/البدء/الإنهاء.</div>
        <div style="overflow:auto; max-height: 720px;">
          <table class="table" id="tripsTable">
            <thead>
              <tr>
                <th>الزبون</th>
                <th>من → إلى</th>
                <th>السعر</th>
                <th>الحالة</th>
                <th>الكابتن</th>
                <th>إجراءات</th>
              </tr>
            </thead>
            <tbody id="tripsBody"></tbody>
          </table>
        </div>
      </div>
    </div>
  </div>

<script>
  const socket = io();
  socket.emit("join", "dispatcher");

  const center = [18.0735, -15.9582]; // Nouakchott
  const map = L.map("map").setView(center, 12);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19
  }).addTo(map);

  const pickupIcon = L.divIcon({ className:"", html:"<div style='background:#0a8f3a;color:#fff;font-weight:900;padding:6px 10px;border-radius:999px;border:2px solid #fff;box-shadow:0 6px 18px rgba(0,0,0,.15)'>انطلاق</div>" });
  const dropoffIcon = L.divIcon({ className:"", html:"<div style='background:#0fb14d;color:#fff;font-weight:900;padding:6px 10px;border-radius:999px;border:2px solid #fff;box-shadow:0 6px 18px rgba(0,0,0,.15)'>وجهة</div>" });

  let picking = "pickup"; // pickup or dropoff
  let pickup = null;
  let dropoff = null;
  let pickupMarker = null;
  let dropoffMarker = null;
  let lastSearchPoint = null;
  let lastSearchMarker = null;

  const $ = (id) => document.getElementById(id);

  function statusLabel(s){
    const map = {
      searching: "قيد البحث",
      accepted: "مقبول",
      rejected: "مرفوض",
      started: "بدأ",
      completed: "انتهى",
      cancelled: "ملغي",
      no_driver: "لم يتم إيجاد كابتن"
    };
    return map[s] || s;
  }
  function pillClass(s){ return "pill " + s; }

  async function reverseGeocode(lat, lng){
    try{
      const url = "https://nominatim.openstreetmap.org/reverse?format=jsonv2&accept-language=ar&lat=" + lat + "&lon=" + lng;
      const r = await fetch(url, { headers: { "User-Agent": "fast-car-mvp" }});
      const j = await r.json();
      return j.display_name || "";
    }catch(e){
      return "";
    }
  }

  async function searchPlace(q){
    const url = "https://nominatim.openstreetmap.org/search?format=jsonv2&accept-language=ar&q=" + encodeURIComponent(q);
    const r = await fetch(url, { headers: { "User-Agent": "fast-car-mvp" }});
    const arr = await r.json();
    return arr?.[0] || null;
  }

  function haversineKm(a, b){
    const R = 6371;
    const dLat = (b.lat - a.lat) * Math.PI/180;
    const dLng = (b.lng - a.lng) * Math.PI/180;
    const s1 = Math.sin(dLat/2), s2 = Math.sin(dLng/2);
    const q = s1*s1 + Math.cos(a.lat*Math.PI/180)*Math.cos(b.lat*Math.PI/180)*s2*s2;
    const c = 2 * Math.atan2(Math.sqrt(q), Math.sqrt(1-q));
    return R*c;
  }

  async function updateEstimate(){
    if(!pickup || !dropoff){
      $("kpiDistance").innerText = "—";
      $("kpiPrice").innerText = "—";
      return;
    }
    const distanceKm = haversineKm(pickup, dropoff);
    // تقدير وقت بسيط: متوسط 30 كم/س + 3 دقائق ثابتة
    const durationMin = (distanceKm / 30) * 60 + 3;

    $("kpiDistance").innerText = distanceKm.toFixed(2) + " كم • " + durationMin.toFixed(0) + " دقيقة";

    const r = await fetch("/api/estimate", {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({
        pickupLat: pickup.lat,
        pickupLng: pickup.lng,
        distanceKm,
        durationMin
      })
    });
    const j = await r.json();
    $("kpiPrice").innerText = (j.priceOld ?? "—") + " أوقية";
    return { distanceKm, durationMin, estimate: j };
  }

  map.on("click", async (e) => {
    const lat = e.latlng.lat;
    const lng = e.latlng.lng;

    const address = await reverseGeocode(lat, lng);

    if(picking === "pickup"){
      pickup = { lat, lng };
      if(pickupMarker) map.removeLayer(pickupMarker);
      pickupMarker = L.marker([lat,lng], { icon: pickupIcon }).addTo(map);
      $("pickupAddress").value = address;
    } else {
      dropoff = { lat, lng };
      if(dropoffMarker) map.removeLayer(dropoffMarker);
      dropoffMarker = L.marker([lat,lng], { icon: dropoffIcon }).addTo(map);
      $("dropoffAddress").value = address;
    }
    updateEstimate();
  });

  $("btnPickup").onclick = () => { picking = "pickup"; };
  $("btnDropoff").onclick = () => { picking = "dropoff"; };

  $("searchBox").addEventListener("keydown", async (e) => {
    if(e.key !== "Enter") return;
    const q = e.target.value.trim();
    if(!q) return;
    $("searchStatus").innerText = "جارٍ البحث...";
    const result = await searchPlace(q);
    if(!result){
      $("searchStatus").innerText = "لم يتم العثور على نتيجة.";
      return;
    }
    lastSearchPoint = { lat: Number(result.lat), lng: Number(result.lon), address: result.display_name || q };
    if(lastSearchMarker) map.removeLayer(lastSearchMarker);
    lastSearchMarker = L.circleMarker([lastSearchPoint.lat, lastSearchPoint.lng], { radius: 10 }).addTo(map);
    map.setView([lastSearchPoint.lat, lastSearchPoint.lng], 14);
    $("searchStatus").innerText = "تم العثور: " + (result.display_name || q);
  });

  $("setAsPickup").onclick = async () => {
    if(!lastSearchPoint) return;
    picking = "pickup";
    pickup = { lat: lastSearchPoint.lat, lng: lastSearchPoint.lng };
    if(pickupMarker) map.removeLayer(pickupMarker);
    pickupMarker = L.marker([pickup.lat,pickup.lng], { icon: pickupIcon }).addTo(map);
    $("pickupAddress").value = lastSearchPoint.address;
    updateEstimate();
  };

  $("setAsDropoff").onclick = async () => {
    if(!lastSearchPoint) return;
    picking = "dropoff";
    dropoff = { lat: lastSearchPoint.lat, lng: lastSearchPoint.lng };
    if(dropoffMarker) map.removeLayer(dropoffMarker);
    dropoffMarker = L.marker([dropoff.lat,dropoff.lng], { icon: dropoffIcon }).addTo(map);
    $("dropoffAddress").value = lastSearchPoint.address;
    updateEstimate();
  };

  function driverNameById(id, drivers){
    const d = drivers.find(x => x.id === id);
    return d ? d.name : "—";
  }

  async function loadDrivers(){
    const r = await fetch("/api/driver-list");
    return await r.json();
  }

  function renderTrips(trips, drivers){
    const tbody = $("tripsBody");
    tbody.innerHTML = "";
    for(const t of trips){
      const tr = document.createElement("tr");

      const c1 = document.createElement("td");
      c1.innerHTML = "<b>" + t.customerName + "</b><div class='small'>" + t.customerPhone + "</div>";
      tr.appendChild(c1);

      const c2 = document.createElement("td");
      c2.innerHTML = "<div class='small'>من:</div>" + (t.pickup.address || (t.pickup.lat.toFixed(5)+","+t.pickup.lng.toFixed(5))) +
                    "<div class='small' style='margin-top:6px'>إلى:</div>" + (t.dropoff.address || (t.dropoff.lat.toFixed(5)+","+t.dropoff.lng.toFixed(5)));
      tr.appendChild(c2);

      const c3 = document.createElement("td");
      c3.innerHTML = "<b>" + t.priceOld + "</b> أوقية<div class='small'>" + t.zoneName + "</div>";
      tr.appendChild(c3);

      const c4 = document.createElement("td");
      c4.innerHTML = "<span class='" + pillClass(t.status) + "'>" + statusLabel(t.status) + "</span>";
      tr.appendChild(c4);

      const c5 = document.createElement("td");
      c5.innerHTML = t.assignedDriverId ? ("<b>" + driverNameById(t.assignedDriverId, drivers) + "</b>") : "—";
      tr.appendChild(c5);

      const c6 = document.createElement("td");
      const wrap = document.createElement("div");
      wrap.className = "actions";

      const cancel = document.createElement("button");
      cancel.className = "btn";
      cancel.innerText = "إلغاء";
      cancel.onclick = async () => {
        await fetch("/api/trips/" + t.id, {
          method:"PATCH",
          headers:{ "Content-Type":"application/json" },
          body: JSON.stringify({ action:"cancel" })
        });
      };

      const noDriver = document.createElement("button");
      noDriver.className = "btn";
      noDriver.innerText = "لا يوجد كابتن";
      noDriver.onclick = async () => {
        await fetch("/api/trips/" + t.id, {
          method:"PATCH",
          headers:{ "Content-Type":"application/json" },
          body: JSON.stringify({ action:"no_driver" })
        });
      };

      wrap.appendChild(cancel);
      wrap.appendChild(noDriver);
      c6.appendChild(wrap);
      tr.appendChild(c6);

      tbody.appendChild(tr);
    }
  }

  async function refresh(){
    const [tRes, dRes] = await Promise.all([fetch("/api/trips"), fetch("/api/driver-list")]);
    const t = await tRes.json();
    const d = await dRes.json();
    renderTrips(t, d);
  }

  $("btnSend").onclick = async () => {
    const customerName = $("customerName").value.trim();
    const customerPhone = $("customerPhone").value.trim();
    if(!customerName || !customerPhone){
      alert("يرجى إدخال اسم الزبون ورقم الهاتف");
      return;
    }
    if(!pickup || !dropoff){
      alert("يرجى اختيار موقع الانطلاق والوجهة من الخريطة");
      return;
    }
    const est = await updateEstimate();
    if(!est){
      alert("تعذر حساب السعر");
      return;
    }

    const body = {
      customerName,
      customerPhone,
      pickupLat: pickup.lat,
      pickupLng: pickup.lng,
      pickupAddress: $("pickupAddress").value,
      dropoffLat: dropoff.lat,
      dropoffLng: dropoff.lng,
      dropoffAddress: $("dropoffAddress").value,
      distanceKm: est.distanceKm,
      durationMin: est.durationMin
    };

    const r = await fetch("/api/trips", {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify(body)
    });
    const j = await r.json();
    if(j.error){
      alert(j.error);
      return;
    }
    $("customerName").value = "";
    $("customerPhone").value = "";
    alert("تم إرسال الكورس للكباتنة ✅");
    refresh();
  };

  // Realtime events
  socket.on("trip:created", () => refresh());
  socket.on("trip:update", () => refresh());
  socket.on("trips", () => refresh());

  refresh();
</script>
</body>
</html>
`;
}

function captainPage() {
  return `
<!doctype html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Fast Car - لوحة الكابتن</title>
  ${SOCKET_CDN}
  <style>${PAGE_CSS}</style>
</head>
<body class="rtl">
  <div class="container">
    <div class="header">
      <div class="brand">
        <div class="logo"></div>
        <div>
          <div class="title">Fast Car</div>
          <div class="small">لوحة الكابتن — قبول/رفض/بدء/إنهاء</div>
        </div>
      </div>
      <div class="nav">
        <a class="btn" href="/">لوحة الكورسات</a>
        <a class="btn btnPrimary" href="/captain">لوحة الكابتن</a>
      </div>
    </div>

    <div class="grid">
      <div class="card">
        <h3 style="margin:0 0 10px 0">تسجيل دخول الكابتن (PIN)</h3>
        <div class="row">
          <div>
            <div class="label">PIN (مثال: 1111)</div>
            <input id="pin" class="input" placeholder="أدخل PIN">
          </div>
          <div style="display:flex;align-items:flex-end;gap:10px">
            <button class="btn btnPrimary" id="loginBtn">دخول</button>
            <button class="btn" id="logoutBtn">خروج</button>
          </div>
        </div>
        <div class="note" id="loginStatus">—</div>

        <hr>

        <div class="row">
          <div>
            <div class="label">حالة التوفر</div>
            <div class="actions">
              <button class="btn" id="availOn">متاح</button>
              <button class="btn" id="availOff">غير متاح</button>
            </div>
            <div class="note" id="availStatus">—</div>
          </div>
          <div>
            <div class="label">موقع الكابتن (اختياري)</div>
            <div class="actions">
              <button class="btn" id="setMyLoc">تحديد موقعي</button>
            </div>
            <div class="note" id="locStatus">—</div>
          </div>
        </div>
      </div>

      <div class="card">
        <h3 style="margin:0 0 10px 0">الطلبات الجديدة</h3>
        <div class="note">ستظهر الكورسات بحالة "قيد البحث".</div>
        <div style="overflow:auto; max-height: 720px;">
          <table class="table">
            <thead>
              <tr>
                <th>الزبون</th>
                <th>المسافة/الوقت</th>
                <th>السعر</th>
                <th>الحالة</th>
                <th>إجراءات</th>
              </tr>
            </thead>
            <tbody id="list"></tbody>
          </table>
        </div>
      </div>
    </div>
  </div>

<script>
  const socket = io();
  socket.emit("join", "captain");

  const $ = (id) => document.getElementById(id);

  let me = null;
  let myLat = null;
  let myLng = null;

  function statusLabel(s){
    const map = {
      searching: "قيد البحث",
      accepted: "مقبول",
      rejected: "مرفوض",
      started: "بدأ",
      completed: "انتهى",
      cancelled: "ملغي",
      no_driver: "لم يتم إيجاد كابتن"
    };
    return map[s] || s;
  }
  function pillClass(s){ return "pill " + s; }

  function haversineKm(a, b){
    const R = 6371;
    const dLat = (b.lat - a.lat) * Math.PI/180;
    const dLng = (b.lng - a.lng) * Math.PI/180;
    const s1 = Math.sin(dLat/2), s2 = Math.sin(dLng/2);
    const q = s1*s1 + Math.cos(a.lat*Math.PI/180)*Math.cos(b.lat*Math.PI/180)*s2*s2;
    const c = 2 * Math.atan2(Math.sqrt(q), Math.sqrt(1-q));
    return R*c;
  }

  async function login(){
    const pin = $("pin").value.trim();
    if(!pin) return alert("أدخل PIN");
    const r = await fetch("/api/driver/login", {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ pin })
    });
    const j = await r.json();
    if(j.error){ $("loginStatus").innerText = j.error; return; }
    me = j.driver;
    $("loginStatus").innerText = "مرحباً " + me.name + " ✅";
    $("availStatus").innerText = me.isAvailable ? "متاح" : "غير متاح";
    refresh();
  }

  async function logout(){
    me = null;
    $("loginStatus").innerText = "تم تسجيل الخروج";
    $("availStatus").innerText = "—";
    $("locStatus").innerText = "—";
    $("list").innerHTML = "";
  }

  async function setAvailability(on){
    if(!me) return alert("سجّل الدخول أولاً");
    await fetch("/api/driver/availability", {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ driverId: me.id, isAvailable: on })
    });
    me.isAvailable = on;
    $("availStatus").innerText = on ? "متاح" : "غير متاح";
    refresh();
  }

  async function setMyLocation(){
    if(!navigator.geolocation){
      alert("المتصفح لا يدعم تحديد الموقع");
      return;
    }
    navigator.geolocation.getCurrentPosition(async (pos) => {
      myLat = pos.coords.latitude;
      myLng = pos.coords.longitude;
      $("locStatus").innerText = "تم تحديد الموقع: " + myLat.toFixed(5) + "," + myLng.toFixed(5);
      if(me){
        await fetch("/api/driver/location", {
          method:"POST",
          headers:{ "Content-Type":"application/json" },
          body: JSON.stringify({ driverId: me.id, lat: myLat, lng: myLng })
        });
      }
      refresh();
    }, (err) => {
      alert("تعذر تحديد الموقع: " + err.message);
    }, { enableHighAccuracy:true, timeout:8000 });
  }

  async function actionTrip(id, action){
    if(!
