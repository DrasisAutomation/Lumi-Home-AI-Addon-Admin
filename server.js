const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const DIR = __dirname;
const PORT = process.env.PORT || 2454;

const HA_URL = process.env.SUPERVISOR_TOKEN ? "http://supervisor/core/api" : "https://demo.lumihomepro1.com/api";
const HA_TOKEN = process.env.SUPERVISOR_TOKEN || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiIzNGNlNThiNDk1Nzk0NDVmYjUxNzE2NDA0N2Q0MGNmZCIsImlhdCI6MTc2NTM0NzQ5MSwiZXhwIjoyMDgwNzA3NDkxfQ.Se5PGwx0U9aqyVRnD1uwvCv3F-aOE8H53CKA5TqsV7U";
console.log("TOKEN:", HA_TOKEN ? "EXISTS" : "MISSING");
let addonOptions = {};
try { addonOptions = JSON.parse(fs.readFileSync('/data/options.json', 'utf8')); } catch(e) {}
const OAI_KEY = addonOptions.openai_api_key || process.env.OAI_KEY || "";
const OAI_MODEL = "gpt-4o-mini";

// FTP Configuration
const FTP_CONFIG = {
  host: '192.168.2.25',
  port: 21,
  user: 'lumiai',
  password: 'Lumiai@Secure#2026',
  remotePath: '/config/www/community/images'
};

const HISTORY_FILE = path.join(DIR, 'history.json');
const SCHEDULE_FILE = path.join(DIR, 'schedule.json');
const MEMORY_FILE = path.join(DIR, 'memory.json');
const CHATHISTORY_FILE = path.join(DIR, 'chathistory.json');
const COMMON_MEMORY_FILE = path.join(DIR, 'common_memory.json');
const CATALOGUE_FILE = path.join(DIR, 'catalogue.json');

// Ensure json files exist
try { if (!fs.existsSync(HISTORY_FILE)) fs.writeFileSync(HISTORY_FILE, '[]'); } catch (_) {}
try { if (!fs.existsSync(SCHEDULE_FILE)) fs.writeFileSync(SCHEDULE_FILE, '[]'); } catch (_) {}
try { if (!fs.existsSync(MEMORY_FILE)) fs.writeFileSync(MEMORY_FILE, JSON.stringify({rooms: {}, ac: {}})); } catch (_) {}
try { if (!fs.existsSync(CHATHISTORY_FILE)) fs.writeFileSync(CHATHISTORY_FILE, '{}'); } catch (_) {}
try { if (!fs.existsSync(COMMON_MEMORY_FILE)) fs.writeFileSync(COMMON_MEMORY_FILE, '{}'); } catch (_) {}
try { if (!fs.existsSync(CATALOGUE_FILE)) fs.writeFileSync(CATALOGUE_FILE, '{}'); } catch (_) {}

// Ensure local audio directory exists
const LOCAL_AUDIO_PATH = '/config/www/community/images';
try {
  if (!fs.existsSync(LOCAL_AUDIO_PATH)) {
    fs.mkdirSync(LOCAL_AUDIO_PATH, { recursive: true });
  }
} catch (e) {
  console.log('Using fallback local path for audio');
}

const MIME = {
  '.html': 'text/html',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.mp3':  'audio/mpeg',
  '.wav':  'audio/wav'
};

// State
let PENDING_REPEAT = null;
let SC_TIMERS = {};

// --- UTILS ---
function readJson(fp) { 
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } 
  catch { 
    if (fp === MEMORY_FILE) return { rooms: {} };
    if (fp === CHATHISTORY_FILE) return {};
    if (fp === COMMON_MEMORY_FILE) return {};
    if (fp === CATALOGUE_FILE) return {};
    return []; 
  } 
}
function writeJson(fp, d) { fs.writeFileSync(fp, JSON.stringify(d, null, 2)); }

function getIstTimeStr(d) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false
  }).format(d || new Date());
}

function logAction(device, actionStr, rawCmd) {
  const h = readJson(HISTORY_FILE);
  const t = new Date();
  const devName = Array.isArray(device) ? device.join(', ') : String(device);
  h.push({ device: devName.toLowerCase(), action: actionStr.toUpperCase(), timestamp: t.toISOString(), rawCmd });
  if (h.length > 2000) h.shift();
  writeJson(HISTORY_FILE, h);
}

// --- FTP UPLOAD FUNCTION ---
async function uploadToFTP(buffer, filename) {
  return new Promise((resolve, reject) => {
    const ftp = require('ftp');
    const client = new ftp();
    
    client.on('ready', () => {
      client.cwd(FTP_CONFIG.remotePath, (err) => {
        if (err) {
          client.mkdir(FTP_CONFIG.remotePath, true, () => {
            client.cwd(FTP_CONFIG.remotePath, (err2) => {
              if (err2) {
                client.end();
                reject(err2);
                return;
              }
              uploadFile();
            });
          });
        } else {
          uploadFile();
        }
      });
      
      function uploadFile() {
        client.put(buffer, filename, (err) => {
          client.end();
          if (err) reject(err);
          else resolve();
        });
      }
    });
    
    client.on('error', reject);
    client.connect(FTP_CONFIG);
  });
}

