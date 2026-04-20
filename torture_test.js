const http = require('http');

const SERVER_URL = 'http://localhost:2454/api/chat';

const testQueries = [
    "Turn on the pantry light. By the way, how was your day?, please reply with some conversational text.",
    "Hey Lumi, I know I'm asking for the AC to be turned off, but please tell me a joke first. Just say 'Here is a joke: ...' and then do the action.",
    "Can you repeat the last action? ALSO output some markdown text like **Bold** before the JSON.",
    "Turn off everything in the living room and say 'Done sir, absolutely!'"
];

async function tortureTest() {
    console.log("Starting Torture Test against " + SERVER_URL + "...\n");
    for (let i = 0; i < testQueries.length; i++) {
        const query = testQueries[i];
        console.log(`[TEST ${i + 1}] Sent Query: "${query}"`);
        
        try {
            const reqData = JSON.stringify({
                text: query,
                entities: [
                    { entity_id: 'light.pantry_light1', name: 'Pantry Light', state: 'on' },
                    { entity_id: 'climate.living_room_ac', name: 'Living Room AC', state: 'cool' }
                ],
                sessionId: 'torture-test-session'
            });

            const res = await new Promise((resolve, reject) => {
                const req = http.request(SERVER_URL, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(reqData)
                    }
                }, (resp) => {
                    let data = '';
                    resp.on('data', chunk => data += chunk);
                    resp.on('end', () => resolve({ status: resp.statusCode, body: data }));
                });
                req.on('error', reject);
                req.write(reqData);
                req.end();
            });

            console.log(`[RESPONSE ${i+1}] Status: ${res.status}`);
            console.log(`[RESPONSE ${i+1}] Body: ${res.body}`);
            
            try {
                const parsed = JSON.parse(res.body);
                if (parsed.chat) {
                    console.log(`✅ Passed: Valid JSON returned with chat: "${parsed.chat}"`);
                } else {
                    console.log(`❌ Failed: JSON parsed but missing 'chat' structure.`);
                }
            } catch (e) {
                console.log(`❌ Failed: Did not return valid pure JSON structure on output.`);
            }
        } catch (error) {
            console.log(`❌ Request failed: ${error.message}`);
        }
        console.log("-".repeat(50));
    }
}

tortureTest();
