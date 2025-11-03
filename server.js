/**
 * server.js — Binary Sniper God (final, modular)
 * - full features (auto-pick, pre-signal, AI learner, result resolver, /signals/history)
 */
require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fetch = require('node-fetch');

const compute = require('./computeStrategy');
const aiLearner = require('./aiLearner');
const manipul = require('./manipulationDetector');
const resultResolver = require('./resultResolver');
const quotexAdapter = require('./quotexAdapter');
const sentimentEngine = require('./sentimentEngine');
const strategyManager = require('./strategyManager');
const patternEngine = require('./patternEngine');
const newsFilter = require('./newsFilter');
const riskManager = require('./riskManager');
const optimizer = require('./optimizer');
const martingaleAdvisor = require('./martingaleAdvisor');
const deepSentiment = require('./deepSentiment');
const modeDetector = require('./modeDetector');
const liquidityDetector = require('./liquidityDetector');
const divergenceFilter = require('./divergenceFilter');
const masterOverseer = require('./masterOverseer');
const userManager = require('./userManager');
const cloudSync = require('./cloudSync');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

app.use(express.static('public'));
app.use(express.json());

// Config
const PORT = parseInt(process.env.PORT || '3000', 10);
const SIGNAL_INTERVAL_MS = parseInt(process.env.SIGNAL_INTERVAL_MS || '3500', 10);
const MIN_CONF = parseInt(process.env.MIN_BROADCAST_CONF || '45', 10);
const BINARY_EXPIRY_SECONDS = parseInt(process.env.BINARY_EXPIRY_SECONDS || '60', 10);
const AUTO_PICK = (process.env.AUTO_PICK || 'true') === 'true';
const AUTO_PICK_MIN_SCORE = parseInt(process.env.AUTO_PICK_MIN_SCORE || '50', 10);
const OWNER = process.env.OWNER_NAME || 'Owner';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'admin_token';

// Pairs
let PAIRS = (process.env.WATCH_SYMBOLS || '').split(',').map(s=>s.trim()).filter(Boolean);
if(PAIRS.length === 0){
  PAIRS = ['EUR/USD','GBP/USD','USD/JPY','AUD/USD','USD/CAD','USD/CHF','NZD/USD','BTC (OTC)','Gold (OTC)'];
}

// Globals
global.barsGlobal = {};
const bars = {};    // per-symbol bars
const signals = []; // saved signals
const users = userManager.loadUsers(); // simple user manager

// Append tick builder
function appendTick(sym, price, qty, tsSec){
  if(!sym) return;
  sym = String(sym).toUpperCase();
  bars[sym] = bars[sym] || [];
  const arr = bars[sym];
  const last = arr[arr.length-1];
  if(!last || last.time !== tsSec){
    arr.push({ time: tsSec, open: price, high: price, low: price, close: price, volume: qty || 1 });
    if(arr.length > 10000) arr.shift();
  } else {
    last.close = price;
    last.high = Math.max(last.high, price);
    last.low = Math.min(last.low, price);
    last.volume = (last.volume || 0) + (qty || 0);
  }
  global.barsGlobal = Object.assign({}, bars);
}

// Simulate ticks (safe fallback)
function simulateTick(sym){
  const isCrypto = /BTC|DOGE|SHIBA|PEPE|ARB|APTOS|TRON|BITCOIN|BINANCE/i.test(sym);
  const base = isCrypto ? (Math.random()*200 + 20) : (sym.startsWith('EUR') ? 1.09 : 1.0);
  const noise = (Math.random()-0.5) * (isCrypto ? 2 : 0.003);
  const price = +(base + noise).toFixed(4);
  const qty = Math.random() * (isCrypto ? 2 : 100);
  appendTick(sym, price, qty, Math.floor(Date.now()/1000));
}

// Warmup initial bars
function warmup(){
  for(const s of PAIRS){
    bars[s] = bars[s] || [];
    for(let i=0;i<240;i++){
      const ts = Math.floor(Date.now()/1000) - (240 - i);
      const base = s.startsWith('EUR') ? 1.09 : 1.0;
      appendTick(s, +(base + (Math.random()-0.5)*0.005).toFixed(4), Math.random()*100, ts);
    }
  }
}
warmup();

