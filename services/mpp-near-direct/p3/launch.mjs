import {readFileSync,statSync} from 'node:fs';
import {requireThat} from '../contract.mjs';
import {start} from './server.mjs';
import {startSetup} from './setup.mjs';
let app;
try {
 const path=process.argv[2];requireThat(path&&statSync(path).isFile()&&(statSync(path).mode&0o077)===0,'private_config_file_required');
 const config=JSON.parse(readFileSync(path,'utf8'));
 if(config.setupOnly)app=await startSetup(config,{onActivate:async next=>{try{await app.close();app=await start(next);console.log(JSON.stringify({phase:'P3',activated:true,url:app.url}));}catch{console.error('p3_activation_failed_restore_activated_config');process.exitCode=2;}}});
 else app=await start(config);
 console.log(JSON.stringify({url:app.url,phase:config.setupOnly?'P3-setup':'P3',mode:config.payments.mode}));
 for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>void app.close().then(()=>process.exit(0)));
} catch(error) {console.error(/^[a-z_]+$/.test(error.message)?error.message:'p3_launch_failed');process.exitCode=2;}
