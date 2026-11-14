// libfx 0.0.16 adds these exact recovery-only messages after an interrupted
// confirmed tool step. They do not authorize resampling or a changed task.
const NOTES=['Resuming from unexpected session interruption.','Continue from the confirmed tool result above without repeating the tool.'];
export function normalizeRecoveryBody(raw,recovery){
 if(!recovery)return raw;
 const body=JSON.parse(raw),messages=body.messages;
 if(!Array.isArray(messages)||messages.length<4||messages.at(-3)?.role!=='tool')return raw;
 if(!NOTES.every((note,i)=>{const m=messages.at(i-2);return m?.role==='user'&&m.content===note&&Object.keys(m).length===2;}))return raw;
 messages.splice(-2);
 return JSON.stringify(body);
}