// Time sync
let serverOffsetMs = 0;
async function syncTime(){
  try {
    const r = await fetch('http://worldtimeapi.org/api/timezone/Etc/UTC');
    const j = await r.json();
    const serverMs = (j.unixtime ? j.unixtime*1000 : (new Date(j.datetime)).getTime());
    serverOffsetMs = serverMs - Date.now();
  } catch(e){}
}
setInterval(syncTime, 60_000);
syncTime();

// Basic API: pairs & history
app.get('/pairs', (req,res)=>{
  const structured = PAIRS.map(p=>{
    const type = (/\(OTC\)/i.test(p) || /OTC$/i.test(p)) ? 'otc'
               : /(BTC|DOGE|SHIBA|PEPE|ARB|APTOS|TRON|BITCOIN|BINANCE)/i.test(p) ? 'crypto'
               : /(GOLD|SILVER|CRUDE|UKBRENT|USCRUDE)/i.test(p) ? 'commodity'
               : 'real';
    return { symbol: p, type };
  });
  res.json({ ok:true, pairs: structured, server_time: new Date(Date.now()+serverOffsetMs).toISOString() });
});

// history endpoint used by UI (returns last N signals)
app.get('/signals/history', (req,res)=>{
  const rows = signals.slice(-500).map(s => ({
    id: s.id, symbol: s.symbol, direction: s.direction, confidence: s.confidence, entry: s.entry, entry_ts: s.entry_ts, expiry_ts: s.expiry_ts, result: s.result, time: s.time, candleSize: s.candleSize || null
  }));
  res.json({ ok:true, rows, server_time: new Date(Date.now()+serverOffsetMs).toISOString() });
});

// Auto modules start
resultResolver.start({ signalsRef: signals, barsRef: bars, broadcast });
optimizer.start({ signalsRef: signals, ai: aiLearner });
quotexAdapter.startQuotexAdapter({
  apiUrl: process.env.QUOTEX_API_URL,
  username: process.env.QUOTEX_USERNAME,
  password: process.env.QUOTEX_PASSWORD,
  wsUrl: process.env.QUOTEX_WS_URL
}, {
  appendTick: (sym, price, qty, ts) => appendTick(sym.toUpperCase(), price, qty, ts),
  onOrderConfirm: o => broadcast({ type:'order_confirm', data: o })
}).catch(()=>{});

// helpers
function broadcast(obj){ const raw = JSON.stringify(obj); wss.clients.forEach(c=>{ if(c.readyState === WebSocket.OPEN) c.send(raw); }); }
function scoreAllPairs(){
  const scores = [];
  for(const s of PAIRS){
    try{ const cand = compute.computeSignalForSymbol(s, bars, { require100:false }); if(cand) scores.push({ symbol:s, score: cand.confidence, cand }); }catch(e){}
  }
  scores.sort((a,b)=>b.score - a.score);
  return scores;
}