// --- AUDIO CONVERSION: WAV to MP3 ---
async function convertWavToMp3(wavBuffer) {
  return new Promise((resolve, reject) => {
    const tempWav = path.join('/tmp', `recording_${Date.now()}.wav`);
    const tempMp3 = path.join('/tmp', `recording_${Date.now()}.mp3`);
    
    // Write WAV to temp file
    fs.writeFileSync(tempWav, wavBuffer);
    
    // Convert using ffmpeg
    exec(`ffmpeg -i ${tempWav} -acodec libmp3lame -ab 128k -ar 16000 -ac 1 ${tempMp3} -y`, (error) => {
      if (error) {
        console.log('ffmpeg error, falling back to direct WAV:', error.message);
        // Fallback: just copy the WAV as MP3
        fs.writeFileSync(tempMp3, wavBuffer);
      }
      
      try {
        const mp3Buffer = fs.readFileSync(tempMp3);
        // Cleanup
        try { fs.unlinkSync(tempWav); } catch(e) {}
        try { fs.unlinkSync(tempMp3); } catch(e) {}
        resolve(mp3Buffer);
      } catch (e) {
        reject(e);
      }
    });
  });
}

// --- HA API ---
async function callSvc(domain, service, data) {
  const r = await fetch(`${HA_URL}/services/${domain}/${service}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${HA_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  if (!r.ok) {
    const errText = await r.text();
    throw new Error(`HA Error ${r.status}: ${errText}`);
  }
  const text = await r.text();
  try { return text ? JSON.parse(text) : {}; } catch(e) { return {}; }
}

async function getLiveStates() {
  try {
    const r = await fetch(`${HA_URL}/states`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${HA_TOKEN}`, 'Content-Type': 'application/json' }
    });
    if (!r.ok) return null;
    const data = await r.json();
    
    const activeIds = new Set();
    const acIds = new Set();
    const mem = readJson(MEMORY_FILE);
    function extractIds(obj, isAc = false) {
      if (typeof obj === 'string' && obj.includes('.')) {
         activeIds.add(obj);
         if (isAc) acIds.add(obj);
      }
      else if (Array.isArray(obj)) obj.forEach(x => extractIds(x, isAc));
      else if (typeof obj === 'object' && obj !== null) {
         Object.keys(obj).forEach(k => {
             extractIds(obj[k], isAc || k === 'ac');
         });
      }
    }
    extractIds(mem.rooms || {});
    
    const filtered = data.filter(s => activeIds.has(s.entity_id));
    return filtered.map(e => {
       let st = e.state;
       if (acIds.has(e.entity_id)) st = "(IR Stateless - Cannot retrieve status)";
       return `${e.attributes?.friendly_name || e.entity_id}|${e.entity_id}|${st}`;
    }).join('\n');
  } catch (e) {
    return null;
  }
}

function getEnergyContext() {
    try {
        const energyDir = fs.existsSync('/data/options.json') ? '/config/energy_monitor' : path.join(DIR, '../Energy Monitoring/data');
        const dailyFile = path.join(energyDir, 'daily_usage.json');
        const devicesFile = path.join(energyDir, 'devices.json');
        
        if (!fs.existsSync(dailyFile) || !fs.existsSync(devicesFile)) return "";
        
        const dailyData = JSON.parse(fs.readFileSync(dailyFile, 'utf8'));
        const devicesData = JSON.parse(fs.readFileSync(devicesFile, 'utf8'));
        
        const deviceMap = {};
        (devicesData.devices || []).forEach(d => { deviceMap[d.entity] = d.name || d.entity; });
        const rate = (devicesData.currentPricing && devicesData.currentPricing.rate) || 0;
        
        const dates = Object.keys(dailyData).sort((a,b)=>b.localeCompare(a));
        if(dates.length === 0) return "";
        
        const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date()); 
        
        let todayUnits = 0;
        let d7Units = 0;
        let d30Units = 0;
        
        const device30 = {};
        const device7 = {};
        const deviceToday = {};
        
        let dailyBreakdown = '';
        let count = 0;
        
        const nowMs = Date.now();
        const d7Ms = nowMs - 7*86400*1000;
        const d30Ms = nowMs - 30*86400*1000;
        
        for (const date of dates) {
            const dateObj = new Date(date + "T00:00:00+05:30");
            const dateMs = dateObj.getTime();
            const units = dailyData[date].total_units || 0;
            
            if (date === todayStr || dateMs >= nowMs - 86400*1000) { 
                todayUnits += units; 
                Object.entries(dailyData[date].devices || {}).forEach(([e, d]) => {
                    deviceToday[e] = (deviceToday[e]||0) + (d.units||0);
                });
            }
            if (dateMs >= d7Ms) { 
                d7Units += units; 
                Object.entries(dailyData[date].devices || {}).forEach(([e, d]) => {
                    device7[e] = (device7[e]||0) + (d.units||0);
                });
            }
            if (dateMs >= d30Ms) { 
                d30Units += units; 
                Object.entries(dailyData[date].devices || {}).forEach(([e, d]) => {
                    device30[e] = (device30[e]||0) + (d.units||0);
                });
            }
            
            if (count < 7) {
                dailyBreakdown += `\n- ${date}: ${units.toFixed(2)} kWh`;
                count++;
            }
        }
        
        function getTop3(devMap) {
            const arr = Object.entries(devMap).sort((a,b)=>b[1]-a[1]).slice(0,3);
            if (!arr.length) return 'None';
            return arr.map((x, i) => `${i+1}. ${deviceMap[x[0]]||x[0]} (${x[1].toFixed(2)} kWh)`).join(', ');
        }
        
        return `\n\n-----------------------------------------
💡 ENERGY MONITORING STATS (Use this to answer questions about power/energy usage)
-----------------------------------------
Current Rate: ₹${rate}/kWh
Today (${todayStr}): ${todayUnits.toFixed(2)} kWh (₹${(todayUnits*rate).toFixed(2)})
Today's Top Devices: ${getTop3(deviceToday)}

Last 7 Days: ${d7Units.toFixed(2)} kWh (₹${(d7Units*rate).toFixed(2)})
7-Day Top Devices: ${getTop3(device7)}

Last 30 Days: ${d30Units.toFixed(2)} kWh (₹${(d30Units*rate).toFixed(2)})
30-Day Top Devices: ${getTop3(device30)}

Recent Daily History:${dailyBreakdown}
* To answer queries about specific dates, refer to the "Recent Daily History".`;
    } catch(e) {
        console.log("Energy context error:", e.message);
        return "";
    }
}

