let raw = '{"domain":"switch","service":"turn_on","data":{"entity_id":"light.pantry_light1"}},{"domain":"switch","service":"turn_on","data":{"entity_id":"light.pantry_light2"}},{"chat":"Done boss"}';
let match = raw.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
let jsonStr = match[0];
try {
    console.log('Try 1');
    JSON.parse(jsonStr);
    console.log('Success 1');
} catch(e) {
    try {
        console.log('Try 2');
        JSON.parse('[' + jsonStr + ']');
        console.log('Success 2');
    } catch(e2) {
        try {
            console.log('Try 3');
            JSON.parse('[' + jsonStr.replace(/\}\s*\{/g, '},{') + ']');
            console.log('Success 3');
        } catch(e3) {
            console.log('Failed:', e3.message);
        }
    }
}