// Main scanner loop
setInterval(async ()=>{
  const candidates = [];
  for(const s of PAIRS){
    try{
      if(!bars[s] || bars[s].length < 140){ simulateTick(s); continue; }
      const mode = modeDetector.detectMode(bars[s]);
      if(mode === 'no-trade') continue;
      const manip = manipul.detect([], bars[s].slice(-120));
      if(manip.score > 85) continue;
      const signalSmall = compute.computeSignalForSymbol(s, bars, { require100:false });
      if(!signalSmall) continue;
      const div = divergenceFilter.check(bars[s].slice(-200));
      const liq = liquidityDetector.check(bars[s].slice(-200));
      if(div.forbid || liq.forbid) continue;
      const ds = deepSentiment.estimate(s, bars[s].slice(-200));
      signalSmall.deepSentiment = ds;
      candidates.push({ symbol: s, cand: signalSmall, score: signalSmall.confidence + (ds.bias||0) - manip.score*0.1 });
    }catch(e){}
  }
  candidates.sort((a,b)=>b.score - a.score);
  if(candidates.length === 0) return;
  const top = candidates[0];
  try{
    const s = top.symbol;
    const cand = top.cand;
    const patterns = patternEngine.detectPatterns(bars[s].slice(-200));
    if(patterns && patterns.length) cand.notes = (cand.notes||'') + '|' + patterns.join(',');
    const sent = sentimentEngine.getSentiment(s);
    const weighted = strategyManager.applyWeights(cand, { sentiment: sent, patterns });
    const risk = await riskManager.computeRisk({ symbol: s, bars: bars[s].slice(-200), manip: manipul.detect([], bars[s].slice(-120)), sentiment: sent });
    if(risk.riskScore > 65) return;
    const verdict = masterOverseer.decide({ symbol: s, candidate: weighted, bars: bars[s] });
    if(!verdict.ok) return;
    if(verdict.preSignal){
      broadcast({ type:'pre_signal', data:{ symbol:s, hint: 'Potential setup forming', score: Math.round(verdict.score) } });
    }
    const fv = { fvg: cand.notes && cand.notes.includes('fvg'), volumeSpike: cand.notes && cand.notes.includes('volSpike'), manipulation: false, bos: cand.notes && cand.notes.includes('bos')?1:0 };
    const boost = aiLearner.predictBoost ? aiLearner.predictBoost(fv) : 0;
    weighted.confidence = Math.max(1, Math.min(99, Math.round((weighted.confidence||50) + boost + (verdict.score||0))));
    if(weighted.confidence < MIN_CONF) return;
    const mtg = martingaleAdvisor.suggest({ symbol:s, recentSignals: signals.slice(-20), confidence: weighted.confidence, riskScore: risk.riskScore });
    const id = signals.length + 1;
    const expiry_ts = Math.floor(Date.now()/1000) + BINARY_EXPIRY_SECONDS;
    const entry_ts = cand.entry_ts || Math.floor(Date.now()/1000);
    // attach candleSize if present in cand
    const rec = {
      id, symbol: s, market: 'binary', direction: weighted.direction, confidence: weighted.confidence,
      entry: cand.entry, entry_ts, entry_time_iso: cand.entry_time_iso || new Date(entry_ts*1000).toISOString(),
      expiry_ts, notes: weighted.notes || cand.notes || '', time_iso: new Date().toISOString(), server_time_iso: new Date(Date.now()+serverOffsetMs).toISOString(), result: null, mtg, mode: modeDetector.detectMode(bars[s]),
      candleSize: cand.candleSize || null
    };
    signals.push(rec);
    broadcast({ type:'signal', data: rec });
    broadcast({ type:'log', data:`Signal ${rec.symbol} ${rec.direction} conf:${rec.confidence}% id:${rec.id} mtg:${rec.mtg.decision}` });
    try { if(process.env.ENABLE_TELEGRAM === 'true'){ await quotexAdapter.pushTelegramSignal(rec); } } catch(e){}
    cloudSync.saveSignal(rec).catch(()=>{});
  } catch(e){ console.warn('scanner err', e && (e.message||e)); }
}, SIGNAL_INTERVAL_MS);