function buildPrompt(entsStr, energyStatsStr = "") {
  const mem = readJson(MEMORY_FILE);
  const commonMem = readJson(COMMON_MEMORY_FILE);
  const catalogueData = readJson(CATALOGUE_FILE);
  return `You are Lumi, a smart home AI assistant.

Your owner is "Boss". Always call the user "Boss".
Behave like a HUMAN assistant, not just execute commands.

CORE BEHAVIOR
1. Understand intent (not just keywords)
2. Handle indirect sentences naturally
3. Ask smart follow-up questions before actions
4. Use memory of rooms and devices
5. Confirm before critical actions
6. Maintain short conversation memory

CONTEXT AWARE INTELLIGENCE
If user says: "I am cold" -> DO NOT execute freely. Ask: "Boss, I think you might want me to turn off the AC. Should I do that?"
If user says: "I am hot" -> Ask: "Boss, should I turn on the AC for you?"
If user says: "Too bright" -> Ask: "Boss, which room are you in?"
If user gives room -> Ask: "Boss, would you like me to reduce the brightness?"
If user says YES -> Reduce brightness

ROOM UNDERSTANDING
Use Learned memory and Entity names. If room missing -> ALWAYS ask

CONVERSATION FLOW
User -> AI -> User -> AI -> EXECUTE

FOLLOW-UP ACTION SYSTEM
If AI asked and user says "yes" or "ok" -> Execute last suggested action. If "no" -> Cancel.

LEARNING MODE
If user teaches something, you MUST return a strict JSON payload with the 'learn' parameter:
ROOM ALIAS: "mohan room means experience room" -> Return: {"learn": {"type": "room_alias", "alias": "mohan room", "target": "experience room"}, "chat": "Got it"}
ROOM DEVICE W/ SUBCATEGORY: "this light is the chandelier in living room" -> Return: {"learn": {"type": "room_device", "category": "lights", "sub_category": "chandelier", "entity_id": "light.1", "value": "living room"}, "chat": "Saved"}
AC ENTITY: "this is home theater ac 18 degree" -> Return: {"learn": {"type": "room_ac", "sub_category": "main ac", "mode": "18", "entity_id": "switch.ac_18", "value": "home theater"}, "chat": "Saved"}

MEMORY USAGE & SENSORS
Memory: ${JSON.stringify(mem || {}, null, 2)}
* If user queries sensors, lookup room's sensor entity in memory, find its state below, reply naturally.
* If user acts on subcategory, trigger ALL entities listed under it.

SERVICES & ENTITY DOMAINS:
* ALWAYS match domain/service to ENTITY PREFIX.
* switch. -> use switch/turn_on or turn_off. NEVER open_cover.
* cover. -> use cover/open_cover or close_cover.
light->turn_on(brightness_pct, rgb_color)/turn_off/toggle
switch/fan/input_boolean->turn_on/turn_off/toggle
cover->open_cover/close_cover/set_cover_position(position)
media_player->media_play/media_pause/volume_set/play_media(media_content_type="music", media_content_id="query")
climate->set_temperature/set_hvac_mode
scene/script->turn_on

RESPONSE FORMAT (JSON ONLY)
Chat: {"chat":"Boss, which room are you in?"}
Light: {"domain":"light", "service":"turn_on", "data":{"entity_id":"light.1", "brightness_pct":30}, "chat":"Done boss, the light is turned on."}
AC OFF: {"domain":"climate", "service":"set_hvac_mode", "data":{"entity_id":"climate.1", "hvac_mode":"off"}, "chat":"Got it boss, the AC is now off."}
AC SWITCH (If entity is switch.): {"domain":"switch", "service":"turn_on", "data":{"entity_id":"switch.ac_off"}, "chat":"Triggered the AC for you boss."}
PLAY MEDIA: {"domain":"media_player", "service":"play_media", "data":{"entity_id":"media_player.1", "media_content_type":"music", "media_content_id":"song from movie"}, "chat":"Playing that right away boss."}

MULTIPLE ACTIONS: Wrap in single JSON array: [ {"learn": {...}}, {"domain":..., "chat":"Done boss, I have completed all the actions."} ]

COMMON MEMORY (STRUCTURED KNOWLEDGE)
If user wants to save BOQ, Plan, Project, or list:
1. Identify lists/bullet points and create structured JSON.
2. Formulate 'common_memory' JSON payload.
Categories: brand, product, feature, specification, behavior, response_style, planning, boq, project.
Keys lowercase with underscores.
Example User: "Common memory: BOQ for 2BHK. Items: Smart switches: 20"
Expected: {"common_memory": {"type": "add", "category": "boq", "key": "2bhk_smart_home", "value": { "items": [{"name": "smart switches", "quantity": 20}] }}, "chat": "Saved"}
Use current Common Memory to naturally answer questions. Format beautifully using Markdown.
CURRENT COMMON MEMORY: ${JSON.stringify(commonMem || {}, null, 2)}

CATALOGUE MANAGEMENT
Add product/brand structure:
{"catalogue": {"type": "add", "brand": {"id": "id", "name": "Name"}, "products": [{"id": "id", "name": "Name", "category": "cat", "description": "desc", "features": [], "specifications": {}, "types": []}]}, "chat": "Saved"}
If user queries catalogue, follow STRICT navigation flow. DO NOT skip or dump:
1. "catalogue": Show ONLY list of available brand names.
2. brand name: Show ONLY products under brand.
3. product name: If no types -> describe it. If types -> list types ONLY.
4. type name: Describe type.
Format elegantly natively within "chat" string using HTML tags. DO NOT return JSON for queries.
CURRENT CATALOGUE DATA: ${JSON.stringify(catalogueData || {}, null, 2)}

STRICT RULES
- ALWAYS return JSON ONLY. NO raw text.
- Do NOT prepend JSON with labels. Just output raw '{' or '['.
- NEVER auto execute indirect intent unless 70%+ confident.
- If command is clear and confidence >70%, DO NOT ask for confirmation. Execute immediately.
- ALWAYS ask room if missing
- ALWAYS remember learned data
- Do NOT ask confirmation if user specifies a schedule/delay (e.g. "at 3:30 PM"). Output JSON action directly!

ENTITIES:
${entsStr}${energyStatsStr}`;
}