// WebSocket
wss.on('connection', ws => {
  const structured = PAIRS.map(p=>{
    const type = (/\(OTC\)/i.test(p) || /OTC$/i.test(p)) ? 'otc'
               : /(BTC|DOGE|SHIBA|PEPE|ARB|APTOS|TRON|BITCOIN|BINANCE)/i.test(p) ? 'crypto'
               : /(GOLD|SILVER|CRUDE|UKBRENT|USCRUDE)/i.test(p) ? 'commodity'
               : 'real';
    return { symbol: p, type };
  });
  ws.send(JSON.stringify({ type:'hello', server_time: new Date(Date.now()+serverOffsetMs).toISOString(), pairs: structured, owner: OWNER }));

  ws.on('message', async (msgRaw)=>{
    try{
      const m = JSON.parse(msgRaw.toString());
      if(m.auth && m.token){
        const ok = userManager.validateToken(m.token);
        if(!ok){ ws.send(JSON.stringify({ type:'auth_error', data:'Invalid token' })); return; }
      }
      if(m.type === 'start' || m.type === 'next'){
        let sym = (m.symbol||'').toString().trim();
        if(!sym && AUTO_PICK){
          const best = scoreAllPairs()[0];
          if(best && best.score >= AUTO_PICK_MIN_SCORE) sym = best.symbol;
        }
        if(!sym){ ws.send(JSON.stringify({ type:'hold', data:{ reason:'No pairs available or no suitable auto-pick' } })); return; }
        let sig = compute.computeSignalForSymbol(sym, bars, { require100:true, forceNext: m.type==='next' });
        if(!sig) sig = compute.computeSignalForSymbol(sym, bars, { require100:false, forceNext: m.type==='next' });
        if(!sig){ ws.send(JSON.stringify({ type:'hold', data:{ symbol: sym, reason:'No confirmed opportunity now — hold' } })); return; }
        const patterns = patternEngine.detectPatterns(bars[sym] ? bars[sym].slice(-200) : []);
        if(patterns && patterns.length) sig.notes = (sig.notes||'') + '|' + patterns.join(',');
        const sent = sentimentEngine.getSentiment(sym);
        const weighted = strategyManager.applyWeights(sig, { sentiment: sent, patterns });
        const manip = manipul.detect([], bars[sym] ? bars[sym].slice(-120) : []);
        const risk = await riskManager.computeRisk({ symbol: sym, bars: bars[sym]||[], manip, sentiment: sent });
        if(risk.riskScore > 65){ ws.send(JSON.stringify({ type:'hold', data:{ symbol: sym, reason:'Risk high (news/manip). Hold' } })); return; }
        const fv = { fvg: sig.notes && sig.notes.includes('fvg'), volumeSpike: sig.notes && sig.notes.includes('volSpike'), manipulation: manip.score>0, bos: sig.notes && sig.notes.includes('bos')?1:0 };
        const boost = aiLearner.predictBoost ? aiLearner.predictBoost(fv) : 0;
        weighted.confidence = Math.max(1, Math.min(99, Math.round((weighted.confidence || 50) + boost)));
        const mtg = martingaleAdvisor.suggest({ symbol: sym, recentSignals: signals.slice(-20), confidence: weighted.confidence, riskScore: risk.riskScore });
        if(weighted.confidence < MIN_CONF) { ws.send(JSON.stringify({ type:'hold', data:{ symbol: sym, reason:'Confidence too low' } })); return; }
        const id = signals.length + 1;
        const expiry_ts = Math.floor(Date.now()/1000) + BINARY_EXPIRY_SECONDS;
        const entry_ts = sig.entry_ts || Math.floor(Date.now()/1000);
        const rec = {
          id, symbol: sig.symbol || sym, market: sig.market || 'binary', direction: weighted.direction, confidence: weighted.confidence,
          entry: sig.entry, entry_ts, entry_time_iso: sig.entry_time_iso || new Date(entry_ts*1000).toISOString(),
          expiry_ts, notes: weighted.notes || sig.notes || '', time_iso: new Date().toISOString(), server_time_iso: new Date(Date.now()+serverOffsetMs).toISOString(), result: null, mtg,
          candleSize: sig.candleSize || null
        };
        signals.push(rec);
        ws.send(JSON.stringify({ type:'signal', data: rec }));
        broadcast({ type:'log', data:`User requested ${m.type} -> ${rec.symbol} id:${rec.id} mtg:${rec.mtg.decision}` });
        cloudSync.saveSignal(rec).catch(()=>{});
      } else if(m.type === 'getScores'){
        ws.send(JSON.stringify({ type:'scores', data: scoreAllPairs().slice(0,10) }));
      } else if(m.type === 'admin' && m.token === ADMIN_TOKEN){
        ws.send(JSON.stringify({ type:'admin_stats', data:{ pairs: PAIRS.length, signals: signals.length, users: users.length } }));
      }
    }catch(e){}
  });
});

server.listen(PORT, ()=> {
  console.log(`Binary Sniper God listening ${PORT} — pairs:${PAIRS.length}`);
  optimizer.start({ signalsRef: signals, ai: aiLearner });
});