async function parseNL(txt, entsStr, sid) {
  const energyStats = getEnergyContext();
  const msgs = [
    { role: 'system', content: buildPrompt(entsStr, energyStats) }
  ];
  const hist = readJson(CHATHISTORY_FILE);
  if (hist[sid] && hist[sid].messages) {
      hist[sid].messages.slice(-10).forEach(m => {
          if (!m.isHtml && m.role && m.content) msgs.push({ role: m.role, content: m.content });
      });
  }
  msgs.push({ role: 'user', content: txt });

  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OAI_KEY}` },
    body: JSON.stringify({
      model: OAI_MODEL,
      temperature: 0.1,
      max_tokens: 2000,
      messages: msgs
    })
  });
  const data = await r.json();
  if (data.error) throw new Error(data.error.message);
  
  const raw = data.choices[0].message.content.trim();
  console.log("GPT RAW RESP:", raw);
  let jsonStr = raw;
  let parsed;
  const match = raw.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  
  if (match) {
    let jsonStr = match[0];
    try {
        parsed = JSON.parse(jsonStr);
    } catch (e) {
        try {
            // Rescue unbracketed comma-separated items
            parsed = JSON.parse(`[${jsonStr}]`);
        } catch (e2) {
            try {
                // Rescue item sequences with missing commas entirely
                parsed = JSON.parse(`[${jsonStr.replace(/\}\s*\{/g, '},{')}]`);
            } catch (e3) {
                parsed = { chat: raw };
            }
        }
    }
  } else {
    parsed = { chat: raw };
  }
  
  return parsed;
}

// --- COMMAND EXECUTION ---
async function executeCmds(cmds, reqEntities) {
  let results = [];
  cmds = Array.isArray(cmds) ? cmds : [cmds];
  for (const c of cmds) {
    if (c.error) { results.push({ err: c.error }); continue; }
    
    if (c.learn) {
      let m = readJson(MEMORY_FILE);
      
      if (c.learn.type === 'room_alias') {
         if (!m.room_aliases) m.room_aliases = {};
         m.room_aliases[c.learn.alias] = c.learn.target;
      }
      
      let rv = c.learn.value;
      if (rv) {
         if (!m.rooms) m.rooms = {};
         if (!m.rooms[rv]) m.rooms[rv] = {};
         
         if (!m.rooms[rv].lights) m.rooms[rv].lights = {};
         if (!m.rooms[rv].covers) m.rooms[rv].covers = {};
         if (!m.rooms[rv].sensors) m.rooms[rv].sensors = {};
         if (!m.rooms[rv].devices) m.rooms[rv].devices = {};
         if (!m.rooms[rv].ac) m.rooms[rv].ac = {};
         
         if (['room_device', 'room', 'light', 'cover', 'sensor'].includes(c.learn.type)) {
            let cat = c.learn.category || (c.learn.entity_id?.startsWith('light') ? 'lights' : c.learn.entity_id?.startsWith('cover') ? 'covers' : c.learn.entity_id?.startsWith('sensor') ? 'sensors' : 'devices');
            let sub = c.learn.sub_category || 'default';
            
            if (Array.isArray(m.rooms[rv][cat])) {
               m.rooms[rv][cat] = { default: m.rooms[rv][cat] };
            }
            if (!m.rooms[rv][cat][sub]) m.rooms[rv][cat][sub] = [];
            if (!m.rooms[rv][cat][sub].includes(c.learn.entity_id)) m.rooms[rv][cat][sub].push(c.learn.entity_id);
         } else if (c.learn.type === 'room_ac' || c.learn.type === 'ac') {
            let sub = c.learn.sub_category || 'default';
            if (m.rooms[rv].ac.on || m.rooms[rv].ac.off) {
                let tempAc = { ...m.rooms[rv].ac };
                m.rooms[rv].ac = { default: tempAc };
            }
            if (!m.rooms[rv].ac[sub]) m.rooms[rv].ac[sub] = {};
            m.rooms[rv].ac[sub][c.learn.mode || 'on'] = c.learn.entity_id;
         }
      }
      writeJson(MEMORY_FILE, m);
      if (!c.domain) { continue; }
    }
    
    if (c.common_memory && c.common_memory.type === 'add') {
      let cm = readJson(COMMON_MEMORY_FILE);
      const cat = c.common_memory.category;
      const key = c.common_memory.key;
      const val = c.common_memory.value;
      if (cat && key) {
         if (!cm[cat]) cm[cat] = {};
         cm[cat][key] = val;
         writeJson(COMMON_MEMORY_FILE, cm);
      }
      if (!c.domain) { continue; }
    }
    
    if (c.catalogue && c.catalogue.type === 'add') {
      let catDB = readJson(CATALOGUE_FILE);
      const bData = c.catalogue.brand;
      if (bData && bData.name) {
         const bId = bData.id || bData.name.toLowerCase().replace(/\s+/g, '_');
         if (!catDB[bId]) catDB[bId] = { id: bId, name: bData.name, products: [] };
         
         const pData = c.catalogue.products || [];
         pData.forEach(p => {
            const existsIndex = catDB[bId].products.findIndex(x => x.id === p.id);
            if (existsIndex > -1) catDB[bId].products[existsIndex] = p;
            else catDB[bId].products.push(p);
         });
         writeJson(CATALOGUE_FILE, catDB);
      }
      if (!c.domain) { continue; }
    }

    if (c.chat && !c.domain && !c.learn && !c.common_memory && !c.catalogue) { results.push({ chat: c.chat }); continue; }
    
    const eid = c.data?.entity_id;
    let name = '';
    if (typeof eid === 'string') {
      const ent = reqEntities.find(e => e.entity_id === eid);
      name = ent ? ent.name : eid;
    } else if (Array.isArray(eid)) {
      name = eid.map((id) => {
        const ent = reqEntities.find(e => e.entity_id === id);
        return ent ? ent.name : id;
      }).join(', ');
    } else {
      name = String(eid || 'Unknown');
    }

    try {
      let actualDomain = c.domain;
      let actualService = c.service;
      
      const eidStr = Array.isArray(eid) ? eid[0] : eid;
      if (typeof eidStr === 'string' && eidStr.includes('.')) {
        const entityPrefix = eidStr.split('.')[0];
        if (entityPrefix && entityPrefix !== actualDomain) {
           console.log(`Domain mismatch repaired: ${actualDomain} -> ${entityPrefix}`);
           actualDomain = entityPrefix;
        }
      }
      
      if (actualDomain === 'cover') {
        if (actualService === 'open_cover' || actualService === 'turn_on') {
          actualService = 'set_cover_position';
          c.data.position = 100;
        } else if (actualService === 'close_cover' || actualService === 'turn_off') {
          actualService = 'set_cover_position';
          c.data.position = 0;
        }
      }
      
      if (Array.isArray(c.data.entity_id)) {
        for (const e of c.data.entity_id) {
           await callSvc(actualDomain, actualService, { ...c.data, entity_id: e });
           await new Promise(r => setTimeout(r, 150)); // KNX safety buffer
        }
      } else {
        await callSvc(actualDomain, actualService, c.data);
      }
      
      let actionStr = 'ON';
      if (actualService && (actualService.includes('off') || actualService.includes('close'))) actionStr = 'OFF';
      
      logAction(name, actionStr, c);
      results.push({ name, err: null });
    } catch (e) {
      console.error(`Failed to execute command for ${eid}:`, e.message);
      results.push({ name, err: e.message });
    }
    
    // Safety spacer between commands to protect physical UDP/KNX busses from dropping bulk writes
    await new Promise(r => setTimeout(r, 150));
  }
  return results;
}

// --- SCHEDULER ENGINE ---
function scheduleExecution(delayMs, cmds, reqEntities, niceTime) {
  const s = readJson(SCHEDULE_FILE);
  const id = Date.now().toString();
  const executeAt = new Date(Date.now() + delayMs).toISOString();
  
  s.push({ id, cmds, reqEntities, executeAt, displayTime: niceTime });
  writeJson(SCHEDULE_FILE, s);
  
  startTimerForSchedule(id, delayMs, cmds, reqEntities);
}

function startTimerForSchedule(id, delayMs, cmds, reqEntities) {
  const d = Math.max(0, delayMs);
  SC_TIMERS[id] = setTimeout(async () => {
    try { await executeCmds(cmds, reqEntities); } catch (e) { console.error('Schedule Execution Error:', e); }
    let s = readJson(SCHEDULE_FILE);
    s = s.filter(x => x.id !== id);
    writeJson(SCHEDULE_FILE, s);
    delete SC_TIMERS[id];
  }, d);
}

function loadSchedules() {
  const s = readJson(SCHEDULE_FILE);
  const now = Date.now();
  s.forEach(sch => {
    const delay = new Date(sch.executeAt).getTime() - now;
    startTimerForSchedule(sch.id, delay, sch.cmds, sch.reqEntities);
  });
}
loadSchedules();

// --- HTTP SERVER ---
const server = http.createServer(async (req, res) => {
  console.log(`[REQUEST] ${req.method} ${req.url}`);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  // --- DIRECT AUDIO UPLOAD ENDPOINT (Accepts WAV from Recorder.js) ---
  if (req.method === 'POST' && req.url === '/api/upload-audio') {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', async () => {
      try {
        const buffer = Buffer.concat(chunks);
        
        console.log(`Received audio upload, size: ${buffer.length} bytes`);
        
        // Recorder.js sends direct WAV data (already correct format)
        const wavBuffer = buffer;
        
        // Convert to MP3
        console.log('Converting WAV to MP3...');
        const mp3Buffer = await convertWavToMp3(wavBuffer);
        
        // Save locally
        const localMp3Path = path.join(LOCAL_AUDIO_PATH, 'Lumiai.mp3');
        fs.writeFileSync(localMp3Path, mp3Buffer);
        console.log('✅ MP3 saved locally:', localMp3Path);
        
        // Upload to FTP
        try {
          await uploadToFTP(mp3Buffer, 'Lumiai.mp3');
          console.log('✅ Audio uploaded to FTP');
        } catch (ftpErr) {
          console.warn('FTP upload failed, but local file saved:', ftpErr.message);
        }
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Audio uploaded and converted' }));
      } catch (e) {
        console.error('Upload error:', e);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // --- CHECK MP3 ENDPOINT ---
  if (req.method === 'GET' && req.url === '/api/check-mp3') {
    const mp3Path = path.join(LOCAL_AUDIO_PATH, 'Lumiai.mp3');
    try {
      const stats = fs.statSync(mp3Path);
      const now = Date.now();
      const fileAge = now - stats.mtimeMs;
      
      if (fileAge < 30000) { // 30 seconds
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ready: true, age: fileAge }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ready: false, age: fileAge }));
      }
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ready: false, error: 'File not found' }));
    }
    return;
  }

  // --- TRANSCRIBE MP3 ENDPOINT ---
  if (req.method === 'POST' && req.url === '/api/transcribe-mp3') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { mp3Path } = JSON.parse(body);
        const mp3FullPath = path.join(LOCAL_AUDIO_PATH, mp3Path);
        
        if (!fs.existsSync(mp3FullPath)) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'MP3 file not found' }));
        }
        
        const mp3Buffer = fs.readFileSync(mp3FullPath);
        const mp3Base64 = mp3Buffer.toString('base64');
        
        // Send to OpenAI Whisper
        const boundary = '----Boundary' + Math.random().toString(36).substring(2);
        const pre = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.mp3"\r\nContent-Type: audio/mp3\r\n\r\n`;
        const post = `\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n--${boundary}--`;
        
        const payload = Buffer.concat([
          Buffer.from(pre, 'utf8'),
          Buffer.from(mp3Base64, 'base64'),
          Buffer.from(post, 'utf8')
        ]);
        
        const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
          method: 'POST',
          headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Authorization': `Bearer ${OAI_KEY}`
          },
          body: payload
        });
        
        const ans = await whisperRes.json();
        if (ans.error) throw new Error(ans.error.message);
        
        console.log('Transcription result:', ans.text);
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text: ans.text || "" }));
      } catch (e) {
        console.error('Transcription error:', e);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // --- HA SERVICE PROXY ---
  if (req.method === 'POST' && req.url === '/api/ha-service') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { domain, service, data } = JSON.parse(body);
        const result = await callSvc(domain, service, data);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/save-config') {
    let body = ''; req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        fs.writeFileSync(path.join(DIR, 'config.json'), JSON.stringify(payload, null, 2));
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true }));
      } catch (e) { res.writeHead(500); res.end(e.message); }
    });
    return;
  }

  // --- SMS PROXY ENDPOINT ---
  if (req.method === 'POST' && req.url === '/api/send-otp') {
    let body = ''; req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        let { phoneNumber, otp } = JSON.parse(body);
        phoneNumber = String(phoneNumber || '').trim();
        otp = String(otp || '').trim();
        
        if (!phoneNumber || !otp || !/^[0-9]{10}$/.test(phoneNumber) || !/^[0-9]{6}$/.test(otp)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'Invalid format' }));
        }

        const msg = `Your OTP for login is ${otp}. It is valid for 5 minutes. Do not share this code with anyone. Contact support if the OTP was not requested by you - Ziamore.`;
        const smsUrl = `https://sms.textspeed.in/vb/apikey.php?apikey=gdCD8AQiQWAPDTS2&senderid=ZIAMRE&templateid=1707177390087516591&number=${phoneNumber}&message=${encodeURIComponent(msg)}`;
        
        https.get(smsUrl, (smsRes) => {
          let data = '';
          smsRes.on('data', chunk => data += chunk);
          smsRes.on('end', () => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, message: 'OTP dispatched' }));
          });
        }).on('error', (e) => {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'SMS proxy failed: ' + e.message }));
        });
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }

  // --- SESSION HISTORY ENDPOINT ---
  if (req.method === 'GET' && req.url === '/api/sessions') {
    const s = readJson(CHATHISTORY_FILE);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(s));
  }
  if (req.method === 'DELETE' && req.url.startsWith('/api/sessions')) {
    const id = req.url.split('id=')[1];
    let s = readJson(CHATHISTORY_FILE);
    if (id && s[id]) delete s[id];
    writeJson(CHATHISTORY_FILE, s);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ok:true}));
  }

  // --- STATES ENDPOINT ---
  if (req.method === 'GET' && req.url === '/api/states') {
    try {
      const r = await fetch(`${HA_URL}/states`, {
        headers: { 'Authorization': `Bearer ${HA_TOKEN}`, 'Content-Type': 'application/json' }
      });
      if (!r.ok) {
        const errText = await r.text();
        res.writeHead(r.status, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: `HA Error ${r.status}: ${errText}` }));
      }
      const data = await r.json();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ result: data }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  if (req.method === 'GET' && req.url === '/api/schedule') {
    const s = readJson(SCHEDULE_FILE);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(s));
  }

  if (req.method === 'DELETE' && req.url.startsWith('/api/schedule')) {
    const id = req.url.split('id=')[1];
    let s = readJson(SCHEDULE_FILE);
    if (id) {
      if (SC_TIMERS[id]) { clearTimeout(SC_TIMERS[id]); delete SC_TIMERS[id]; }
      s = s.filter(x => x.id !== id);
    } else {
      s.forEach(x => { if(SC_TIMERS[x.id]) { clearTimeout(SC_TIMERS[x.id]); delete SC_TIMERS[x.id]; } });
      s = [];
    }
    writeJson(SCHEDULE_FILE, s);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ok:true}));
  }
  
  if (req.method === 'GET' && req.url === '/api/history') {
    const h = readJson(HISTORY_FILE);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(h));
  }

  if (req.method === 'POST' && req.url === '/api/chat') {
    let body = ''; req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { text, entities, sessionId } = JSON.parse(body);
        let q = (text || '').toLowerCase().trim();
        let entsStr = (entities || []).map(e => `${e.name}|${e.entity_id}|${e.state}`).join('\n') || '(none)';
        const liveStates = await getLiveStates();
        if (liveStates) entsStr = liveStates;
        const sid = sessionId || Date.now().toString();

        const endChat = (data) => {
            let s = readJson(CHATHISTORY_FILE);
            if (!s[sid]) s[sid] = { id: sid, title: (text||'').substring(0, 30) || 'New Chat', messages: [], updatedAt: Date.now() };
            s[sid].messages.push({ role: 'user', content: text||'' });
            s[sid].messages.push({ role: 'assistant', content: data.chat, isHtml: data.isHtml || false });
            s[sid].updatedAt = Date.now();
            writeJson(CHATHISTORY_FILE, s);
            data.sessionId = sid;
            return replyJSON(res, data);
        };

        // Follow-up "YES"
        if (q === 'yes' || q === 'yeah' || q === 'yep') {
            if (PENDING_REPEAT) {
              const r = await executeCmds(PENDING_REPEAT.cmds, entities);
              PENDING_REPEAT = null;
              let outputs = [];
              for (let i = 0; i < r.length; i++) {
                if (r[i].err) outputs.push(`${r[i].name} failed: ${r[i].err}`);
                else outputs.push(`${getIstTimeStr()} | ${r[i].name.toLowerCase()} | ON`);
              }
        
              return endChat({ chat: outputs.join('\n') });
            }
        } else {
            PENDING_REPEAT = null;
        }

        // LOGS & HISTORY & MEMORY
        if (q.match(/\bclear\b/) && q.match(/\bmemory\b/)) {
            writeJson(MEMORY_FILE, { rooms: {} });
            let s = readJson(CHATHISTORY_FILE);
            if(s[sid]) s[sid].messages = [];
            writeJson(CHATHISTORY_FILE, s);
            return endChat({ chat: "Done! I have wiped my memory file and conversation context." });
        }
        
        if (q.match(/\b(history|logs?)\b/) && q.match(/\b(delete|remove|clear)\b/) && q.match(/\ball\b/)) {
            writeJson(HISTORY_FILE, []);
            let s = readJson(CHATHISTORY_FILE);
            if(s[sid]) s[sid].messages = [];
            writeJson(CHATHISTORY_FILE, s);
            return endChat({ chat: "Done boss! I have cleared your entire action history." });
        }

        const logMatch = q.match(/last\s*(\d+)?\s*log/);
        if (logMatch || q.includes('last logs') || q.includes('show logs') || q === 'logs' || q === 'logs.') {
          const count = parseInt(logMatch?.[1] || 10);
          const h = readJson(HISTORY_FILE);
          const l = h.slice(-count);
          if (l.length === 0) return endChat({chat: "No logs found boss."});
          
          let logHtml = `<div style="display:flex;flex-direction:column;gap:6px;width:100%;margin-top:4px">`;
          l.forEach(x => {
            const time = getIstTimeStr(new Date(x.timestamp));
            const color = x.action === 'ON' ? 'var(--green)' : (x.action === 'OFF' ? 'var(--red)' : 'var(--accent)');
            logHtml += `<div style="background:var(--surf2);padding:8px 14px;border-radius:10px;font-size:13px;display:flex;justify-content:space-between;align-items:center;border:1px solid var(--bdr2);box-shadow:0 2px 8px rgba(0,0,0,0.2);">
              <span style="display:flex;align-items:center;"><span style="color:var(--txt3);font-size:11.5px;margin-right:12px;font-family:monospace">${time}</span><span style="font-weight:500;color:var(--txt)">${x.device}</span></span>
              <span style="color:${color};font-weight:600;font-size:11px;letter-spacing:0.5px;background:rgba(255,255,255,0.04);padding:2px 8px;border-radius:100px">${x.action}</span>
            </div>`;
          });
          logHtml += `</div>`;
          return endChat({chat: logHtml, isHtml: true});
        }

        // REPEAT LAST ACTION
        if (q === 'repeat last action' || q === 'repeat last') {
          const h = readJson(HISTORY_FILE);
          for (let i = h.length - 1; i >= 0; i--) {
            if (h[i].rawCmd) {
              const c = h[i].rawCmd;
              const r = await executeCmds([c], entities);
              const name = (r[0] && !r[0].err) ? r[0].name : "the device";
              let actionStr = 'turned ON';
              if (c.service && (c.service.includes('off') || c.service.includes('close'))) actionStr = 'turned OFF';
              return endChat({ chat: `I have ${actionStr} ${name.toLowerCase()} boss!` });
            }
          }
          return endChat({ chat: "No previous action to repeat boss." });
        }

        // SCHEDULES MANAGEMENT
        if (q.includes('schedule') || q.includes('schedules')) {
          if (q.match(/\b(show|what|list)\b/)) {
            const sum = readJson(SCHEDULE_FILE).length;
            if (sum === 0) return endChat({ chat: "No schedules found boss." });
            return endChat({ chat: `You have ${sum} scheduled actions boss. Check the schedule icon at the top for details!` });
          }
          if (q.includes('remove') || q.includes('delete') || q.includes('cancel') || q.includes('clear')) {
            let s = readJson(SCHEDULE_FILE);
            if (q.includes('all')) {
              s.forEach(x => { if(SC_TIMERS[x.id]) { clearTimeout(SC_TIMERS[x.id]); delete SC_TIMERS[x.id]; } });
              writeJson(SCHEDULE_FILE, []);
              return endChat({ chat: "Done boss! I have removed all schedules." });
            }
          }
        }

        // TIME LOOKBACK
        const isEnergyQuery = q.includes('power') || q.includes('energy') || q.includes('consumption') || q.includes('cost') || q.includes('bill') || q.includes('kwh');
        if (!isEnergyQuery && (q.includes('yesterday') || q.includes('ago') || q.includes('before') || q.match(/(\d+)\s*mis\s*befor/))) {
          let target = Date.now();
          let windowMs = 15 * 60 * 1000;
          if (q.includes('yesterday')) target -= 24 * 3600 * 1000;
          
          const h = readJson(HISTORY_FILE);
          let found = h.filter(x => Math.abs(new Date(x.timestamp).getTime() - target) <= windowMs);
          
          
          if (!found.length) return endChat({ chat: "No actions found around that time boss."});
          
          PENDING_REPEAT = { cmds: found.map(x => x.rawCmd).filter(x => !!x) };
          
          let logHtml = `<div style="display:flex;flex-direction:column;gap:6px;width:100%;margin-top:4px">`;
          found.forEach(x => {
            const time = getIstTimeStr(new Date(x.timestamp));
            const color = x.action === 'ON' ? 'var(--green)' : (x.action === 'OFF' ? 'var(--red)' : 'var(--accent)');
            logHtml += `<div style="background:var(--surf2);padding:8px 14px;border-radius:10px;font-size:13px;display:flex;justify-content:space-between;align-items:center;border:1px solid var(--bdr2);box-shadow:0 2px 8px rgba(0,0,0,0.2);">
              <span style="display:flex;align-items:center;"><span style="color:var(--txt3);font-size:11.5px;margin-right:12px;font-family:monospace">${time}</span><span style="font-weight:500;color:var(--txt)">${x.device}</span></span>
              <span style="color:${color};font-weight:600;font-size:11px;letter-spacing:0.5px;background:rgba(255,255,255,0.04);padding:2px 8px;border-radius:100px">${x.action}</span>
            </div>`;
          });
          logHtml += `</div><div style="margin-top:10px;font-size:13.5px">Do you want me to repeat this?</div>`;
          return endChat({chat: logHtml, isHtml: true});
        }

        // DELAYS & SCHEDULES
        let delayMs = 0;
        let niceTime = '';
        const delayMatch = q.match(/after (\d+) (second|minute|hour)s?/);
        const atMatch = q.match(/at (\d+)(?::(\d+))?\s*(pm|am)?/);
        
        let cleanedQ = q;
        if (delayMatch) {
          const v = parseInt(delayMatch[1]), u = delayMatch[2];
          if (u === 'second') delayMs = v * 1000;
          if (u === 'minute') delayMs = v * 60 * 1000;
          if (u === 'hour') delayMs = v * 3600 * 1000;
          cleanedQ = cleanedQ.replace(delayMatch[0], '').trim();
          niceTime = `in ${v} ${u}s`;
        } else if (atMatch) {
          let hr = parseInt(atMatch[1]);
          let mn = parseInt(atMatch[2] || 0);
          let ampm = atMatch[3];
          if (ampm === 'pm' && hr < 12) hr += 12;
          if (ampm === 'am' && hr === 12) hr = 0;
          
          let now = new Date();
          const istStr = new Intl.DateTimeFormat('en-US', {timeZone:'Asia/Kolkata', year:'numeric', month:'numeric', day:'numeric'}).format(now);
          const tDate = new Date(`${istStr} ${hr}:${mn}:00 GMT+0530`);
          if (tDate.getTime() < Date.now()) tDate.setDate(tDate.getDate() + 1);
          delayMs = tDate.getTime() - Date.now();
          cleanedQ = cleanedQ.replace(atMatch[0], '').trim();
          niceTime = `at ${hr}:${mn.toString().padStart(2, '0')} ${ampm||''}`.trim();
        }

        // OPENAI NLP
        const aiQuery = delayMs > 0 ? `${cleanedQ} (CRITICAL: User is scheduling this. DO NOT ask for confirmation, output the action JSON immediately.)` : (cleanedQ || "turn on");
        const parsed = await parseNL(aiQuery, entsStr, sid);
        if (parsed.chat && !parsed.domain && !parsed.learn && !parsed.common_memory && !parsed.catalogue) return endChat({ chat: parsed.chat });
        
        const cmds = Array.isArray(parsed) ? parsed : [parsed];

        if (delayMs > 0) {
          scheduleExecution(delayMs, cmds, entities, niceTime);
          return replyJSON(res, { chat: `Got it boss, I've scheduled that for ${niceTime}.` });
        } else {
          const results = await executeCmds(cmds, entities);
          let outputs = [];
          for (let i = 0; i < results.length; i++) {
              if (results[i].err) outputs.push(`${results[i].name} failed: ${results[i].err}`);
          }
          if (outputs.length > 0) return endChat({ chat: outputs.join('\n') });
          
          return endChat({ chat: Array.isArray(parsed) ? (parsed[0]?.chat || "Consider it done boss!") : (parsed.chat || "Done boss!") });
        }
      } catch (e) {
        return replyJSON(res, { chat: `Ran into an issue boss: ${e.message}` });
      }
    });
    return;
  }

  // Serving static files
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';
  
  const fp = path.join(DIR, urlPath);
  try {
    const data = fs.readFileSync(fp);
    const ext  = path.extname(fp);
    const ct   = MIME[ext] || 'text/plain';
    res.writeHead(200, { 
      'Content-Type': ct, 
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
      'Surrogate-Control': 'no-store'
    });
    res.end(data);
  } catch (err) { 
    console.error(`[Static File Error] Failed to serve ${fp}:`, err.message);
    res.writeHead(404); 
    res.end('404 Not Found - ' + urlPath); 
  }
});

function replyJSON(res, obj) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Lumi Demo AI Backend running at http://localhost:${PORT}`);
  console.log(`Audio endpoints ready (using Recorder.js compatible WAV format):`);
  console.log(`  - POST /api/upload-audio (Direct WAV upload)`);
  console.log(`  - GET  /api/check-mp3 (Check if MP3 is ready)`);
  console.log(`  - POST /api/transcribe-mp3 (Transcribe MP3 via Whisper)`);
});